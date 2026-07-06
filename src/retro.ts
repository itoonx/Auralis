// The self-improving loop. After each run, oracle records a retrospective built from the run's REAL signals
// (pass/fail, reworks, what the first attempt missed, coordination, wall) — templated from measurements, never
// an LLM's opinion. Before the next run of a similar goal, that retro is recalled and fed to the planner so
// the society avoids repeating the miss. A retro is just a tagged, searchable finding — this reuses the
// brain's own learn()/search(); there is no new store.
import type { MemoryAdapter } from "./memory";

export const RETRO_PREFIX = "⟲ RETRO";

export interface RunSignals {
  goal: string;
  mode: "build" | "analyze";
  pass?: boolean; // build only
  reworks?: number; // build only
  firstFail?: string; // build only: what acceptance attempt #1 was missing (the actionable bit)
  filesWritten?: number; // build only
  reuses: number;
  repairs: number;
  readRedundant?: number; // analyse: duplicate FILE reads the claim gate didn't prevent
  wallSec?: number;
}

const clip = (s: string, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n);

// Derive an actionable lesson from the signals alone — templated, so it cannot hallucinate a "lesson".
function lesson(s: RunSignals): string {
  if (s.mode === "build") {
    if (s.reworks && s.firstFail) return `The first attempt FAILED the check — make sure up front: ${clip(s.firstFail, 220)}`;
    if (s.pass) return "This decomposition passed on the first try — repeat its structure.";
    return "Did not reach a passing build — try a different file split.";
  }
  if (s.readRedundant && s.readRedundant > 0) return `Workers re-read ${s.readRedundant} file(s) — split tasks so they don't overlap.`;
  return "Coordinated cleanly — repeat the task split.";
}

export function buildRetroText(s: RunSignals): string {
  const result =
    s.mode === "build"
      ? s.pass
        ? s.reworks
          ? `PASS after ${s.reworks} rework(s)`
          : "PASS first try"
        : "FAIL"
      : `analysed (reuses=${s.reuses})`;
  return [
    `${RETRO_PREFIX} · mode: ${s.mode} · goal: ${clip(s.goal, 120)}`,
    `result: ${result} · coordination: reuses=${s.reuses} repairs=${s.repairs}` +
      `${s.readRedundant != null ? ` redundant-reads=${s.readRedundant}` : ""}${s.wallSec != null ? ` · wall=${s.wallSec}s` : ""}`,
    `LESSON: ${lesson(s)}`,
  ].join("\n");
}

// Persist the retro to the shared brain (append-only, searchable). Best-effort — never breaks a run.
// Only retros with a HARD lesson (a measured failure that got fixed, or self-repairs) are pinned forever;
// "passed first try — repeat structure" retros carry near-zero information, so they stay unpinned and fade
// via the U4 forgetting sweep instead of accumulating as permanent noise. (Utility audit, 2026-07-07: 3 of
// the first 5 retros in the live brain were no-lesson pins.)
export async function writeRetro(adapter: MemoryAdapter, project: string, s: RunSignals): Promise<string> {
  const text = buildRetroText(s);
  const hardLesson = (s.mode === "build" && (s.pass === false || (s.reworks ?? 0) > 0)) || s.repairs > 0;
  try {
    await adapter.learn(text, { project, source: "auralis:retro", concepts: ["retrospective", s.mode], pinned: hardLesson });
  } catch {
    /* retro is best-effort observability, not a dependency of the work */
  }
  return text;
}

// Recall the most relevant prior retro(s) for this goal so the planner can learn from them. Returns "" for a
// cold project. Filters to retro records so ordinary findings don't leak in as "lessons".
export async function recallRetro(adapter: MemoryAdapter, project: string, goal: string, limit = 2): Promise<string> {
  try {
    // Search wide: in a brain full of ordinary findings, a short retro is easily pushed out of a small
    // top-k, so we over-fetch and then filter to retro records. (Robustness fix — a small limit made recall
    // miss the retro once the brain had a session's worth of noise.)
    const hits = await adapter.search(goal, { project, limit: 40 });
    const retros = hits.filter((h) => h.content.startsWith(RETRO_PREFIX) && !h.supersededBy).slice(0, limit);
    return retros.map((h) => h.content).join("\n\n");
  } catch {
    return "";
  }
}
