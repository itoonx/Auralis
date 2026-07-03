// Graph memory: findings become entity/relationship triplets, and two findings that mention the SAME
// entity both contribute edges to that entity's node (cross-finding linkage — the milestone outcome).
import { describe, it, expect } from "vitest";
import { normalizeEntity, extractTriplets, cognify } from "../src/graph";
import type { MemoryAdapter, Triplet, SearchHit } from "../src/memory";

describe("normalizeEntity", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalizeEntity("  Auth/Session.TS ")).toBe("auth/session.ts");
    expect(normalizeEntity("Session   Token")).toBe("session token");
  });
});

describe("extractTriplets", () => {
  it("pulls entities and links one hub to the rest", () => {
    const t = extractTriplets("The `login` handler in auth/session.ts issues a `SessionToken`.");
    const ents = new Set(t.flatMap((e) => [e.subject, e.object]));
    expect(ents.has("auth/session.ts")).toBe(true);
    expect(t.length).toBeGreaterThanOrEqual(1);
    expect(new Set(t.map((e) => e.subject)).size).toBe(1); // single hub subject
  });
  it("returns nothing when there are fewer than 2 entities", () => {
    expect(extractTriplets("just some plain prose with no entities")).toEqual([]);
  });
});

// Records relate() calls (with docId) and serves graph() from them.
class FakeAdapter implements MemoryAdapter {
  edges: { docId: string; t: Triplet }[] = [];
  async search(): Promise<SearchHit[]> { return []; }
  async learn(): Promise<{ id: string }> { return { id: "x" }; }
  async relate(docId: string, _project: string, triplets: Triplet[]): Promise<void> {
    for (const t of triplets) this.edges.push({ docId, t });
  }
  async graph(entity: string): Promise<{ edges: Triplet[]; entities: string[] }> {
    const key = normalizeEntity(entity);
    const hit = this.edges.filter((e) => normalizeEntity(e.t.subject) === key || normalizeEntity(e.t.object) === key);
    return { edges: hit.map((e) => e.t), entities: [...new Set(hit.flatMap((e) => [e.t.subject, e.t.object]))] };
  }
}

describe("cognify linkage", () => {
  it("links two findings that mention the same entity to one node", async () => {
    const a = new FakeAdapter();
    const stub = (text: string): Triplet[] =>
      text.includes("password")
        ? [{ subject: "password", predicate: "checked-in", object: "auth/session.ts" }]
        : [{ subject: "cookie", predicate: "set-by", object: "auth/session.ts" }];
    await cognify(a, "doc_1", "p", "login validates the password", { extract: stub });
    await cognify(a, "doc_2", "p", "issues a session cookie", { extract: stub });

    const g = await a.graph("auth/session.ts");
    expect(g.edges.length).toBe(2);
    const docs = new Set(a.edges.filter((e) => e.t.object === "auth/session.ts").map((e) => e.docId));
    expect(docs).toEqual(new Set(["doc_1", "doc_2"])); // both findings contributed
  });
});
