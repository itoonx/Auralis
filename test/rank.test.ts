import { describe, it, expect } from "vitest";
import { rrf, trustOf, boost, daysBetween, RRF_K } from "../oracle-lite/rank";

describe("rrf", () => {
  it("a doc in BOTH lists outranks a doc that tops one list", () => {
    // b is rank-2 in both lists; a tops only the fts list.
    const s = rrf([
      ["a", "b", "c"], // fts order
      ["b", "d"], // vector order
    ]);
    expect(s.get("b")!).toBeGreaterThan(s.get("a")!);
  });

  it("rank-1 beats rank-2 within a single list", () => {
    const s = rrf([["x", "y"]]);
    expect(s.get("x")!).toBeGreaterThan(s.get("y")!);
    expect(s.get("x")!).toBeCloseTo(1 / (RRF_K + 1));
  });

  it("works with one empty list (fts-only / vector-only modes)", () => {
    const s = rrf([["a"], []]);
    expect(s.get("a")).toBeCloseTo(1 / (RRF_K + 1));
    expect(s.size).toBe(1);
  });
});

describe("trustOf", () => {
  it("maps sources to the research priors, defaulting LOW", () => {
    expect(trustOf("human")).toBe(1.0);
    expect(trustOf("auralis:retro")).toBe(0.85); // test-derived
    expect(trustOf("auralis:decision")).toBe(0.7);
    expect(trustOf("auralis:distilled")).toBe(0.7);
    expect(trustOf("auralis:worker:brain")).toBe(0.5); // agent_inferred floor
    expect(trustOf("anything-else")).toBe(0.5);
  });
});

describe("boost", () => {
  const base = { timesUsed: 0, maxUsed: 0, daysSinceAccess: 0, superseded: false };

  it("higher trust wins at equal relevance (retro beats worker finding)", () => {
    const retro = boost(1, { ...base, trust: 0.85 });
    const finding = boost(1, { ...base, trust: 0.5 });
    expect(retro).toBeGreaterThan(finding);
  });

  it("relevance dominates: max boost is bounded ×1.5, so a clearly better match still wins", () => {
    const bestMatchWorstMeta = boost(1.0, { trust: 0, timesUsed: 0, maxUsed: 10, daysSinceAccess: 9999, superseded: false });
    const weakMatchBestMeta = boost(0.6, { trust: 1, timesUsed: 10, maxUsed: 10, daysSinceAccess: 0, superseded: false });
    expect(bestMatchWorstMeta).toBeGreaterThan(weakMatchBestMeta); // 1.0 ≥ 0.6×1.5
  });

  it("superseded docs sink hard (×0.3)", () => {
    const live = boost(1, { ...base, trust: 0.5 });
    const dead = boost(1, { ...base, trust: 0.5, superseded: true });
    expect(dead).toBeCloseTo(live * 0.3);
  });

  it("fresh beats stale at equal trust (14-day half-life)", () => {
    const fresh = boost(1, { ...base, trust: 0.5, daysSinceAccess: 0 });
    const stale = boost(1, { ...base, trust: 0.5, daysSinceAccess: 28 }); // two half-lives
    expect(fresh).toBeGreaterThan(stale);
  });

  it("usage boosts, log-damped", () => {
    const used = boost(1, { trust: 0.5, timesUsed: 5, maxUsed: 5, daysSinceAccess: 0, superseded: false });
    const unused = boost(1, { trust: 0.5, timesUsed: 0, maxUsed: 5, daysSinceAccess: 0, superseded: false });
    expect(used).toBeGreaterThan(unused);
  });
});

describe("daysBetween", () => {
  it("no timestamp = fresh, not dead", () => {
    expect(daysBetween(null, Date.now())).toBe(0);
    expect(daysBetween("garbage", Date.now())).toBe(0);
  });
  it("counts days", () => {
    const now = Date.parse("2026-07-07T00:00:00Z");
    expect(daysBetween("2026-06-23T00:00:00Z", now)).toBeCloseTo(14);
  });
});
