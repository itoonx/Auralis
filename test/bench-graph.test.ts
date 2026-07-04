// M3 measurement: graph-aware recall surfaces findings flat search misses; the report quantifies the uplift.
import { describe, it, expect } from "vitest";
import { measureGraphRecall } from "../src/bench-graph";
import type { MemoryAdapter, GraphEdge, SearchHit } from "../src/memory";

class Fake implements MemoryAdapter {
  docs = [
    { id: "d1", content: "login is handled in auth/session.ts" },
    { id: "d2", content: "auth/session.ts issues a signed cookie" }, // no query keyword; graph-connected to d1
  ];
  edges: GraphEdge[] = [{ subject: "auth/session.ts", predicate: "sets", object: "signed cookie", docId: "d2" }];
  async search(q: string): Promise<SearchHit[]> {
    const terms = q.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    return this.docs.filter((d) => terms.some((t) => d.content.toLowerCase().includes(t))).map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(): Promise<{ id: string }> {
    return { id: "x" };
  }
  async graph(entity: string): Promise<{ edges: GraphEdge[]; entities: string[] }> {
    const k = entity.toLowerCase();
    const h = this.edges.filter((e) => e.subject.toLowerCase() === k || e.object.toLowerCase() === k);
    return { edges: h, entities: [...new Set(h.flatMap((e) => [e.subject, e.object]))] };
  }
}

describe("measureGraphRecall (M3)", () => {
  it("quantifies findings the graph adds over flat search", async () => {
    const report = await measureGraphRecall(new Fake(), "demo", ["how does login work"]);
    expect(report.flatTotal).toBe(1); // flat finds only d1 (keyword 'login')
    expect(report.addedTotal).toBe(1); // graph adds d2 via the shared auth/session.ts node
    expect(report.upliftPct).toBe(1); // 100% uplift on this query
  });
});
