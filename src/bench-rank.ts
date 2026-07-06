// Pure ranking metrics for the A/B ranking bench (src/run-bench-rank.ts). Split out so they test without a
// server. A "ranking" is the ordered list of doc ids a query returned, plus the id we labelled correct.
export interface Ranking {
  query: string;
  correct: string;
  order: string[]; // returned ids, best-first
}

// precision@1 — the fraction of queries whose correct doc ranked #1. The headline: did the ranker put the
// right answer on top? (Ordering, not recall — recall benches like bench-graph can't see this.)
export function precisionAt1(rankings: Ranking[]): number {
  if (!rankings.length) return 0;
  return rankings.filter((r) => r.order[0] === r.correct).length / rankings.length;
}

// Mean Reciprocal Rank — partial credit: 1 if correct is #1, 1/2 if #2, … 0 if absent. Rewards "close".
export function mrr(rankings: Ranking[]): number {
  if (!rankings.length) return 0;
  const sum = rankings.reduce((acc, r) => {
    const i = r.order.indexOf(r.correct);
    return acc + (i >= 0 ? 1 / (i + 1) : 0);
  }, 0);
  return sum / rankings.length;
}
