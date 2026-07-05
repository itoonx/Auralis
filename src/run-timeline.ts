// pnpm timeline — replay a run's activity timeline from the shared brain: the narrated feed + a scorecard.
// Read-only; talks to a running oracle-lite (start one with `pnpm oracle`, or just run `pnpm dev` first).
// AURALIS_PROJECT scopes it; AURALIS_RUN pins a specific run (default: the newest run for the project).
import { OracleAdapter, oracleReachable } from "./memory";
import { scorecard } from "./narrate";

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (c: string, s: string) => (useColor ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = (s: string) => paint("2", s);
const cyan = (s: string) => paint("36", s);
const bold = (s: string) => paint("1", s);

async function main() {
  const project = process.env.AURALIS_PROJECT ?? "default";
  const run = process.env.AURALIS_RUN; // omit -> newest run for the project
  if (!(await oracleReachable())) {
    console.error("oracle-lite is not reachable on :47778 — start it with `pnpm oracle` (or run `pnpm dev` first).");
    process.exit(1);
  }
  const events = await new OracleAdapter().timeline({ project, run, limit: 2000 });
  if (!events.length) {
    console.log(`(no timeline events for project "${project}"${run ? ` · run ${run}` : ""} yet — run \`pnpm dev\`)`);
    return;
  }
  console.log(bold(`━━━ timeline · ${events[0]?.runId ?? run ?? project} ━━━`));
  for (const e of events) {
    const t = (e.ts ?? "").slice(11, 23).padEnd(12); // HH:MM:SS.mmm (UTC)
    console.log(`  ${dim(t)}  ${e.human}`);
  }
  const s = scorecard(events);
  console.log(
    "\n  " +
      cyan("scorecard") +
      ` · ${s.tasks} task(s) · deduped ${s.deduped} · overlaps ${s.overlaps} · repairs ${s.repairs} · notes ${s.notes}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
