# PRD — Activity Timeline (the run ledger)

**Status:** proposed · **Pillar:** 4 · Observability · **Owner:** auralis

## 1. Problem

Today a run's coordination is legible only *after the fact* and only *locally*:

- The bus carries **findings** (results), never **intent** — you can't see "worker A is *about to* analyse auth" while it happens, only what it found once done.
- Observability is scattered across three sinks with different shapes: `Auditor` → `trace-*.jsonl` (per run, on disk), `Sentry.warnings` (in memory), `log.ts` → `timing.jsonl` (timing, not narrative).
- None of it is **human-readable at a glance** — a reader gets JSON blobs or a timing table, not "A and B both touched `config.ts`."
- None of it is **persisted centrally or replayable** — close the process and the narrative is gone; there's no way to ask oracle "show me what the fleet did on the last run of project X."

We want the coordination between agents to be **visible as it happens, in plain language, and replayable later** — one timeline of the whole run.

## 2. Goals

1. Every meaningful coordination moment emits one **event** with a concise **human line**.
2. Events cover **intent** ("about to do X"), not just outcomes.
3. Events **persist to oracle-lite** (append-only, like findings) and are **queryable by run and project**.
4. A reader can **replay the whole timeline** ordered as it happened: `pnpm timeline`.
5. The timeline reconstructs **causal structure** (which task spawned which) automatically from the DAG — not from bookkeeping the agent has to remember.
6. The run ends with a **scorecard** — the timeline is *evidence* (what coordination prevented), not just a log.
7. Zero impact on run correctness or speed — emission is **best-effort, non-blocking**, exactly like graph-build.

## 3. Non-goals

- The human line is a deterministic template. A worker MAY narrate its own plan via an opt-in `note` tool (see §5/§8), but no path *requires* an LLM and no LLM *writes* the structural lines — an unnarrated run still gets a complete timeline. *ponytail: deterministic spine, LLM enriches.*
- No live web UI in v1 — a terminal reader is enough. (A self-contained HTML artifact is a v1.1 option; see §12.)
- No new event *bus* — reuse the mozaik bus and the existing oracle sidecar. No new service.
- No agent-to-agent free-form chat / forum. "Agents talk to each other" = they narrate onto one shared, visible timeline; overlap is *prevented* by the claim registry, not *discussed* away (see §4).

## 4. Positioning — how this beats the reference (arra-oracle-v3)

arra-oracle-v3 is a larger sibling of oracle-lite (same stack: Bun + SQLite FTS5 + LanceDB, same port 47778) and it already ships a feed/trace/forum/presence stack. Studying it **validates the direction** (its `POST /api/feed {oracle, event, project, session_id, message}` is our timeline almost field-for-field) — but its coordination is **advisory and agent-asserted**, which is exactly where we win. We do not out-*feature* it; we out-*structure* it.

| arra has | arra's approach (the weakness) | how auralis is superior |
|---|---|---|
| **feed** (timeline) | `feed.log` file; the message is whatever the agent writes — as complete as the agent is disciplined | **table + `seq` + typed `kind`s**; the Conductor **guarantees** intent+finding per task even if the LLM says nothing — the timeline can't be half-empty |
| **trace chain** (prev/next/parent/child) | the agent must call `trace_link` to build the chain — LLM forgets → chain breaks | events carry the **DAG `node_id` + `parent_node`** the Planner already computed → causal tree is **derived, not asserted** |
| **forum + inbox** (agents converse, GitHub-synced) | agents chat to *avoid* colliding — depends on LLM discipline | the **claim registry makes collision mechanically impossible**; a `dedup` event proves coordination *happened*, enforced — no conversation needed |
| **handoff / session summary** | the agent summarises and hands off *manually* every time | the brain **recalls by meaning automatically** — proven 9→1 files across separate processes; no handoff step |
| **god-table trace** (timeline+timing+distill+agent in one row) | easy to correlate, tightly coupled | three modular sinks **cross-linked by `runId`+`node_id`** — same correlation, each swappable |
| **OracleNet presence** (multi-instance heartbeat) | knows other oracles are *online* — does not dedup work across them | the claim policy lives in the **middle layer** → many processes/machines **don't do the same file twice** (coordination, not just awareness) |
| capabilities **asserted** in the README | "it can do X" | auralis **measures**: redundant→0, prevented-dupes=4, timing 99.9% — and the scorecard (§10) makes every run say so |

