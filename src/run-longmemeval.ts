// `pnpm lme` — the LongMemEval harness (docs/prd-longmemeval.md, phases P1–P3; P4 deliberately deferred).
// Per question: a FRESH project in an isolated scratch brain → ingest every haystack turn through the same
// lanes session-capture uses (user turns trust 1.0 / assistant 0.5, validAt = the session's real date —
// LLM-less, the structural edge) → hybrid retrieval → one Claude call composes the hypothesis → jsonl
// {question_id, hypothesis} compatible with the official judge. A built-in Claude judge gives ITERATION
// numbers; only the official GPT-4o judge produces comparable ones (label anything internal as such).
//
// env: LME_DATA (dataset json) · LME_SUBSET (ids json) · LME_LIMIT · LME_OUT (jsonl)
//      LME_JUDGE=claude|none · AURALIS_SEMANTIC=1 for the P3 embedder arm · LME_CONCURRENCY (default 3)
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { OracleAdapter, oracleReachable } from "./memory";
import { extractEntities } from "./triplets";

const SCRATCH = process.env.LME_SCRATCH ?? "/tmp/auralis-lme";
const PORT = Number(process.env.LME_PORT ?? 47799);
const BASE = `http://localhost:${PORT}`;
const DATA = process.env.LME_DATA ?? `${SCRATCH}/longmemeval_s.json`;
const OUT = process.env.LME_OUT ?? `${SCRATCH}/hypotheses.jsonl`;
const JUDGE = process.env.LME_JUDGE ?? "claude";
const LIMIT = Number(process.env.LME_LIMIT ?? 0);
const CONC = Number(process.env.LME_CONCURRENCY ?? 3);

interface Q {
  question_id: string;
  question_type: string;
  question: string;
  answer: unknown;
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: { role: string; content: string }[][];
}

// '2023/04/10 (Mon) 17:50' → ISO. Tolerant: unparseable dates just omit validAt (falls back to created_at).
function toIso(d: string): string | undefined {
  const t = Date.parse(d.replace(/\s*\([^)]*\)\s*/, " "));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

async function ask(prompt: string): Promise<string> {
  let out = "";
  for await (const m of query({ prompt, options: { cwd: SCRATCH, maxTurns: 1, allowedTools: [] } as any })) {
    const msg: any = m;
    if (msg.type === "result" && msg.subtype === "success") out = String(msg.result ?? "");
  }
  return out.trim();
}

async function runOne(oracle: OracleAdapter, q: Q): Promise<{ id: string; type: string; hypothesis: string; ingested: number }> {
  const project = `lme_${q.question_id}`;
  let ingested = 0;
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const validAt = toIso(q.haystack_dates?.[i] ?? "");
    for (const turn of q.haystack_sessions[i]) {
      const text = String(turn.content ?? "").trim();
      if (text.length < 20) continue; // trivial acks carry no memory
      const opts = {
        project,
        source: turn.role === "user" ? "human:prompt" : "session:assistant",
        pinned: false, // benchmark corpora must age like everything else
        validAt,
      };
      try {
        await oracle.learn(`${turn.role}: ${text}`, opts);
      } catch {
        // one retry — a 100k-turn run must not die on a single hiccup; a persistent failure still throws
        await new Promise((r) => setTimeout(r, 300));
        await oracle.learn(`${turn.role}: ${text}`, opts);
      }
      ingested++;
    }
  }
  // Multi-query retrieval: a "days between A and B" question names TWO events — one query's top-k tends
  // to cover only the dominant one (sanity-gate finding). Union the main search with a per-entity search
  // so every named event gets its own shot. Deterministic, no LLM.
  const seen = new Map<string, (typeof hits0)[number]>();
  const hits0 = await oracle.search(q.question, { project, limit: 8 });
  for (const h of hits0) seen.set(h.id, h);
  for (const ent of extractEntities(q.question).slice(0, 3)) {
    for (const h of await oracle.search(ent, { project, limit: 4 })) if (!seen.has(h.id)) seen.set(h.id, h);
  }
  const hits = [...seen.values()].slice(0, 12);
  if (!hits.length) return { id: q.question_id, type: q.question_type, hypothesis: "I don't know.", ingested };
  const excerpts = hits
    .map((h) => `- [said ${String(h.validAt ?? "").slice(0, 10) || "unknown date"}] ${h.content.slice(0, 500)}`)
    .join("\n");
  const hypothesis = await ask(
    `Today is ${q.question_date}. Below are excerpts from the user's past chat sessions, each marked with when it was said.\n\n` +
      `${excerpts}\n\nQuestion: ${q.question}\n\n` +
      `Answer concisely using ONLY the excerpts. If they don't contain the answer, reply exactly: I don't know.`,
  );
  return { id: q.question_id, type: q.question_type, hypothesis: hypothesis || "I don't know.", ingested };
}

