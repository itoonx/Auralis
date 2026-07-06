// The session-capture INGRESS classifier: every Claude Code hook event lands in the right lane —
// knowledge (learn, trust-tiered), observability (event only), or dropped. Pure function, no I/O.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no types; route() is the exported pure classifier
import { route } from "../hooks/session-capture.mjs";

const base = { cwd: "/Users/x/git/myrepo", session_id: "s1" };

describe("session-capture ingress", () => {
  it("a substantive prompt → timeline event + learn (human trust, NOT pinned) + recall", () => {
    const prompt = "Please refactor the auth middleware so the session token is validated before rate limiting is applied.";
    const a = route({ ...base, hook_event_name: "UserPromptSubmit", prompt });
    expect(a.map((x: any) => x.type)).toEqual(["event", "recall", "learn"]); // recall BEFORE learn — no self-echo
    const learn = a[2];
    expect(learn.source).toBe("human:prompt"); // → trust 1.0 at the server
    expect(learn.pinned).toBe(false); // ground truth but unused instructions must fade
    expect(learn.project).toBe("myrepo"); // project = repo basename, same brain the fleet uses
  });

  it("a trivial prompt stays out of the brain (event + recall only)", () => {
    const a = route({ ...base, hook_event_name: "UserPromptSubmit", prompt: "ทำต่อ" });
    expect(a.map((x: any) => x.type)).toEqual(["event", "recall"]);
  });

  it("slash and shell prompts are not knowledge at all", () => {
    expect(route({ ...base, hook_event_name: "UserPromptSubmit", prompt: "/compact" })).toEqual([]);
    expect(route({ ...base, hook_event_name: "UserPromptSubmit", prompt: "! pwd" })).toEqual([]);
  });

  it("Write/Edit → observability trace only, never learn (traces must not pollute recall)", () => {
    const a = route({ ...base, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "src/x.ts" } });
    expect(a).toHaveLength(1);
    expect(a[0].type).toBe("event");
    expect(a[0].kind).toBe("trace");
    expect(a[0].refs).toEqual(["src/x.ts"]);
  });

  it("other tools (Read/Bash/…) are dropped entirely — git already records commits", () => {
    expect(route({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" } })).toEqual([]);
    expect(route({ ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" } })).toEqual([]);
  });

  it("unknown events are ignored", () => {
    expect(route({ ...base, hook_event_name: "SomethingElse" })).toEqual([]);
    expect(route({})).toEqual([]);
  });
});
