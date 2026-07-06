// `pnpm bench-rank` — the A/B RANKING benchmark. Recall benches (bench-graph) count what surfaces; this
// measures ORDER: does the right answer rank #1 when decoys compete? It boots an ISOLATED FTS-only brain
// (own port + db, deterministic — no vectors, no LLM), seeds a labelled corpus engineered so pure keyword
// relevance gets 3 of 4 WRONG, then compares the full ranker (RRF + trust/usage/supersede boosts) against
// `rank=plain` (RRF only). The bench has teeth: if the boosts don't help, full ties plain and it FAILS;
// a guardrail query (high-trust but off-topic) FAILS an over-boosted ranker that lets trust beat relevance.
import { spawn } from "node:child_process";
import { oracleReachable } from "./memory";
import { precisionAt1, mrr, type Ranking } from "./bench-rank";

const PORT = Number(process.env.AURALIS_BENCH_PORT ?? 47781);
const BASE = `http://localhost:${PORT}`;
const DB = `${process.env.AURALIS_OUT ?? ".auralis-out"}/bench-rank.sqlite`;
const PROJECT = "bench-rank";

// Each decoy is engineered to out-keyword its target (repeats a query term), so pure bm25 ranks the WRONG
// doc first on Q1–Q3. The boost that should fix each is named. Q4 is the guardrail: relevance must win.
const SEED: { key: string; content: string; source: string }[] = [
  // Q1 — supersede should sink the decoy (the old, wrong version)
  { key: "q1_target", content: "The auth session token is stored in a signed HTTP cookie.", source: "auralis:worker:a" },
  { key: "q1_decoy", content: "The auth session token is stored, stored in browser localStorage store storage.", source: "auralis:worker:b" },
  // Q2 — citation should lift the target (the finding that proved useful)
  { key: "q2_target", content: "Rate limiting is enforced in middleware and returns HTTP 429.", source: "auralis:worker:a" },
  { key: "q2_decoy", content: "Rate limiting draft: limiting rate, rate limiting limits, limiting enforced rate.", source: "auralis:worker:b" },
  // Q3 — trust should break a near-tie toward the retro (measured-derived source)
  { key: "q3_target", content: "Acceptance contract for the todo api requires persistence to disk.", source: "auralis:retro" },
  { key: "q3_decoy", content: "Acceptance contract todo api contract, contract notes, contract draft api.", source: "auralis:worker:b" },
  // Q4 — GUARDRAIL: a high-trust retro that is OFF-topic must NOT beat the on-topic finding
  { key: "q4_target", content: "The vector index uses LanceDB with cosine similarity for semantic recall.", source: "auralis:worker:a" },
  { key: "q4_hitrust", content: "Retro lesson: the index of past runs shows persistence was the common miss.", source: "auralis:retro" },
];
const SUPERSEDE = ["q1_decoy"]; // the localStorage answer was wrong and got superseded
const CITE: { key: string; times: number }[] = [{ key: "q2_target", times: 2 }]; // proven useful twice
const QUERIES: { q: string; correct: string }[] = [
  { q: "where is the auth session token stored", correct: "q1_target" },
  { q: "how is rate limiting enforced", correct: "q2_target" },
  { q: "the acceptance contract for the todo api", correct: "q3_target" },
  { q: "how does the vector index work", correct: "q4_target" },
];

