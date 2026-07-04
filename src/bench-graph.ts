// M3 — measure what the graph adds to recall. For each query, compare flat search alone vs graph-aware
// recall (injectFor): how many findings does the graph surface that flat keyword/vector search misses?
import type { MemoryAdapter } from "./memory";
import { MemoryLibrarian } from "./participants";

export interface GraphRecallRow {
  query: string;
  flat: number;
  graph: number;
  added: number; // findings recalled via the graph that flat search missed
}
export interface GraphRecallReport {
  rows: GraphRecallRow[];
  flatTotal: number;
  graphTotal: number;
  addedTotal: number;
  upliftPct: number; // addedTotal / flatTotal
}

export async function measureGraphRecall(adapter: MemoryAdapter, project: string, queries: string[]): Promise<GraphRecallReport> {
  const lib = new MemoryLibrarian(adapter, project);
  const rows: GraphRecallRow[] = [];
  for (const query of queries) {
    const flatHits = await adapter.search(query, { project, limit: 5 });
    const flat = new Set(flatHits.map((h) => h.id).filter(Boolean));
    const { hitIds } = await lib.injectFor(query); // flat + fuzzy graph
    const added = hitIds.filter((id) => !flat.has(id)).length;
    rows.push({ query, flat: flat.size, graph: hitIds.length, added });
  }
  const flatTotal = rows.reduce((a, r) => a + r.flat, 0);
  const graphTotal = rows.reduce((a, r) => a + r.graph, 0);
  const addedTotal = rows.reduce((a, r) => a + r.added, 0);
  return { rows, flatTotal, graphTotal, addedTotal, upliftPct: flatTotal ? addedTotal / flatTotal : 0 };
}