**Thesis in one line:** arra makes one agent *remember* and *see who's online*; auralis makes many agents *not collide* and *proves it*. Every row above converts "the agent has to be diligent" into "the structure does it."

## 5. What counts as an event

| kind | emitted when | by | example human line |
|------|--------------|-----|--------------------|
| `phase` | run/level starts & ends | conductor | `━ level 1 · 3 tasks` |
| `intent` | a worker is assigned & starting a task | conductor | `▸ A starting: how does auth work?` |
| `note` | a worker narrates its own plan/progress mid-task (opt-in tool) | worker (LLM) | `✎ A: checking router → middleware → session next` |
| `finding` | a worker finishes | conductor | `✓ A: session tokens live in auth/session.ts (4 files)` |
| `dedup` | a Read is blocked — teammate owns the file | claim gate | `⇄ B skipped auth/session.ts — A owns it` |
| `overlap` | two workers explored the same target | sentry | `⚠ A & B both touched config.ts` |
| `repair` | the Critic rejected an answer → retry | conductor | `↻ A retry: stopped before answering` |

**intent A+B.** `intent` (A) is deterministic (Conductor at assignment) so the timeline is *always* complete; `note` (B) is the worker's own words via an opt-in `mcp__oracle__note` tool — deep when it fires, never required. Same proven pattern as the brain: deterministic capture + optional worker-pull enrichment.

## 6. Data model

New oracle-lite table, append-only (consistent with the no-delete values layer — no delete route):

```sql
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic, server-assigned -> stable ordering
  run_id      TEXT,     -- groups one fleet run, e.g. "auralis:shared:2026-07-06T10:15:00.000Z"
  project     TEXT,     -- brain namespace (recall/timeline scoped to it)
  kind        TEXT,     -- phase | intent | note | finding | dedup | overlap | repair
  actor       TEXT,     -- "A" | "conductor" | "sentry" | "critic"
  human       TEXT,     -- the concise line shown to a person
  node_id     TEXT,     -- the DAG task node this event belongs to (null for run-level phase events)
  parent_node TEXT,     -- JSON array of the node's dependsOn ids -> causal tree, no agent bookkeeping
  refs        TEXT,     -- JSON array of file/doc ids involved (nullable)
  ts          TEXT      -- ISO 8601 UTC, new Date().toISOString() — same format as docs.created_at
);
```

`node_id` + `parent_node` are captured at emit time from the DAG the Planner already produced — so the causal tree is reconstructed for free (this is the "beat arra's manual trace_link" move, §4). Ordering is by `seq` (not `ts`) so same-millisecond events under concurrency stay stable.

## 7. API (oracle-lite)

- `POST /api/event` — body `{ runId, project, kind, actor, human, nodeId?, parentNode?, refs? }` -> `{ ok: true, seq }`. Append one.
- `GET /api/timeline?run=<runId>&project=<p>&limit=<n>` -> `{ events: [...] }` ordered by `seq`. `run` optional (omit = latest across project); `limit` default 500.
- The causal (tree) view is reconstructed **client-side** by the reader from `node_id` + `parent_node` — no extra route. *ponytail: don't add a grouping endpoint until a consumer needs server-side grouping.*

Both mirror the existing route style in `oracle-lite/server.ts`. No auth (local sidecar), same as every other route.

## 8. Surfaces

