export type CollabActor = "E1" | "E2" | "API";
export type DraftField = "subject" | "previewText" | "html";

export interface DraftFields {
  subject: string;
  previewText: string;
  html: string;
}

export type CollabAction =
  | { op: "Load"; actor: CollabActor }
  | { op: "EditLocal"; actor: CollabActor; field: DraftField; val: string }
  | { op: "Save"; actor: CollabActor }
  | { op: "ReloadMergeSave"; actor: CollabActor }
  | { op: "RaceSave"; a: CollabActor; b: CollabActor };

export interface CollabObs {
  status: number;
  code: string | null;
  revision: number;
  server: DraftFields;
}

export interface CollabSnapshot {
  revision: number;
  server: DraftFields;
  staleOverwrites: string[];
  lostDisjointEdits: string[];
  leakedErrors: string[];
}
