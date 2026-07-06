// B.3 — worker-direct brain access. An in-process MCP server that exposes the shared brain to a Claude
// Code worker so it can PULL what teammates already found, push its own note, and record honest DESIGN
// DECISIONS — directly, mid-task. The tool logic lives in plain, testable functions.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { OracleAdapter, type MemoryAdapter } from "./memory";
import { recordDecision, reverseDecision } from "./decision";
import type { Emit } from "./narrate";

export async function brainSearch(adapter: MemoryAdapter, project: string, query: string): Promise<string> {
  const hits = await adapter.search(query, { project, limit: 5 });
  // Ids are shown so the worker can CITE the finding that actually helped (U3) — citation, not retrieval,
  // is what feeds the usage boost, so ranking can't self-reinforce its own winners.
  return hits.length
    ? hits.map((h) => `- [${h.id}] ${h.content}`).join("\n") +
        "\n(if one of these materially helps your work, call mcp__oracle__cite with its id)"
    : "(nothing in the shared brain for that query yet — explore and then record what you find)";
}

export async function brainLearn(adapter: MemoryAdapter, project: string, finding: string): Promise<string> {
  const { id } = await adapter.learn(finding, { project, concepts: ["worker-note"] });
  return id ? `saved to the shared brain (${id})` : "saved";
}

// Live counters so a run can SEE the real-time channel working: how often workers pulled the brain
// mid-task, how often a pull actually surfaced a teammate's finding (hit), and how often they pushed.
// Without this the live pull/push is invisible — provenance only sees the once-at-start injection.
export interface LiveStats {
  searches: number;
  hits: number;
  learns: number;
  claims: number; // targets a worker successfully claimed (its own to explore)
  skips: number; // targets a worker skipped because a teammate already claimed them — a *prevented* duplicate
  cites: number; // findings a worker explicitly cited as having helped (feeds the usage ranking boost)
}
export const newLiveStats = (): LiveStats => ({ searches: 0, hits: 0, learns: 0, claims: 0, skips: 0, cites: 0 });

export function brainMcpServer(adapter: MemoryAdapter = new OracleAdapter(), project = "default", stats?: LiveStats, emit?: Emit, workerId = "worker") {
  return createSdkMcpServer({
    name: "oracle",
    version: "1.0.0",
    tools: [
      tool(
        "note",
        "Narrate what you're about to do or just realised, in ONE short line, so teammates and a human " +
          "watching the run can follow your reasoning live. Use it when you start a subtask or change " +
          "direction. This is for INTENT/progress — record actual findings with learn instead.",
        { note: z.string().describe("a short, human-readable line about your current plan or progress") },
        async (args) => {
          emit?.("note", workerId, args.note, { nodeId: workerId });
          return { content: [{ type: "text", text: "noted on the timeline" }] };
        },
      ),
      tool(
        "search",
        "Search the shared team brain for what teammates already found, BEFORE exploring the codebase yourself.",
        { query: z.string().describe("what to look up in the shared brain") },
        async (args) => {
          const text = await brainSearch(adapter, project, args.query);
          if (stats) { stats.searches++; if (!text.startsWith("(nothing")) stats.hits++; } // hit = a teammate's finding came back
          return { content: [{ type: "text", text }] };
        },
      ),
      tool(
        "learn",
        "Record a finding into the shared team brain so teammates and future runs can reuse it.",
        { finding: z.string().describe("the finding to remember") },
        async (args) => {
          const text = await brainLearn(adapter, project, args.finding);
          if (stats) stats.learns++;
          return { content: [{ type: "text", text }] };
        },
      ),
      tool(
        "cite",
        "Credit a shared-brain finding that MATERIALLY helped your work (you used its interface/fact in what " +
          "you produced). Pass the id shown in [brackets] by search. Cite only real help — this feeds ranking.",
        { id: z.string().describe("the finding id shown in [brackets] in search results") },
        async (args) => {
          try {
            await adapter.cite?.(args.id);
            if (stats) stats.cites++;
            emit?.("note", workerId, `${workerId} cited ${args.id}`, { nodeId: workerId, refs: [args.id] });
            return { content: [{ type: "text", text: "cited — this finding's usefulness is now on record" }] };
          } catch {
            return { content: [{ type: "text", text: "cite failed (best-effort — continue your task)" }] };
          }
        },
      ),
      tool(
        "decide",
        "Record an architecture/design DECISION into the shared brain so a future agent finds it when it " +
          "touches this area. ALWAYS include the alternatives you rejected and why. Be honest: if there are " +
          "external constraints you cannot see (deadlines, licensing, team skills, lock-in), leave `external` " +
          "empty and let a human fill them — do NOT invent technical-sounding reasons for everything.",
        {
          title: z.string(),
          chose: z.string(),
          because: z.string(),
          rejected: z.array(z.object({ option: z.string(), why: z.string() })).optional(),
          external: z.array(z.string()).optional(),
          revisitIf: z.string().optional(),
          supersedes: z.string().describe("id of a prior decision this one reverses — it is superseded, not deleted").optional(),
        },
        async (args) => {
          const { supersedes, ...decision } = args as any;
          const res = supersedes
            ? await reverseDecision(adapter, project, supersedes, decision)
            : await recordDecision(adapter, project, decision);
          const text = supersedes
            ? `decision recorded; prior decision ${supersedes} superseded (${res.id})`
            : `decision recorded to the shared brain (${res.id})`;
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });
}
