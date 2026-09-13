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

describe("conservative musical performance matcher", () => {
  const canonical = { ...segment, matchText: ["가장 어려운 곳에 주님의 사랑이"], captions: [{ actor: "A", text: "가장 어려운 곳에 주님의 사랑이" }] };
  const match = (text: string, expected = canonical, nearbySegments: ScriptSegment[] = [canonical], candidateOffset = 0) => new PrefixFuzzyMatcher().match({ text, confidence: 0.95, speechActive: true, receivedAt: 0, isFinal: false }, expected, { candidateOffset, mode: "NORMAL", operatingMode: "PERFORMANCE_LOCAL", nearbySegments });

  it("recovers missing and stretched opening words using internal canonical anchors", () => {
    for (const text of ["어려운 곳에 주님의 사랑이", "가아아장 어러운 곳에 주님의 사랑이"]) {
      const result = match(text);
      expect(result.eligible, text).toBe(true);
      expect(result.selectedAnchor!.length).toBeGreaterThanOrEqual(4);
      expect(result.components?.text).toBeGreaterThan(0.8);
      expect(result.fast).toBe(false);
    }
  });

  it("uses local fuzzy evidence for a mangled lyric rather than depending on the first syllable", () => {
    const fuzzy = { ...canonical, matchText: ["언제나흔들림없이"] };
    expect(match("언제나흔들림엎이", fuzzy, [fuzzy]).eligible).toBe(true);
  });

  it("rejects common two-syllable phrases and unrelated speech", () => {
    const first = { ...canonical, matchText: ["다시 시작해 우리의 꿈을"] };
    const second = { ...canonical, id: "next", matchText: ["다시 시작해 너의 길을"] };
    for (const text of ["다시", "다시 시작해", "관객 여러분 휴대폰을 꺼주세요", "주님"]) expect(match(text, first, [first, second]).eligible, text).toBe(false);
  });

  it("accepts a complete repeated lyric only at the ordered pointer", () => {
    const first = { ...canonical, matchText: ["다시 시작해"] };
    const second = { ...first, id: "next" };
    expect(match("다시 시작해", first, [first, second]).eligible).toBe(true);
    expect(match("다시 시작해", second, [first, second], 1).eligible).toBe(false);
  });

  it("never matches explicit image cues from recognition or silence", () => {
    const image: ScriptSegment = { id: "image", order: 1, type: "IMAGE", captions: [], matchText: [], image: { src: "/scene.png", alt: "" } };
    expect(match("scene image", image, [image]).eligible).toBe(false);
  });

  it("rejects fuzzy next-lyric evidence that matches the previous lyric more strongly", () => {
    const previous = { ...canonical, id: "previous", matchText: ["우리는 함께 걸어와"] };
    const next = { ...canonical, id: "next", matchText: ["우리는 함께 걸어가"] };
    expect(match(previous.matchText[0]!, next, [previous, next]).eligible).toBe(false);
    expect(match(next.matchText[0]!, next, [previous, next]).eligible).toBe(true);
  });
});
