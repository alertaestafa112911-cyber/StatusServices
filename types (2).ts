export type Level =
  | "operational"
  | "info"
  | "degraded"
  | "outage"
  | "maintenance"
  | "unknown";

export type IncidentState = "active" | "scheduled" | "resolved";

export type Incident = {
  id: string;
  title: string;
  level: Level;
  summary: string;
  startedAt: string | null;
  updatedAt: string | null;
  url: string | null;
  regions: string[];
  services: string[];
  state: IncidentState;
};

export type ServiceIssue = {
  name: string;
  level: Level;
  group: string | null;
  region: string | null;
  kind: "product" | "location";
};

export type StatusCounts = {
  operational: number;
  info: number;
  degraded: number;
  outage: number;
  maintenance: number;
};

export type ProviderSnapshot = {
  id: string;
  company: "Google" | "Amazon" | "Microsoft" | "Cloudflare";
  name: string;
  short: string;
  level: Level;
  headline: string;
  sourceUrl: string;
  sourceLabel: string;
  updatedAt: string | null;
  error: string | null;
  note: string;
  incidents: Incident[];
  recent: Incident[];
  issues: ServiceIssue[];
  issueTotal: number;
  counts: StatusCounts | null;
  countsLabel: string | null;
};

export type StatusBoard = {
  fetchedAt: string;
  providers: ProviderSnapshot[];
};

export const LEVEL_RANK: Record<Level, number> = {
  unknown: 0,
  operational: 1,
  info: 2,
  maintenance: 3,
  degraded: 4,
  outage: 5,
};

export function worstLevel(levels: Level[]): Level {
  let best: Level = "operational";
  for (const level of levels) {
    if (LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  }
  return levels.length ? best : "operational";
}
