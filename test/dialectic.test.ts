// M8 — the dialectic engine against its v1 implementation contract: schema default, fault-tolerant
// state machine, provenance-constrained synthesis. Scripted panelists, no LLM.
import { describe, it, expect } from "vitest";
import { dialectic, admissible, type Crystal } from "../src/dialectic";
import type { Panelist } from "../src/brainstorm";

// Routes by stage: propose/challenge/defend/judge/premise prompts are distinguishable by their headers.
const roleplay = (name: string, script: { propose?: string; challenge?: string; defend?: string; premise?: string }): Panelist => ({
  name,
  run: async (prompt: string) => {
    if (prompt.includes("You are the CHALLENGER")) return script.challenge ?? '{"weakest_point":"wp","failure_scenario":"input X -> wrong Y"}';
    if (prompt.includes("You are the AUTHOR")) return script.defend ?? '{"kind":"rebut","body":"the scenario is handled by Z"}';
    if (prompt.includes("premise red-teamer")) return script.premise ?? '{"assumption":"a","why_false":"b"}';
    return script.propose ?? `${name}'s proposal`;
  },
});
const judgeOf = (name: string, responsive: boolean | "dead"): Panelist => ({
  name,
  run: async () => {
    if (responsive === "dead") throw new Error("529 overloaded");
    return JSON.stringify({ responsive, why: responsive ? "answers the exact scenario" : "restates the proposal" });
  },
});
const synth = (): { p: Panelist; prompts: string[] } => {
  const prompts: string[] = [];
  return { prompts, p: { name: "synth", run: async (prompt) => { prompts.push(prompt); return "brief"; } } };
};

describe("dialectic engine (M8 v1 contract)", () => {
  it("happy path: rebut + responsive ruling → SURVIVED with a complete scar; winner picked", async () => {
    const s = synth();
    const res = await dialectic("q", [roleplay("a", {}), roleplay("b", {})], judgeOf("j", true), s.p);
    expect(res.crystals.every((c) => c.verdict === "SURVIVED")).toBe(true);
    expect(res.winner?.scar.attack?.challenger).not.toBe(res.winner?.author); // derangement held
    expect(res.winner?.scar.ruling?.judge).toBe("j");
    expect(res.allSunk).toBe(false);
    expect(res.premiseAttack?.assumption).toBe("a");
  });

  it("concede → CONCEDED, complete scar without a ruling, not a winner", async () => {
    const s = synth();
    const res = await dialectic("q", [roleplay("a", { defend: '{"kind":"concede","body":"the attack is right"}' }), roleplay("b", { defend: '{"kind":"concede","body":"agreed"}' })], judgeOf("j", true), s.p);
    expect(res.crystals.every((c) => c.verdict === "CONCEDED")).toBe(true);
    expect(res.allSunk).toBe(true); // nothing survived — flagged, no least-bad winner
    expect(res.crystals.every(admissible)).toBe(true); // a concession is a COMPLETE scar — admitted with its lesson
  });

  it("non-responsive defense → REFUTED by the procedural judge", async () => {
    const s = synth();
    const res = await dialectic("q", [roleplay("a", {}), roleplay("b", {})], judgeOf("j", false), s.p);
    expect(res.crystals.every((c) => c.verdict === "REFUTED")).toBe(true);
    expect(res.allSunk).toBe(true);
  });

  it("FAULT MODEL: dead judge → INCONCLUSIVE, never 'survived a challenge it never received'", async () => {
    const s = synth();
    const res = await dialectic("q", [roleplay("a", {}), roleplay("b", {})], judgeOf("j", "dead"), s.p);
    expect(res.crystals.every((c) => c.verdict === "INCONCLUSIVE")).toBe(true);
    expect(res.crystals.every((c) => c.scar.note?.includes("ruling missing"))).toBe(true); // WHY is recorded
    expect(res.inconclusive).toBe(2); // counted, not silent
  });

  it("FAULT MODEL: challenger that names no concrete failure scenario → INCONCLUSIVE", async () => {
    const s = synth();
    const bad = roleplay("b", { challenge: "I think it looks fine overall" }); // void attack (no JSON scenario)
    const res = await dialectic("q", [roleplay("a", {}), bad], judgeOf("j", true), s.p);
    const aCrystal = res.crystals.find((c) => c.author === "a")!; // attacked by b's void challenge
    expect(aCrystal.verdict).toBe("INCONCLUSIVE");
  });

  it("SYNTH GATE (contract #3): an INCONCLUSIVE claim never reaches the synthesizer prompt", async () => {
    const s = synth();
    const bad = roleplay("b", { challenge: "no json here", propose: "PROPOSAL-B-UNIQUE-TEXT" });
    const res = await dialectic("q", [roleplay("a", { propose: "PROPOSAL-A-UNIQUE-TEXT" }), bad], judgeOf("j", true), s.p);
    const aCrystal = res.crystals.find((c) => c.author === "a")!;
    expect(aCrystal.verdict).toBe("INCONCLUSIVE"); // b's void attack left A unchallenged
    expect(s.prompts[0]).not.toContain("PROPOSAL-A-UNIQUE-TEXT"); // hard-rejected — not laundered
    expect(s.prompts[0]).toContain("PROPOSAL-B-UNIQUE-TEXT"); // b WAS properly challenged by a → admitted
  });

  it("DERANGEMENT precondition: judge colliding with a panelist ABORTS before any model call", async () => {
    const s = synth();
    await expect(dialectic("q", [roleplay("a", {}), roleplay("b", {})], judgeOf("a", true), s.p)).rejects.toThrow(/collides/);
    await expect(dialectic("q", [roleplay("a", {})], judgeOf("j", true), s.p)).rejects.toThrow(/2 panelists/);
    await expect(dialectic("q", [roleplay("a", {}), roleplay("a", {})], judgeOf("j", true), s.p)).rejects.toThrow(/distinct/);
  });

  it("FAULT MODEL: stage timeout lands INCONCLUSIVE instead of hanging the debate", async () => {
    const s = synth();
    const hang: Panelist = { name: "b", run: (prompt) => prompt.includes("CHALLENGER") ? new Promise(() => {}) : Promise.resolve("b's proposal") };
    const res = await dialectic("q", [roleplay("a", {}), hang], judgeOf("j", true), s.p, { stageTimeoutMs: 50 });
    const aCrystal = res.crystals.find((c) => c.author === "a")!; // its challenger (b) hung
    expect(aCrystal.verdict).toBe("INCONCLUSIVE");
  }, 10_000);
});
