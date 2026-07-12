// Preflight decision logic — a broke/keyless provider must be dropped before round 0, loudly, and the run
// must abort if nobody is left. Fake probe, no network.
import { describe, it, expect } from "vitest";
import { preflightPanel, label } from "../src/brainstorm-preflight";
import type { RunnerSpec } from "../src/runners";

const spec = (vendor: RunnerSpec["vendor"], model?: string): RunnerSpec => ({ vendor, model });

describe("brainstorm preflight", () => {
  it("drops a broke provider LOUDLY and keeps the survivors", async () => {
    const lines: string[] = [];
    const probe = async (s: RunnerSpec) => { if (s.vendor === "glm") throw new Error("429 out of credits"); };
    const pf = await preflightPanel([spec("claude"), spec("gpt"), spec("glm")], spec("claude"), probe, (l) => lines.push(l));
    expect(pf.panel.map(label)).toEqual(["claude", "gpt"]);
    expect(pf.excluded).toEqual([{ name: "glm", reason: "429 out of credits" }]);
    expect(lines.some((l) => l.includes("✗ glm"))).toBe(true); // surfaced, not silent
  });

  it("resolves synth to a live provider when the configured synth is broke", async () => {
    const probe = async (s: RunnerSpec) => { if (s.vendor === "glm") throw new Error("no money"); };
    const pf = await preflightPanel([spec("gpt")], spec("glm"), probe, () => {});
    expect(pf.synth && label(pf.synth)).toBe("gpt"); // fell back to the ready panelist
  });

  it("returns empty panel + null synth when EVERYONE fails (caller must abort)", async () => {
    const probe = async () => { throw new Error("dead"); };
    const pf = await preflightPanel([spec("gpt"), spec("glm")], spec("gpt"), probe, () => {});
    expect(pf.panel).toEqual([]);
    expect(pf.synth).toBeNull();
  });

  it("probes each DISTINCT provider once, even if it is both a panelist and the synth", async () => {
    let calls = 0;
    const probe = async () => { calls++; };
    await preflightPanel([spec("gpt"), spec("claude")], spec("gpt"), probe, () => {});
    expect(calls).toBe(2); // gpt (panel == synth, deduped) + claude
  });
});
