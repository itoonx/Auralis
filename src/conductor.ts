// The Conductor walks a planned DAG level by level (level N waits for N-1, so a task reuses what its
// prerequisites found; independent tasks within a level run concurrently up to a cap). A Critic grades
// each answer and self-repair retries the rejected ones. Per-task PROVENANCE (recalled/explored/
// produced/contributed/attempts) makes a run auditable — "why did the society produce this?".
import type { DagNode } from "./dag";
import { buildLevels } from "./dag";
import type { Worker, MemoryLibrarian } from "./participants";
import type { Exploration } from "./runner";
import { log } from "./log";
import type { Emit } from "./narrate";

// One narrated line: collapse whitespace, keep it short enough to read at a glance.
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 90);

export interface TaskProvenance {
  task: string;
  recalled: string[];
  explored: string[];
  summary: string;
  learnedId: string;
  attempts?: number;
}

export interface FleetOutcome {
  perWorker: { id: string; explored: Exploration[] }[];
  reuses: number;
  repairs: number; // tasks that needed more than one attempt (self-repair kicked in)
  provenance: TaskProvenance[];
}

// A Critic grades a worker's answer; the Conductor retries rejected tasks (self-repair).
export interface Critic {
  grade(question: string, result: string): { ok: boolean; reason: string };
}

// Default heuristic Critic: reject empty answers, early-stop stubs, non-answers, and infra errors.
// The infra pattern matters: a real run with an exhausted API credit returned "Credit balance is too low"
// as its "finding", which was then captured into the brain claiming its files were fully covered —
// memory poisoning by outage, no attacker needed. The critic is the first gate against that.
const INFRA_ERROR = /credit balance|rate.?limit|overloaded|billing|invalid.*api.?key|api error|quota exceeded/i;
export const heuristicCritic: Critic = {
  grade(_question, result) {
    const r = result.trim();
    if (!r) return { ok: false, reason: "empty result" };
    if (r.startsWith("(worker stopped early")) return { ok: false, reason: "stopped before answering" };
    if (r.length < 200 && INFRA_ERROR.test(r)) return { ok: false, reason: "infrastructure error, not an answer" };
    if (r.length < 20) return { ok: false, reason: "answer too short to be real" };
    return { ok: true, reason: "ok" };
  },
};

// Bounded-concurrency map that preserves input order. limit=1 is strictly sequential.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  });
  await Promise.all(lanes);
  return results;
}

export async function coordinate(
  nodes: DagNode[],
  makeWorker: (id: string) => Worker,
  librarian: MemoryLibrarian,
  opts: { concurrency?: number; maxRetries?: number; critic?: Critic; emit?: Emit } = {},
): Promise<FleetOutcome> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const maxRetries = Math.max(0, opts.maxRetries ?? 0); // 0 = no self-repair (original behaviour)
  const critic = opts.critic ?? heuristicCritic;
  const emit = opts.emit; // narrate coordination moments onto the activity timeline (no-op if unset)
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const perWorker: FleetOutcome["perWorker"] = [];
  const provenance: TaskProvenance[] = [];
  let reuses = 0;
  let repairs = 0;

  const runNode = async (node: DagNode) => {
    // intent (A): deterministic "about to do X" — the timeline is complete even if the worker never narrates.
    emit?.("intent", node.id, `${node.id} starting: ${oneLine(node.question)}`, { nodeId: node.id, parentNode: node.dependsOn });
    const injectEnd = log.start("brain.inject", node.id); // pull: recall + graph-expand before the worker runs
    const ctx = await librarian.injectFor(node.question);
    injectEnd({ hits: ctx.hitIds.length });
    let res = await log.time("worker.run", node.id, () => makeWorker(node.id).run(node.question, ctx.context)); // emits finding on the bus
    let verdict = critic.grade(node.question, res.result);
    let attempts = 1;
    while (!verdict.ok && attempts <= maxRetries) {
      emit?.("repair", node.id, `${node.id} retry: ${verdict.reason}`, { nodeId: node.id });
      const feedback = `A reviewer rejected the previous attempt (${verdict.reason}). Answer the task directly and concretely.`;
      const retryContext = ctx.context ? `${ctx.context}\n\n${feedback}` : feedback;
      res = await log.time("worker.run", `${node.id}#retry${attempts}`, () => makeWorker(node.id).run(node.question, retryContext));
      verdict = critic.grade(node.question, res.result);
      attempts++;
    }
    const targets = [...new Set(res.explored.map((e) => e.target))];
    emit?.("finding", node.id, `${node.id}: ${oneLine(res.result)} (${targets.length} files)`, { nodeId: node.id, parentNode: node.dependsOn, refs: targets });
    // Capture ONLY results the critic accepted. A rejected result (infra error, stub) written to the brain
    // claims its files are "fully covered" — poisoning every future run's recall. Better no memory than a lie.
    let learnedId = "";
    if (verdict.ok) {
      const captureEnd = log.start("brain.capture", node.id); // push: learn + (optional) graph-build
      learnedId = await librarian.capture(node.id, node.question, res);
      captureEnd();
    } else {
      emit?.("overlap", node.id, `${node.id} result rejected (${verdict.reason}) — NOT captured to the brain`, { nodeId: node.id });
    }
    return { node, ctx, res, learnedId, attempts };
  };

  const levels = buildLevels(nodes);
  for (let li = 0; li < levels.length; li++) {
    const levelNodes = levels[li].map((id) => byId.get(id)!);
    emit?.("phase", "conductor", `level ${li + 1}/${levels.length} · ${levelNodes.length} task(s)`);
    const done = await mapWithConcurrency(levelNodes, concurrency, runNode);
    for (const r of done) {
      if (r.ctx.hitIds.length > 0) reuses++;
      if (r.attempts > 1) repairs++;
      perWorker.push({ id: r.node.id, explored: r.res.explored });
      provenance.push({
        task: r.node.id,
        recalled: r.ctx.hitIds,
        explored: [...new Set(r.res.explored.map((e) => e.target))],
        summary: r.res.result.slice(0, 300),
        learnedId: r.learnedId,
        attempts: r.attempts,
      });
    }
  }
  return { perWorker, reuses, repairs, provenance };
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
