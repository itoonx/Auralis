// The audit inspector: turn a run's provenance into a plain-language answer to "why did the society
// produce this?" — what each task built on, explored, produced, and contributed back to the brain.
import type { TaskProvenance } from "./conductor";

export function explainProvenance(prov: TaskProvenance[]): string {
  const out = ["WHY — how this run produced its output:"];
  for (const p of prov) {
    out.push(`\n■ task "${p.task}"`);
    out.push(`  · built on ${p.recalled.length} prior finding(s)${p.recalled.length ? `: ${p.recalled.join(", ")}` : " (none — cold start)"}`);
    out.push(`  · explored ${p.explored.length} target(s)${p.explored.length ? `: ${p.explored.slice(0, 8).join(", ")}${p.explored.length > 8 ? " …" : ""}` : ""}`);
    out.push(`  · produced: ${p.summary.replace(/\s+/g, " ").trim().slice(0, 160)}${p.summary.length > 160 ? "…" : ""}`);
    out.push(`  · contributed finding ${p.learnedId || "(none)"} back to the brain`);
  }
  return out.join("\n");
}
