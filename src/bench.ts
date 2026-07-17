// Multi-trial benchmark: run the baseline-vs-shared fleet N times over a FIXED task set, resetting the
// brain between trials, and report the DISTRIBUTION — mean, min, max, sample sd — instead of a single
// noisy number. Turns "directional" into "robust".
//
// What this gate measures (audited 2026-07-17): ONCE-AT-START INJECTION sharing only — cfg passes no
// workerPull/claims, so the live-pull machinery run.ts ships by default is NOT exercised here.
// Per-arm timing (worker.run share of wall) is captured so the "LLM is ~all of wall-clock" claim carries
// a distribution too; the share is only meaningful at parallel=1 (spans overlap otherwise).
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { OracleAdapter, NullMemoryAdapter, type MemoryAdapter } from "./memory";
import { ensureOracle, resolveTasks, runFleet } from "./fleet";
import { fleetRedundantCount, reductionPct } from "./metrics";
import { log, type SpanRecord } from "./log";

// Billing keys (OPENAI_API_KEY…) for the configured LLM critic live in .env — tsx does NOT auto-load it.
// Shell env wins (loadEnvFile won't clobber). Deliberately NOT .env.oracle: the scratch oracle stays auth-free.
try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); } catch { /* no .env — key-less critics error clearly */ }

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const PROJECT = process.env.AURALIS_PROJECT ?? "bench";
const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 8);
const PLAN_TURNS = Number(process.env.AURALIS_PLAN_TURNS ?? 5);
const CONCURRENCY = Number(process.env.AURALIS_PARALLEL ?? 1);
const TRIALS = Math.max(1, Number(process.env.AURALIS_TRIALS ?? 1));
const GOAL = process.env.AURALIS_GOAL; // unset → pinned task file (see main); set → LLM-planned, non-comparable across invocations

function stats(xs: number[]) {
  const n = xs.length || 1;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  // Sample sd (n-1): the honest spread for small n. At n=1 there IS no spread — report null, never a fake 0.
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : null;
  return { mean, min: Math.min(...xs), max: Math.max(...xs), stddev: sd, n: xs.length };
}

const fmtStats = (s: ReturnType<typeof stats>, unit = "") =>
  `mean ${s.mean.toFixed(1)}${unit} · min ${s.min.toFixed(1)}${unit} · max ${s.max.toFixed(1)}${unit} · sd ${s.stddev === null ? "n/a (n=1)" : s.stddev.toFixed(1)}`;

function phaseTotals(spans: SpanRecord[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const s of spans) t[s.name] = (t[s.name] ?? 0) + s.ms;
  return t;
}

