# Engineering principles — non-negotiable

> Set 2026-07-10 after one session's dogfooding uncovered **5 silent failures** (brain corruption undetected
> for weeks, benchmark data leaking into the prod brain, the LLM lifecycle never firing in prod, `pnpm bench`
> able to wipe prod, and `AURALIS_SEMANTIC` silently running on trigram). Every one **passed its unit tests
> and its self-authored benchmark**, and every one was hidden by the system's own graceful degradation.
> This is our standing principle. Do not let it slide.

## VERIFY IN REALITY — the one rule

We are good at *building mechanisms* and *making them robust*. We were under-invested in *proving they
actually work in production and knowing when they don't*. Robustness (fail-silent, best-effort, graceful
fallback) is the **enemy of observability** — the same design that keeps the system running is what hid it
running WRONG. Hold both axes.

## The checklist — every feature/PR must pass it

1. **Assert the OUTCOME, not the call.** A test that proves `learn()` was called proves nothing. Assert the
   *ground truth*: the vector is in the index, `invalid_at` got written, the brain passes `integrity_check`,
   the edge exists. Mechanism-tested ≠ works-in-production.

2. **Every silent fallback emits a COUNTER, not just a log.** Graceful degradation is allowed *only if it is
   observable* — "fail-quiet-but-counted." If code can silently do the cheap/wrong thing (builtin instead of
   semantic, FTS instead of vector, skip instead of write), it must expose a count/ratio a caller can check.
   (The R0 `semantic_embeds / embed_fallbacks` stat is the template.)

3. **Verify the instrument before trusting the number.** Every measurement pipeline has a ruler that can lie
   — judge, reader/answer model, embedder engagement, retrieval mode. Check EACH one actually is what you
   think before you believe the result. Never conclude on a **proxy**: an env flag (`AURALIS_SEMANTIC=1`) is
   not behavior; a unit-test pass is not production; "a number was produced" is not "the number is valid."

4. **Dogfood and INSPECT, on a schedule.** A system you don't open and read in production is drifting
   silently. Reading the real brain (M0) is what cracked all 5 open. Make "look at the real thing" routine.

5. **Don't conclude fast on plausible evidence.** The embedder was declared "closed (trigram wins)" on a run
   nobody verified was actually semantic. Plausible + unverified = unknown. If a result would change a
   decision, verify its instrument first.

## How to use this

Every task in `tasks-fix-recall.md` (and beyond) must satisfy the checklist before it's "done". A recall
fix isn't done when the code compiles — it's done when a probe/assert proves the vectors populated and the
number moved for the reason you claim. Reviewers block on missing outcome-assertions and un-counted fallbacks.

## Diagnosis principles — added 2026-07-10 (session 2)

> The recall diagnosis flipped THREE times in one day — "retrieval recall is broken" → "chunk granularity" →
> "the reader is the bottleneck" → "half retrieval / half reader, and the root cause is the query builder."
> Every earlier conclusion was confidently wrong, and each flip came from a better instrument. The final bug
> (`sanitize()` truncating every query to its first 8 tokens — "…what color was the Plesiosaur?" never
> queried "Plesiosaur") had sat in the PROD retrieval path the whole time while we debated embedders.

6. **Decompose the funnel before choosing a lever.** One aggregate number (53.4%) cannot say WHERE the loss
   is. Ladder it: session-found → chunk-retrieved → chunk-in-reader's-hand → answer-visible → correct, each
   stage with its own ground-truth ruler. We built levers for the wrong stage twice because stages were
   conflated.

7. **Marginals lie; attribution needs the joint.** "Session recall 81%" and "correct 53%" said nothing until
   the confusion (chunk-in-hand × correct) split the blame 54/46. And `some`-semantics over-counted
   multi-evidence questions — one anchor in hand looked like "retrieval done" while the other anchor was the
   whole loss. Count ALL required evidence, not ANY.

8. **Root-cause per-item, not per-metric.** The 8-token cap was invisible in every aggregate — it took
   ranking individual evidence chunks for individual questions ("this chunk, this query, rank >500, WHY")
   to see it. When an aggregate says "X% lost," pick 10 concrete losses and trace each to its mechanism
   before building anything. No mechanism, no conclusion.

9. **Suspect the cheap layers first: query construction before model, plumbing before intelligence.** The
   whole debate was "MiniLM vs BGE-M3" while the actual losses were: a query builder dropping the key term,
   a missing stemmer, a 400-char display cut, an 8-slot budget eviction. Every hard-coded small constant on
   a data path (top-k, char cut, token cap) is a recall bug waiting — test the ceiling (2×, 4×) before
   accepting any of them.

10. **Cleverness must beat lazy breadth before it ships.** Two smart selection heuristics moved coverage
    57→59%; "just show the whole top-48" hit the ceiling by construction (and full-context already proved
    the reader tolerates breadth). When the downstream consumer is an LLM, ration nothing until measurement
    says you must.

11. **Deltas only count on the SAME instrument; know each flaw's bias direction.** subset-69% vs full-set-82%
    got compared once and produced a phantom "13-pt leak" (real: 4). Our 88% is not the official 53.4 —
    different reader+judge. A gold-peek inflates, a truncated excerpt deflates: when you fix an instrument
    flaw, say which way the old numbers leaned. And identical-retrieval reruns flip ±2-3/90 from reader
    sampling — check the evidence-state of a flipped item before chasing it.