async function judgeOne(q: Q, hypothesis: string): Promise<boolean> {
  const abstention = q.question_id.includes("_abs");
  // Sanity-gate finding: the judge failed "Two: Dr. Smith…" against gold `2` and penalised correct
  // abstentions — be explicit that equivalence (number words, extra explanation) counts as correct.
  const verdict = await ask(
    abstention
      ? `This question has NO answer in the source material; the correct behaviour is to decline.\n` +
          `Question: ${q.question}\nResponse: ${hypothesis}\n` +
          `Any response expressing lack of information (e.g. "I don't know", "not enough information") is CORRECT.\n` +
          `Did the response correctly decline (yes/no)? Answer one word.`
      : `Question: ${q.question}\nGold answer: ${JSON.stringify(q.answer)}\nResponse: ${hypothesis}\n` +
          `Judge SEMANTIC equivalence: number words equal digits ("Two" = 2), extra correct detail or ` +
          `explanation does NOT make it wrong, paraphrases count. Wrong facts or missing the gold's core answer = no.\n` +
          `Is the response correct (yes/no)? Answer one word.`,
  );
  return /^\s*yes/i.test(verdict);
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  const all: Q[] = JSON.parse(readFileSync(DATA, "utf8"));
  const subset = process.env.LME_SUBSET ? new Set(JSON.parse(readFileSync(process.env.LME_SUBSET, "utf8"))) : null;
  let qs = subset ? all.filter((q) => subset.has(q.question_id)) : all;
  if (LIMIT > 0) qs = qs.slice(0, LIMIT);

  // Isolated scratch brain — never the real one. Semantic arm (P3): spawn the embed sidecar first.
  const kids: ChildProcess[] = [];
  const env: Record<string, string | undefined> = { ...process.env, ORACLE_PORT: String(PORT), ORACLE_DB: `${SCRATCH}/brain.sqlite`, ORACLE_RESET: "1", ORACLE_API_URL: BASE };
  if (process.env.AURALIS_SEMANTIC === "1") {
    const embedPort = 47798;
    kids.push(spawn("pnpm", ["exec", "tsx", "src/embed-sidecar.ts"], { env: { ...process.env, EMBED_PORT: String(embedPort) }, stdio: "ignore" }));
    for (let i = 0; i < 180; i++) {
      try { if ((await fetch(`http://localhost:${embedPort}/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    env.ORACLE_EMBED_URL = `http://localhost:${embedPort}`;
  }
  rmSync(`${SCRATCH}/brain.sqlite`, { force: true });
  kids.push(spawn("bun", ["run", "oracle-lite/server.ts"], { env: env as any, stdio: "ignore" }));
  const stop = () => kids.forEach((k) => { try { k.kill(); } catch { /* noop */ } });
  try {
    for (let i = 0; i < 60 && !(await oracleReachable(BASE)); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await oracleReachable(BASE))) throw new Error("lme oracle did not start");
    process.env.ORACLE_API_URL = BASE; // adapters in THIS process point at the scratch brain
    const oracle = new OracleAdapter(BASE);

    writeFileSync(OUT, "");
    const results: { id: string; type: string; ok?: boolean }[] = [];
    let done = 0;
    const t0 = Date.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONC, qs.length) }, async () => {
        for (let i = next++; i < qs.length; i = next++) {
          const q = qs[i];
          const r = await runOne(oracle, q);
          const ok = JUDGE === "claude" ? await judgeOne(q, r.hypothesis) : undefined;
          appendFileSync(OUT, JSON.stringify({ question_id: r.id, hypothesis: r.hypothesis }) + "\n");
          results.push({ id: r.id, type: r.type, ok });
          done++;
          console.log(`  [${done}/${qs.length}] ${r.id} · ${r.type} · ingested=${r.ingested}${ok === undefined ? "" : ok ? " · ✅" : " · ❌"}`);
        }
      }),
    );

    console.log(`\n━━━ LongMemEval (${process.env.AURALIS_SEMANTIC === "1" ? "semantic" : "trigram"} · judge=${JUDGE} · INTERNAL numbers) ━━━`);
    if (JUDGE === "claude") {
      const byType = new Map<string, { n: number; ok: number }>();
      for (const r of results) {
        const t = byType.get(r.type) ?? { n: 0, ok: 0 };
        t.n++; if (r.ok) t.ok++;
        byType.set(r.type, t);
      }
      let N = 0, OK = 0;
      for (const [t, v] of [...byType.entries()].sort()) {
        console.log(`  ${t.padEnd(28)} ${v.ok}/${v.n}  (${((v.ok / v.n) * 100).toFixed(0)}%)`);
        N += v.n; OK += v.ok;
      }
      console.log(`  ${"TOTAL".padEnd(28)} ${OK}/${N}  (${((OK / N) * 100).toFixed(0)}%)`);
      console.log(`  (Claude-judge = iteration numbers; official comparability needs evaluate_qa.py + GPT-4o)`);
    }
    console.log(`  wall ${(Date.now() - t0) / 1000 | 0}s · hypotheses → ${OUT}`);
  } finally {
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
