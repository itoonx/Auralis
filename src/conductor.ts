// The Conductor walks a planned DAG in dependency order. Before each task it pulls relevant context
// from the shared brain (so later tasks reuse earlier findings); after each task it pushes the new
// finding back. It records per-task PROVENANCE (what was recalled, explored, produced, contributed)
// so a run's output is auditable — "why did the society produce this?".
import type { DagNode } from "./dag";
import { topoOrder } from "./dag";
import type { Worker, MemoryLibrarian } from "./participants";
import type { Exploration } from "./runner";

export interface TaskProvenance {
  task: string;
  recalled: string[]; // ids of prior findings injected into this task
  explored: string[]; // distinct targets this task explored
  summary: string; // what the task produced (truncated)
  learnedId: string; // the finding this task contributed back
}

export interface FleetOutcome {
  perWorker: { id: string; explored: Exploration[] }[];
  reuses: number;
  provenance: TaskProvenance[];
}

export async function coordinate(
  nodes: DagNode[],
  makeWorker: (id: string) => Worker,
  librarian: MemoryLibrarian,
): Promise<FleetOutcome> {
  const perWorker: { id: string; explored: Exploration[] }[] = [];
  const provenance: TaskProvenance[] = [];
  let reuses = 0;
  for (const node of topoOrder(nodes)) {
    const ctx = await librarian.injectFor(node.question);
    if (ctx.hitIds.length > 0) reuses++;
    const worker = makeWorker(node.id);
    const res = await worker.run(node.question, ctx.context); // emits finding on the bus → Sentry reacts
    const learnedId = await librarian.capture(node.id, node.question, res);
    perWorker.push({ id: node.id, explored: res.explored });
    provenance.push({
      task: node.id,
      recalled: ctx.hitIds,
      explored: [...new Set(res.explored.map((e) => e.target))],
      summary: res.result.slice(0, 300),
      learnedId,
    });
  }
  return { perWorker, reuses, provenance };
}

export interface SessionMetrics {
  label: string;
  cold: boolean;
  crossSessionRecall: number;
  explored: number;
}

// Run ONE independent analysis session against the shared brain. The only thing linking it to other
// sessions is the (persistent) brain. crossSessionRecall is measured BEFORE this session writes
// anything, so any hit came from a prior session.
export async function runOneSession(
  goal: string,
  label: string,
  librarian: MemoryLibrarian,
  makeWorker: (id: string) => Worker,
  cold = false,
): Promise<SessionMetrics> {
  const pre = await librarian.injectFor(goal);
  const crossSessionRecall = pre.hitIds.length;
  const worker = makeWorker(label);
  const res = await worker.run(goal, pre.context);
  await librarian.capture(label, goal, res);
  return { label, cold, crossSessionRecall, explored: new Set(res.explored.map((e) => e.target)).size };
}
