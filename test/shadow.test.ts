// Shadow-log: appends across calls (routing needs history), kill-switch AURALIS_SHADOW=0, never throws.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shadowLog, type ShadowRec } from "../src/shadow";

const rec = (task: string): ShadowRec => ({
  ts: "2026-07-18T00:00:00.000Z", runId: "r1", project: "p", task, model: "test-model",
  verdictOk: true, reason: "ok", attempts: 1, ms: 1.5, explored: 2, resultChars: 10,
});

describe("shadowLog", () => {
  let out: string;
  const saved = { out: process.env.AURALIS_OUT, shadow: process.env.AURALIS_SHADOW };
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "shadow-"));
    process.env.AURALIS_OUT = out;
    delete process.env.AURALIS_SHADOW;
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    if (saved.out === undefined) delete process.env.AURALIS_OUT; else process.env.AURALIS_OUT = saved.out;
    if (saved.shadow === undefined) delete process.env.AURALIS_SHADOW; else process.env.AURALIS_SHADOW = saved.shadow;
  });

  it("appends one parseable line per record — across calls, not truncating", () => {
    shadowLog(rec("a"));
    shadowLog(rec("b"));
    const lines = readFileSync(join(out, "shadow-log.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines.map((l) => (JSON.parse(l) as ShadowRec).task)).toEqual(["a", "b"]);
    expect((JSON.parse(lines[0]) as ShadowRec).verdictOk).toBe(true);
  });

  it("AURALIS_SHADOW=0 disables writing entirely", () => {
    process.env.AURALIS_SHADOW = "0";
    shadowLog(rec("a"));
    expect(existsSync(join(out, "shadow-log.jsonl"))).toBe(false);
  });
});
