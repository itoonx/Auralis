// M8 — the dialectic engine (docs/prd-multi-runner.md): crystallize what SURVIVES attack, not what
// agrees. propose → challenge (non-author, must name a concrete failure scenario) → defend (rebut or
// concede) → judge (non-author, procedural: "did the defense answer the attack?") → synthesize.
// No voting; winner = survivability.
//
// Built to the v1 implementation contract, in order:
//  1. SCHEMA IS THE ENFORCEMENT POINT — verdict defaults to NOT_ANSWERED; a claim with no scar is
//     representable only as NOT_ANSWERED/INCONCLUSIVE, never as survived.
//  2. FAULT-TOLERANT STATE MACHINE — every stage call is timeout-bounded; a dead challenger/defender/
//     judge lands the crystal in terminal INCONCLUSIVE (→ provisional). Derangement (author ≠
//     challenger ≠ judge) is asserted up front and ABORTS when unsatisfiable — never relaxed silently.
//  3. PROVENANCE-CONSTRAINED SYNTHESIS — the synthesizer sees only crystals whose scar is complete
//     (verdict ≠ NOT_ANSWERED/INCONCLUSIVE); an unchallenged claim cannot be laundered in.
// v1 slices: ALL crystals provisional (no anchor pool yet) · reopen by user flag · staking not built.
import { extractObject, type Panelist } from "./brainstorm";

export type Verdict = "NOT_ANSWERED" | "SURVIVED" | "REFUTED" | "CONCEDED" | "INCONCLUSIVE";

export interface Attack { challenger: string; weakestPoint: string; failureScenario: string }
export interface Defense { kind: "rebut" | "concede"; body: string }
export interface Ruling { judge: string; responsive: boolean; why: string }
export interface Scar { attack?: Attack; defense?: Defense; ruling?: Ruling; note?: string } // note = why a stage is missing (timeout/error) — surfaced, never silent

export interface Crystal {
  id: string;
  author: string;
  claim: string;
  verdict: Verdict; // machine-branchable; only a complete scar chain can move it off NOT_ANSWERED
  scar: Scar;
  margin: number; // v1: 1 = survived, 0 = everything else (real margins arrive with the anchor pool)
  status: "provisional"; // v1: the anchor pool doesn't exist yet, so nothing can be "settled"
  groundedIn: string[]; // provenance edges (brain recall ids) — filled by the CLI wiring
}

export interface PremiseAttack { challenger: string; assumption: string; whyFalse: string }

export interface DialecticResult {
  topic: string;
  crystals: Crystal[];
  winner: Crystal | null;
  allSunk: boolean; // every crystal refuted/conceded/inconclusive — surfaced, never a silent least-bad pick
  premiseAttack: PremiseAttack | null;
  synthesis: string;
  inconclusive: number; // fault-model landings — counted, per the no-silent-fallback rule
}

export interface DialecticOpts {
  stageTimeoutMs?: number; // per role call (default 180s)
  onEvent?: (kind: string, name: string, human: string) => void;
}

// ---------- prompts ----------
const CHALLENGE = (topic: string, claim: string) =>
  `You are the CHALLENGER in an adversarial review. The problem:\n${topic}\n\nA colleague proposed:\n${claim}\n\n` +
  `Attack the SINGLE weakest point. You are told to REFUTE, not to give balanced feedback — and your attack ` +
  `is void unless it names a CONCRETE failure scenario (inputs/conditions → wrong outcome). If unsure, attack anyway.\n` +
  `Reply with JSON only: {"weakest_point":"...","failure_scenario":"concrete inputs/conditions -> wrong outcome"}`;

const DEFEND = (topic: string, claim: string, attack: Attack) =>
  `You are the AUTHOR of this proposal in an adversarial review. Problem:\n${topic}\n\nYour proposal:\n${claim}\n\n` +
  `A challenger attacked it:\n- weakest point: ${attack.weakestPoint}\n- failure scenario: ${attack.failureScenario}\n\n` +
  `Either REBUT the attack head-on (address the exact scenario) or CONCEDE if it is right — conceding an ` +
  `unfixable hit is respectable; a dodge is not.\nReply with JSON only: {"kind":"rebut"|"concede","body":"..."}`;

const JUDGE = (topic: string, claim: string, attack: Attack, defense: Defense) =>
  `You are the JUDGE in an adversarial review. Rule PROCEDURALLY — not on which idea you prefer, only on ` +
  `whether the defense actually ANSWERS the attack.\nProblem: ${topic}\nProposal: ${claim}\n` +
  `Attack: ${attack.weakestPoint} — ${attack.failureScenario}\nDefense (${defense.kind}): ${defense.body}\n\n` +
  `Non-responsive defenses (restating the proposal, answering a different attack, vague reassurance) must be ` +
  `ruled unresponsive.\nReply with JSON only: {"responsive":true|false,"why":"one line"}`;

