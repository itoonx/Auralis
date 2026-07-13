// `pnpm brainstorm "<topic>"` (and the /brainstorm command / MCP tool) — spin up a multi-model panel,
// converge, synthesize, and LEARN the brief into the shared brain so every future session/worker recalls it.
// Panel = config runners.brainstorm (or AURALIS_BRAINSTORM_PANEL="gpt:gpt-5.5,glm:glm-4-plus,claude").
// Brainstorming is TOOL-LESS (thinking, not exploring) — so each panelist is a plain text-out runner.
import "./load-env"; // oracle secrets (.env.oracle) → the LEARN step authenticates to the live brain
// Billing keys (OPENAI_API_KEY, GLM_API_KEY…) live in .env, which tsx/Node does NOT auto-load — do it here
// so a `/brainstorm` panel authenticates out of the box. Shell env wins (loadEnvFile won't clobber it).
try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* no .env — key-less panelists error clearly */ }
// The Claude panelist runs on the Claude Code CLI login (the user's setup), NOT a stray ANTHROPIC_API_KEY —
// which is often a separate API account that may be out of credits. Drop it so the Agent SDK falls back to
// the CLI login. Opt back into the API key with AURALIS_BRAINSTORM_ANTHROPIC_API=1 (headless/CI, no CLI login).
if (process.env.AURALIS_BRAINSTORM_ANTHROPIC_API !== "1") delete process.env.ANTHROPIC_API_KEY;
import { brainstorm, positionOf, type Panelist } from "./brainstorm";
import { dialectic } from "./dialectic";
import { preflightPanel } from "./brainstorm-preflight";
import { parseSpec, keyFor, loadConfig, textRunnerFor, resolveRunnerSpec, type RunnerSpec } from "./runners";
import { OracleAdapter } from "./memory";
import { makeEmitter } from "./narrate";

const PROJECT = process.env.AURALIS_PROJECT ?? "default";

// A tool-less panelist from a spec — brainstorming is thinking, not exploring. One shared factory
// (runners.textRunnerFor) builds every pure-text role runner: panelists here, the M5 critic/reviewer there.
const panelist = (spec: RunnerSpec): Panelist => textRunnerFor(spec);

// Liveness/credit probe for preflight: Claude uses the CLI login (no pay-per-call balance risk), so it's
// assumed live and any auth issue surfaces in round 0. A paid provider must have a key AND answer a tiny
// call — a 429 "out of credits" / 401 throws HERE, before the real brainstorm spends anything.
async function liveProbe(spec: RunnerSpec): Promise<void> {
  if (spec.vendor === "claude") return;
  const key = keyFor(spec);
  if (!key.ok) throw new Error(`no key (${key.missing?.join(" / ")})`);
  await panelist(spec).run("Reply with the single word: ok"); // ponytail: no max_tokens yet — the terse prompt keeps it cheap
}

