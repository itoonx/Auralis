# Roadmap

Where the platform is headed. Ordered by leverage (timing tells us which knob actually moves the needle).

> **State (2026-07-12):** the semantic stack SHIPPED to production — BGE-M3 dense via the python
> bge-sidecar (launchd, KeepAlive) + opt-in cross-encoder rerank (`rerank=1`) + 2-plane API auth
> (JWT/token, `.env.oracle`). Ground-truth LME probe (subset50, 100% semantic engagement verified):
> evidence-chunk@48 88→93%, preference 33→67%, assistant@12 67→83%. **M4 aggregation is DROPPED**
> (premise refuted by the R3 probe; triggers to reopen recorded in `docs/prd-next-phase.md` §M4).
> Next gates: the answer-stage A/B when LLM credit returns (one evening — it is also M4's reopen
> test), and production mileage on the new stack. Prior notes: the P4 official number 53.4% predates
> this stack; `docs/prd-fix-recall.md` closed at 93.3% internal (subset90).

- **Memory-OS upgrades — complete (U1–U7), all shipped and measured** (`docs/research-memory-os.md`):
  RRF+trust ranking, citation feedback, forgetting-as-ranking, bi-temporal validity with `as_of` queries,
  the sleep job (snapshot → dedup → LLM contradiction judgment writing `invalid_at`), and atomic
  pre-mutation snapshots. Next on this axis: let real usage accumulate and watch the lifecycle work.
- **Model / turn routing** — *highest leverage.* Timing proves the LLM call dominates wall-clock —
  **97.1% ± 1.0 (n=5 trials, 2026-07-17 multi-trial bench;** the old "99.9%" was a single 2026-07-06 run) —
  so the real cost lever is *which* model runs *which* task: a small/cheap model for the Planner and easy
  subtasks, Opus reserved for hard analysis, plus a per-task turn budget. This is the one change measurement
  says is worth it. Per the 2026-07-17 brainstorm decision: ship it correctness-gated — CI green → shadow-log
  (quality, not just cost) → canary + kill-switch → the multi-trial bench as merge gate, on CLEAN trials only.
- **Parallel writing beyond disjoint files** — build mode (above) already coordinates *writing* when each
  worker owns a distinct file: the claim registry generalised from "who reads this file" to "who writes it",
  proven on real builds. The open part is **overlapping edits** to a shared file — worktrees + clean merges,
  or a finer-grained claim than whole-file. That, plus a real container/VM sandbox for executing generated
  code, is the next frontier.
- **Cross-machine fleets** — the claim policy already lives in the middle layer, so cross-process dedup
  works today. The remaining piece is a **TTL/lease** (so a worker that dies mid-run doesn't hold its claim
  forever) and true multi-machine namespacing. Deferred until a genuine multi-machine fleet exists.
- **Heterogeneous runtimes in one fleet** — the `AgentRunner` seam makes GPT / Gemini / Aider runners
  drop-in; the work is writing each runner and its per-runtime claim intercept. They already share one brain
  and one claim registry.
- **Trustworthy numbers** — *instrument DONE, first distribution measured (2026-07-17).* `pnpm bench` now
  pins the task set (`benchmarks/core.json`), hard-isolates its scratch oracle, captures per-arm timing, and
  counts what used to be silent (worker early-stops, critic rejections) — a trial with failures is flagged
  suspect instead of quietly feeding the metric. First 5-trial run at defaults:
  - **LLM share of wall-clock: 97.1% ± 1.0** — robust; the routing premise above survives with a real spread.
  - **Redundancy reduction: NOT yet a trustworthy number** — mean 24% (all-tools) / 53% (Read-only) with
    sd ~130/65 and range −200%..+100%. Cause is visible in the new counters: **16/30 worker runs rejected**
    (mostly `maxTurns=8` early-stops), zero clean trials, and tiny redundancy counts (1–6) make the ratio
    quantization noise. The −53% headline in `proven.md` stays historical/directional.
  - **Second n=5 (2026-07-18, instrument v2: `AURALIS_MAX_TURNS=12` + core.json without the
    self-defeating "Be concise"): reduction 58.1% ± 12.9 (band 40.0–71.4) all-tools / 41.7% ± 28.9
    Read-only · LLM share 97.6% ± 1.4 · reuses = 2 in every trial.** The spread tightened 10× (sd 130→13)
    — but 11/30 runs still rejected, so ZERO clean trials and the S1 routing-gate band stays PENDING.
  - Shadow-log's first catch (per-item, both arms visible): **8/11 rejects are answer TRUNCATION on the
    long-form tasks** — results 5.7–8.5k chars cut mid-sentence, an output-length ceiling, NOT turns
    (accepted answers top out ~6.3k); 2 residual early-stops; 1 infra error the poison-guard correctly
    kept out of the brain.
  - **Best measured band so far — v2 instrument @ 16-turn budget (n=5, 2026-07-18): reduction
    70.6% ± 20.4 (42.9–90.0), rejects 8/30.** LLM share is rock-steady across every run: 96.4–97.6%.
  - **Negative result, recorded on purpose (2026-07-18):** a bundled v3 change (symmetric
    "finish every section" answer rule + stripping the inherited `CLAUDE_EFFORT`) measured WORSE —
    14/30 rejects, sd blew back up to 53 — and was REVERTED to v2 verbatim. Lesson re-learned: one
    variable per run; completion-clause prompts push essays INTO the ceiling.
  - Truncation mechanism status: turn-cap **REFUTED** (truncations at 10–24 turns while accepted runs
    reach 25); effort-env **REFUTED as deterministic** (A/B probe, n=1/arm, both clean); leading
    hypothesis = **per-MESSAGE output ceiling** on long final answers. The runner now records the final
    assistant message's `stop_reason` into the shadow-log — the next n=5 names the mechanism for free
    (`max_tokens` there = confirmed). Gate rule until then: quote the v2@16t band; S1 waits for clean trials.
