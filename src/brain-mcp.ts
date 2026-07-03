// B.3 — worker-direct brain access. An in-process MCP server that exposes the shared brain to a Claude
// Code worker so it can PULL what teammates already found (and push its own note) directly, mid-task —
// not only via the librarian's inject/capture. The tool logic lives in plain, testable functions.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { OracleAdapter, type MemoryAdapter } from "./memory";

export async function brainSearch(adapter: MemoryAdapter, project: string, query: string): Promise<string> {
  const hits = await adapter.search(query, { project, limit: 5 });
  return hits.length
    ? hits.map((h) => `- ${h.content}`).join("\n")
    : "(nothing in the shared brain for that query yet — explore and then record what you find)";
}

export async function brainLearn(adapter: MemoryAdapter, project: string, finding: string): Promise<string> {
  const { id } = await adapter.learn(finding, { project, concepts: ["worker-note"] });
  return id ? `saved to the shared brain (${id})` : "saved";
}

// Build the MCP server bound to a given brain adapter + project namespace.
export function brainMcpServer(adapter: MemoryAdapter = new OracleAdapter(), project = "default") {
  return createSdkMcpServer({
    name: "oracle",
    version: "1.0.0",
    tools: [
      tool(
        "search",
        "Search the shared team brain for what teammates already found, BEFORE exploring the codebase yourself.",
        { query: z.string().describe("what to look up in the shared brain") },
        async (args) => ({ content: [{ type: "text", text: await brainSearch(adapter, project, args.query) }] }),
      ),
      tool(
        "learn",
        "Record a finding into the shared team brain so teammates and future runs can reuse it.",
        { finding: z.string().describe("the finding to remember") },
        async (args) => ({ content: [{ type: "text", text: await brainLearn(adapter, project, args.finding) }] }),
      ),
    ],
  });
}
