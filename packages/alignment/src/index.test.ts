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

  it("accepts the exact next two syllables even at low interim confidence", () => {
    const result = new PrefixFuzzyMatcher().match({ text: "오늘", confidence: 0.1, receivedAt: 0, speechActive: true, isFinal: false }, segment, { candidateOffset: 0, mode: "NORMAL" });
    expect(result.eligible).toBe(true);
    expect(result.fast).toBe(true);
    expect(result.end - result.start).toBe(2);
  });

  it("does not use two-syllable evidence to skip an ordered cue", () => {
    const result = new PrefixFuzzyMatcher().match({ text: "오늘", confidence: 1, receivedAt: 0, speechActive: true }, segment, { candidateOffset: 1, mode: "NORMAL" });
    expect(result.eligible).toBe(false);
  });

  it("finds next-prefix evidence after unconsumed words from the previous line", () => {
    const result = new PrefixFuzzyMatcher().match({ text: "이전 문장 끝 오늘", confidence: 0.5, receivedAt: 0, speechActive: true }, segment, { candidateOffset: 0, mode: "NORMAL" });
    expect(result.eligible).toBe(true);
    expect(result.start).toBe(5);
  });
});
