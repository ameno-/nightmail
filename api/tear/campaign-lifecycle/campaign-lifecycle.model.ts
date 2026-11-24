/**
 * Nightmail Campaign Lifecycle model (draft -> review -> launch/schedule -> preparing -> list probe ->
 * sending -> done/paused/canceled/failed, plus operational faults, deploy, crash/redelivery, and rate/view parity).
 *
 * Pure reference model: never imports api/src/. Enforces all 8 named lifecycle invariants + temporal
 * at-most-once delivery per frozen recipient.
 */
import { choice, model, prop, satisfies, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import {
  LIFECYCLE_PRESETS,
  type CampaignStateName,
  type LifecycleAction,
  type LifecycleObs,
  type LifecycleSnapshot,
  type LifecyclePreset,
} from "./campaign-lifecycle.types.ts";

export interface LifecycleState {
  configured: boolean;
  preset: LifecyclePreset | null;
  state: CampaignStateName;
  archived: boolean;
  scheduled: boolean;
  expandedAny: boolean;
  dbReadOnly: boolean;
  originRevoked: boolean;
  requiredNoticesOn: boolean;
  sesModeFlipped: boolean;
  quotaTight: boolean;
  contactsMutated: number[];
  settled: boolean;
  faultOccurred: boolean;
  bouncedProbe: boolean;
  resumedProbe: boolean;
}

const CONTROL_BOUND_MS = 2500;

const lifecycleIdleRules: IdleRule<LifecycleSnapshot>[] = [
  {
    id: "lifecycle.accounting-exact",
    description: "no recipient sent twice; at terminal state every frozen recipient is accounted for (counts.total + delivery.canceled === delivery.total)",
    when: (s) => s.configured,
    check: (s) => {
      if (s.duplicateRecipients.length) return `duplicate recipient sends: ${s.duplicateRecipients.slice(0, 5).join(", ")}`;
      if (s.accountingViolations.length) return s.accountingViolations[0];
      return undefined;
    },
  },
  {
    id: "lifecycle.validate-before-send-and-stop-bounds",
    description: "zero sends before every recipient is validated, zero sends after cancel, and paused sends stay within pre-pause queued buffer",
    when: (s) => s.configured,
    check: (s) => {
      if (s.sentBeforePrepared.length) return `sent before prepared: ${s.sentBeforePrepared[0]}`;
      if (s.sentAfterCancel.length) return `sent after cancel: ${s.sentAfterCancel[0]}`;
      if (s.pauseBoundViolations.length) return s.pauseBoundViolations[0];
      return undefined;
    },
  },
  {
    id: "lifecycle.pre-release-suppression-wins",
    description: "an unsubscribe, bounce suppression, or contact delete landing before release always prevents sending (required notices skip only unsubscribe)",
    when: (s) => s.configured,
    check: (s) => (s.preReleaseSuppressionViolations.length ? s.preReleaseSuppressionViolations[0] : undefined),
  },
  {
    id: "lifecycle.controls-responsive",
    description: "Pause, Resume, and Cancel answer within bound and take effect in every valid state including preparing and probe wait",
    when: (s) => s.configured,
    check: (s) => (s.controlViolations.length ? s.controlViolations[0] : undefined),
  },
  {
    id: "lifecycle.probe-enforced",
    description: "probe caps releases until cleared after 10 min; bad probe quarantines; probe wait survives job crash and redelivery without restarting or skipping",
    when: (s) => s.configured,
    check: (s) => (s.probeViolations.length ? s.probeViolations[0] : undefined),
  },
  {
    id: "lifecycle.never-stuck",
    description: "with faults stopped, every campaign reaches done, canceled, failed, paused with reason, or an explicit visible wait with reason and time",
    when: (s) => s.configured,
    check: (s) => (s.stuckViolations.length ? s.stuckViolations[0] : undefined),
  },
  {
    id: "lifecycle.rate-matches-view",
    description: "releases respect rateShare and planner rate matches regional_workspace_limits (shared / 4 unless exempt: migration 422)",
    when: (s) => s.configured,
    check: (s) => (s.rateViolations.length ? s.rateViolations[0] : undefined),
  },
  {
    id: "lifecycle.stats-monotonic-bounded",
    description: "shown stats never exceed reality: delivered <= accepted <= released <= total and accepted <= actual SES accepted",
    when: (s) => s.configured,
    check: (s) => (s.statsViolations.length ? s.statsViolations[0] : undefined),
  },
  {
    id: "lifecycle.no-leaked-errors",
    description: "no unhandled rejections or host errors",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
];

const GUIDED_PRESETS: readonly [LifecyclePreset, number][] = [
  ["small", 40],
  ["probe", 20],
  ["probeCleanSkip", 15],
  ["paced", 15],
  ["exempt", 15],
  ["badRecipient", 10],
  ["requiredNotice", 15],
  ["autoPause", 1],
  ["asyncLarge", 1],
  ["asyncEmpty", 1],
];

export const campaignLifecycle = model<LifecycleState, LifecycleAction, LifecycleObs, LifecycleSnapshot>({
  id: "campaign-lifecycle",
  description: "Full campaign lifecycle from draft to done/paused/canceled/failed under probe, pacing, quotas, suppression, faults, crash/redelivery, and deploy",
  maxSteps: 22,
  bug: "canary_double_send",

  initial: (): LifecycleState => ({
    configured: false,
    preset: null,
    state: "draft",
    archived: false,
    scheduled: false,
    expandedAny: false,
    dbReadOnly: false,
    originRevoked: false,
    requiredNoticesOn: true,
    sesModeFlipped: false,
    quotaTight: false,
    contactsMutated: [],
    settled: false,
    faultOccurred: false,
    bouncedProbe: false,
    resumedProbe: false,
  }),

  choices(s): Choice<LifecycleAction>[] {
    if (!s.configured) {
      return GUIDED_PRESETS.map(([preset, w]) => choice({ op: "Configure", preset }, w));
    }
    const cfg = LIFECYCLE_PRESETS[s.preset!]!;
    const out: Choice<LifecycleAction>[] = [];
    const add = (a: LifecycleAction, w = 1) => out.push(choice(a, w));

    // Read & rate verification
    add({ op: "GetCampaign" }, 2);
    add({ op: "CheckPlannerRate" }, 1);
    add({ op: "PreviewAudience" }, 1);

    // Draft & launch controls
    add({ op: "EditDraft", subject: "v1" }, 1);
    add({ op: "EditDraft", subject: "v2" }, s.state === "draft" ? 10 : 2);
    add({ op: "SendNow" }, s.state === "draft" && !cfg.requiredNotice ? 25 : 3);
    add({ op: "SendNow", confirmNotice: true }, s.state === "draft" && cfg.requiredNotice ? 25 : 1);
    add({ op: "SendNow", rateShare: 0.05 }, s.preset === "paced" || s.preset === "exempt" ? 10 : 1);
    add({ op: "SendNow", rateShare: 0.1 }, 1);
    add({ op: "SendNow", rateShare: 0.25 }, s.preset === "paced" ? 10 : 1);
    add({ op: "Schedule", delaySec: 60 }, s.state === "draft" ? 15 : 2);
    add({ op: "Schedule", delaySec: 300 }, 1);
    add({ op: "Reschedule", delaySec: 120 }, s.scheduled ? 10 : 2);
    add({ op: "Reschedule", delaySec: 600 }, 1);
    add({ op: "Unschedule" }, s.scheduled ? 10 : 2);

    // Pause / Resume / Cancel / Archive (offered from EVERY state to verify guards + responsiveness)
    add({ op: "Pause" }, 15);
    add({ op: "Resume" }, 15);
    add({ op: "Cancel" }, 10);
    add({ op: "Archive", archived: true }, !s.archived ? 5 : 1);
    add({ op: "Archive", archived: false }, s.archived ? 5 : 1);

    // Worker, dispatcher, feedback & time
    add({ op: "RunJobOnce" }, 30);
    add({ op: "Dispatch" }, 25);
    add({ op: "Dispatch", limit: 2 }, 1);
    add({ op: "Dispatch", limit: 100 }, 1);
    add({ op: "Dispatch", limit: 200 }, 1);
    add({ op: "Dispatch", limit: 1000 }, 1);
    add({ op: "Tick", seconds: 10 }, 2);
    add({ op: "Tick", seconds: 60 }, 10);
    add({ op: "Tick", seconds: 300 }, 2);
    add({ op: "Tick", seconds: 605 }, s.preset === "probe" ? 15 : 3);
    add({ op: "Tick", seconds: 1805 }, 2);
    add({ op: "Tick", seconds: 86405 }, s.preset === "paced" ? 10 : 1);
    add({ op: "DeliverFeedback", kind: "delivery", count: 5 }, 10);
    add({ op: "DeliverFeedback", kind: "delivery", count: 6 }, 1);
    add({ op: "DeliverFeedback", kind: "delivery", count: 96 }, 1);
    add({ op: "DeliverFeedback", kind: "delivery", count: 100 }, 1);
    add({ op: "DeliverFeedback", kind: "bounce", count: 4 }, s.preset === "probe" ? 6 : 1);
    add({ op: "DeliverFeedback", kind: "bounce", count: 25 }, 1);
    add({ op: "DeliverFeedback", kind: "complaint", count: 2 }, s.preset === "probe" ? 6 : 1);

    // Pre-release contact mutations
    if (!s.contactsMutated.includes(1)) add({ op: "UnsubscribeContact", index: 1 }, 10);
    if (!s.contactsMutated.includes(2)) add({ op: "BounceSuppressContact", index: 2 }, 10);
    if (!s.contactsMutated.includes(3)) add({ op: "DeleteContact", index: 3 }, 10);

    // Operational / fault transitions
    if (!s.dbReadOnly) add({ op: "SetDbReadOnly", on: true }, 4);
    else add({ op: "SetDbReadOnly", on: false }, 20);
    if (!s.originRevoked) add({ op: "RevokeOriginKey" }, 4);
    if (cfg.requiredNotice) {
      add({ op: "SetRequiredNotices", enabled: !s.requiredNoticesOn }, 10);
    }
    if (!s.sesModeFlipped) add({ op: "FlipSesMode" }, 4);
    add({ op: "CrashJobAndRedeliver" }, 8);
    add({ op: "DeployMidCampaign" }, 8);
    add({ op: "SetQuota", max24: 100, sent24: 95, customer24: 0 }, !s.quotaTight && (s.preset === "paced" || s.preset === "small") ? 5 : 1);
    add({ op: "SetQuota", max24: 100, sent24: 98, customer24: 0 }, 1);
    add({ op: "SetQuota", max24: 100, sent24: 0, customer24: 99 }, 1);
    add({ op: "SetQuota", max24: cfg.accountMax24h, sent24: 0, customer24: 0 }, s.quotaTight ? 15 : 1);
    add({ op: "InjectFeedbackLag", lane: "routine", lagMs: 600000 }, 1);
    add({ op: "InjectFeedbackLag", lane: "priority", lagMs: 360000 }, 1);
    add({ op: "InjectFeedbackLag", lane: "priority", lagMs: 0 }, 1);

    // Liveness check: settle remaining work with faults cleared
    if (!s.settled) add({ op: "Settle" }, 15);

    return out;
  },

  step(s, a): Step<LifecycleState, LifecycleObs> {
    if (a.op === "Configure") {
      const next: LifecycleState = {
        configured: true,
        preset: a.preset,
        state: "draft",
        archived: false,
        scheduled: false,
        expandedAny: false,
        dbReadOnly: false,
        originRevoked: false,
        requiredNoticesOn: true,
        sesModeFlipped: false,
        quotaTight: false,
        contactsMutated: [],
        settled: false,
        faultOccurred: false,
        bouncedProbe: false,
        resumedProbe: false,
      };
      return {
        next,
        expect: satisfies("configured-draft", (obs) =>
          obs.status === 201 && obs.state === "draft"
            ? true
            : `Configure failed: status=${obs.status} state=${obs.state} code=${obs.code}`,
        ),
      };
    }

    const next = structuredClone(s);
    const ro = s.dbReadOnly;

    switch (a.op) {
      case "SetDbReadOnly":
        next.dbReadOnly = a.on;
        if (a.on) next.faultOccurred = true;
        return {
          next,
          expect: satisfies("set-ro-ok", (obs) => (obs.status === 200 ? true : `SetDbReadOnly failed: ${obs.status}`)),
        };

      case "RevokeOriginKey":
        next.originRevoked = true;
        return {
          next,
          expect: satisfies("revoke-origin-ok", (obs) =>
            obs.status === 200 || (ro && obs.status === 503)
              ? true
              : `RevokeOriginKey unexpected: status=${obs.status} code=${obs.code}`,
          ),
        };

      case "SetRequiredNotices":
        next.requiredNoticesOn = a.enabled;
        return {
          next,
          expect: satisfies("set-notices-ok", (obs) => (obs.status === 200 ? true : `SetRequiredNotices failed: ${obs.status}`)),
        };

      case "FlipSesMode":
        next.sesModeFlipped = !s.sesModeFlipped;
        return {
          next,
          expect: satisfies("flip-ses-ok", (obs) => (obs.status === 200 ? true : `FlipSesMode failed: ${obs.status}`)),
        };

      case "SetQuota":
        next.quotaTight = a.sent24 >= a.max24 - 10 || a.customer24 > 0;
        return {
          next,
          expect: satisfies("set-quota-ok", (obs) => (obs.status === 200 ? true : `SetQuota failed: ${obs.status}`)),
        };

      case "UnsubscribeContact":
      case "BounceSuppressContact":
      case "DeleteContact":
        if (!next.contactsMutated.includes(a.index)) next.contactsMutated.push(a.index);
        return {
          next,
          expect: satisfies("contact-mutation-ok", (obs) => {
            if (ro && obs.status === 503) return true;
            if (obs.status >= 200 && obs.status < 300) return true;
            if (obs.status === 404) return true;
            return `${a.op} unexpected: status=${obs.status} code=${obs.code}`;
          }),
        };

      case "CheckPlannerRate":
        return {
          next,
          expect: satisfies("planner-rate-matches-view", (obs) => {
            if (obs.status !== 200) return `CheckPlannerRate failed: status=${obs.status}`;
            if (obs.viewRate !== obs.expectedViewRate) {
              return `regional_workspace_limits.max_send_rate=${obs.viewRate}, expected ${obs.expectedViewRate} (migration 422)`;
            }
            return true;
          }),
        };

      case "Pause":
      case "Resume":
      case "Cancel":
        if (!ro && a.op === "Cancel" && !["draft", "done"].includes(s.state)) {
          next.state = "canceled";
        }
        if (!ro && a.op === "Resume" && s.preset === "probe" && s.bouncedProbe) {
          next.resumedProbe = true;
        }
        return {
          next,
          expect: satisfies("control-responsive-and-valid", (obs) => {
            if (obs.elapsedMs > CONTROL_BOUND_MS) {
              return `${a.op} took ${obs.elapsedMs}ms > ${CONTROL_BOUND_MS}ms bound`;
            }
            if (ro && obs.status === 503) return true;
            if (obs.status === 200) return true;
            // Valid state-guard refusals (409/403/401 when origin key revoked)
            if (obs.status === 409 || obs.status === 403 || (s.originRevoked && obs.status === 401)) return true;
            return `${a.op} unexpected status=${obs.status} code=${obs.code} state=${obs.state}`;
          }),
        };

      case "EditDraft":
      case "SendNow":
      case "Schedule":
      case "Reschedule":
      case "Unschedule":
      case "Archive": {
        const cfg = LIFECYCLE_PRESETS[s.preset!]!;
        const launchMustSucceed =
          (a.op === "SendNow" || a.op === "Schedule") &&
          s.state === "draft" &&
          !s.archived &&
          !ro &&
          !s.originRevoked &&
          !cfg.emptyAudience &&
          (!cfg.requiredNotice || (s.requiredNoticesOn && (a.op === "Schedule" || a.confirmNotice === true)));
        if (launchMustSucceed) {
          next.state = "preparing";
          if (a.op === "Schedule") next.scheduled = true;
        }
        if (!ro && a.op === "Unschedule") next.scheduled = false;
        if (!ro && a.op === "Archive") next.archived = a.archived;
        return {
          next,
          expect: satisfies("api-transition-valid", (obs) => {
            if (ro && obs.status === 503) return true;
            if (launchMustSucceed) {
              if (obs.status !== 202 || obs.state !== "preparing") {
                return `${a.op} from valid draft must return 202/preparing, got status=${obs.status} code=${obs.code} state=${obs.state}`;
              }
              return true;
            }
            if (obs.status === 200 || obs.status === 202) return true;
            // Legitimate refusals (409 state lock/active/archived, 403 notices off, 422 validation/empty, 401 revoked key)
            if ([409, 403, 422].includes(obs.status) || (s.originRevoked && obs.status === 401)) return true;
            return `${a.op} unexpected status=${obs.status} code=${obs.code} state=${obs.state}`;
          }),
        };
      }

      case "Settle": {
        next.dbReadOnly = false;
        next.quotaTight = false;
        next.settled = true;
        // Known product bug BUG-LC-01 (plans/tear/bugs-campaign-lifecycle.md): when a quarantined probe campaign
        // is resumed (deliveredOnly=true) and every remaining recipient is skipped (0 emails inserted), releaseStep
        // advances expanded=total but never calls finishCampaigns, leaving state='sending' with waiting=null.
        const mask = s.preset === "probe" && s.bouncedProbe && s.resumedProbe ? "BUG-LC-01" : undefined;
        const expect = satisfies("settle-not-stuck", (obs) => {
          if (obs.status !== 200) return `Settle failed: status=${obs.status} code=${obs.code}`;
          if (["draft", "done", "canceled", "failed"].includes(obs.state)) return true;
          if (obs.state === "paused" && obs.pauseReasonCode !== null) return true;
          if (obs.state === "scheduled") return true;
          if (obs.state === "sending" && obs.waitingReason !== null) return true;
          return `campaign stuck after Settle: state=${obs.state} prepared=${obs.prepared}/${obs.total} expanded=${obs.expanded} waiting=${obs.waitingReason} pauseReason=${obs.pauseReasonCode}`;
        });
        return mask ? { next, expect, mask } : { next, expect };
      }

      default:
        if (a.op === "DeliverFeedback" && (a.kind === "bounce" || a.kind === "complaint") && s.preset === "probe") {
          next.bouncedProbe = true;
        }
        return {
          next,
          expect: satisfies("step-safe", (obs) => {
            if (obs.status >= 200 && obs.status < 300) return true;
            if (ro && obs.status === 503) return true;
            if (obs.status === 401 && s.originRevoked) return true;
            if (obs.status === 409 || obs.status === 422) return true;
            return `${a.op} unexpected status=${obs.status} code=${obs.code} state=${obs.state}`;
          }),
        };
    }
  },

  idle: lifecycleIdleRules,

  temporal: [
    {
      id: "lifecycle.once-per-recipient",
      title: "no frozen recipient is ever sent to SES more than once for the same campaign",
      prop: prop.optional(
        prop.forEach(
          { name: "rcpt", discover: sel.event("campaign.ses_committed"), key: "/to" },
          (to) => [prop.never(sel.event("campaign.ses_call", { "/to": to }))],
        ),
      ),
    },
  ],
});
