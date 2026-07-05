// The claim policy — one function the oracle-lite server and any runtime resolve against. First worker
// wins; a different worker is told to skip; the owner can re-claim; `fresh` flags the creating call.
import { describe, it, expect } from "vitest";
import { resolveClaim } from "../src/claim";

describe("claim policy prevents concurrent duplicate work", () => {
  it("first claim wins fresh, a different worker skips, owner re-claims (not fresh)", () => {
    const claimed = new Map<string, string>();
    expect(resolveClaim(claimed, "src/memory.ts", "A")).toEqual({ ok: true, owner: "A", fresh: true });
    // B tries the same file A is on → skip, told who owns it
    expect(resolveClaim(claimed, "src/memory.ts", "B")).toEqual({ ok: false, owner: "A", fresh: false });
    // A revisiting its own file is fine but not a new claim
    expect(resolveClaim(claimed, "src/memory.ts", "A")).toEqual({ ok: true, owner: "A", fresh: false });
    // a different file is free
    expect(resolveClaim(claimed, "src/graph.ts", "B")).toEqual({ ok: true, owner: "B", fresh: true });
  });
});