async function main() {
  // Isolate the bench onto a THROWAWAY oracle — it wipes the brain every trial and must NEVER touch the
  // human's prod brain. HARD-SET, not ??= (audit 2026-07-17): inherited shell exports of ORACLE_PORT/
  // ORACLE_API_URL silently retargeted the whole bench at the prod daemon on 47778.
  process.env.ORACLE_PORT = "47797";
  process.env.ORACLE_DB = ".auralis-out/bench-brain.sqlite";
  process.env.ORACLE_API_URL = "http://localhost:47797";
  process.env.ORACLE_ALLOW_RESET = "1"; // let the sidecar wipe the (scratch) brain between trials
  // Exclusive scratch oracle or nothing: ensureOracle would silently ATTACH to anything already serving
  // 47797 (a concurrent bench or a stale sidecar) and the two runs would cross-wipe each other's brains
  // mid-arm — clean-looking, silently wrong numbers in both. Die loudly instead (review 2026-07-17).
  try {
    const r = await fetch("http://localhost:47797/health", { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      console.error("✗ something already serves :47797 (another bench? stale sidecar?) — benches need an exclusive scratch oracle.\n  kill it first: lsof -ti :47797 | xargs kill");
      process.exit(1);
    }
  } catch { /* unreachable = good, we spawn our own */ }
  // Pin the task set unless the caller explicitly benches a custom goal: an LLM-planned set differs per
  // invocation, so unpinned runs are different instruments and their deltas are meaningless. Absolute
  // path — fleet reads it with readFileSync, which must not depend on the caller's cwd.
  if (!GOAL) process.env.AURALIS_TASKS ??= resolve(dirname(fileURLToPath(import.meta.url)), "../benchmarks/core.json");
  const taskSource = process.env.AURALIS_TASKS ?? `goal: ${GOAL}`;
  console.log(`bench: project=${PROJECT_DIR} · trials=${TRIALS} · parallel=${CONCURRENCY} · tasks=${taskSource}`);
  if (TRIALS === 1) console.warn("⚠ n=1 — spread unmeasured; set AURALIS_TRIALS>=3 before quoting this number");
  rmSync(`${OUT}/bench-summary.json`, { force: true }); // a crash must not leave the PREVIOUS run's summary looking current
  const stop = await ensureOracle();
  try {
    const nodes = await resolveTasks(PROJECT_DIR, GOAL ?? "Understand this codebase end-to-end: architecture, core modules, primary flow, and error handling.", PLAN_TURNS);
    console.log(`${nodes.length} task(s): ${nodes.map((n) => n.id).join(", ")}`);
    if (nodes.length < 2)
      console.warn("⚠ single-task fleet has ZERO structural redundancy — reduction will read 0% regardless of the brain (planner parse fallback?)");
    const cfg = { projectDir: PROJECT_DIR, project: PROJECT, maxTurns: MAX_TURNS, concurrency: CONCURRENCY };
    const brain = new OracleAdapter();
    const READ_ONLY = new Set(["Read"]);
    const perTrial: Record<string, unknown>[] = [];
    const series = { reductionAll: [] as number[], reductionRead: [] as number[], llmShare: [] as number[], reuses: [] as number[] };
    let rejectedTotal = 0;

    // One arm = one fleet run with its own timing sink; worker.run total / wall = the LLM share.
    const runArm = async (name: string, adapter: MemoryAdapter, t: number, tag: string) => {
      log.reset(`${OUT}/bench-timing-${t}-${tag}.jsonl`); // artifact survives the run — evidence behind the number
      const t0 = performance.now();
      const r = await runFleet(name, adapter, nodes, cfg);
      const wallMs = performance.now() - t0;
      const phases = phaseTotals(log.spans);
      return { outcome: r.outcome, wallMs, workerMs: phases["worker.run"] ?? 0, phases };
    };

    for (let t = 1; t <= TRIALS; t++) {
      await brain.reset!(); // each trial starts from an empty brain
      const base = await runArm(`bench-base-${t}`, new NullMemoryAdapter(), t, "base");
      const shared = await runArm(`bench-shared-${t}`, brain, t, "shared");
      const baseAll = fleetRedundantCount(base.outcome.perWorker.map((w) => w.explored));
      const sharedAll = fleetRedundantCount(shared.outcome.perWorker.map((w) => w.explored));
      const baseRead = fleetRedundantCount(base.outcome.perWorker.map((w) => w.explored), READ_ONLY);
      const sharedRead = fleetRedundantCount(shared.outcome.perWorker.map((w) => w.explored), READ_ONLY);
      const rejected = base.outcome.rejected + shared.outcome.rejected;
      rejectedTotal += rejected;
      const llmShare = ((base.workerMs + shared.workerMs) / (base.wallMs + shared.wallMs)) * 100;
      series.reductionAll.push(reductionPct(baseAll, sharedAll) * 100);
      series.reductionRead.push(reductionPct(baseRead, sharedRead) * 100);
      series.llmShare.push(llmShare);
      series.reuses.push(shared.outcome.reuses);
      perTrial.push({
        trial: t,
        redundant: { baseAll, sharedAll, baseRead, sharedRead }, // raw counts: baseline 0 makes pct meaningless — visible here
        reuses: shared.outcome.reuses,
        rejected,
        wallMs: { base: Math.round(base.wallMs), shared: Math.round(shared.wallMs) },
        workerMs: { base: Math.round(base.workerMs), shared: Math.round(shared.workerMs) },
        llmSharePct: llmShare,
      });
      console.log(
        `trial ${t}/${TRIALS}: reduction=${series.reductionAll[t - 1].toFixed(1)}% (Read-only ${series.reductionRead[t - 1].toFixed(1)}%)` +
          `  redundant base/shared=${baseAll}/${sharedAll}  reuses=${shared.outcome.reuses}  llm=${llmShare.toFixed(1)}%` +
          (rejected ? `  ⚠ rejected=${rejected} — trial suspect` : ""),
      );
      if (baseAll === 0) console.warn(`⚠ trial ${t}: baseline redundancy is 0 — reduction% is structurally meaningless for this trial`);
    }

    console.log(`\n─── bench summary (n=${TRIALS} trial${TRIALS > 1 ? "s" : ""}, parallel=${CONCURRENCY}, tasks=${taskSource}) ───`);
    console.log(`redundancy reduction (all tools): ${fmtStats(stats(series.reductionAll), "%")}`);
    console.log(`redundancy reduction (Read-only): ${fmtStats(stats(series.reductionRead), "%")}`);
    console.log(`LLM share of wall-clock (worker.run): ${fmtStats(stats(series.llmShare), "%")}${CONCURRENCY > 1 ? "  ⚠ parallel>1: spans overlap, share inflated" : ""}`);
    console.log(`reuses per trial: ${series.reuses.join(", ")}`);
    if (rejectedTotal > 0) console.warn(`⚠ ${rejectedTotal} rejected result(s) across trials — affected trials are suspect, do not gate on this run`);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      `${OUT}/bench-summary.json`,
      JSON.stringify(
        {
          trials: TRIALS,
          concurrency: CONCURRENCY,
          maxTurns: MAX_TURNS, // instrument version matters: numbers are only comparable at the same turn budget
          project: PROJECT_DIR,
          taskSource,
          tasks: nodes.map((n) => n.id),
          perTrial,
          rejectedTotal,
          summary: {
            reductionAllPct: stats(series.reductionAll),
            reductionReadPct: stats(series.reductionRead),
            llmSharePct: stats(series.llmShare),
            reuses: series.reuses,
          },
        },
        null,
        2,
      ),
    );
    console.log(`summary → ${OUT}/bench-summary.json · timing → ${OUT}/bench-timing-<trial>-<arm>.jsonl`);
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
