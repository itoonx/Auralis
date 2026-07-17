// Shadow-log: append-only per-task record across ALL runs (live harness, bench, MCP) — the observational
// data the routing phase decides from: which model handled which task, did the critic accept it, how long
// it took. One JSON line per completed task attempt-set. The file SURVIVES runs on purpose (routing needs
// history; log.ts truncates per run, this must not). AURALIS_SHADOW=0 disables.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ShadowRec {
  ts: string; // ISO timestamp
  runId: string;
  project: string;
  task: string;
  model: string; // resolved worker model (spec.model ?? vendor)
  verdictOk: boolean; // the critic's FINAL verdict — the free quality signal routing compares models on
  reason: string;
  attempts: number;
  ms: number; // whole task: inject + worker turns (incl. retries) + capture
  explored: number;
  resultChars: number;
}

export function shadowLog(rec: ShadowRec): void {
  if (process.env.AURALIS_SHADOW === "0") return;
  const file = `${process.env.AURALIS_OUT ?? "./.auralis-out"}/shadow-log.jsonl`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch { /* observability must never break the run */ }
}
