// The values layer: supersession flags but never deletes (append-only), and the audit inspector turns
// provenance into a plain-language "why".
import { describe, it, expect } from "vitest";
import { explainProvenance } from "../src/audit";
import type { MemoryAdapter, SearchHit } from "../src/memory";

class AppendOnlyFake implements MemoryAdapter {
  private docs = new Map<string, { content: string; supersededBy?: string }>();
  private n = 0;
  async search(_query: string): Promise<SearchHit[]> {
    return [...this.docs.entries()].map(([id, d]) => ({ id, content: d.content, supersededBy: d.supersededBy }));
  }
  async learn(pattern: string): Promise<{ id: string }> {
    const id = `doc_${++this.n}`;
    this.docs.set(id, { content: pattern });
    return { id };
  }
  async supersede(oldId: string, newId: string, _reason?: string): Promise<void> {
    const d = this.docs.get(oldId);
    if (d) d.supersededBy = newId; // flag, never delete
  }
  async count(): Promise<number> {
    return this.docs.size;
  }
}

describe("values layer", () => {
  it("supersession flags but never deletes (append-only)", async () => {
    const brain = new AppendOnlyFake();
    const v1 = await brain.learn("v1");
    const v2 = await brain.learn("v2");
    await brain.supersede(v1.id, v2.id, "corrected");
    expect(await brain.count()).toBe(2); // nothing removed
    const old = (await brain.search("x")).find((h) => h.id === v1.id);
    expect(old).toBeDefined();
    expect(old!.supersededBy).toBe(v2.id); // flagged outdated, still present
  });

  it("explainProvenance answers 'why' from a run's provenance", () => {
    const why = explainProvenance([
      { task: "flow", recalled: ["doc_1"], explored: ["src/run.ts"], summary: "the harness boots the brain", learnedId: "doc_2" },
    ]);
    expect(why).toContain('task "flow"');
    expect(why).toContain("doc_1"); // what it built on
    expect(why).toContain("src/run.ts"); // what it explored
    expect(why).toContain("doc_2"); // what it contributed
  });
});
