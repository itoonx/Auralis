#!/usr/bin/env node
// auralis — Supabase-style CLI for the production stack (docs/prd-production-docker.md).
// A thin, boring wrapper over `docker compose`: no daemon manager of its own — compose IS the daemon
// manager (restart: unless-stopped). Zero dependencies.
//
//   auralis start [--share]     bring the stack up in the background, wait for healthy, print URLs
//   auralis stop                take it down (the brain survives — bind mount)
//   auralis status              services + health + brain stats
//   auralis logs [svc] [-f]     compose logs
//   auralis restart [svc]
//   auralis doctor              docker? compose file? ports? brain reachable? token?
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = process.env.ORACLE_API_URL ?? "http://localhost:47778";
const AUTH = process.env.ORACLE_TOKEN ? { authorization: `Bearer ${process.env.ORACLE_TOKEN}` } : {};
const [cmd, ...rest] = process.argv.slice(2);

const sh = (args, opts = {}) => spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: "inherit", ...opts });
const compose = (...args) => sh(["docker", "compose", ...args]);
const composeJson = () => {
  try {
    const out = execSync("docker compose ps --format json", { cwd: ROOT, encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const health = async (base = ORACLE) => {
  try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
};

async function start() {
  const share = rest.includes("--share");
  // studio ships the dashboard's production build — build it if missing (host-build keeps the image tiny).
  if (!existsSync(join(ROOT, "dashboard/dist/index.html"))) {
    console.log("· building dashboard (first run)…");
    if (sh(["pnpm", "-C", "dashboard", "build"]).status !== 0) return fail("dashboard build failed");
  }
  const args = ["up", "-d", "--build"];
  if (share) args.splice(1, 0, "--profile", "share");
  if (compose(...args).status !== 0) return fail("docker compose up failed");
  process.stdout.write("· waiting for healthy");
  for (let i = 0; i < 60; i++) {
    const rows = composeJson();
    if (rows.length >= 2 && rows.every((r) => /healthy/.test(r.Health ?? ""))) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("\n");
  console.log("auralis is running (daemon — survives terminal close; `auralis stop` to end it)\n");
  console.log(`  studio     http://localhost:47780`);
  console.log(`  oracle API ${ORACLE}${process.env.ORACLE_TOKEN ? "   (ORACLE_TOKEN required)" : ""}`);
  console.log(`  data dir   ${join(ROOT, ".auralis-out")} (bind mount — survives rebuilds)`);
  if (share) console.log(`  tunnel     docker compose logs tunnel | grep trycloudflare`);
  console.log(`\n  fleet/MCP on this machine: ORACLE_API_URL=${ORACLE}`);
  await status();
}

async function status() {
  const rows = composeJson();
  if (!rows.length) return console.log("stack is not running (`auralis start`)");
  console.log("\nSERVICE   STATE");
  for (const r of rows) console.log(`  ${String(r.Service).padEnd(8)} ${r.Status}`);
  if (await health()) {
    try {
      const s = await (await fetch(`${ORACLE}/api/stats`, { headers: AUTH, signal: AbortSignal.timeout(2000) })).json();
      console.log(`  brain    ${s.count} docs · ${s.edges} edges · vectors=${s.vectors ? "on" : "off"}`);
    } catch { console.log("  brain    reachable (stats need ORACLE_TOKEN)"); }
  } else console.log("  brain    UNREACHABLE");
}

async function doctor() {
  const checks = [];
  checks.push(["docker", sh(["docker", "--version"], { stdio: "ignore" }).status === 0]);
  checks.push(["compose file", existsSync(join(ROOT, "docker-compose.yml"))]);
  checks.push(["dashboard dist", existsSync(join(ROOT, "dashboard/dist/index.html"))]);
  checks.push(["oracle reachable", await health()]);
  checks.push(["token set", !!process.env.ORACLE_TOKEN]);
  for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "✗"} ${name}`);
  const critical = checks.slice(0, 2).every(([, ok]) => ok);
  if (!critical) fail("docker or compose file missing");
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

switch (cmd) {
  case "start": await start(); break;
  case "stop": compose("down"); break;
  case "status": await status(); break;
  case "restart": compose("restart", ...rest.filter((a) => !a.startsWith("-"))); break;
  case "logs": compose("logs", ...rest); break;
  case "doctor": await doctor(); break;
  default:
    console.log("auralis — production stack CLI\n");
    console.log("  auralis start [--share]   up as daemons (+public tunnel with --share)");
    console.log("  auralis stop              down (brain data survives)");
    console.log("  auralis status            services + brain stats");
    console.log("  auralis logs [svc] [-f]   service logs");
    console.log("  auralis restart [svc]");
    console.log("  auralis doctor            environment checks");
    process.exit(cmd ? 1 : 0);
}
