# auralis

**A team of AI agents that explore a codebase together — and remember what they learn.**

Point auralis at any repository and it spins up a small society of Claude Code agents to analyse it.
One agent breaks your question into subtasks, others investigate, and — the important part —
everything they discover is written to a shared memory that *persists*. The next agent, and even
tomorrow's session, builds on that memory instead of starting from a blank page.

Most multi-agent setups are amnesiacs: every run starts cold, agents re-read the same files, and
nothing carries over. auralis is built around the opposite idea — a persistent, auditable shared
brain — and the payoff is measurably less wasted work.

## The idea

When you run several AI agents on the same codebase, two things go wrong:

- **They redo each other's work.** Agent A reads the core modules; Agent B reads them all over again,
  because it has no idea A already did.
- **They forget everything.** Close the session and all that hard-won context is gone — tomorrow's
  run re-derives it from scratch.

auralis fixes both by giving the agents a **shared brain** (a small, persistent memory) plus enough
**coordination** that they hand findings to each other instead of stepping on each other's toes. And
because trust matters, the brain is **append-only and auditable**: nothing it learns is ever silently
deleted, and every run can explain *why* it produced what it did.

## How it works

auralis runs its agents as a **society** on the [mozaik](https://github.com/jigjoy-ai/mozaik) runtime —
participants that react to each other on a shared event bus, rather than following a fixed script.

- **Planner** turns your one-line goal into a small graph of subtasks.
- **Conductor** walks that graph in order. Before each task it *pulls* relevant knowledge out of the
  brain; after each task it *pushes* the new findings back in.
- **Workers** are real Claude Code agents (via the Agent SDK — no API key, it reuses your existing
  login). What they read and search *is* their record of work.
- **MemoryLibrarian** is the bridge to the brain: it injects what's already known before a worker
  starts, and captures what it found afterwards.
- **Sentry** watches the bus and flags, live, when two workers wander into the same territory.
- **Auditor** records everything, so any run leaves a readable "why did it do that?" trail.

The brain itself is **oracle-lite** — a tiny local service (Bun + SQLite full-text search). It's
persistent, append-only, and fast enough that a finding is searchable the instant it's written.

## What it can do — proven on live runs

Every claim below was measured on real Claude Code runs (over auralis's own codebase), not asserted.

- **Agents share instead of repeat.** Two workers analysing related things used to both re-read the
  shared core; with the brain, the second one skips it. Redundant re-reads dropped to **zero**, and
  total files opened fell from 19 to 14.
- **They coordinate as a real team.** The Planner splits a goal into a dependency graph and workers
  run against it while the Sentry flags overlaps live. On a 3-task run, redundant work fell **53%**
  (17 → 8).
- **Memory outlives the session.** Seed the brain in one process, then open a *completely separate*
  process for a related task: it recalled the earlier findings and opened just **1 file** — where a
  cold run with no memory opened **9**.
- **Nothing is lost, and everything is explainable.** Outdated findings are *superseded* (flagged but
  still searchable), never deleted — there's no delete route at all — and every run writes a
  provenance trail of what each task recalled, explored, produced, and contributed.

## Architecture

```
             mozaik · one shared event bus (the society)
   ┌──────────────────────────────────────────────────────────┐
   │   Planner → Conductor → Worker ×N (Claude Code)           │
   │            MemoryLibrarian · Sentry · Auditor             │
   └──────────────────────────┬───────────────────────────────┘
                              │  learn · search · supersede (HTTP)
                       ┌──────▼───────┐
                       │  oracle-lite │   Bun + SQLite FTS5
                       │  the brain   │   persistent · append-only
                       └──────────────┘
```

## Getting started

You'll need **Node 20+**, **pnpm**, **Bun ≥ 1.2**, and **Claude Code** logged in (no API key required).

```bash
pnpm install
pnpm test        # fast offline proofs of the mechanics + a live memory check
```

Then point it at any repo:

```bash
# watch a team analyse a codebase and share findings, with a "why" trail
AURALIS_PROJECT_DIR=/path/to/your/repo pnpm dev

# prove the memory survives across separate processes
AURALIS_PROJECT_DIR=/path/to/your/repo pnpm persist

# see the append-only / supersession guarantees for yourself
pnpm values
```

Everything project-specific — the target repo, the goal, the tasks — comes from environment
variables, so auralis isn't tied to any one project. See `.env.example`.

## Project layout

| Path | What it is |
|---|---|
| `oracle-lite/server.ts` | the shared brain — learn / search / supersede / stats (no delete route) |
| `src/planner.ts`, `src/dag.ts` | turn a goal into a dependency graph |
| `src/conductor.ts` | walk the graph; pull-before / push-after the brain |
| `src/participants.ts` | Worker, MemoryLibrarian, Sentry, Auditor |
| `src/runner.ts` | drive Claude Code (or a deterministic stub for tests) |
| `src/audit.ts` | turn a run's provenance into a plain-language "why" |
| `src/run.ts` · `run-persist.ts` · `run-values.ts` | the three live demos |

## Honest notes

The live numbers are real but **directional** — how much you save depends on how much the tasks
overlap and how faithfully the agents reuse what they're handed. The deterministic tests pin down the
*mechanisms*; the live runs show them working. Making the numbers robust across many runs is next.

---

Built with [mozaik](https://github.com/jigjoy-ai/mozaik) and Claude Code.