async function post(path: string, body: unknown) {
  const r = await fetch(new URL(path, BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function measure(mode: "full" | "plain", idOf: Map<string, string>): Promise<Ranking[]> {
  const out: Ranking[] = [];
  for (const { q, correct } of QUERIES) {
    const u = new URL("/api/search", BASE);
    u.searchParams.set("q", q);
    u.searchParams.set("project", PROJECT);
    u.searchParams.set("limit", "10");
    if (mode === "plain") u.searchParams.set("rank", "plain");
    const body = (await (await fetch(u)).json()) as { results: { id: string }[] };
    out.push({ query: q, correct: idOf.get(correct)!, order: body.results.map((r) => r.id) });
  }
  return out;
}

const rankOfCorrect = (r: Ranking) => { const i = r.order.indexOf(r.correct); return i < 0 ? "—" : `#${i + 1}`; };

async function main() {
  const child = spawn("bun", ["run", "oracle-lite/server.ts"], {
    env: { ...process.env, ORACLE_PORT: String(PORT), ORACLE_DB: DB, ORACLE_RESET: "1", ORACLE_NO_VECTORS: "1", ORACLE_ALLOW_RESET: "1" },
    stdio: "inherit",
  });
  const stop = () => { try { child.kill(); } catch { /* noop */ } };
  try {
    for (let i = 0; i < 60 && !(await oracleReachable(BASE)); i++) await new Promise((r) => setTimeout(r, 200));
    if (!(await oracleReachable(BASE))) throw new Error("bench oracle did not start");

    // Seed + set up state (supersede, cite), mapping logical keys → real ids.
    const idOf = new Map<string, string>();
    for (const d of SEED) {
      const { id } = (await post("/api/learn", { pattern: d.content, project: PROJECT, source: d.source })) as { id: string };
      idOf.set(d.key, id);
    }
    if (idOf.size !== SEED.length) throw new Error("seed failed — aborting (a bench that scores a half-seeded brain is a lie)");
    for (const k of SUPERSEDE) await post("/api/supersede", { oldId: idOf.get(k), newId: "bench-superseded", reason: "bench: old wrong version" });
    for (const c of CITE) for (let i = 0; i < c.times; i++) await post("/api/cite", { id: idOf.get(c.key) });

    // A/B: plain first (pure relevance), then full (with boosts). Both hit the SAME seeded brain.
    const plain = await measure("plain", idOf);
    const full = await measure("full", idOf);

    console.log("\n─── ranking benchmark (A/B: full boosts vs plain relevance) ───");
    console.log("  query                                     plain → full   boost tested");
    const tested = ["supersede sinks old", "citation lifts useful", "trust breaks tie", "GUARDRAIL relevance"];
    QUERIES.forEach((qq, i) => {
      const pad = (qq.q + " ".repeat(42)).slice(0, 42);
      console.log(`  ${pad}  ${rankOfCorrect(plain[i]).padStart(3)} → ${rankOfCorrect(full[i]).padStart(3)}      ${tested[i]}`);
    });
    const pPlain = precisionAt1(plain), pFull = precisionAt1(full);
    console.log(`\n  precision@1:  plain ${(pPlain * 100).toFixed(0)}%  →  full ${(pFull * 100).toFixed(0)}%`);
    console.log(`  MRR:          plain ${mrr(plain).toFixed(3)}  →  full ${mrr(full).toFixed(3)}`);

    // The bench encodes the DESIGN'S ACTUAL CONTRACT, not a wish. HARD (must pass): the instrument
    // discriminates (plain is fooled, or the corpus proves nothing — the 7/7-hit lesson); supersede and
    // citation are STRONG signals that must put the right answer #1; and the GUARDRAIL holds — a high-trust
    // but off-topic doc must NOT beat the on-topic answer (relevance dominates). SOFT (reported only): trust
    // breaking an exact tie — it's a 0.05 nudge by design (RRF can't safely distinguish tie from real gap),
    // so we don't fail the build on it.
    const first = (r: Ranking) => r.order[0] === r.correct;
    const discriminates = pPlain < 0.75;
    const supersede = first(full[0]), cite = first(full[1]), trustTie = first(full[2]), guardrail = first(full[3]);
    console.log(`  hard: discriminate=${discriminates ? "✓" : "✗"} supersede=${supersede ? "✓" : "✗"} cite=${cite ? "✓" : "✗"} guardrail=${guardrail ? "✓" : "✗"}   soft: trust-tie=${trustTie ? "✓" : "·"}`);
    const ok = discriminates && supersede && cite && guardrail && pFull > pPlain;
    console.log(
      ok
        ? `\n✅ boosts earn their place — supersede & citation put the right answer #1, guardrail holds (relevance dominates), plain ${(pPlain * 100).toFixed(0)}% → full ${(pFull * 100).toFixed(0)}%`
        : `\n❌ not met — discriminate=${discriminates} supersede=${supersede} cite=${cite} guardrail=${guardrail} full>plain=${pFull > pPlain}`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
