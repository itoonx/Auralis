# PRD — Model / turn routing: spend the expensive model only where it earns it

Date: 2026-07-18 · Status: direction decided (multi-model brainstorm 2026-07-17,
`learning_178427800248070`), tasks not yet broken down · Basis: the runner-selection seam already
resolves a model per role (`src/runners.ts:69` `resolveRunnerSpec`; env `AURALIS_*_RUNNER` +
`auralis.config.json` `runners.{worker,critic,reviewer,planner?}`). Routing is a *policy* on that seam,
not a new mechanism.

## The problem, plainly

The LLM call **is** the run. `pnpm bench` (pinned `benchmarks/core.json`, isolated scratch oracle,
n=5 trials, 2026-07-18, `.auralis-out/bench-summary.json`) measured **LLM share of wall-clock = 97.1% ±
1.0** — the one robust number the harness produces today. Everything auralis does around the model
(claim registry, dedup, narration, storage) rounds to noise against it. So the *only* order-of-magnitude
cost/latency lever is **which model runs which task** — a cheap model for the Planner and easy subtasks,
Opus reserved for hard analysis, plus a per-task turn budget. The roadmap has called this the
highest-leverage item since the 97.1% landed; this PRD is how it ships without trading quality for cost
silently.

**The reliability finding that shapes the gate.** At the default `maxTurns=8`, the same 5-trial bench
showed **16/30 worker runs critic-rejected** (mostly early-stops). A router judged on those runs would be
graded on noise. So: **a router is judged only on CLEAN trials** (`rejected=0`), and **per-task turn
budgets are in scope** — routing and turn-budgeting are the same reliability problem seen from two sides.

## Non-goals

- **No new runner vendors.** Adding GPT/GLM/Gemini runtimes is `prd-multi-runner.md`'s scope; this PRD
  only chooses *among runners that already resolve*.
- **No retrieval / recall work.** The memory layer is `prd-next-phase.md`'s scope; routing touches
  neither the ranker nor ingestion.
- **No new config mechanism.** Routing is expressed as `runners.*` values + turn budgets on the existing
  seam. If a rule can't be written there, it's out of scope until the seam is extended deliberately.

## Design

**Routing = per-role runner + per-task turn budget, both on the existing seam.** Nothing new to resolve:
`resolveRunnerSpec(role)` already answers "which model for this layer?" (env > config > worker-fallback >
`claude`). Routing adds (a) *populating* the cheap-model roles the seam already supports, and (b) a
per-task `maxTurns` the fleet passes through to the runner. An **explicit, auditable rule** decides
"easy subtask" — never a model's own guess; the rule is code the shadow-log can be replayed against.

**Shadow-log — the quality instrument (schema FIXED, being wired in parallel).** Cost is easy to see and
easy to fool yourself with; *quality* drift is the thing that hides. Every completed task attempt-set
appends one JSON line to `.auralis-out/shadow-log.jsonl`, capturing the free LLM-critic verdict as the
quality signal:

```jsonc
{ "ts": "<ISO>", "runId": "…", "project": "…", "task": "…", "model": "claude:claude-opus-4-8",
  "verdictOk": true, "reason": "…",         // the LLM critic's accept/reject + its reason
  "attempts": 1, "ms": 8421, "explored": 12, "resultChars": 1840 }
```

Append-only; one line per attempt-set, not per turn (state, not firehose). **Kill-switch: `AURALIS_SHADOW=0`
disables logging.** S0 runs it on today's all-Opus config to establish the verdict-rate baseline *before*
any model is swapped — the router is measured against auralis-answering-as-Opus, not against a guess.

**Merge gate — CLEAN-trial bench, three ways.** A routing change lands only if, on `rejected=0` trials:
1. **Suite green** (correctness gate — non-negotiable, first).
2. **Bench non-regression** — `reduction` *and* `reuse` means stay within the prior config's observed
   `min..max` band (not a point estimate — the band is the honest comparison given current spread).
