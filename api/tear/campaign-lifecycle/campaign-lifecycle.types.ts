export type LifecyclePreset =
  | "small"
  | "probe"
  | "probeCleanSkip"
  | "paced"
  | "exempt"
  | "autoPause"
  | "badRecipient"
  | "requiredNotice"
  | "asyncLarge"
  | "asyncEmpty";

export type CampaignStateName =
  | "draft"
  | "preparing"
  | "scheduled"
  | "sending"
  | "paused"
  | "done"
  | "failed"
  | "canceled";

export interface PresetCfg {
  preset: LifecyclePreset;
  recipients: number;
  exempt: boolean;
  accountMaxRate: number;
  accountMax24h: number;
  goodStanding: boolean;
  priorCleanCampaign: boolean;
  badPlaceholder: boolean;
  requiredNotice: boolean;
  emptyAudience?: boolean;
}

export const LIFECYCLE_PRESETS: Record<LifecyclePreset, PresetCfg> = {
  small: {
    preset: "small",
    recipients: 6,
    exempt: false,
    accountMaxRate: 40,
    accountMax24h: 100_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: false,
    requiredNotice: false,
  },
  probe: {
    preset: "probe",
    recipients: 120,
    exempt: false,
    accountMaxRate: 2000,
    accountMax24h: 100_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: false,
    requiredNotice: false,
  },
  probeCleanSkip: {
    preset: "probeCleanSkip",
    recipients: 120,
    exempt: false,
    accountMaxRate: 2000,
    accountMax24h: 100_000,
    goodStanding: true,
    priorCleanCampaign: true,
    badPlaceholder: false,
    requiredNotice: false,
  },
  paced: {
    preset: "paced",
    recipients: 12,
    exempt: false,
    accountMaxRate: 400,
    accountMax24h: 100_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: false,
    requiredNotice: false,
  },
  exempt: {
    preset: "exempt",
    recipients: 12,
    exempt: true,
    accountMaxRate: 400,
    accountMax24h: 100_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: false,
    requiredNotice: false,
  },
  autoPause: {
    preset: "autoPause",
    recipients: 1050,
    exempt: false,
    accountMaxRate: 4000,
    accountMax24h: 1_000_000,
    goodStanding: true,
    priorCleanCampaign: true,
    badPlaceholder: false,
    requiredNotice: false,
  },
  badRecipient: {
    preset: "badRecipient",
    recipients: 6,
    exempt: false,
    accountMaxRate: 40,
    accountMax24h: 100_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: true,
    requiredNotice: false,
  },
  requiredNotice: {
    preset: "requiredNotice",
    recipients: 6,
    exempt: false,
    accountMaxRate: 40,
    accountMax24h: 100_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: false,
    requiredNotice: true,
  },
  // PR #618 (>5,000 list members -> async capture in campaign.run + s1: static hashes)
  asyncLarge: {
    preset: "asyncLarge",
    recipients: 5050,
    exempt: false,
    accountMaxRate: 400,
    accountMax24h: 1_000_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: false,
    requiredNotice: false,
  },
  // PR #618 late EMPTY_AUDIENCE failure when all >5,000 members are unsubscribed
  asyncEmpty: {
    preset: "asyncEmpty",
    recipients: 5050,
    exempt: false,
    accountMaxRate: 400,
    accountMax24h: 1_000_000,
    goodStanding: true,
    priorCleanCampaign: false,
    badPlaceholder: false,
    requiredNotice: false,
    emptyAudience: true,
  },
};

export type LifecycleAction =
  | { op: "Configure"; preset: LifecyclePreset }
  | { op: "PreviewAudience" }
  | { op: "EditDraft"; subject: "v1" | "v2" }
  | { op: "SendNow"; rateShare?: number; pacePerDay?: number; confirmNotice?: boolean }
  | { op: "Schedule"; delaySec: 60 | 300; rateShare?: number }
  | { op: "Reschedule"; delaySec: 120 | 600 }
  | { op: "Unschedule" }
  | { op: "Pause" }
  | { op: "Resume" }
  | { op: "Cancel" }
  | { op: "Archive"; archived: boolean }
  | { op: "GetCampaign" }
  | { op: "UnsubscribeContact"; index: number }
  | { op: "BounceSuppressContact"; index: number }
  | { op: "DeleteContact"; index: number }
  | { op: "RunJobOnce" }
  | { op: "Dispatch"; limit?: number }
  | { op: "DeliverFeedback"; kind: "delivery" | "bounce" | "complaint"; count: number }
  | { op: "Tick"; seconds: 10 | 60 | 300 | 605 | 1805 | 86405 }
  | { op: "Settle" }
  | { op: "RevokeOriginKey" }
  | { op: "SetRequiredNotices"; enabled: boolean }
  | { op: "FlipSesMode" }
  | { op: "SetDbReadOnly"; on: boolean }
  | { op: "SetQuota"; max24: number; sent24: number; customer24: number }
  | { op: "CrashJobAndRedeliver" }
  | { op: "DeployMidCampaign" }
  | { op: "CheckPlannerRate" }
  | { op: "InjectFeedbackLag"; lane: "priority" | "routine"; lagMs: number };

export interface LifecycleObs {
  status: number;
  code: string | null;
  state: CampaignStateName;
  archived: boolean;
  total: number;
  prepared: number;
  expanded: number;
  canceled: number;
  waitingReason: string | null;
  pauseReasonCode: string | null;
  errorCode: string | null;
  deliveredOnly: boolean;
  elapsedMs: number;
  /** Observed planner rate vs view (only populated on CheckPlannerRate). */
  viewRate?: number | null;
  expectedViewRate?: number | null;
  /** For #618 verification: whether review recipients carry s1: hashes. */
  hasS1Hash?: boolean;
}

export interface LifecycleSnapshot {
  configured: boolean;
  state: CampaignStateName;
  total: number;
  prepared: number;
  expanded: number;
  canceled: number;
  waitingReason: string | null;
  waitingUntil: string | null;
  pauseReasonCode: string | null;
  errorCode: string | null;
  // Rule 1: accounting exactness
  duplicateRecipients: string[];
  accountingViolations: string[];
  // Rule 2: validate before send & stop bounds
  sentBeforePrepared: string[];
  sentAfterCancel: string[];
  pauseBoundViolations: string[];
  // Rule 3: pre-release suppression wins
  preReleaseSuppressionViolations: string[];
  // Rule 4: control responsiveness
  controlViolations: string[];
  // Rule 5: probe invariants
  probeViolations: string[];
  // Rule 6: liveness / never stuck
  stuckViolations: string[];
  // Rule 7: rate & view parity (migration 422)
  rateViolations: string[];
  // Rule 8: stats monotonicity & upper bounds
  statsViolations: string[];
  // Leaked host errors
  leakedErrors: string[];
}
