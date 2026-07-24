// Runner selection (docs/prd-multi-runner.md M2): one place that answers "which model runs this layer?".
// Resolution order per role: env AURALIS_<ROLE>_RUNNER > auralis.config.json runners[role] > worker's
// spec > "claude". Spec format: `vendor[:model]` — claude · gpt[:model] · glm[:model] · api-compat.
// Billing keys live in .env / the shell (OPENAI_API_KEY, GLM_API_KEY…) — NEVER .env.oracle (oracle secrets).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiRunner, ClaudeCodeRunner, type AgentRunner } from "./runner";
import { ToolLoopRunner, type BrainTools } from "./runner-toolloop";
import { brainSearch, brainLearn, type LiveStats } from "./brain-mcp";
import { recordDecision, reverseDecision } from "./decision";
import type { MemoryAdapter } from "./memory";
import type { Emit } from "./narrate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Role = "worker" | "planner" | "synthesis" | "critic" | "reviewer";

export interface RunnerSpec {
  vendor: "claude" | "gpt" | "glm" | "api-compat";
  model?: string;
}

export interface RunnerPreset {
  baseURL: string;
  defaultModel: string;
  keyEnv: string[]; // first present wins
}

export const PRESETS: Record<Exclude<RunnerSpec["vendor"], "claude">, RunnerPreset> = {
  gpt: { baseURL: "https://api.openai.com/v1", defaultModel: "gpt-5.4-mini", keyEnv: ["OPENAI_API_KEY"] },
  glm: { baseURL: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-plus", keyEnv: ["GLM_API_KEY", "ZHIPU_API_KEY"] },
  "api-compat": { baseURL: process.env.AURALIS_RUNNER_BASE_URL ?? "http://localhost:11434/v1", defaultModel: process.env.AURALIS_RUNNER_MODEL ?? "llama3", keyEnv: ["AURALIS_RUNNER_API_KEY"] },
};

export function parseSpec(raw: string): RunnerSpec {
  const [vendor, ...rest] = raw.trim().split(":");
  const model = rest.join(":") || undefined;
  if (vendor === "claude" || vendor === "gpt" || vendor === "glm" || vendor === "api-compat") return { vendor, model };
  throw new Error(`unknown runner vendor "${vendor}" (want claude | gpt | glm | api-compat)`);
}

interface AuralisConfig {
  runners?: Partial<Record<Role, string>> & { brainstorm?: string[] };
  brainstorm?: { rounds?: number; synthesizer?: string; mode?: "panel" | "converge"; judge?: string };
}

let cached: AuralisConfig | null | undefined;
export function loadConfig(root = ROOT): AuralisConfig {
  if (cached !== undefined && root === ROOT) return cached ?? {};
  const p = join(root, "auralis.config.json");
  let cfg: AuralisConfig = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(`auralis.config.json is not valid JSON: ${(e as Error).message}`); }
  }
  if (root === ROOT) cached = cfg;
  return cfg;
}
export const resetConfigCache = () => { cached = undefined; }; // tests

const ROLE_ENV: Record<Role, string> = {
  worker: "AURALIS_RUNNER",
  planner: "AURALIS_PLANNER_RUNNER",
  synthesis: "AURALIS_SYNTHESIS_RUNNER",
  critic: "AURALIS_CRITIC_RUNNER",
  reviewer: "AURALIS_REVIEWER_RUNNER",
};

export function resolveRunnerSpec(role: Role, root = ROOT): RunnerSpec {
  const env = process.env[ROLE_ENV[role]];
  if (env && env !== "api") return parseSpec(env); // "api" is the legacy lifecycle switch (makeRunner) — not a worker vendor
  const cfg = loadConfig(root).runners ?? {};
  const raw = cfg[role] ?? (role === "worker" ? undefined : cfg.worker);
  return raw ? parseSpec(raw) : { vendor: "claude" };
}

// Like resolveRunnerSpec but WITHOUT the worker/claude fallback — null unless the role was explicitly
// configured (env or config). Used where a role runner is opt-in (M5's LLM critic/reviewer): silence
// must mean "keep the free default", never "silently spend on a model".
export function explicitRunnerSpec(role: Role, root = ROOT): RunnerSpec | null {
  const env = process.env[ROLE_ENV[role]];
  if (env && env !== "api") return parseSpec(env);
  const raw = loadConfig(root).runners?.[role];
  return raw ? parseSpec(raw) : null;
}

