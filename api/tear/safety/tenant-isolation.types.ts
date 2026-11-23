export type TenantAction =
  | { op: "HeavyImport" }
  | { op: "HeavyMarketingFlood" }
  | { op: "VictimSend" }
  | { op: "OverlapImportAndVictimSend" }
  | { op: "DrainVictim" };

export interface TenantObs {
  status: number;
  code: string | null;
  victimStatus: number | null;
  victimElapsedMs: number | null;
  victimDeliveredBeforeMarketing: boolean | null;
}

export interface TenantSnapshot {
  victimAccepted: number;
  victimDelivered: number;
  victimFailures: string[];
  starvedVictim: string[];
  leakedErrors: string[];
}
