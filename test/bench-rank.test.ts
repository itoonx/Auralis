import { describe, it, expect } from "vitest";
import { precisionAt1, mrr, type Ranking } from "../src/bench-rank";

const R = (correct: string, order: string[]): Ranking => ({ query: "q", correct, order });

describe("ranking metrics", () => {
  it("precision@1 = fraction with the correct doc at rank #1", () => {
    expect(precisionAt1([R("a", ["a", "b"]), R("a", ["b", "a"]), R("c", ["c"])])).toBeCloseTo(2 / 3);
    expect(precisionAt1([])).toBe(0);
  });

  it("mrr gives 1 for #1, 1/2 for #2, 0 for absent", () => {
    expect(mrr([R("a", ["a", "b"])])).toBe(1);
    expect(mrr([R("a", ["b", "a"])])).toBe(0.5);
    expect(mrr([R("a", ["b", "c"])])).toBe(0); // correct not returned
    expect(mrr([R("a", ["a"]), R("b", ["x", "b"])])).toBeCloseTo((1 + 0.5) / 2);
  });
});
