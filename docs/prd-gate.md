# PRD — Gate-first generated verifier: an objective check per build, not 4 canned specs

Date: 2026-07-24 (updated 2026-07-25) · Basis: adopted from disler/fusion-harness `/auto-validate` (memory
`fusion-harness-adopt`). Built on the existing acceptance seam (`src/accept.ts runAcceptance`,
`src/build.ts buildWithRework`), not a new mechanism.

**Status:** M1 (`5de21fb`) + M2/M3 (`b50beef`) **SHIPPED** — gate module, reliable gen (10/10 valid 1st try),
wired opt-in into build mode (keeps the 4 fixed specs as fallback), proven end-to-end on a non-canned build
(gate generated → fleet built → gate executed real files → PASS, ground truth agreed). M4 came free with M3
(gate FAIL lines feed the rework loop). **M5 DEFERRED (YAGNI)** — see M5's row for the triggers that should
re-open it. **M6 (bench) = the recommended next step.** Load-bearing lesson: generate the gate BEFORE the
fleet build (a one-shot SDK call after the fleet's heavy concurrent use fails silently).

## The problem, measured

Auralis build mode verifies work against **4 hardcoded specs** (`src/accept.ts`: rps/todo/restapi/calc). Any
other build request gets only the LLM critic — and the critic grades the worker's **prose report**
(`src/critic-llm.ts` GRADE reads `result` text), never the files. Measured 2026-07-24 (real gpt-5.6-sol
critic vs a generated gate, 4 fizzbuzz builds, known truth): **gate wrong 0/4, critic wrong 1/4.** The gate's
edge is **structural, not intelligence** — a strong code-reading critic tied the gate on code-visible bugs,
but on `report-lies` (report claims correct code, disk has the bug) the critic passed it 3/3 while the gate
executed the disk and caught it. In production the worker reports a *summary*, not code
(`src/participants.ts` build prompt), so report≠reality is the **common** case → the gate is the only thing
that verifies the real artifact. It is also the objective verifier the autonomous path needs
(`[[souls-agent-team-design]]` / memory).

## Non-goals

- **Not replacing the LLM critic** — analyze-mode tasks have no executable artifact and still need it. The
  gate is for BUILD tasks (something you can run/inspect).
- **Not a new runner/config mechanism** — reuse `resolveRunnerSpec` (architect writes the gate) and the
  existing build/rework loop.
- **Not the autonomous loop itself** — that's M7 / the S4 bridge, gated last.

## What already exists (prototype, tested)

`src/gate.ts`: `generateGate(request, cwd, run)` (architect writes a Node gate script), `runGate(script, ws)`
→ `{pass, malformed, passLines, failLines}`, `gateInvalidReason(script)` (syntax + baseline-must-go-red).
Self-check + typecheck pass. NOT wired into build.ts. Two reliability facts the measurement surfaced: a
generated gate can **crash** (undefined var / leaked prose) and gate-gen can hit an **SDK turn-cap throw** —
both must be handled (M2).

## Milestones — each ships a real, runnable test

| # | Milestone | Real test (the gate on the milestone itself) |
|---|---|---|
| **M1 ✅** | **Land the module + unit tests.** `test/gate.test.ts`: baseline-red, malformed-crash detection, PASS/FAIL parse, `gateInvalidReason`. Commit `src/gate.ts`. | ✅ 8 tests green (`5de21fb`) |
| **M2 ✅** | **Reliable gate generation.** `generateValidGate` (retry on invalid/throw) + `textRunnerFor` optional `maxTurns`. | ✅ **10/10 valid on 1st try** at maxTurns=4 (`b50beef`) |
| **M3 ✅** | **Wire into build mode (opt-in).** `buildWithRework` takes optional `gate`; generate BEFORE the build (fresh SDK — post-fleet gen fails silently), run it after each attempt; MCP `build` tool `gate:true`; fall back to the 4 fixed specs. | ✅ real e2e build of `rev.js`: gate→build→PASS, ground truth agreed (`b50beef`) |
| **M4 ✅** | **Structured FAIL → rework feedback.** Gate `failLines` (expected/found/at/fix) flow into the rework loop via `acc.failLines`. | ✅ free with M3; A/B vs soft feedback → M6 |
| **M5 ⏸ DEFERRED (2026-07-25, YAGNI)** | **Triage + one gate self-repair** (fusion's guard). After K fails, a diagnostician reads real state (not the worker's claims); if the gate itself is defective it repairs it ONCE (old kept, re-run free, checks never weakened). **RE-OPEN when:** gate-gen reliability drops · the builder oscillates/stuck-fails a gate across rounds · a gate is itself wrong (demands something never asked) · or building autonomous S4 (unattended — a wrong gate burns the whole budget in a loop). Prerequisite for SAFE autonomy. | a deliberately over-strict gate → triage repairs → loop ends green without weakening a real check |
| **M6** | **Gate-vs-critic benchmark** (mean±spread, the bench discipline from `docs/roadmap.md`). Generalise the experiment: N tasks × {correct, planted-defect, report-lies} → false-accept rate (gate vs critic), gate-gen reliability, cost/build. | `pnpm bench-gate` produces a distribution, not n=1 |
| **M7** | **(stretch) S4-bridge: scoped autonomous build-with-gate.** Now that green is objective, an unattended loop can safely stop. Budget + no-progress killer + human checkpoint (per `[[souls-agent-team-design]]`), on ONE real recurring task. | point at a real small task, run unattended with a token budget; measure delegated-success + cost vs doing it by hand |

## Task breakdown (M1–M3 — the "run it full-scale" core)

- **M1** · add `test/gate.test.ts` (4 cases above, deterministic, no LLM) · commit gate.ts + tests.
- **M2** · extract `generateValidGate` (retry on `gateInvalidReason` or throw, cap N, log attempts) · fix
  gate-gen turn budget (the claude text runner throws "max turns (1)" on long gates — give gate-gen its own
  spec/turns) · a tiny reliability probe over a fixed task list.
- **M3** · extend `FleetCfg`/build opts with `gate?: {request}` · in `buildWithRework`: generate+validate
  gate before the loop, `runGate` after each attempt, merge with/replace `runAcceptance` · thread through
  `src/run.ts` and `src/mcp-server.ts` build tool (new optional `gate` arg) · **the real end-to-end run.**

## Risks (measured or named)

| Risk | Mitigation |
|---|---|
| Generated gate crashes / leaks prose (SEEN in v1) | `gateInvalidReason` (syntax + baseline-red) + retry; never trust an unvalidated gate |
| Gate-gen hits the model turn-cap (SEEN once) | retry-on-throw + a dedicated gate-gen turn budget (M2) |
| A gate too STRICT fails correct work | baseline-red proves it can fail; M5 triage repairs a defective gate ONCE, forbidden to weaken real checks |
| A gate too WEAK passes wrong work | baseline MUST fail red (a gate green on an empty project is rejected) |
| Only helps BUILD tasks | scope: analyze mode keeps the LLM critic; the gate is opt-in per build |
| Extra architect call per build | same cost shape as the planner; only on gated builds |

## Open questions

1. **Gate language:** Node (matches auralis, done) vs fusion's PEP723 uv-python (auralis has python via the
   bge-sidecar). Node keeps it dependency-free; revisit only if a task needs python-only checks.
2. **Replace or augment the 4 fixed specs?** Keep them as fast deterministic fallbacks, or regenerate a gate
   even for rps/todo? Decide at M3 — leaning keep-as-fallback (they're proven + free).
3. **Does M4's structured feedback help enough to measure?** M6's bench should A/B soft-vs-structured feedback
   on rework rounds before committing M4 as default.
4. **M7 autonomy scope** — which real recurring task, whose budget, what checkpoint cadence. Decide when M1–M6
   are green (don't front-run the verifier the autonomous loop depends on).
