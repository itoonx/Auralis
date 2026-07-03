// Milestone #4: the values layer. Proves the brain is APPEND-ONLY (nothing is deleted; obsolete
// findings are SUPERSEDED, i.e. flagged while kept intact and searchable) and that there is no delete
// route. Auditability (the "why" provenance trail) is demonstrated by `pnpm dev`.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { OracleAdapter, oracleReachable } from "./memory";

const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const BASE = process.env.ORACLE_API_URL ?? "http://localhost:47778";

async function ensureOracle(): Promise<() => void> {
  if (await oracleReachable()) return () => {};
  const child = spawn("bun", ["run", "oracle-lite/server.ts"], {
    env: { ...process.env, ORACLE_RESET: "1", ORACLE_DB: ".auralis-out/values-brain.sqlite" },
    stdio: "inherit",
  });
  for (let i = 0; i < 60; i++) {
    if (await oracleReachable()) return () => { try { child.kill(); } catch { /* noop */ } };
    await new Promise((r) => setTimeout(r, 200));
  }
  try { child.kill(); } catch { /* noop */ }
  throw new Error("oracle-lite failed to start on :47778");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const stop = await ensureOracle();
  try {
    const brain = new OracleAdapter();
    const before = await brain.count!();
    const v1 = await brain.learn("Finding v1: the live harness lives in src/run.ts. (OUTDATED — incomplete)", { concepts: ["arch"] });
    const v2 = await brain.learn("Finding v2 (correction): src/run.ts also boots the oracle-lite brain and runs baseline vs shared.", { concepts: ["arch"] });
    await brain.supersede!(v1.id, v2.id, "v1 omitted that run.ts boots the brain");
    const after = await brain.count!();

    const hits = await brain.search("where is the live harness", { limit: 10 });
    const oldStill = hits.find((h) => h.id === v1.id);

    let delStatus = 0;
    try {
      delStatus = (await fetch(`${BASE}/api/learn/${v1.id}`, { method: "DELETE" })).status;
    } catch {
      delStatus = -1;
    }

    const appendOnly = after >= before + 2 && !!oldStill; // both docs kept; nothing removed
    const superseded = oldStill?.supersededBy === v2.id; // v1 flagged outdated, still present
    const noDelete = delStatus === 404 || delStatus === 405;

    console.log("\n─── auralis milestone #4 (values-aligned & auditable) ───");
    console.log(`doc count: ${before} → ${after}   (append-only: never decreases)`);
    console.log(`superseded v1 (${v1.id}) with v2 (${v2.id})`);
    console.log(`  v1 still searchable: ${!!oldStill}, flagged supersededBy=${oldStill?.supersededBy ?? "-"}`);
    console.log(`no delete route (DELETE → HTTP ${delStatus}): ${noDelete}`);
    console.log(`audit trail ("why" provenance) is written by \`pnpm dev\` → ${OUT}/provenance-*.json`);

    writeFileSync(`${OUT}/values-audit.json`, JSON.stringify({ before, after, v1: v1.id, v2: v2.id, oldStillPresent: !!oldStill, supersededBy: oldStill?.supersededBy, delStatus }, null, 2));

    const pass = appendOnly && superseded && noDelete;
    console.log(pass ? "\n✅ milestone #4 met: append-only + supersession-not-deletion, no delete route" : "\n⚠️  not met — see output");
    process.exitCode = pass ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
