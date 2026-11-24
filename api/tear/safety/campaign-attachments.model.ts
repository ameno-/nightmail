/**
 * Preventative property (b): What is attached is what is sent (PR #583 class).
 * Invariant: Every attachment delivered to SES on a sent campaign message was in the draft
 * and referenced (for inline images) or listed (for files) at launch time, and nothing else.
 */
import { choice, exact, model, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type { AttachAction, AttachKey, AttachObs, AttachSnapshot, InlineKey } from "./campaign-attachments.types.ts";

export interface AttachState {
  inlines: InlineKey[];
  files: ("doc1")[];
  sent: boolean;
}

function sortedKeys(s: AttachState): AttachKey[] {
  return ([...s.inlines, ...s.files] as AttachKey[]).sort();
}

const attachIdleRules: IdleRule<AttachSnapshot>[] = [
  {
    id: "attachments.db-links-match-draft",
    description: "sending_attachment_links for the campaign matches the current draft attachments with no leftovers",
    check(s) {
      const a = JSON.stringify([...s.draftAttachments].sort());
      const b = JSON.stringify([...s.dbLinkedAttachments].sort());
      return a === b ? undefined : `db links ${b} != draft ${a}`;
    },
  },
  {
    id: "attachments.sent-matches-draft",
    description: "every attachment delivered to SES equals the draft attachment set at launch",
    when: (s) => s.sentAttachments !== null,
    optional: true,
    check(s) {
      const a = JSON.stringify([...s.draftAttachments].sort());
      const b = JSON.stringify([...(s.sentAttachments ?? [])].sort());
      return a === b ? undefined : `SES sent ${b} != draft ${a}`;
    },
  },
  {
    id: "attachments.no-unreferenced-inline",
    description: "no inline Content-ID delivered to SES is absent from the sent HTML body",
    when: (s) => s.sentAttachments !== null && s.sentInlineCids.length > 0,
    optional: true,
    check(s) {
      const html = s.sentHtml ?? "";
      const stray = s.sentInlineCids.filter((cid) => !html.includes(`cid:${cid}`));
      return stray.length ? `unreferenced inline attachments sent: ${stray.join(", ")}` : undefined;
    },
  },
  {
    id: "attachments.all-cid-attached",
    description: "every cid: image referenced in the sent HTML is delivered as an inline attachment",
    when: (s) => s.sentAttachments !== null,
    optional: true,
    check(s) {
      const html = s.sentHtml ?? "";
      const refs = [...html.matchAll(/cid:([a-zA-Z0-9_.@-]+)/g)].map((m) => m[1]!);
      const missing = refs.filter((cid) => !s.sentInlineCids.includes(cid));
      return missing.length ? `dangling cid references not attached: ${missing.join(", ")}` : undefined;
    },
  },
  {
    id: "attachments.no-leaked-errors",
    description: "no unhandled rejections or host errors",
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
];

export const campaignAttachments = model<AttachState, AttachAction, AttachObs, AttachSnapshot>({
  id: "campaign-attachments",
  description: "What is attached is what is sent: every SES attachment matches the draft with no stray removed inline images",
  maxSteps: 12,
  bug: "canary_keep_removed_inline",

  initial: (): AttachState => ({ inlines: [], files: [], sent: false }),

  choices(s): Choice<AttachAction>[] {
    if (s.sent) return [];
    const out: Choice<AttachAction>[] = [];
    for (const key of ["img1", "img2"] as const) {
      if (!s.inlines.includes(key)) out.push(choice({ op: "AddInline", key }, 3));
      else out.push(choice({ op: "RemoveInline", key }, 3));
    }
    if (!s.files.includes("doc1")) out.push(choice({ op: "AddFile", key: "doc1" }, 2));
    else out.push(choice({ op: "RemoveFile", key: "doc1" }, 2));
    out.push(choice({ op: "LaunchAndSend" }, 2));
    return out;
  },

  step(s, a): Step<AttachState, AttachObs> {
    const next = structuredClone(s);
    switch (a.op) {
      case "AddInline":
        next.inlines.push(a.key);
        return { next, expect: exact({ status: 200, draftAttachments: sortedKeys(next), sentAttachments: null }) };
      case "RemoveInline":
        next.inlines = next.inlines.filter((k) => k !== a.key);
        return { next, expect: exact({ status: 200, draftAttachments: sortedKeys(next), sentAttachments: null }) };
      case "AddFile":
        next.files.push(a.key);
        return { next, expect: exact({ status: 200, draftAttachments: sortedKeys(next), sentAttachments: null }) };
      case "RemoveFile":
        next.files = next.files.filter((k) => k !== a.key);
        return { next, expect: exact({ status: 200, draftAttachments: sortedKeys(next), sentAttachments: null }) };
      case "LaunchAndSend":
        next.sent = true;
        return {
          next,
          expect: exact({ status: 202, draftAttachments: sortedKeys(next), sentAttachments: sortedKeys(next) }),
        };
    }
  },

  idle: attachIdleRules,
});
