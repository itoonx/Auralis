// Thin client over the oracle-lite brain. In dev, Vite proxies /api -> :47778 (see vite.config.ts), so
// every call is same-origin. Mirrors the server shapes in ../../src/memory.ts (kept in sync by hand — the
// dashboard is a separate package, so there's no shared type import).

export interface TimelineEvent {
  seq?: number;
  runId?: string;
  project?: string;
  kind: string; // phase | intent | note | finding | dedup | overlap | repair
  actor: string;
  human: string;
  nodeId?: string;
  parentNode?: string[];
  refs?: string[];
  ts?: string;
}

export interface Stats {
  count: number;
  edges: number;
  nodes: number;
  vectors: boolean;
  embedder: string;
}

export interface Finding {
  id: string;
  content: string;
  tier?: string;
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export const getStats = () => json<Stats>("/api/stats");

export const getTimeline = (project: string, run?: string) => {
  const u = new URLSearchParams({ project, limit: "500" });
  if (run) u.set("run", run);
  return json<{ run: string; events: TimelineEvent[] }>(`/api/timeline?${u}`);
};

export const getDocs = (project: string) =>
  json<{ docs: Finding[] }>(`/api/docs?project=${encodeURIComponent(project)}&max=50`);

// Same scorecard the CLI reader computes — evidence, not just a log. Kept local to the dashboard package.
export interface Scorecard {
  tasks: number;
  deduped: number;
  overlaps: number;
  repairs: number;
  notes: number;
}
export function scorecard(events: TimelineEvent[]): Scorecard {
  const c = (k: string) => events.filter((e) => e.kind === k).length;
  const tasks = new Set(events.filter((e) => e.nodeId).map((e) => e.nodeId)).size;
  return { tasks, deduped: c("dedup"), overlaps: c("overlap"), repairs: c("repair"), notes: c("note") };
}
