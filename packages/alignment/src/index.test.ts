import { describe, expect, it } from "vitest";
import type { ScriptSegment } from "@stage/script-schema";
import { normalizeKorean, PrefixFuzzyMatcher } from "./index";

const segment: ScriptSegment = {
  id: "segment",
  order: 1,
  type: "SOLO",
  captions: [{ actor: "A", text: "오늘 여기서 시작하자" }],
  matchText: ["오늘 여기서 시작하자"]
};

describe("Korean prefix matcher", () => {
  it("normalizes spaces, punctuation, case, and standalone fillers", () => {
    expect(normalizeKorean("음, 오늘 여기서! ABC")).toBe("오늘여기서abc");
  });

  it("rejects one-syllable evidence", () => {
    const result = new PrefixFuzzyMatcher().match(
      { text: "오", confidence: 1, receivedAt: 0, speechActive: true },
      segment,
      { candidateOffset: 0, mode: "NORMAL" }
    );
    expect(result.eligible).toBe(false);
  });

  it("triggers on a confident partial prefix", () => {
    const result = new PrefixFuzzyMatcher().match(
      { text: "오늘 여기서", confidence: 0.9, receivedAt: 0, speechActive: true },
      segment,
      { candidateOffset: 0, mode: "NORMAL" }
    );
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThan(0.78);
  });
});