3. **Shadow verdict-rate non-regression** — the cheap-model config's `verdictOk` rate ≥ the baseline's.

Canary + kill-switch precede the gate: a new route runs shadowed alongside the incumbent, and
`AURALIS_SHADOW=0` (plus reverting the `runners.*` value) is the instant rollback.

## Rollout stages — each gated, none skipped

- **S0 · Collect.** Ship the shadow-log on the current all-Opus config. No routing yet. **Gate:** a
  verdict-rate + clean-trial baseline exists in `shadow-log.jsonl` and `bench-summary.json` — the ruler
  before the cut. **Risk:** none (observability only).
- **S1 · Route the Planner to a cheap model.** Lowest risk: the plan's quality is *visible* in the task
  decomposition, and the Planner runs once per run. Set `runners.planner` (the seam falls back
  planner→worker today, so this is a one-line config change + `AURALIS_PLANNER_RUNNER` override).
  **Gate:** suite green + clean-trial bench non-regression (band) + shadow verdict-rate non-regression.
- **S2 · Route easy subtasks by explicit rule.** A written, auditable classifier sends easy exploration
  subtasks to the cheap model, Opus keeps hard analysis + synthesis; per-task turn budgets tune alongside.
  **Gate:** same three, plus the classifier's decisions are replayable against the shadow-log (every
  "easy" call is inspectable after the fact).

Each stage is independently revertible; a stage that fails its gate rolls back to the prior config and
its data feeds the next attempt rather than being discarded.

## Risks — carried verbatim from the brainstorm

| Risk | Mitigation |
|---|---|
| The gate is only as good as the bench sample size — small n makes the `min..max` band wide enough to wave anything through | clean-trial requirement shrinks the band's noise at the source; grow n at decision points (the `prd-next-phase.md` 3×-at-gates discipline); treat a suspiciously wide band as *not enough data*, not a pass |
| Silent quality drift ≠ cost drift — a cheaper run that quietly answers worse looks like a win on cost | the shadow-log captures the **critic verdict**, not just $/latency; S0 baselines verdict-rate first; gate #3 blocks a cost win that costs quality |
| "Easy subtask" is a judgment call | the classifier is an **explicit, auditable rule** (code, not a model's self-assessment), and every decision is replayable against the shadow-log |
| A router judged on early-stopped runs grades noise | CLEAN trials only (`rejected=0`); per-task turn budgets in scope so trials come back clean |

## Open questions

1. **The band leans on a number the roadmap flags as not-yet-trustworthy.** `reduction` currently has
   sd ~130/65 and range −200%..+100% (`roadmap.md` "Trustworthy numbers"), *because* 16/30 runs were
   rejected. The clean-trial requirement is the bet that fixing reliability also makes `reduction`
   quotable — but S1's gate #2 can't be trusted until at least one all-Opus clean-trial run proves the
   band tightened. Sequence S0 to produce that run before S1 gates on it.
2. **Where does the worker/synthesis tier split fit?** `prd-multi-runner.md` M3 imagined routing's first
   step as cheap-exploration-workers + strong-synthesis (`AURALIS_RUNNER` vs `AURALIS_SYNTHESIS_RUNNER`,
   both already wired). This PRD routes the **Planner** first instead (lower risk, plan quality visible).
   Are these two S-stages of one plan, or does the worker/synthesis split replace S2? Decide before S2.
3. **Turn-budget granularity.** Per-task `maxTurns` is in scope — is it a per-role default, or does the
   classifier set it per subtask alongside the model choice? S2 needs this pinned.
4. **Verdict-rate is a lagging, low-resolution signal.** The critic accepts/rejects; it doesn't grade
   "slightly worse but still ok". If a cheap model degrades *within* the accept band, gate #3 misses it.
   Do we need a graded critic score before S2, or is accept-rate enough for the first cut?