function panelSpecs(): { panel: RunnerSpec[]; synth: RunnerSpec } {
  const cfg = loadConfig();
  const rawPanel = (process.env.AURALIS_BRAINSTORM_PANEL?.split(",").map((s) => s.trim()).filter(Boolean)) ?? cfg.runners?.brainstorm ?? ["claude"];
  const panel = rawPanel.map(parseSpec);
  const synth = parseSpec(process.env.AURALIS_BRAINSTORM_SYNTH ?? cfg.brainstorm?.synthesizer ?? rawPanel[0]);
  return { panel, synth };
}

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  if (!topic) { console.error('usage: pnpm brainstorm "<topic or design question>"'); process.exit(1); }
  const rounds = Number(process.env.AURALIS_BRAINSTORM_ROUNDS ?? loadConfig().brainstorm?.rounds ?? 3);
  const { panel, synth } = panelSpecs();

  // Preflight — a paid provider with no key or no balance must not start work, and must not fail silently.
  console.error(`🔎 preflight — each paid provider needs a key + balance before we start:`);
  const pf = await preflightPanel(panel, synth, liveProbe, (l) => console.error(l));
  if (!pf.panel.length || !pf.synth) {
    console.error(`\n✗ no usable panelists — every provider failed preflight (keys / credits). Nothing to brainstorm.`);
    process.exit(1);
  }
  if (pf.excluded.length) console.error(`⚠ running without: ${pf.excluded.map((e) => e.name).join(", ")} — fix keys/credits to include them`);

  // M8 converge mode — the adversarial dialectic replaces the simultaneous panel. Opt-in until the
  // anti-theatre A/B gate passes (PRD rule: don't ship it as the default on vibes).
  const mode = process.env.AURALIS_BRAINSTORM_MODE ?? loadConfig().brainstorm?.mode ?? "panel";
  if (mode === "converge") return runConverge(topic, pf.panel, pf.synth);

  console.error(`🧠 brainstorm: ${pf.panel.map((s) => s.model ?? s.vendor).join(" · ")} → synth ${pf.synth.model ?? pf.synth.vendor} · ≤${rounds} rounds\n`);

  // Timeline wiring — the studio replays a brainstorm like any fleet run. Best-effort by construction
  // (makeEmitter swallows a dead oracle), so observability can never block or slow the debate.
  const brain = new OracleAdapter();
  const runId = `brainstorm-${Date.now().toString(36)}`;
  const emit = makeEmitter({ adapter: brain, runId, project: PROJECT });
  emit("prompt", "user", topic);
  pf.excluded.forEach((e) => emit("dropped", e.name, `${e.name} excluded at preflight — ${e.reason}`));

  const result = await brainstorm(topic, pf.panel.map(panelist), panelist(pf.synth), {
    rounds,
    onEvent: (kind, name, human) => {
      console.error(kind === "dropped" ? `  ⚠ ${human}` : `  ${human}`);
      emit(kind, name, human);
    },
  });

  // position.delta — who flipped their POSITION, at which round (the chart's spine, per the observability
  // design). Compares stance labels (vote text as fallback) so a reworded vote is not a flip.
  let flips = 0, lastRoundFlips = 0;
  for (let r = 1; r < result.rounds.length; r++) {
    for (const e of result.rounds[r]) {
      const prev = result.rounds[r - 1].find((p) => p.name === e.name);
      if (prev && positionOf(e) && positionOf(prev) && positionOf(prev) !== positionOf(e)) {
        flips++;
        if (r === result.rounds.length - 1) lastRoundFlips++;
        emit("flip", e.name, `${e.name} flipped (round ${r + 1}): "${(prev.stance || prev.vote).slice(0, 60)}" → "${(e.stance || e.vote).slice(0, 60)}"`);
      }
    }
  }

  // Trust badge — flip TIMING, not count (earned = flipped under challenge then settled; groupthink =
  // agreement that was never challenged; unstable = still churning at the cap).
  // ponytail: v1 heuristic, thresholds calibrate on real runs — the chart milestone owns tuning.
  const badge =
    pf.panel.length < 2 ? "solo (single panelist — no cross-examination)"
    : result.converged === "max-rounds" && lastRoundFlips > 0 ? "unstable — still flipping in the final round; debate never closed"
    : flips === 0 ? "groupthink? — converged with zero flips; agreement was never challenged"
    : "earned — flipped under challenge, then settled";
  emit("note", "trust", `trust: ${badge} (${flips} flip${flips === 1 ? "" : "s"}, ${result.converged}, ${result.roundsUsed} rounds)`);
  emit("answer", "synthesizer", `${result.converged} in ${result.roundsUsed} round(s) — ${result.synthesis.slice(0, 200)}`);
  console.error(`\n🎖 trust: ${badge}`);

  console.log(`\n${"═".repeat(70)}\n🧠 SYNTHESIS (${result.converged}, ${result.roundsUsed} round${result.roundsUsed > 1 ? "s" : ""})\n${"═".repeat(70)}\n${result.synthesis}\n`);
  if (result.dropped.length) console.error(`⚠ dropped (no contribution): ${result.dropped.join(", ")} — check their keys/credits`);

  // LEARN — "จนกว่าจะได้เรียนรู้": the brief becomes a recallable decision-style memory, project-scoped.
  if (process.env.AURALIS_BRAINSTORM_NO_LEARN !== "1") {
    try {
      const contributors = (result.rounds.at(-1) ?? []).map((e) => e.name); // who actually spoke, not who was configured
      const pattern =
        `Brainstorm decision — ${topic}\n` +
        `Panel: ${contributors.join(", ")}${result.dropped.length ? ` (dropped: ${result.dropped.join(", ")})` : ""} (${result.converged} in ${result.roundsUsed} rounds)\n` +
        `Best answer & rationale:\n${result.synthesis}`;
      const { id } = await brain.learn(pattern, { project: PROJECT, concepts: ["brainstorm", "decision"], source: "auralis:brainstorm", pinned: true });
      console.error(`✓ learned into the brain (${id}) — recallable in every future session`);
    } catch (e) { console.error(`⚠ brainstorm not saved (oracle unreachable): ${String(e).slice(0, 120)}`); }
  }
}

