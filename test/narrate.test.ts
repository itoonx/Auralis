// The timeline emitter is deterministic and best-effort: templated human lines, and a run must never fail
// because the ledger did. These pin the mechanics without a network or an LLM.
import { describe, it, expect } from "vitest";
import { format, makeEmitter, scorecard } from "../src/narrate";
import type { MemoryAdapter, TimelineEvent } from "../src/memory";

describe("timeline narration", () => {
  it("format prefixes each kind's glyph (with a fallback)", () => {
    expect(format("intent", "A starting: x")).toBe("▸ A starting: x");
    expect(format("dedup", "B skipped y")).toBe("⇄ B skipped y");
    expect(format("finding", "A done")).toBe("✓ A done");
    expect(format("mystery", "z")).toBe("· z");
  });

  it("emit records a well-formed, glyph-prefixed event through the adapter", async () => {
    const got: TimelineEvent[] = [];
    const adapter = { recordEvent: async (e: TimelineEvent) => void got.push(e) } as unknown as MemoryAdapter;
    const emit = makeEmitter({ adapter, runId: "p:shared:t", project: "p" });
    emit("intent", "A", "A starting: auth", { nodeId: "A", parentNode: ["root"], refs: ["a.ts"] });
    await Promise.resolve();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      runId: "p:shared:t",
      project: "p",
      kind: "intent",
      actor: "A",
      human: "▸ A starting: auth",
      nodeId: "A",
      parentNode: ["root"],
      refs: ["a.ts"],
    });
  });

  it("is best-effort: a throwing adapter never throws into the caller", async () => {
    const adapter = { recordEvent: async () => { throw new Error("oracle down"); } } as unknown as MemoryAdapter;
    const emit = makeEmitter({ adapter, runId: "r", project: "p" });
    expect(() => emit("finding", "A", "done")).not.toThrow();
    await Promise.resolve();
  });

  it("tolerates a null-control adapter with no recordEvent", () => {
    const emit = makeEmitter({ adapter: {} as MemoryAdapter, runId: "r", project: "p" });
    expect(() => emit("phase", "conductor", "level 1")).not.toThrow();
  });

  it("scorecard counts kinds and distinct tasks", () => {
    const evs: TimelineEvent[] = [
      { kind: "intent", actor: "A", human: "", nodeId: "A" },
      { kind: "finding", actor: "A", human: "", nodeId: "A" },
      { kind: "dedup", actor: "B", human: "", nodeId: "B" },
      { kind: "overlap", actor: "sentry", human: "" },
      { kind: "note", actor: "A", human: "", nodeId: "A" },
      { kind: "repair", actor: "B", human: "", nodeId: "B" },
    ];
    expect(scorecard(evs)).toEqual({ tasks: 2, deduped: 1, overlaps: 1, repairs: 1, notes: 1 });
  });
});
