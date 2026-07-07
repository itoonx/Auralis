# PRD — LongMemEval: auralis on a neutral benchmark

Date: 2026-07-07 · Status: proposed (plan only — no harness built yet)
Why: our benches prove mechanisms honestly but are self-authored. LongMemEval (ICLR 2025,
[repo](https://github.com/xiaowu0162/LongMemEval), MIT, data on HuggingFace) is the field's most credible
public memory benchmark — the arena where a competitive claim stops being self-referential.

## The benchmark, in facts

- **Variants:** `S` (~40 sessions ≈115k tokens per question, 500 questions) · `M` (~500 sessions) ·
  `oracle` (evidence-only sessions). Start with `S`; `M` later.
- **Five abilities:** information extraction · multi-session reasoning · **knowledge updates** ·
  **temporal reasoning** · abstention.
- **Format per question:** `haystack_sessions` (user/assistant turns), `haystack_dates` (session
  timestamps), `question`, `question_date`, `answer`.
- **Integration contract:** emit `jsonl` of `{question_id, hypothesis}` → official `evaluate_qa.py`
  judges with **GPT-4o**.

## Why this maps unusually well onto what we built

1. **Free ingestion is a structural edge.** Every competitor pays an LLM per write (Mem0 extraction,
   Zep graph build). Our ingest is `learn()` — deterministic lanes, auto graph, no LLM. 500 haystacks
   ≈ 100–300k learns ≈ minutes of wall, ~zero cost.
2. **`haystack_dates` → `validAt` verbatim.** Session timestamps back-date each memory's validity —
   then **knowledge-update questions** are literally our supersede/invalidate semantics and **temporal
   questions** are `as_of` queries. These two categories are the field's universal weak spot (lowest
   sub-scores for every vendor) and our two newest proven mechanisms.
3. **Abstention** maps to our confidence machinery: weak/empty retrieval → decline to answer.

**Honest expectation:** chat-history memory is Zep's home turf, not ours (coding-agent memory). The
trigram embedder will hurt on paraphrase-heavy extraction questions — which is exactly why this doubles
as the **§7 embedder instrument**: the trigram-vs-semantic A/B this benchmark provides is the evidence
the deferred embedder decision is waiting for.

## Plan — four phases, each gated on the previous one's numbers

| phase | what | measure / gate |
|---|---|---|
| **P0 · scout** (~1h) | download `S` + `oracle`, inspect format, build the 50-question stratified subset (10 per ability) | data loads; subset covers all 5 abilities |
| **P1 · harness** (~half day) | `run-longmemeval.ts`: per question — fresh project → ingest turns through the session-capture lanes (user turns `validAt`=session date; assistant turns 0.5 trust) → retrieve (top-k; temporal questions add `as_of`=question context) → Claude composes the hypothesis → jsonl out. Abstention rule: retrieval below floor → "no answer" | oracle-variant sanity ≥ high (evidence-only should be near-ceiling; if not, the harness is broken — instrument-first) |
| **P2 · smoke, trigram** | 50-Q subset, current defaults; judge twice — Claude-judge for fast iteration, official GPT-4o judge for the reportable number (needs an OpenAI key; ~$2–5) | per-ability breakdown; expectation: temporal/updates strong, extraction weak |
| **P3 · embedder A/B** | same 50-Q with `AURALIS_SEMANTIC=1` (+ re-embed backfill built here — the §7 blocker) | **the embedder decision gets made on this delta** — flip default only if the gap is real |
| **P4 · full run** | 500-Q `S` with the winning config; publish per-ability table vs published numbers (Zep: +18.5% over full-context, gpt-4o) | the first non-self-referential auralis number |

## Costs, stated plainly

- Ingest: ~free (the edge). Hypothesis generation: 500 Claude calls (subscription; do P2/P3 on 50 first).
- Official judge: GPT-4o API — the one external dependency; without an OpenAI key we can iterate on
  Claude-judge but must label those numbers non-comparable.
- Wall time: P2/P3 ≈ an hour each; P4 ≈ several hours unattended.

## Out of scope (v1)

`M` variant (1.5M tokens — after `S` says we belong) · leaderboard submissions/PR to their repo ·
tuning the ranker specifically to LongMemEval (benchmark-gaming; config changes must be justified by
our own benches too, or they're overfitting).