// M8 converge — propose → challenge → defend → judge → synthesize; the crystal (with its scar record)
// is LEARNED as PROVISIONAL. Judge: AURALIS_BRAINSTORM_JUDGE > config brainstorm.judge > reviewer role —
// preflighted like any paid provider; the engine aborts on a name collision (author ≠ challenger ≠ judge).
async function runConverge(topic: string, panelSpecList: RunnerSpec[], synthSpec: RunnerSpec) {
  const rawJudge = process.env.AURALIS_BRAINSTORM_JUDGE ?? loadConfig().brainstorm?.judge;
  const judgeSpec = rawJudge ? parseSpec(rawJudge) : resolveRunnerSpec("reviewer");
  const judgeName = judgeSpec.model ? `${judgeSpec.vendor}:${judgeSpec.model}` : judgeSpec.vendor;
  try { await liveProbe(judgeSpec); console.error(`  ✓ judge ${judgeName}`); } catch (e) {
    console.error(`✗ judge ${judgeName} failed preflight (${String((e as Error).message).slice(0, 100)}) — a dialectic cannot run unjudged.`);
    process.exit(1);
  }

  const brain = new OracleAdapter();
  const runId = `dialectic-${Date.now().toString(36)}`;
  const emit = makeEmitter({ adapter: brain, runId, project: PROJECT });
  emit("prompt", "user", topic);
  console.error(`⚔️ dialectic: ${panelSpecList.map((s) => s.model ?? s.vendor).join(" · ")} → judge ${judgeSpec.model ?? judgeSpec.vendor} → synth ${synthSpec.model ?? synthSpec.vendor}\n`);

  const res = await dialectic(topic, panelSpecList.map(panelist), panelist(judgeSpec), panelist(synthSpec), {
    onEvent: (kind, name, human) => {
      console.error(kind === "dropped" ? `  ⚠ ${human}` : `  ${human}`);
      emit(kind, name, human);
    },
  });

  console.error("");
  for (const c of res.crystals) console.error(`  🔹 [${c.id} ${c.author}] ${c.verdict}${c.scar.note ? ` — ${c.scar.note}` : ""}`);
  if (res.premiseAttack) console.error(`  🔻 premise risk (${res.premiseAttack.challenger}): ${res.premiseAttack.assumption.slice(0, 100)}`);
  console.log(`\n${"═".repeat(70)}\n⚔️ DIALECTIC ${res.allSunk ? "— ALL SUNK (no winner; do not build on this as settled)" : `— winner ${res.winner!.id} by ${res.winner!.author}`}\n${"═".repeat(70)}\n${res.synthesis}\n`);
  emit("answer", "synthesizer", `${res.allSunk ? "ALL SUNK" : `winner ${res.winner!.id} by ${res.winner!.author}`} · ${res.inconclusive} inconclusive — ${res.synthesis.slice(0, 200)}`);

  // LEARN the crystal WITH its scar record — the scar is the valuable part, and it is PROVISIONAL by
  // rule (v1: no anchor pool exists, nothing can be settled). Every provisional write is thus visible.
  if (process.env.AURALIS_BRAINSTORM_NO_LEARN !== "1") {
    try {
      const scarText = res.crystals.map((c) =>
        `[${c.id} by ${c.author} · ${c.verdict}] ${c.claim.slice(0, 120)}` +
        (c.scar.attack ? `\n  attack (${c.scar.attack.challenger}): ${c.scar.attack.failureScenario.slice(0, 150)}` : "") +
        (c.scar.defense ? `\n  defense: ${c.scar.defense.kind}` : "") +
        (c.scar.ruling ? `\n  ruling (${c.scar.ruling.judge}): ${c.scar.ruling.responsive ? "responsive" : "NOT responsive"} — ${c.scar.ruling.why.slice(0, 120)}` : "") +
        (c.scar.note ? `\n  note: ${c.scar.note}` : "")).join("\n");
      const pattern =
        `Dialectic decision (PROVISIONAL) — ${topic}\n` +
        (res.allSunk
          ? `ALL PROPOSALS SUNK — no survivor; the synthesis below is a new direction, not a settled answer.\n`
          : `Winner (by survivability): [${res.winner!.id} by ${res.winner!.author}] ${res.winner!.claim.slice(0, 300)}\n`) +
        `Scar record:\n${scarText}\n` +
        (res.premiseAttack ? `Premise risk: ${res.premiseAttack.assumption} — ${res.premiseAttack.whyFalse.slice(0, 200)}\n` : "") +
        `Synthesis:\n${res.synthesis}`;
      const { id } = await brain.learn(pattern, { project: PROJECT, concepts: ["dialectic", "decision", "provisional"], source: "auralis:dialectic", pinned: true });
      console.error(`✓ crystal learned (PROVISIONAL, scar attached) — ${id}`);
    } catch (e) { console.error(`⚠ crystal not saved (oracle unreachable): ${String(e).slice(0, 120)}`); }
  }
}

main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
