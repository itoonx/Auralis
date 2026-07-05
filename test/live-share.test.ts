// Real-time sharing: a worker with live brain access must be DRIVEN to pull the brain before it reads
// and push findings mid-task — that's the mechanism that lets siblings running at the same time see
// each other's work in flight, instead of only at the next DAG level. Without live access it falls back
// to the static once-at-start injection.
import { describe, it, expect } from "vitest";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { Worker } from "../src/participants";
import type { AgentRunner, RunResult } from "../src/runner";

class CapturingRunner implements AgentRunner {
  prompt = "";
  async run(prompt: string): Promise<RunResult> {
    this.prompt = prompt;
    return { result: "done", explored: [] };
  }
}

describe("worker real-time sharing", () => {
  it("live-pull worker is told to search the brain before reading and learn mid-task", async () => {
    const runner = new CapturingRunner();
    const env = new AgenticEnvironment();
    const w = new Worker("A", env, runner, true);
    w.join(env); // Worker announces its finding on the bus at the end of run()
    await w.run("map the auth flow", "");
    expect(runner.prompt).toContain("mcp__oracle__search");
    expect(runner.prompt).toContain("mcp__oracle__learn");
    expect(runner.prompt).toContain('worker "A"'); // worker knows its own id
    expect(runner.prompt).toMatch(/AT THE SAME TIME/i);
  });

  it("without live access, the worker only gets the static injected findings", async () => {
    const runner = new CapturingRunner();
    const env = new AgenticEnvironment();
    const w = new Worker("B", env, runner); // livePull defaults off
    w.join(env);
    await w.run("map the auth flow", "teammate already read auth/session.ts");
    expect(runner.prompt).not.toContain("mcp__oracle__search");
    expect(runner.prompt).toContain("auth/session.ts");
  });
});
