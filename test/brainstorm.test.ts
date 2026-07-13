// M6 — the brainstorm engine: convergence rules, tolerant parsing, event stream. Scripted panelists, no LLM.
import { describe, it, expect } from "vitest";
import { brainstorm, parseEntry, trustBadge, type Panelist } from "../src/brainstorm";

// A panelist that returns a queue of scripted replies (JSON strings), one per call.
const scripted = (name: string, replies: string[]): Panelist => {
  let i = 0;
  return { name, run: async () => replies[Math.min(i++, replies.length - 1)] };
};
const J = (idea: string, vote: string, stance?: string) => JSON.stringify({ idea, vote, ...(stance ? { stance } : {}) });

describe("brainstorm engine (M6)", () => {
  it("parseEntry: JSON, fenced JSON, alt keys, and plain-text fallback", () => {
    expect(parseEntry("a", J("use bge", "bge")).vote).toBe("bge");
    expect(parseEntry("a", '```json\n{"idea_revision":"x","vote":"y"}\n```').idea).toBe("x");
    expect(parseEntry("a", "no json here, just prose")).toEqual({ name: "a", idea: "no json here, just prose", critiques: [], vote: "", stance: "" });
    expect(parseEntry("a", J("x", "spaces everywhere", "spaces")).stance).toBe("spaces");
    expect(parseEntry("a", JSON.stringify({ idea: "z", critiques: [{ of: "b", point: "slow" }], vote: "z" })).critiques).toEqual(["b: slow"]);
  });

  it("converges on VOTE-STABLE: two consecutive rounds with the same votes stop early", async () => {
    const panel = [
      scripted("m1", [J("idea A", "A"), J("idea A refined", "A"), J("A", "A")]),
      scripted("m2", [J("idea B", "B"), J("agree", "A"), J("agree", "A")]), // flips to A in round 2
    ];
    const res = await brainstorm("A or B?", panel, scripted("s", ["A wins because …"]), { rounds: 5 });
    expect(res.converged).toBe("vote-stable");
    expect(res.roundsUsed).toBe(3); // r1 {A,B}, r2 {A,A}, r3 {A,A} == r2 → stop
    expect(res.synthesis).toContain("A wins");
  });

  it("converges on NO-CHANGE: identical ideas two rounds running", async () => {
    const same = J("keep it simple", "simple");
    const res = await brainstorm("how?", [scripted("m1", [same, same]), scripted("m2", [J("other", "other"), J("other", "other")])], scripted("s", ["brief"]), { rounds: 4 });
    expect(res.converged).toBe("no-change");
    expect(res.roundsUsed).toBe(2);
  });

  it("hits MAX-ROUNDS when the panel keeps churning", async () => {
    const churn = (n: string) => scripted(n, [J(`${n}1`, `${n}1`), J(`${n}2`, `${n}2`), J(`${n}3`, `${n}3`)]);
    const res = await brainstorm("q", [churn("m1"), churn("m2")], scripted("s", ["brief"]), { rounds: 3 });
    expect(res.converged).toBe("max-rounds");
    expect(res.roundsUsed).toBe(3);
    expect(res.rounds).toHaveLength(3);
  });

  it("emits a timeline event per phase and per panelist finding", async () => {
    const events: string[] = [];
    await brainstorm("q", [scripted("m1", [J("x", "x")]), scripted("m2", [J("x", "x")])], scripted("s", ["b"]), {
      rounds: 1,
      onEvent: (kind, name) => events.push(`${kind}:${name}`),
    });
    expect(events).toContain("phase:panel");
    expect(events).toContain("finding:m1");
    expect(events).toContain("finding:m2");
    expect(events).toContain("phase:synthesizer");
  });

  it("single panelist is allowed; empty panel throws", async () => {
    const res = await brainstorm("q", [scripted("solo", [J("idea", "v")])], scripted("s", ["brief"]), { rounds: 2 });
    expect(res.roundsUsed).toBe(2); // solo repeats its reply → round 2 == round 1 → no-change
    await expect(brainstorm("q", [], scripted("s", ["b"]))).rejects.toThrow(/at least one/);
  });

  it("stance labels: a REWORDED vote with the same stance is not a flip — converges vote-stable", async () => {
    // Both models keep stance "spaces" while rewording BOTH idea and vote every round (the live
    // false-flip case) — only the stance label says the position never moved.
    const m1 = scripted("m1", [J("2-space indent", "Spaces, 2 per indent", "spaces"), J("prettier default indent", "Spaces (2), enforced by Prettier", "spaces"), J("x", "spaces via CI", "spaces")]);
    const m2 = scripted("m2", [J("use spaces", "spaces everywhere", "spaces"), J("spaces with editorconfig", "spaces, prettier default", "spaces"), J("y", "spaces final", "spaces")]);
    const res = await brainstorm("tabs or spaces?", [m1, m2], scripted("s", ["brief"]), { rounds: 4 });
    expect(res.converged).toBe("vote-stable"); // stance stable round 1→2 despite new vote text every round
    expect(res.roundsUsed).toBe(2);
  });

  it("trust badge v2: unanimous-independent ≠ groupthink; zero-flip non-convergence = stalemate", () => {
    const base = { panelSize: 2, flips: 0, lastRoundFlips: 0 } as const;
    // nobody moved AND it converged → start-to-finish agreement (structural — never cross-model strings)
    expect(trustBadge({ ...base, converged: "vote-stable" })).toContain("unanimous-independent");
    // nobody moved AND it never converged → a non-result, distrust
    expect(trustBadge({ ...base, converged: "max-rounds" })).toContain("stalemate");
    // flipped early then settled → earned
    expect(trustBadge({ panelSize: 2, flips: 1, lastRoundFlips: 0, converged: "vote-stable" })).toContain("earned");
    // still churning at the cap → unstable
    expect(trustBadge({ panelSize: 2, flips: 2, lastRoundFlips: 1, converged: "max-rounds" })).toContain("unstable");
    expect(trustBadge({ panelSize: 1, flips: 0, lastRoundFlips: 0, converged: "no-change" })).toContain("solo");
  });

  const failing = (name: string): Panelist => ({ name, run: async () => { throw new Error("boom 429 no credits"); } });

  it("survives a failing panelist: survivors carry on, the drop is recorded (not silent)", async () => {
    const res = await brainstorm("q", [scripted("m1", [J("a", "a"), J("a", "a")]), failing("bad")], scripted("s", ["brief"]), { rounds: 2 });
    expect(res.dropped).toContain("bad");
    expect(res.rounds[0].map((e) => e.name)).toEqual(["m1"]); // only the survivor is on the board
    expect(res.synthesis).toContain("brief");
  });

  it("throws only when EVERY panelist fails round 0", async () => {
    await expect(brainstorm("q", [failing("a"), failing("b")], scripted("s", ["x"]))).rejects.toThrow(/every panelist failed/);
  });
});