// A tool-less TEXT runner from a spec — thinking, not exploring: claude → the Agent SDK with no tools
// (reuses the CLI login), anything else → an OpenAI-compatible chat call. Shared by the brainstorm
// panel and the M5 critic/reviewer so every "pure text" role builds runners exactly one way.
export function textRunnerFor(spec: RunnerSpec, opts: { maxTurns?: number } = {}): { name: string; run: (prompt: string) => Promise<string> } {
  const name = spec.model ? `${spec.vendor}:${spec.model}` : spec.vendor;
  // Default 1 turn (right + cheap for brainstorm/critic). A long single-shot output — a generated gate
  // script — can spill past one turn and make the SDK throw "max turns (1)"; gate-gen passes a higher cap.
  const maxTurns = Math.max(1, opts.maxTurns ?? 1);
  if (spec.vendor === "claude") {
    return {
      name,
      run: async (prompt) => {
        const { query } = await import("@anthropic-ai/claude-agent-sdk"); // lazy — no SDK cost in tests
        let out = "";
        for await (const m of query({ prompt, options: { maxTurns, allowedTools: [], ...(spec.model ? { model: spec.model } : {}) } as any })) {
          const msg: any = m;
          if (msg.type === "result" && msg.subtype === "success") out = String(msg.result ?? "");
        }
        return out.trim();
      },
    };
  }
  const preset = PRESETS[spec.vendor];
  const key = keyFor(spec);
  if (!key.ok) throw new Error(`runner "${name}" needs one of: ${key.missing?.join(" / ")} (set it in .env / shell)`);
  const runner = new ApiRunner({ url: `${preset.baseURL.replace(/\/$/, "")}/chat/completions`, model: spec.model ?? preset.defaultModel, key: key.keyEnv ? process.env[key.keyEnv] : undefined });
  return { name, run: async (prompt) => (await runner.run(prompt)).result };
}

// Which env key satisfies a spec's billing requirement — doctor + factory share one truth.
export function keyFor(spec: RunnerSpec): { ok: boolean; keyEnv?: string; missing?: string[] } {
  if (spec.vendor === "claude") return { ok: true }; // reuses the Claude Code login
  const preset = PRESETS[spec.vendor];
  const found = preset.keyEnv.find((k) => !!process.env[k]);
  if (found) return { ok: true, keyEnv: found };
  if (spec.vendor === "api-compat" && /localhost|127\.0\.0\.1/.test(preset.baseURL)) return { ok: true }; // local servers need no key
  return { ok: false, missing: preset.keyEnv };
}

export interface WorkerRunnerOpts {
  cwd: string;
  maxTurns?: number;
  build?: boolean;
  mcpBrain?: unknown; // the in-process MCP server (Claude path)
  brainTools?: BrainTools; // the native bridge (tool-loop path)
  claim?: (target: string) => Promise<{ ok: boolean; owner: string }>;
  onStep?: (tool: string, target?: string) => void;
}

export function makeRunnerFor(spec: RunnerSpec, opts: WorkerRunnerOpts): AgentRunner {
  if (spec.vendor === "claude") {
    return new ClaudeCodeRunner({ cwd: opts.cwd, maxTurns: opts.maxTurns, model: spec.model, brain: opts.mcpBrain, build: opts.build, claim: opts.claim, onStep: opts.onStep });
  }
  const preset = PRESETS[spec.vendor];
  const key = keyFor(spec);
  if (!key.ok) throw new Error(`runner "${spec.vendor}" needs one of: ${key.missing?.join(" / ")} (billing key — set it in .env or the shell, not .env.oracle)`);
  return new ToolLoopRunner({
    cwd: opts.cwd,
    baseURL: preset.baseURL,
    model: spec.model ?? preset.defaultModel,
    apiKey: key.keyEnv ? process.env[key.keyEnv] : undefined,
    maxTurns: opts.maxTurns,
    build: opts.build,
    brain: opts.brainTools,
    claim: opts.claim,
    onStep: opts.onStep,
  });
}

// The native BrainTools bridge — the SAME behaviour the MCP server gives Claude workers (shared helpers,
// same LiveStats counters, same timeline events), so cross-runtime runs stay comparable.
export function brainToolsFromAdapter(adapter: MemoryAdapter, project: string, stats?: LiveStats, emit?: Emit, workerId = "worker"): BrainTools {
  return {
    async search(query) {
      const text = await brainSearch(adapter, project, query);
      if (stats) { stats.searches++; if (!text.startsWith("(nothing")) stats.hits++; }
      return text;
    },
    async learn(pattern) {
      const text = await brainLearn(adapter, project, pattern);
      if (stats) stats.learns++;
      return text;
    },
    async decide(decision, rejected) {
      const payload = { title: decision.slice(0, 80), chose: decision, because: "", rejected: rejected ? [{ option: rejected, why: "" }] : undefined } as any;
      const m = /^supersedes:(\S+)\s+/.exec(decision);
      const res = m ? await reverseDecision(adapter, project, m[1], payload) : await recordDecision(adapter, project, payload);
      return `decision recorded to the shared brain (${res.id})`;
    },
    async note(note) {
      emit?.("note", workerId, note, { nodeId: workerId });
      return "noted on the timeline";
    },
    async cite(id) {
      try {
        await adapter.cite?.(id);
        if (stats) stats.cites++;
        emit?.("note", workerId, `${workerId} cited ${id}`, { nodeId: workerId, refs: [id] });
        return "cited — this finding's usefulness is now on record";
      } catch { return "cite failed (best-effort — continue your task)"; }
    },
  };
}
