import { describe, expect, it } from "vitest";
import { DiscriminativeWordMatcher, normalizeKorean, PrefixFuzzyMatcher, type ScriptContext, type StreamingHypothesis } from "./index";
import type { ScriptSegment } from "@stage/script-schema";

const cue = (text: string, id = "next"): ScriptSegment => ({ id, order: 1, type: "CAPTION", matchText: [text], captions: [{ actor: "A", text }] });
const hypothesis = (text: string): StreamingHypothesis => ({ text: normalizeKorean(text), confidence: null, confidenceBasis: "unavailable", receivedAt: 1000, speechActive: true, evidenceBasis: "saved-completed-words", isFinal: false });
const context = (rawTranscript: string, target: ScriptSegment, others: ScriptSegment[] = []): ScriptContext => ({ rawTranscript, normalizedOffset: 0, candidateOffset: 0, mode: "NORMAL", operatingMode: "PERFORMANCE_LOCAL", nearbySegments: [target, ...others] });
const matcher = new DiscriminativeWordMatcher();

describe("completed-word discriminative early policy", () => {
  it.each(["창가로", "어서", "걱정"])("accepts an exact unique completed prefix %s, not a final sentence", (word) => {
    const target = cue(word + " 새로운 노래를 불러요");
    const ctx = context(word, target, [cue("달빛 아래 잠들어요", "other")]);
    expect(new PrefixFuzzyMatcher().match(hypothesis(word), target, ctx).eligible).toBe(false);
    expect(matcher.match(hypothesis(word), target, ctx)).toMatchObject({ eligible: true, fast: true, selectedAnchor: word, reason: "unique-completed-word-prefix" });
  });
  it("does not cut an observed word to manufacture an exact prefix", () => {
    const target = cue("동이트기 전에 만나요");
    expect(matcher.match(hypothesis("동의"), target, context("동의", target)).eligible).toBe(false);
  });
  it("accepts a two-word exact internal recovery but not its one-word fragments", () => {
    const target = cue("돌아와요 내 품이 매일 기다려요");
    for (const text of ["내", "품이", "더러워요"]) expect(matcher.match(hypothesis(text), target, context(text, target)).eligible).toBe(false);
    expect(matcher.match(hypothesis("내 품이"), target, context("내 품이", target))).toMatchObject({ eligible: true, reason: "unique-two-word-internal", selectedAnchor: "내품이" });
  });
  it.each(["RESYNC", "FULL_RESYNC"] as const)("does not enable short-evidence %s recovery", (mode) => {
    const target = cue("창가로 새로운 노래");
    expect(matcher.match(hypothesis("창가로"), target, { ...context("창가로", target), mode }).eligible).toBe(false);
  });
  it("does not use a speculative future candidate or unverified live word boundaries", () => {
    const target = cue("창가로 새로운 노래");
    expect(matcher.match(hypothesis("창가로"), target, { ...context("창가로", target), candidateOffset: 1 }).eligible).toBe(false);
    expect(matcher.match({ ...hypothesis("창가로"), evidenceBasis: undefined }, target, context("창가로", target)).eligible).toBe(false);
    expect(matcher.match(hypothesis("창가로"), target, { ...context("창가로", target), rawTranscript: undefined }).eligible).toBe(false);
  });
  it.each(["음", "어", "아", "저기", "우리", "내", "감사합니다"])("does not early-trigger filler/noise/post-take %s", (text) => {
    const target = cue("우리 잠시 이 밤을 만나봐요");
    expect(matcher.match(hypothesis(text), target, context(text, target)).eligible).toBe(false);
  });
  it("preserves unavailable-confidence protection for an authored two-syllable cue", () => {
    const target = cue("다시");
    expect(matcher.match(hypothesis("다시"), target, context("다시", target)).eligible).toBe(false);
  });
  it("blocks shared openings and reports a diagnostic competitor, not a selectable runner-up", () => {
    const target = cue("지금 어딘가 그대도 보고 있나");
    const other = cue("어서 내 문을 지금 두드려 줘요", "nearby");
    expect(matcher.match(hypothesis("지금"), target, context("지금", target, [other]))).toMatchObject({ eligible: false, reason: "ambiguous-short-evidence", competitor: { cueId: "nearby", score: 1 } });
  });
  it("blocks a near-identical opening with insufficient edit margin", () => {
    const target = cue("파란하늘 아래서 노래해");
    const previous = cue("파란하루 아래서 기다려", "previous");
    expect(matcher.match(hypothesis("파란하"), target, context("파란하", target, [previous])).eligible).toBe(false);
  });
  it("blocks previous lyric trailing speech even in a new raw ASR segment", () => {
    const target = cue("길을 열어 주오");
    expect(matcher.match(hypothesis("길을"), target, context("길을", target, [cue("어서 길을 비춰 주오", "previous")])).eligible).toBe(false);
  });
  it("does not early-disambiguate adjacent identical occurrences", () => {
    const target = cue("창가로 스며드는 달빛");
    expect(matcher.match(hypothesis("창가로"), target, context("창가로", target, [cue(target.matchText[0]!, "repeat")])).eligible).toBe(false);
  });
  it("respects normalized cursor offsets and punctuation/filler normalization", () => {
    const target = cue("창가로 스며드는 달빛");
    const raw = "이전 노래. 음 창가로";
    expect(matcher.match(hypothesis("창가로"), target, { ...context(raw, target), normalizedOffset: 4 })).toMatchObject({ eligible: true, start: 0, end: 3 });
    expect(matcher.match(hypothesis("가로"), target, { ...context(raw, target), normalizedOffset: 5 }).eligible).toBe(false);
  });
});
