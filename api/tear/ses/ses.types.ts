export type MsgLabel =
  | "d1" | "b1" | "t1" | "c1" | "n1" | "y1" | "o1" | "v1" | "j1" | "f1"
  | "d2" | "b2" | "c2" | "v2" | "x9";

export type EmailLabel = "e1" | "e2";
export type WorkerName = "J" | "K";
export type HeldName = "Q" | "P";

export type MsgKind =
  | "delivery"
  | "bounce"
  | "transient"
  | "validation"
  | "complaint"
  | "not_spam"
  | "delay"
  | "reject"
  | "render"
  | "open";

export interface MsgSpec {
  label: MsgLabel;
  email: 0 | 1 | 2;
  kind: MsgKind;
  recips: readonly (0 | 1)[];
  story: number;
}

export const MSGS: readonly MsgSpec[] = [
  { label: "d1", email: 0, kind: "delivery", recips: [], story: 1 },
  { label: "b1", email: 0, kind: "bounce", recips: [0], story: 1 },
  { label: "t1", email: 0, kind: "transient", recips: [0], story: 1 },
  { label: "c1", email: 0, kind: "complaint", recips: [0], story: 1 },
  { label: "n1", email: 0, kind: "not_spam", recips: [0], story: 1 },
  { label: "y1", email: 0, kind: "delay", recips: [], story: 1 },
  { label: "o1", email: 0, kind: "open", recips: [], story: 1 },
  { label: "v1", email: 0, kind: "validation", recips: [0], story: 2 },
  { label: "j1", email: 0, kind: "reject", recips: [], story: 3 },
  { label: "f1", email: 0, kind: "render", recips: [], story: 4 },
  { label: "d2", email: 1, kind: "delivery", recips: [], story: 0 },
  { label: "b2", email: 1, kind: "bounce", recips: [1], story: 0 },
  { label: "c2", email: 1, kind: "complaint", recips: [1], story: 0 },
  { label: "v2", email: 1, kind: "validation", recips: [0], story: 0 },
  { label: "x9", email: 2, kind: "bounce", recips: [0], story: 0 },
] as const;

export const PAIRS: readonly [MsgLabel, MsgLabel][] = [
  ["c1", "o1"],
  ["b1", "b1"],
  ["d1", "b1"],
  ["b1", "c1"],
  ["t1", "d1"],
  ["y1", "d1"],
  ["d2", "b2"],
  ["b2", "c2"],
  ["o1", "c1"],
  ["c1", "n1"],
] as const;

export const EMAILS: readonly EmailLabel[] = ["e1", "e2"] as const;
export const RECIPS = ["r1", "r2"] as const;
export const WORKERS: readonly WorkerName[] = ["J", "K"] as const;
export const HELD: readonly HeldName[] = ["Q", "P"] as const;
export const ENVELOPE: readonly (readonly (0 | 1)[])[] = [[0], [0, 1]] as const;
export const COST = [1, 2] as const;

export type SesAction =
  | { op: "Queue"; msg: MsgLabel; old?: boolean }
  | { op: "Pair"; a: MsgLabel; b: MsgLabel }
  | { op: "Http"; msg: MsgLabel; old?: boolean }
  | { op: "Forge" }
  | { op: "Stray" }
  | { op: "Alien" }
  | { op: "Cross"; via: "queue" | "http" }
  | { op: "Accept"; email: EmailLabel }
  | { op: "Lost"; email: EmailLabel }
  | { op: "Expire" }
  | { op: "Pause"; paused: boolean }
  | { op: "Claim"; worker: WorkerName; msg: MsgLabel; old?: boolean }
  | { op: "Go"; worker: WorkerName }
  | { op: "Crash"; worker: WorkerName }
  | { op: "Hold"; conn: HeldName; msg: MsgLabel }
  | { op: "Commit"; conn: HeldName; commit: boolean }
  | { op: "Repair" };

export interface SesView {
  emails: Record<string, [string, boolean, number, string | null, string | null]>;
  contacts: Record<string, [boolean, string | null, boolean]>;
  events: [string, string, string, number][];
  published: [string, string][];
  deliveries: [string[], string[]];
  receipts: Record<string, boolean>;
  jobs: [string, string, string, number][];
  hosted: [number, number, number];
  stats: [number, number, number, number, number, number];
  score: [number | null, number | null, number | null];
}

export interface SesObs {
  r: unknown;
  woke: Record<string, unknown>;
  view: SesView;
}

export interface SesSnapshot {
  outcomeBitsMismatches: string[];
  duplicateStoredEvents: string[];
  orphanPublishedEvents: string[];
  deliveryInconsistencies: string[];
  creditsProjectionMismatch: string | null;
  hourlyCreditsMismatch: string | null;
  quarantinedCount: number;
  suppressionLifted: string[];
}
