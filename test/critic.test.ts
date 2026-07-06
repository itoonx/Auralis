// Critic + self-repair: the heuristic grader rejects bad answers, and a rejected task is retried and
// its improved result kept. Default (maxRetries 0) never retries, so existing behaviour is unchanged.
import { describe, it, expect } from "vitest";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { Worker, MemoryLibrarian } from "../src/participants";
import { coordinate, heuristicCritic } from "../src/conductor";
import { NullMemoryAdapter } from "../src/memory";
import type { AgentRunner, RunResult } from "../src/runner";
import type { DagNode } from "../src/dag";

// Fails on the first attempt (an early-stop stub), succeeds on the second.
class FlakyRunner implements AgentRunner {
  private calls = 0;
  async run(): Promise<RunResult> {
    this.calls++;
    return this.calls === 1
      ? { result: "(worker stopped early: reached maximum number of turns (8))", explored: [] }
      : { result: "A real, complete analysis of the module and how it connects to the rest.", explored: [] };
  }
}

const one: DagNode[] = [{ id: "t", question: "analyze the module", dependsOn: [] }];

function makeWorkerFactory(env: AgenticEnvironment, runner: AgentRunner) {
  return (id: string) => {
    const w = new Worker(id, env, runner);
    w.join(env);
    return w;
  };
}

describe("critic / self-repair", () => {
  it("heuristic grader rejects empty, early-stop, and too-short answers", () => {
    expect(heuristicCritic.grade("q", "").ok).toBe(false);
    expect(heuristicCritic.grade("q", "(worker stopped early: turns)").ok).toBe(false);
    expect(heuristicCritic.grade("q", "short").ok).toBe(false);
    expect(heuristicCritic.grade("q", "A full and complete answer to the question.").ok).toBe(true);
  });

  it("rejects infrastructure errors masquerading as findings (the credit-exhaustion poisoning path)", () => {
    expect(heuristicCritic.grade("q", "Credit balance is too low").ok).toBe(false);
    expect(heuristicCritic.grade("q", "API error: rate limit exceeded, retry later").ok).toBe(false);
    expect(heuristicCritic.grade("q", "Request failed: quota exceeded for this billing period").ok).toBe(false);
    // a long real analysis that merely MENTIONS rate limiting is NOT an infra error
    const real = "The middleware applies a rate limit of 100 req/min per key; exceeding it returns 429. " +
      "This is enforced in middleware/rate.ts which reads limits from config, and the login endpoint wraps it. " +
      "Overall the request path is: router -> rate middleware -> auth -> handler.";
    expect(heuristicCritic.grade("q", real).ok).toBe(true);
  });

  it("a rejected result is NOT captured into the brain (no memory poisoning)", async () => {
    class DeadRunner implements AgentRunner {
      async run(): Promise<RunResult> {
        return { result: "Credit balance is too low", explored: [] };
      }
    }
    const learned: string[] = [];
    const adapter = new NullMemoryAdapter();
    (adapter as any).learn = async (p: string) => { learned.push(p); return { id: "x" }; };
    const env = new AgenticEnvironment();
    const out = await coordinate(one, makeWorkerFactory(env, new DeadRunner()), new MemoryLibrarian(adapter), { maxRetries: 0 });
    expect(learned).toEqual([]); // nothing captured
    expect(out.provenance[0].learnedId).toBe("");
  });

  it("retries a rejected task and keeps the improved result", async () => {
    const env = new AgenticEnvironment();
    const out = await coordinate(one, makeWorkerFactory(env, new FlakyRunner()), new MemoryLibrarian(new NullMemoryAdapter()), { maxRetries: 1 });
    expect(out.provenance[0].attempts).toBe(2);
    expect(out.provenance[0].summary).toContain("real, complete analysis");
    expect(out.repairs).toBe(1);
  });

  it("does not retry when maxRetries = 0 (default)", async () => {
    const env = new AgenticEnvironment();
    const out = await coordinate(one, makeWorkerFactory(env, new FlakyRunner()), new MemoryLibrarian(new NullMemoryAdapter()));
    expect(out.provenance[0].attempts).toBe(1);
    expect(out.repairs).toBe(0);
  });
});
