// Boots an ISOLATED oracle-lite sidecar for the live tests (own port + scratch db), then tears it down.
// Never reuses a dev oracle: the old reuse-if-reachable shortcut meant a running :47778 brain got test
// probe events written into REAL data (the tl-* project junk in the dashboard). vitest.config sets
// ORACLE_API_URL so every adapter inside the tests points here.
import { spawn, type ChildProcess } from "node:child_process";

const TEST_PORT = 47788;
let child: ChildProcess | undefined;

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${TEST_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function setup() {
  if (await reachable()) return; // a leaked previous TEST server — same isolated db, safe to reuse
  child = spawn("bun", ["run", "oracle-lite/server.ts"], {
    env: { ...process.env, ORACLE_PORT: String(TEST_PORT), ORACLE_RESET: "1", ORACLE_DB: ".auralis-out/test-brain.sqlite" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if (await reachable()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("oracle-lite did not start for tests");
}

export async function teardown() {
  child?.kill();
}
