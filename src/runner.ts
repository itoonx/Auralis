// Pluggable worker runtimes. ClaudeCodeRunner is the real one — it drives Claude Code via the Agent
// SDK (reuses existing auth, no API key) and its tool_use stream IS our exploration log. Optionally an
// in-process "brain" MCP server is attached so the worker can pull/push the shared brain directly.
// StubRunner is a deterministic stand-in for tests (no LLM, no network).
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface Exploration {
  tool: string;
  target: string;
}
export interface RunResult {
  result: string;
  explored: Exploration[];
}
export interface AgentRunner {
  run(prompt: string): Promise<RunResult>;
}

const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob"]);
function targetOf(name: string, input: any): string | undefined {
  if (name === "Read") return input?.file_path;
  if (name === "Grep" || name === "Glob") return input?.pattern ?? input?.path;
  return undefined;
}

export class ClaudeCodeRunner implements AgentRunner {
  // `brain` is an in-process MCP server (from brainMcpServer). When set, the worker can call
  // mcp__oracle__search / mcp__oracle__learn directly. MCP tool calls are NOT counted as exploration.
  // `claim` is the concurrent-dedup gate: when set, every Read is routed through canUseTool and DENIED
  // if a teammate already owns that file — deterministic prevention, not a request the LLM may ignore.
  constructor(private readonly opts: { cwd: string; maxTurns?: number; brain?: unknown; claim?: (target: string) => { ok: boolean; owner: string } }) {}

  async run(prompt: string): Promise<RunResult> {
    const explored: Exploration[] = [];
    const denied = new Set<string>(); // Reads the claim gate blocked — a teammate owns the file, so it never happened
    const gate = this.opts.claim;
    let result = "";
    const options: any = {
      cwd: this.opts.cwd,
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "acceptEdits",
      maxTurns: this.opts.maxTurns ?? 12,
    };
    if (this.opts.brain) {
      options.mcpServers = { oracle: this.opts.brain };
      options.allowedTools = [...options.allowedTools, "mcp__oracle__search", "mcp__oracle__learn", "mcp__oracle__decide"];
    }
    if (gate) {
      // A PreToolUse hook fires for EVERY tool — canUseTool is skipped for read-only tools like Read — so
      // this is the only place we can actually BLOCK a Read of a file a teammate already owns (real dedup).
      options.hooks = {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              async (input: any) => {
                const path = input?.tool_input?.file_path;
                if (typeof path === "string") {
                  const r = gate(path);
                  if (!r.ok) {
                    denied.add(path);
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason: `A teammate (${r.owner}) already owns ${path}. Use mcp__oracle__search to reuse their finding instead of reading it.`,
                      },
                    };
                  }
                }
                return { continue: true };
              },
            ],
          },
        ],
      };
    }
    try {
      for await (const m of query({ prompt, options })) {
        const msg: any = m;
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block?.type === "tool_use" && EXPLORE_TOOLS.has(block.name)) {
              const target = targetOf(block.name, block.input);
              if (target) explored.push({ tool: block.name, target });
            }
          }
        } else if (msg.type === "result" && msg.subtype === "success") {
          result = String(msg.result ?? "");
        }
      }
    } catch (err) {
      // The agent hit its turn/budget cap or errored mid-run. The exploration captured before the
      // throw is what the redundancy metric needs, so keep it and note the early stop.
      if (!result) result = `(worker stopped early: ${(err as Error).message})`;
    }
    // A blocked Read never happened — drop it so redundancy counts prevention, not a phantom read.
    return { result, explored: denied.size ? explored.filter((e) => !denied.has(e.target)) : explored };
  }
}

// Deterministic worker for tests: "explores" a fixed file list, but SKIPS any file already named in
// its prompt — modelling an agent that reuses injected shared knowledge instead of re-reading it.
export class StubRunner implements AgentRunner {
  constructor(private readonly files: string[]) {}
  async run(prompt: string): Promise<RunResult> {
    const explored = this.files
      .filter((f) => !prompt.includes(f))
      .map((f) => ({ tool: "Read", target: f }));
    return {
      result: `explored ${explored.length} files: ${explored.map((e) => e.target).join(", ")}`,
      explored,
    };
  }
}
