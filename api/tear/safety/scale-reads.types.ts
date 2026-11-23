export type ScaleReadKind =
  | "ContactsPage"
  | "ContactsBigList"
  | "ContactsSmallList"
  | "ContactsSearchHit"
  | "ListsWithCounts"
  | "CampaignAudienceCount";

export type ScaleReadAction = { op: ScaleReadKind };

export interface ScaleReadObs {
  status: number;
  elapsedMs: number;
  budgetMs: number;
  badPlan: string | null;
  rows: number;
  seededContacts: number;
}

export interface ScaleReadSnapshot {
  seededContacts: number;
  slowReads: string[];
  leakedErrors: string[];
}