const PREMISE = (topic: string) =>
  `You are the premise red-teamer in an adversarial review. Do NOT attack any proposal — attack the TASK ` +
  `ITSELF:\n${topic}\n\nWhat assumption baked into this problem statement is most likely FALSE, and why? ` +
  `A shared wrong premise makes every proposal wrong together.\n` +
  `Reply with JSON only: {"assumption":"...","why_false":"..."}`;

const SYNTH = (topic: string, admitted: Crystal[], premise: PremiseAttack | null, allSunk: boolean) =>
  `You are the synthesizer of an adversarial review. Problem: ${topic}\n\n` +
  `Crystals with COMPLETE scar records (attack → defense → ruling):\n` +
  admitted.map((c) => `[${c.id} by ${c.author} · ${c.verdict}] ${c.claim}\n  attack: ${c.scar.attack?.failureScenario ?? "-"}\n  defense(${c.scar.defense?.kind ?? "-"}): ${c.scar.defense?.body?.slice(0, 200) ?? "-"}\n  ruling: ${c.scar.ruling ? `${c.scar.ruling.responsive ? "responsive" : "NOT responsive"} — ${c.scar.ruling.why}` : "-"}`).join("\n\n") +
  (premise ? `\n\nPremise red-team (does the task itself rest on a false assumption?):\n- ${premise.assumption} — ${premise.whyFalse}` : "") +
  (allSunk ? `\n\nEVERY proposal was sunk or conceded. Do NOT crown a least-bad winner: synthesize a new direction from the parts that survived scrutiny, and say plainly that nothing survived intact.` : "") +
  `\n\nWrite the decision brief: what won and WHY (by survivability, citing the scars), what was refuted/conceded and what that teaches, the premise risk if any, and open risks. The scar record matters more than the conclusion.`;

// ---------- fault model ----------
const stage = async <T>(run: () => Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`stage timeout after ${ms}ms`)), ms); }),
    ]);
  } catch {
    return null; // caller records WHY in scar.note and lands the crystal in INCONCLUSIVE
  } finally {
    clearTimeout(timer);
  }
};

// Synthesis admission gate — exported so the invariant is TESTABLE (contract #3): only complete scars pass.
export const admissible = (c: Crystal): boolean =>
  c.verdict !== "NOT_ANSWERED" && c.verdict !== "INCONCLUSIVE" && !!c.scar.attack && !!c.scar.defense &&
  (c.verdict === "CONCEDED" || !!c.scar.ruling); // a concession is a complete scar without a ruling

