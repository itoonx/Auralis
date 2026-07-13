// M5 — the Reviewer role: verdict parsing, fail-open behavior, and the unactionable-rejection rule.
// Scripted runner, no LLM/network.
import { describe, it, expect } from "vitest";
import { reviewBuild } from "../src/reviewer";
import type { AgentRunner, RunResult } from "../src/runner";

const scripted = (reply: string | Error): AgentRunner => ({
  async run(): Promise<RunResult> {
    if (reply instanceof Error) throw reply;
    return { result: reply, explored: [] };
  },
});

describe("reviewer (M5)", () => {
  it("concrete findings → not ok, findings carried for the rework prompt", async () => {
    const v = await reviewBuild(scripted('{"ok":false,"findings":["api.ts: divide() returns NaN when b=0 — no guard","store.ts: TTL never expires entries"]}'), "s");
    expect(v.ok).toBe(false);
    expect(v.findings).toHaveLength(2);
    expect(v.findings[0]).toContain("divide");
  });

  it("clean review → ok, no findings", async () => {
    const v = await reviewBuild(scripted('All good.\n```json\n{"ok":true,"findings":[]}\n```'), "s");
    expect(v).toEqual({ ok: true, findings: [], note: "" });
  });

  it("'not ok' WITHOUT concrete findings is unactionable → passes but says so (never silent)", async () => {
    const v = await reviewBuild(scripted('{"ok":false,"findings":[]}'), "s", "reviewer:gpt");
    expect(v.ok).toBe(true);
    expect(v.note).toContain("without concrete findings");
  });

  it("unparseable verdict → fail-open with a named note", async () => {
    const v = await reviewBuild(scripted("looks fine to me overall"), "s");
    expect(v.ok).toBe(true);
    expect(v.note).toContain("unparseable");
  });

  it("provider outage → fail-open with the error named — a dead reviewer never blocks a build", async () => {
    const v = await reviewBuild(scripted(new Error("529 overloaded")), "s", "reviewer:claude");
    expect(v.ok).toBe(true);
    expect(v.note).toContain("529");
  });
});
