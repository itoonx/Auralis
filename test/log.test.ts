// The centralized run log: spans record durations, and summary() groups them by phase for bottleneck
// spotting. Durations are real wall-clock so we assert structure (counts, grouping, non-negative), not
// exact ms.
import { describe, it, expect } from "vitest";
import { log } from "../src/log";

describe("centralized run log", () => {
  it("records spans and summarizes grouped by phase", async () => {
    log.reset(); // no file — in-memory only
    log.start("phase.a", "one")();
    await log.time("phase.a", "two", async () => {});
    await log.time("phase.b", "three", async () => {});

    expect(log.spans.length).toBe(3);
    expect(log.spans.every((s) => s.ms >= 0 && s.atMs >= 0)).toBe(true);

    const s = log.summary();
    expect(s).toContain("phase.a");
    expect(s).toContain("phase.b");
    // phase.a happened twice → its grouped row shows count 2
    expect(s).toMatch(/phase\.a\s+2/);
  });

  it("reset clears prior spans", () => {
    log.reset();
    expect(log.spans.length).toBe(0);
  });
});
