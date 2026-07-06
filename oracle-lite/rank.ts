// Ranking v2 (U1+U2 from docs/research-memory-os.md): Reciprocal Rank Fusion over the FTS and vector
// lists, then boost multipliers from columns. Pure functions — the server wires them to SQL; tests hit
// them directly. Two design rules from the research: (1) RRF is rank-only, so the incompatible score
// scales of bm25 and cosine never mix; (2) relevance dominates — recency/usage/trust NUDGE (bounded
// multiplier), they never gate.

export const RRF_K = 60; // universal default from the IR literature — gentle decay, rewards consistency

// Reciprocal Rank Fusion: each list is doc ids in rank order (best first). Score = Σ 1/(k + rank).
// A doc found by BOTH lists naturally outranks a doc found by one — no both-modes bonus needed.
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return score;
}

// Trust prior by source (U2). Defaults LOW — Memoria's anti-lesson: unvetted content must not be born
// "verified". ⟲ RETRO is derived from a measured acceptance run, so it earns the test-derived tier.
export function trustOf(source: string): number {
  if (source.startsWith("human")) return 1.0;
  if (source === "auralis:retro") return 0.85; // derived from a real acceptance PASS/FAIL
  if (source === "auralis:decision" || source === "auralis:distilled") return 0.7; // explicit / corroborated
  return 0.5; // agent_inferred — the floor for worker findings
}

export interface BoostInputs {
  trust: number; // [0,1] from trustOf, stored at learn time
  timesUsed: number; // citation count (U3) — 0 until the cite loop lands
  maxUsed: number; // max timesUsed among candidates (log-damped normalizer)
  daysSinceAccess: number; // since last_accessed_at ?? created_at
  superseded: boolean;
}

// final = RRF × (1 + 0.2·recency + 0.1·usage + 0.2·trust) × (superseded ? 0.3 : 1)
// Bounded: the multiplier is at most 1.5× — a stale, unused, untrusted doc still surfaces if it is
// the best match. Recency half-life 14 days (raw findings churn fast in an active repo).
export function boost(base: number, b: BoostInputs): number {
  const recency = Math.pow(2, -Math.max(0, b.daysSinceAccess) / 14);
  const usage = b.maxUsed > 0 ? Math.log(1 + Math.max(0, b.timesUsed)) / Math.log(1 + b.maxUsed) : 0;
  return base * (1 + 0.2 * recency + 0.1 * usage + 0.2 * b.trust) * (b.superseded ? 0.3 : 1);
}

export function daysBetween(fromIso: string | null | undefined, now: number): number {
  if (!fromIso) return 0; // no timestamp → treat as fresh, not dead
  const t = Date.parse(fromIso);
  return Number.isFinite(t) ? (now - t) / 86_400_000 : 0;
}
