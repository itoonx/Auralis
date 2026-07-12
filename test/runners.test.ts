// M2 — runner selection: spec parsing, config-file + env resolution order, key gating, factory classes.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec, resolveRunnerSpec, keyFor, makeRunnerFor, resetConfigCache, PRESETS } from "../src/runners";
import { ToolLoopRunner } from "../src/runner-toolloop";
import { ClaudeCodeRunner } from "../src/runner";

const ENV_KEYS = ["AURALIS_RUNNER", "AURALIS_PLANNER_RUNNER", "AURALIS_CRITIC_RUNNER", "OPENAI_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfigCache();
});

describe("runner selection (M2)", () => {
  it("parses vendor[:model] specs and rejects unknown vendors", () => {
    expect(parseSpec("claude")).toEqual({ vendor: "claude", model: undefined });
    expect(parseSpec("gpt:gpt-5.5")).toEqual({ vendor: "gpt", model: "gpt-5.5" });
    expect(parseSpec("glm")).toEqual({ vendor: "glm", model: undefined });
    expect(() => parseSpec("grok:x")).toThrow(/unknown runner vendor/);
  });

  it("resolution order: env > config file > worker fallback > claude", () => {
    const root = mkdtempSync(join(tmpdir(), "runners-cfg-"));
    writeFileSync(join(root, "auralis.config.json"), JSON.stringify({ runners: { worker: "glm:glm-4-plus", critic: "gpt:gpt-5.5" } }));
    // config file wins when no env
    delete process.env.AURALIS_RUNNER;
    expect(resolveRunnerSpec("worker", root)).toEqual({ vendor: "glm", model: "glm-4-plus" });
    expect(resolveRunnerSpec("critic", root)).toEqual({ vendor: "gpt", model: "gpt-5.5" });
    // roles without their own entry fall back to the worker spec
    expect(resolveRunnerSpec("planner", root)).toEqual({ vendor: "glm", model: "glm-4-plus" });
    // env beats the file
    process.env.AURALIS_RUNNER = "gpt:gpt-5.4-mini";
    expect(resolveRunnerSpec("worker", root)).toEqual({ vendor: "gpt", model: "gpt-5.4-mini" });
    // legacy lifecycle value "api" is NOT a worker vendor — falls through to the file
    process.env.AURALIS_RUNNER = "api";
    expect(resolveRunnerSpec("worker", root)).toEqual({ vendor: "glm", model: "glm-4-plus" });
    // no env, no file → claude
    rmSync(root, { recursive: true, force: true });
    delete process.env.AURALIS_RUNNER;
    expect(resolveRunnerSpec("worker", mkdtempSync(join(tmpdir(), "runners-empty-")))).toEqual({ vendor: "claude" });
  });

  it("keyFor gates billing: gpt needs OPENAI_API_KEY, glm accepts GLM_ or ZHIPU_, claude never needs one", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    expect(keyFor({ vendor: "claude" }).ok).toBe(true);
    expect(keyFor({ vendor: "gpt" })).toMatchObject({ ok: false, missing: ["OPENAI_API_KEY"] });
    process.env.OPENAI_API_KEY = "sk-test";
    expect(keyFor({ vendor: "gpt" })).toMatchObject({ ok: true, keyEnv: "OPENAI_API_KEY" });
    process.env.ZHIPU_API_KEY = "glm-test";
    expect(keyFor({ vendor: "glm" })).toMatchObject({ ok: true, keyEnv: "ZHIPU_API_KEY" });
  });

  it("factory: claude → ClaudeCodeRunner; gpt/glm → ToolLoopRunner with the preset filled in; no key → loud throw", () => {
    expect(makeRunnerFor({ vendor: "claude" }, { cwd: "." })).toBeInstanceOf(ClaudeCodeRunner);
    process.env.OPENAI_API_KEY = "sk-test";
    const r = makeRunnerFor({ vendor: "gpt" }, { cwd: "." });
    expect(r).toBeInstanceOf(ToolLoopRunner);
    expect((r as any).cfg.baseURL).toBe(PRESETS.gpt.baseURL);
    expect((r as any).cfg.model).toBe(PRESETS.gpt.defaultModel);
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    expect(() => makeRunnerFor({ vendor: "glm" }, { cwd: "." })).toThrow(/GLM_API_KEY/);
  });
});
