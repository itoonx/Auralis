// M5 — the Reviewer role: after a build passes acceptance, hunt DEFECTS the check missed (real bugs,
// contract violations, unhandled edges) — distinct from the Critic, which grades whether an ANSWER has
// substance. Defect hunting needs the actual files, so the reviewer is a tool-RUNNING role built on the
// same worker machinery (makeRunnerFor: claude → Agent SDK explore tools, gpt/glm → ToolLoopRunner).
// Opt-in via AURALIS_REVIEWER_RUNNER / config runners.reviewer. Fail-open on outage — named, never silent.
import type { AgentRunner } from "./runner";
import { makeRunnerFor, type RunnerSpec } from "./runners";

export interface ReviewVerdict {
  ok: boolean;
  findings: string[]; // concrete defects ("file.ts: what breaks and when") — empty when ok
  note: string; // fail-open / unactionable-verdict explanations — surfaced on the timeline, never silent
}

const REVIEW = (taskSummaries: string) =>
  `You are the REVIEWER on an agent fleet. A build just passed its acceptance check. Hunt the DEFECTS ` +
  `the check missed: real bugs, contract violations, unhandled edge cases — not style, not preferences.\n\n` +
  `What the workers report they built:\n${taskSummaries}\n\n` +
  `Read the actual files in this directory to verify the claims. Report ONLY defects you can point at ` +
  `concretely (file + what breaks and when); an empty list is a perfectly good answer.\n` +
  `Reply with JSON only: {"ok":true|false,"findings":["file.ts: what breaks and when", "..."]}`;

export function makeReviewer(spec: RunnerSpec, projectDir: string, maxTurns = 12): AgentRunner {
  return makeRunnerFor(spec, { cwd: projectDir, maxTurns }); // explore tools only (no build) — a reviewer never edits
}

export async function reviewBuild(runner: AgentRunner, taskSummaries: string, name = "reviewer"): Promise<ReviewVerdict> {
  try {
    const res = await runner.run(REVIEW(taskSummaries));
    const m = res.result.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j && typeof j.ok === "boolean") {
      const findings = Array.isArray(j.findings) ? j.findings.map(String).filter(Boolean) : [];
      if (findings.length) return { ok: false, findings, note: "" };
      // "not ok" without a concrete defect is unactionable — pass, but say so (rework needs a target).
      if (!j.ok) return { ok: true, findings: [], note: `${name}: rejected without concrete findings (fail-open)` };
      return { ok: true, findings: [], note: "" };
    }
    return { ok: true, findings: [], note: `${name}: unparseable verdict (fail-open)` };
  } catch (e) {
    return { ok: true, findings: [], note: `${name}: unavailable (fail-open): ${String((e as Error).message).slice(0, 80)}` };
  }
}
