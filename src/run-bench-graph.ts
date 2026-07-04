// `pnpm bench-graph` — reproducible M3 benchmark. Boots an ISOLATED scratch brain (own port + db, so it
// never touches your real brain), seeds a small known corpus, cognifies (free heuristic — deterministic),
// then reports how much recall the graph adds over flat search on relationship queries.
import { spawn } from "node:child_process";
import { OracleAdapter, oracleReachable } from "./memory";
import { cognify, extractTriplets } from "./graph";
import { measureGraphRecall } from "./bench-graph";

const PORT = Number(process.env.AURALIS_BENCH_PORT ?? 47780); // off the default 47778
const BASE = `http://localhost:${PORT}`;
const DB = `${process.env.AURALIS_OUT ?? ".auralis-out"}/bench-graph.sqlite`;

// A known corpus: pairs of findings that share an entity but not query keywords — graph should connect them.
const CORPUS = [
  "The login endpoint is defined in auth/session.ts and checks the user password.",
  "auth/session.ts issues a SessionToken saved as a signed cookie for later requests.",
  "Rate limiting wraps the login endpoint via middleware/rate.ts.",
  "middleware/rate.ts reads its limits from config/limits.json.",
];
const QUERIES = ["how does login work", "how are requests authenticated"];

async function main() {
  const child = spawn("bun", ["run", "oracle-lite/server.ts"], {
    env: { ...process.env, ORACLE_PORT: String(PORT), ORACLE_DB: DB, ORACLE_RESET: "1", ORACLE_NO_VECTORS: "1" },
    stdio: "inherit",
  });
  const stop = () => {
    try {
      child.kill();
    } catch {
      /* noop */
    }
  };
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (await oracleReachable(BASE)) {
        up = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error(`bench oracle failed to start on :${PORT}`);

    const adapter = new OracleAdapter(BASE);
    for (const pattern of CORPUS) await adapter.learn(pattern, { project: "bench" });
    const docs = (await adapter.listDocs?.({ project: "bench", max: 100 })) ?? [];
    for (const d of docs) await cognify(adapter, d.id, "bench", d.content, { extract: extractTriplets });

    const report = await measureGraphRecall(adapter, "bench", QUERIES);
    console.log("\n─── graph-recall benchmark (M3) ───");
    for (const r of report.rows) console.log(`  "${r.query}"  →  flat=${r.flat}  graph=${r.graph}  (+${r.added} via graph)`);
    console.log(`\n  flat total ${report.flatTotal} · graph total ${report.graphTotal} · added by graph ${report.addedTotal}`);
    console.log(`  graph-recall uplift: ${(report.upliftPct * 100).toFixed(0)}%  (findings surfaced that flat recall missed)`);
    console.log(report.addedTotal > 0 ? "\n✅ graph retrieval adds recall flat search structurally can't" : "\n⚠️  no uplift on this corpus");
    process.exitCode = report.addedTotal > 0 ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
