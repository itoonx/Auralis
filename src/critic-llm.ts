// M5 — the LLM Critic (docs/prd-multi-runner.md): grades SUBSTANCE ("does this actually answer the
// task?") where the heuristic only catches infra garbage. The heuristic runs FIRST as a free pre-filter —
// infra errors / stubs / empties never reach the model. Fail-open on provider error: a critic outage must
// never stall the fleet — but the fail-open is named in the verdict reason, never silent.
import { heuristicCritic, type Critic, type Verdict } from "./conductor";

const GRADE = (question: string, result: string) =>
  `You are a strict reviewer on an agent fleet. A worker was asked:\n${question}\n\n` +
  `It answered:\n${result.slice(0, 4000)}\n\n` +
  `Does this answer the task concretely and with substance (not a stub, not meta-talk, not a refusal)? ` +
  `Reply with JSON only: {"ok":true|false,"reason":"one line — if not ok, what is missing"}`;

export function makeLlmCritic(run: (prompt: string) => Promise<string>, name = "llm-critic"): Critic {
  return {
    async grade(question, result): Promise<Verdict> {
      const pre = heuristicCritic.grade(question, result); // free gate first — don't pay a model to reject garbage
      if (!pre.ok) return pre;
      try {
        const text = await run(GRADE(question, result));
        const m = text.match(/\{[\s\S]*\}/);
        const j = m ? JSON.parse(m[0]) : null;
        if (j && typeof j.ok === "boolean") return { ok: j.ok, reason: String(j.reason ?? (j.ok ? "ok" : "rejected")).slice(0, 200) };
        return { ok: true, reason: `${name}: unparseable verdict (fail-open)` }; // counted in the reason, not silent
      } catch (e) {
        return { ok: true, reason: `${name}: unavailable (fail-open): ${String((e as Error).message).slice(0, 80)}` };
      }
    },
  };
}
