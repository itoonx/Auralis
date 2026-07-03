// The brain MCP tools (worker-direct pull/push) proxy correctly to the adapter.
import { describe, it, expect } from "vitest";
import { brainSearch, brainLearn } from "../src/brain-mcp";
import type { MemoryAdapter, SearchHit } from "../src/memory";

class FakeAdapter implements MemoryAdapter {
  private docs: { id: string; content: string }[] = [];
  private n = 0;
  async search(q: string): Promise<SearchHit[]> {
    const w = q.toLowerCase().split(/\W+/).filter((x) => x.length > 2);
    return this.docs.filter((d) => w.some((x) => d.content.toLowerCase().includes(x))).map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(p: string): Promise<{ id: string }> {
    const id = `doc_${++this.n}`;
    this.docs.push({ id, content: p });
    return { id };
  }
}

describe("brain MCP tools", () => {
  it("learn then search round-trips through the adapter", async () => {
    const a = new FakeAdapter();
    const saved = await brainLearn(a, "p", "the signing flow lives in signer.ts");
    expect(saved).toContain("doc_1");
    const found = await brainSearch(a, "p", "where is the signing flow");
    expect(found).toContain("signer.ts");
  });

  it("search returns a friendly message when the brain is empty", async () => {
    const found = await brainSearch(new FakeAdapter(), "p", "anything");
    expect(found.toLowerCase()).toContain("nothing in the shared brain");
  });
});