- **Adapter** (`src/memory.ts`): `recordEvent(e)` and `timeline(opts)` added to `MemoryAdapter`; `OracleAdapter` calls the routes, `NullMemoryAdapter` no-ops (no brain -> no timeline).
- **Emit helper** (`src/narrate.ts`, new): `makeEmitter({ adapter, runId, project })` -> `emit(kind, actor, human, { nodeId, parentNode, refs })`. Fire-and-forget POST (never awaited on the hot path; failures swallowed) + `log.event()` so `AURALIS_LOG_TIMING=1` streams it to stderr live too.
- **Call sites**: `conductor.ts` (phase/intent/finding/repair, with the node's id + dependsOn), `fleet.ts` claim closure (dedup), `participants.ts` `Sentry` (overlap). `coordinate()` takes an optional `emit` in `opts`, like `critic` — Conductor stays decoupled.
- **Worker self-narration** (`note`, opt-in B): add a `mcp__oracle__note` tool to `brain-mcp.ts` (reusing the exact MCP-server-per-worker pattern that already serves search/learn/decide) and to `runner.ts` `allowedTools`. The tool calls `emit("note", workerId, text)`. Advisory — if the LLM never calls it, the `intent` spine still covers that worker.
- **Reader** (`src/run-timeline.ts` + `pnpm timeline`): GET `/api/timeline`, print an indented, timestamped, colored feed (reuse `log.ts` color helpers), then the **scorecard** (§10). `AURALIS_RUN=<id>` or newest.

## 9. Human line format

`{glyph} {actor}{detail}` — glyph per kind (`━ ▸ ✎ ✓ ⇄ ⚠ ↻`), <= ~100 chars, no JSON. The reader prints:

```
━━━ timeline · auralis:shared:2026-07-06T10:15 ─────────────
  10:15:00.1  ━ level 1 · 3 tasks
  10:15:00.2  ▸ A starting: how does auth work?
  10:15:00.9  ✎ A: checking router → middleware → session
  10:15:01.4  ⇄ B skipped auth/session.ts — A owns it
  10:15:03.9  ✓ A: session tokens live in auth/session.ts (4 files)
  10:15:04.1  ⚠ A & B both touched config.ts

  scorecard · 3 tasks · deduped 1 · overlaps 1 · repairs 0 · notes 1
```

## 10. Run scorecard

Printed by the reader (and returnable from the timeline), computed purely from the run's events — no new storage. It turns the log into evidence (the §4 "measured, not asserted" edge):

- `tasks` — distinct `node_id` seen
- `deduped` — count of `dedup` events (duplicate reads the claim gate prevented)
- `overlaps` — count of `overlap` events (Sentry flags)
- `repairs` — count of `repair` events (self-repair kicked in)
- `notes` — count of `note` events (how much the workers narrated)

v1 keeps it to what the events already carry (self-contained). Reuse-rate / recall counts can join later from provenance if wanted.

## 11. Acceptance criteria

1. A `pnpm dev` run writes >= one event of each applicable kind to oracle; `pnpm timeline` replays them in order with human lines + the scorecard.
2. Killing oracle mid-run does **not** fail or slow the run (best-effort proven by a test with a throwing adapter).
3. Timeline is scoped: a query for project X never returns project Y's events.
4. Causal: every task's events carry its `node_id`, and a task's `parent_node` matches its DAG `dependsOn` — the tree reconstructs without any agent link call.
5. Append-only: no delete route for events; ordering stable under `AURALIS_PARALLEL=3`.
6. Deterministic tests cover: event schema + human-line rendering, timeline ordering by `seq`, scorecard counts, and Null adapter no-op. No LLM in tests.

## 12. Rollout & roadmap

- **v1 flag:** on by default when a brain is present (cheap, best-effort). `AURALIS_TIMELINE=0` opts out. No migration — the table is created on boot like `edges`.
- **v1.1 — earn the multi-machine "superior" claim:** claim **TTL/lease** so a worker that dies mid-run doesn't hold its file forever (arra detects dead instances via heartbeat; we need lease expiry + release-on-complete). This closes the one real gap behind our OracleNet-beating claim in §4.
- **v1.1 — visual, done lazy:** a single self-contained **HTML timeline artifact** (no web service) — beats arra's dashboard/map3d with far less to maintain.
- **later — retire the duplication:** fold the `Auditor` into an emitter so `trace-*.jsonl` and the timeline aren't two homes for the same data.

## 13. Open questions

- Retention: events are append-only forever and there are more per run than findings. A `max`-row cap or per-project prune is future work. *ponytail: unbounded is fine until a run's timeline is genuinely huge.*
- Per-`note` granularity: v1 emits one `finding` per task on completion; whether to also emit each mid-task `mcp__oracle__learn` as an event is a later refinement.
