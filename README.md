# auralis — a coordinated agent society with a persistent, auditable shared brain

Multiple **Claude Code workers** analyse a codebase as a society: a **Planner** decomposes one goal
into a small dependency graph of subtasks, a **Conductor** walks it, each worker's findings land in a
persistent shared **brain**, and later workers — even in separate sessions/processes — reuse them
instead of re-exploring what a teammate already covered. A reactive **Sentry** flags overlapping work
live on the bus, and every run leaves an auditable "why" trail.

Built on **mozaik** (the coordination substrate); the brain is our own **oracle-lite** (Bun +
bun:sqlite FTS5, append-only, persistent). Works against **any** codebase — target repo, goal, and
tasks all come from the environment.

## Milestones (all proven on live data)
- **#1 Shared brain proven** — two workers share knowledge through the brain, beating a
  no-shared-memory baseline on redundant work.
- **#2 Coordinated society** — a Planner-decomposed DAG + reactive coordination. Example 3-task fleet:
  ```
  baseline: fleet-redundant = 17, sentry overlap warnings = 17
  shared  : fleet-redundant = 8,  sentry overlap warnings = 8, reuses = 2   → 52.9% reduction
  ```
- **#3 Persistence across sessions** — a SEPARATE-process session recalls an earlier session's
  findings from the on-disk brain:
  ```
  warm session (fresh process): recall = 1, explored = 1
  cold session (no brain)     : recall = 0, explored = 9
  ```
- **#4 Values-aligned & auditable** — the brain is **append-only** (nothing is deleted; obsolete
  findings are **superseded** — flagged while kept intact and searchable), there is **no delete
  route**, and every run writes an inspectable **"why" provenance** trail (what each task recalled,
  explored, produced, and contributed).

## Pieces
- `oracle-lite/server.ts` — persistent, append-only shared brain: `learn`, `search`, `supersede`, `stats`, `health` (no delete route)
- `src/dag.ts` — dependency-graph levels + cycle detection
- `src/planner.ts` — decomposes a goal into a DAG (tolerant parse, degrades gracefully)
- `src/participants.ts` — `Worker`, `Auditor` + reactive `Sentry`, `MemoryLibrarian`
- `src/conductor.ts` — `coordinate` (fleet over a DAG, records provenance) + `runOneSession`
- `src/audit.ts` — `explainProvenance`: "why did the society produce this?"
- `src/session.ts` / `src/run-persist.ts` — a session as its own process + the cross-session harness
- `src/runner.ts` — `ClaudeCodeRunner` (Agent SDK, no API key) + `StubRunner`
- `src/metrics.ts` — pairwise + fleet redundancy measures
- `src/run.ts` / `src/run-values.ts` — the live fleet harness + the values/append-only demo

## Run
```bash
pnpm test                                       # 14 deterministic proofs + live read-after-write
AURALIS_PROJECT_DIR=/path/to/repo pnpm dev       # live fleet + "why" provenance (M2)
AURALIS_PROJECT_DIR=/path/to/repo pnpm persist    # cross-session persistence, separate processes (M3)
pnpm values                                      # append-only + supersession-not-deletion (M4)
```
Prereqs: Node 20+, pnpm, Bun >= 1.2, Claude Code logged in (no API key). Config via `.env` (see `.env.example`).

## Note
Live reductions depend on task overlap and how compliantly agents reuse injected findings; the
deterministic tests prove the mechanisms, the live numbers are directional.