export async function dialectic(topic: string, panel: Panelist[], judge: Panelist, synthesizer: Panelist, opts: DialecticOpts = {}): Promise<DialecticResult> {
  const ms = opts.stageTimeoutMs ?? 180_000;
  const ev = opts.onEvent;

  // Contract #2: derangement is a PRECONDITION, asserted before any model call — abort, never relax.
  if (panel.length < 2) throw new Error("dialectic needs ≥2 panelists (a non-author must exist to challenge each proposal)");
  const names = new Set(panel.map((p) => p.name));
  if (names.size !== panel.length) throw new Error("dialectic panelist names must be distinct (derangement is name-based)");
  if (names.has(judge.name)) throw new Error(`judge "${judge.name}" collides with a panelist — author ≠ challenger ≠ judge is unsatisfiable`);

  // PROPOSE — parallel, independent (anti-anchoring). A dead proposer simply fields no crystal.
  ev?.("phase", "panel", `propose · ${panel.length} independent proposals`);
  const proposals = (await Promise.all(panel.map(async (p, i) => {
    const text = await stage(() => p.run(
      `You are on an adversarial review panel. Problem:\n${topic}\n\nGive your BEST concrete proposal — take a position; it will be attacked by a colleague. Reply with the proposal text only.`), ms);
    if (text == null) { ev?.("dropped", p.name, `${p.name} failed to propose`); return null; }
    ev?.("finding", p.name, `${p.name}: ${text.slice(0, 90)}`);
    return { id: `c${i + 1}`, author: p.name, claim: text.trim() };
  }))).filter(Boolean) as { id: string; author: string; claim: string }[];
  if (!proposals.length) throw new Error("every panelist failed to propose (check keys/credits)");

  // Crystals start at the schema's safe default — contract #1: no scar ⇒ NOT_ANSWERED.
  const crystals: Crystal[] = proposals.map((p) => ({ ...p, verdict: "NOT_ANSWERED" as Verdict, scar: {} as Scar, margin: 0, status: "provisional" as const, groundedIn: [] }));

  // CHALLENGE → DEFEND → JUDGE per crystal, all crystals in parallel. Challenger = next surviving
  // proposer round-robin (never the author — requires ≥2 surviving proposers; a lone survivor cannot
  // be cross-examined and stays INCONCLUSIVE, per the abort-don't-relax rule).
  const byName = new Map(panel.map((p) => [p.name, p]));
  const authors = proposals.map((p) => p.author);
  ev?.("phase", "panel", `challenge → defend → judge · ${crystals.length} crystal(s)`);
  await Promise.all(crystals.map(async (c, i) => {
    if (proposals.length < 2) { c.verdict = "INCONCLUSIVE"; c.scar.note = "no non-author challenger available (single surviving proposer)"; return; }
    const challenger = byName.get(authors[(i + 1) % authors.length])!;
    const author = byName.get(c.author)!;

    const atkText = await stage(() => challenger.run(CHALLENGE(topic, c.claim)), ms);
    const atk = atkText != null ? extractObject(atkText) : null;
    if (!atk?.failure_scenario && !atk?.weakest_point) { c.verdict = "INCONCLUSIVE"; c.scar.note = `challenge missing (${challenger.name} died or gave no concrete failure scenario)`; ev?.("dropped", challenger.name, `${c.id}: challenge missing → INCONCLUSIVE`); return; }
    c.scar.attack = { challenger: challenger.name, weakestPoint: String(atk.weakest_point ?? "").slice(0, 300), failureScenario: String(atk.failure_scenario ?? "").slice(0, 500) };
    ev?.("finding", challenger.name, `${c.id} attacked: ${c.scar.attack.failureScenario.slice(0, 80)}`);

    const defText = await stage(() => author.run(DEFEND(topic, c.claim, c.scar.attack!)), ms);
    const def = defText != null ? extractObject(defText) : null;
    if (!def?.kind) { c.verdict = "INCONCLUSIVE"; c.scar.note = "defense missing (author died mid-debate)"; return; }
    c.scar.defense = { kind: def.kind === "concede" ? "concede" : "rebut", body: String(def.body ?? "").slice(0, 1000) };
    if (c.scar.defense.kind === "concede") { c.verdict = "CONCEDED"; ev?.("finding", c.author, `${c.id} conceded`); return; }

    const rulText = await stage(() => judge.run(JUDGE(topic, c.claim, c.scar.attack!, c.scar.defense!)), ms);
    const rul = rulText != null ? extractObject(rulText) : null;
    if (rul == null || typeof rul.responsive !== "boolean") { c.verdict = "INCONCLUSIVE"; c.scar.note = "ruling missing (judge died or gave no verdict)"; return; }
    c.scar.ruling = { judge: judge.name, responsive: rul.responsive, why: String(rul.why ?? "").slice(0, 300) };
    c.verdict = rul.responsive ? "SURVIVED" : "REFUTED";
    c.margin = rul.responsive ? 1 : 0;
    ev?.("finding", judge.name, `${c.id} ${c.verdict}: ${c.scar.ruling.why.slice(0, 80)}`);
  }));

  // PREMISE red-team — one panelist attacks the task itself (a shared wrong premise sinks everyone).
  const premisePanelist = panel[panel.length - 1];
  const preText = await stage(() => premisePanelist.run(PREMISE(topic)), ms);
  const pre = preText != null ? extractObject(preText) : null;
  const premiseAttack: PremiseAttack | null = pre?.assumption
    ? { challenger: premisePanelist.name, assumption: String(pre.assumption).slice(0, 300), whyFalse: String(pre.why_false ?? "").slice(0, 500) }
    : null;
  if (premiseAttack) ev?.("finding", premisePanelist.name, `premise: ${premiseAttack.assumption.slice(0, 80)}`);

  // SYNTHESIZE — contract #3: only complete scars are admitted; NOT_ANSWERED/INCONCLUSIVE cannot be laundered.
  const admitted = crystals.filter(admissible);
  const winner = admitted.filter((c) => c.verdict === "SURVIVED").sort((a, b) => b.margin - a.margin)[0] ?? null;
  const allSunk = winner == null;
  const inconclusive = crystals.filter((c) => c.verdict === "INCONCLUSIVE" || c.verdict === "NOT_ANSWERED").length;
  ev?.("phase", "synthesizer", `synthesizing · ${admitted.length}/${crystals.length} admitted${allSunk ? " · ALL SUNK" : ""}${inconclusive ? ` · ${inconclusive} inconclusive` : ""}`);
  const synthesis = (await stage(() => synthesizer.run(SYNTH(topic, admitted, premiseAttack, allSunk)), ms)) ?? "(synthesis failed — provider error; the scar records above still stand)";

  return { topic, crystals, winner, allSunk, premiseAttack, synthesis: synthesis.trim(), inconclusive };
}
