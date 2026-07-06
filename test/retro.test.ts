import { describe, it, expect } from "vitest";
import { buildRetroText, recallRetro, RETRO_PREFIX } from "../src/retro";

describe("retro", () => {
  it("templates an actionable lesson from a failed-then-passed build", () => {
    const t = buildRetroText({
      goal: "todo api",
      mode: "build",
      pass: true,
      reworks: 1,
      firstFail: "- cli runs end-to-end: todos.json not written",
      reuses: 2,
      repairs: 0,
    });
    expect(t.startsWith(RETRO_PREFIX)).toBe(true);
    expect(t).toContain("PASS after 1 rework");
    expect(t).toContain("todos.json not written"); // the actual miss carried into the lesson
    expect(t).toMatch(/LESSON: The first attempt FAILED/);
  });

  it("a first-try pass yields a repeat-this lesson", () => {
    const t = buildRetroText({ goal: "g", mode: "build", pass: true, reworks: 0, reuses: 1, repairs: 0 });
    expect(t).toContain("PASS first try");
    expect(t).toMatch(/repeat its structure/);
  });

  it("recallRetro returns only retro records, not ordinary findings", async () => {
    const adapter: any = {
      search: async () => [
        { id: "1", content: "ordinary finding: store.js exports add()" },
        { id: "2", content: `${RETRO_PREFIX} · mode: build · goal: g\nresult: FAIL\nLESSON: persist up front` },
        { id: "3", content: `${RETRO_PREFIX} · superseded`, supersededBy: "9" }, // filtered out
      ],
    };
    const r = await recallRetro(adapter, "p", "g");
    expect(r).toContain("LESSON: persist up front");
    expect(r).not.toContain("ordinary finding");
    expect(r).not.toContain("superseded");
  });
});
