export type InlineKey = "img1" | "img2";
export type FileKey = "doc1";
export type AttachKey = InlineKey | FileKey;

export type AttachAction =
  | { op: "AddInline"; key: InlineKey }
  | { op: "RemoveInline"; key: InlineKey }
  | { op: "AddFile"; key: FileKey }
  | { op: "RemoveFile"; key: FileKey }
  | { op: "LaunchAndSend" };

export interface AttachObs {
  status: number;
  draftAttachments: AttachKey[];
  sentAttachments: AttachKey[] | null;
}

export interface AttachSnapshot {
  draftAttachments: AttachKey[];
  dbLinkedAttachments: AttachKey[];
  sentHtml: string | null;
  sentAttachments: AttachKey[] | null;
  sentInlineCids: string[];
  leakedErrors: string[];
}
