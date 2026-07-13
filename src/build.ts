// The build loop, shared by the CLI (run.ts) and the MCP build tool: run the fleet, verify against a spec,
// and on failure rework with the failure as feedback (bounded). Extracted so both paths self-heal identically
// instead of the loop living only in run.ts.
import { runFleet, type FleetCfg } from "./fleet";
import { runAcceptance, type AcceptResult } from "./accept";
import { explicitRunnerSpec } from "./runners";
import { makeReviewer, reviewBuild } from "./reviewer";
import type { MemoryAdapter } from "./memory";
import type { DagNode } from "./dag";
import { makeEmitter } from "./narrate";
import { log } from "./log";

export interface BuildOutcome {
  shared: Awaited<ReturnType<typeof runFleet>>;
  acc?: AcceptResult; // undefined when no spec was given (e.g. analyse, or build without accept)
  attempts: number; // reworks performed (0 = passed first try or no spec)
  firstFail: string; // what acceptance attempt #1 was missing ("" if it passed first try) — the retro lesson
}

// runFleet once; if an acceptance spec is given and fails, rework the fleet with the failure as feedback,
// up to `retries`, then fail-forward. onProgress (via cfg) narrates each rework live.
export async function buildWithRework(
  adapter: MemoryAdapter,
  nodes: DagNode[],
  cfg: FleetCfg,
  opts: { accept?: string; retries: number; projectDir: string },
): Promise<BuildOutcome> {
  let shared = await log.time("arm.shared", undefined, () => runFleet("shared", adapter, nodes, cfg));
  // Acceptance verdicts and reworks belong on the SAME run's timeline (fleet events live under shared.runId)
  // — a replay must show the whole build→verify→rework story, not stop at the last worker finding.
  const emitOn = (kind: string, actor: string, body: string) =>
    adapter.recordEvent &&
    makeEmitter({ adapter, runId: shared.runId, project: cfg.project, onEvent: cfg.onProgress ? (_k, _a, human) => cfg.onProgress!(human) : undefined })(kind, actor, body);
  const acceptEmit = (kind: string, body: string) => emitOn(kind, "acceptance", body);
  let acc: AcceptResult | undefined = opts.accept ? runAcceptance(opts.projectDir, opts.accept) : undefined;
  if (acc) acceptEmit(acc.pass ? "finding" : "repair", acc.pass ? `acceptance PASS (${opts.accept})` : `acceptance FAILED (${opts.accept}): ${acc.failLines.replace(/\n/g, "; ").slice(0, 200)}`);
  const firstFail = acc && !acc.pass ? acc.failLines : ""; // capture attempt #1's miss before rework overwrites acc

  // M5: after acceptance is green (or absent), an EXPLICITLY configured reviewer hunts the defects the
  // check missed; its findings feed the SAME rework loop as an acceptance failure. Opt-in: unset ⇒ zero
  // new spend. A failing build is never reviewed — acceptance feedback is already actionable and free.
  const reviewerSpec = explicitRunnerSpec("reviewer");
  const reviewerName = reviewerSpec ? `reviewer:${reviewerSpec.model ?? reviewerSpec.vendor}` : "";
  const reviewIfGreen = async (): Promise<string> => {
    if (!reviewerSpec || (acc && !acc.pass)) return "";
    const summaries = shared.outcome.provenance.map((p) => `- [${p.task.slice(0, 80)}] ${p.summary.slice(0, 200)}`).join("\n");
    const v = await log.time("reviewer.run", undefined, () => reviewBuild(makeReviewer(reviewerSpec, opts.projectDir), summaries, reviewerName));
    if (v.note) emitOn("note", reviewerName, v.note); // fail-open — surfaced, never silent
    emitOn(v.ok ? "finding" : "repair", reviewerName, v.ok ? `review clean — no defects found` : `review found ${v.findings.length} defect(s): ${v.findings.join("; ").slice(0, 300)}`);
    return v.findings.join("\n");
  };
  let defects = await reviewIfGreen();

  let attempts = 0;
  while (((acc && !acc.pass) || defects) && attempts < opts.retries) {
    attempts++;
    const acceptanceFailing = acc && !acc.pass;
    const failText = acceptanceFailing ? acc!.failLines : defects;
    const line = `↻ ${acceptanceFailing ? "acceptance FAILED" : "reviewer found defects"} — rework ${attempts}/${opts.retries}:\n${failText}`;
    console.log(line);
    cfg.onProgress?.(line);
    acceptEmit("repair", `rework ${attempts}/${opts.retries} — refitting the fleet with the ${acceptanceFailing ? "failure" : "review findings"} as feedback`);
    const fb = acceptanceFailing
      ? `\n\nA PRIOR ATTEMPT FAILED the acceptance check:\n${failText}\nRead the existing files in this directory and CHANGE only what is needed to make it pass; do not rewrite files that already work.`
      : `\n\nA REVIEWER found concrete defects in the previous attempt:\n${failText}\nRead the existing files and FIX exactly these defects; do not rewrite files that already work.`;
    const reworkNodes = nodes.map((n) => ({ ...n, question: n.question + fb }));
    shared = await log.time("arm.shared", `rework${attempts}`, () => runFleet("shared", adapter, reworkNodes, cfg));
    acc = opts.accept ? runAcceptance(opts.projectDir, opts.accept) : undefined;
    if (acc) acceptEmit(acc.pass ? "finding" : "repair", acc.pass ? `acceptance PASS after rework ${attempts} (${opts.accept})` : `acceptance still FAILING after rework ${attempts}: ${acc.failLines.replace(/\n/g, "; ").slice(0, 200)}`);
    defects = await reviewIfGreen();
  }
  return { shared, acc, attempts, firstFail };
}
