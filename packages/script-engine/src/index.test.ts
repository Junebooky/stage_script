import { beforeEach, describe, expect, it } from "vitest";
import { demoScript, type PerformanceScript } from "@stage/script-schema";
import { normalizeKorean } from "@stage/alignment";
import { ScriptFollowingEngine } from "./index";

let engine: ScriptFollowingEngine;
let clock: number;

beforeEach(() => {
  engine = new ScriptFollowingEngine(demoScript);
  engine.arm();
  clock = 100;
});

function speak(text: string, confidence = 0.98) {
  clock += 100;
  engine.speechStart(clock - 10);
  return engine.processHypothesis({ text, confidence, receivedAt: clock, speechActive: true });
}

describe("script following state machine", () => {
  it("follows every syllable of a continuous full-script transcript without premature or missing cues", () => {
    let context = "";
    for (const [index, segment] of demoScript.segments.entries()) {
      const line = normalizeKorean(segment.matchText[0]!);
      for (let length = 1; length <= line.length; length += 1) {
        clock += 20;
        const state = engine.processHypothesis({ text: context + line.slice(0, length), streamId: "continuous-full-script", confidence: 0.3, receivedAt: clock, speechActive: true, isFinal: false });
        expect(state.currentIndex, `cue ${index + 1}, partial ${line.slice(0, length)}`).toBe(length < 2 ? index - 1 : index);
      }
      context += line;
    }
  });

  it("reset while listening ignores old cumulative speech until new evidence arrives", () => {
    const hypothesis = { streamId: "live", confidence: 0.9, receivedAt: 100, speechActive: true, isFinal: false };
    engine.processHypothesis({ ...hypothesis, text: "어둠이 길어져도" });
    engine.reset();
    expect(engine.processHypothesis({ ...hypothesis, text: "어둠이 길어져도", isFinal: true }).currentIndex).toBe(-1);
    expect(engine.processHypothesis({ ...hypothesis, text: "어둠이 길어져도 어둠", receivedAt: 150 }).currentIndex).toBe(0);
  });

  it("rewinding while listening does not replay an old prefix from cumulative speech", () => {
    const hypothesis = { streamId: "live", confidence: 0.9, receivedAt: 100, speechActive: true, isFinal: false };
    engine.processHypothesis({ ...hypothesis, text: "어둠" });
    engine.processHypothesis({ ...hypothesis, text: "어둠 한걸" });
    engine.processHypothesis({ ...hypothesis, text: "어둠 한걸 내목" });
    engine.manualPrevious(120);
    expect(engine.processHypothesis({ ...hypothesis, text: "어둠 한걸 내목소리를 따라와", receivedAt: 150 }).currentIndex).toBe(1);
    expect(engine.processHypothesis({ ...hypothesis, text: "어둠 한걸 내목소리를 따라와 내목", receivedAt: 180 }).currentIndex).toBe(2);
  });

  it("follows every demo cue using two-syllable interims, no finals, silence, or manual buttons", () => {
    let context = "";
    for (const [index, segment] of demoScript.segments.entries()) {
      const prefix = normalizeKorean(segment.matchText[0]!).slice(0, 2);
      context += prefix;
      const state = engine.processHypothesis({ text: prefix, contextText: context, streamId: "entire-performance", utteranceId: `result-${index}`, confidence: 0.2, receivedAt: 100 + index * 20, speechActive: true, isFinal: false });
      expect(state.currentIndex).toBe(index);
      expect(state.displayedSegment?.id).toBe(segment.id);
    }
    expect(engine.snapshot().completedIndexes).toHaveLength(15);
  });

  it("does not treat the next prefix inside the current line as a new cue", () => {
    const script: PerformanceScript = { ...demoScript, segments: [
      { ...demoScript.segments[0]!, captions: [{ actor: "A", text: "우리는 다시 만날 거야" }], matchText: ["우리는 다시 만날 거야"] },
      { ...demoScript.segments[1]!, captions: [{ actor: "A", text: "다시 시작해" }], matchText: ["다시 시작해"] }
    ] };
    const guarded = new ScriptFollowingEngine(script);
    const hypothesis = { utteranceId: "u", confidence: 0.8, receivedAt: 100, speechActive: true, isFinal: false };
    guarded.processHypothesis({ ...hypothesis, text: "우리" });
    expect(guarded.processHypothesis({ ...hypothesis, receivedAt: 110, text: "우리는 다시 만날 거야" }).currentIndex).toBe(0);
    expect(guarded.processHypothesis({ ...hypothesis, receivedAt: 120, text: "우리는 다시 만날 거야 다시" }).currentIndex).toBe(1);
  });

  it("accepts a second occurrence but ignores final revisions of the same repeated cue", () => {
    engine.jumpTo(6, 100);
    const hypothesis = { utteranceId: "same", confidence: 0.8, receivedAt: 110, speechActive: true, isFinal: false };
    expect(engine.processHypothesis({ ...hypothesis, text: "다시" }).currentIndex).toBe(7);
    expect(engine.processHypothesis({ ...hypothesis, text: "다시 시작해", receivedAt: 120, isFinal: true }).currentIndex).toBe(7);
    expect(engine.processHypothesis({ ...hypothesis, text: "다시 시작해 다시", receivedAt: 130 }).currentIndex).toBe(8);
  });

  it("remaps consumed evidence when ASR revises earlier words in a continuous transcript", () => {
    const hypothesis = { utteranceId: "same", confidence: 0.8, receivedAt: 100, speechActive: true, isFinal: false };
    engine.processHypothesis({ ...hypothesis, text: "어둠이 길어져도 우린 이 무대 떠나지 않아" });
    engine.processHypothesis({ ...hypothesis, text: "어둠이 길어져도 우린 이 무대 떠나지 않아 한 걸", receivedAt: 120 });
    const state = engine.processHypothesis({ ...hypothesis, text: "어둠이 길어져도 우리는 이 무대를 떠나지 않아 한 걸음 뒤에는 또 다른 길이 열릴 테니까 내 목", receivedAt: 140 });
    expect(state.currentIndex).toBe(2);
  });

  it("cues the very next line on two syllables without waiting for a final result", () => {
    expect(engine.processHypothesis({ text: "어둠", confidence: 0.3, receivedAt: 100, speechActive: true, isFinal: false, utteranceId: "fast-1" }).currentIndex).toBe(0);
    expect(engine.processHypothesis({ text: "한 걸", confidence: 0.3, receivedAt: 130, speechActive: true, isFinal: false, utteranceId: "fast-2" }).currentIndex).toBe(1);
  });

  it("does not require an earlier ASR sentence to match the entire script verbatim", () => {
    const utterance = { confidence: 0.85, receivedAt: 100, speechActive: true, isFinal: false, utteranceId: "continuous" };
    engine.processHypothesis({ ...utterance, text: "어둠이 길어져도" });
    const next = engine.processHypothesis({ ...utterance, receivedAt: 150, text: "어둠이 길어져도 우린 이 무대 떠나지 않아 한 걸" });
    expect(next.currentIndex).toBe(1);
    expect(next.completedIndexes).toEqual([0]);
  });

  it("supports a rolling recognizer replacing its text with the next line", () => {
    const utterance = { confidence: 0.9, receivedAt: 100, speechActive: true, utteranceId: "rolling" };
    engine.processHypothesis({ ...utterance, text: demoScript.segments[0]!.matchText[0]! });
    expect(engine.processHypothesis({ ...utterance, receivedAt: 140, text: "한 걸" }).currentIndex).toBe(1);
  });

  it("never counts the whole continuous monologue as the latency of each later cue", () => {
    engine.speechStart(10);
    engine.processHypothesis({ text: "어둠이 길어져도", confidence: 0.95, receivedAt: 100, speechActive: true, utteranceId: "a" });
    expect(engine.snapshot().lastTrigger?.speechOnsetAt).toBe(10);
    engine.processHypothesis({ text: "한 걸음 뒤에는", confidence: 0.95, receivedAt: 5000, speechActive: true, utteranceId: "b" });
    expect(engine.snapshot().lastTrigger?.speechOnsetAt).toBe(null);
  });

  it("marks only the previously displayed cue complete, not skipped script lines", () => {
    expect(engine.manualNext(clock).completedIndexes).toEqual([]);
    const skipped = engine.jumpTo(3, clock + 100);
    expect(skipped.currentIndex).toBe(3);
    expect(skipped.completedIndexes).toEqual([0]);
    engine.speechEnd();
    engine.toggleHold();
    expect(speak(demoScript.segments[4]!.matchText[0]!).completedIndexes).toEqual([0]);
  });

  it("re-arms completion state when rewinding and clears it on reset", () => {
    engine.manualNext(clock);
    engine.manualNext(clock + 100);
    expect(engine.manualNext(clock + 200).completedIndexes).toEqual([0, 1]);
    expect(engine.manualPrevious(clock + 300).completedIndexes).toEqual([0]);
    expect(engine.reset().completedIndexes).toEqual([]);
    expect(engine.snapshot().finished).toBe(false);
  });

  it("finishes the final cue explicitly, keeping its caption without inventing skipped completions", () => {
    expect(engine.finish().finished).toBe(false);
    engine.jumpTo(demoScript.segments.length - 1, clock);
    expect(engine.snapshot().completedIndexes).toEqual([]);
    const finished = engine.manualNext(clock + 100);
    expect(finished.finished).toBe(true);
    expect(finished.completedIndexes).toEqual([15]);
    expect(finished.displayedSegment?.id).toBe("seg-016");
    expect(speak(demoScript.segments[0]!.matchText[0]!).currentIndex).toBe(15);
    expect(engine.manualPrevious(clock + 300).finished).toBe(false);
  });

  it("does not re-trigger a repeated phrase on revisions of the same ASR utterance", () => {
    engine.jumpTo(6, clock);
    const partial = { text: "다시 시작해", confidence: 0.99, receivedAt: clock + 100, speechActive: true, utteranceId: "u1" };
    expect(engine.processHypothesis(partial).currentIndex).toBe(7);
    expect(engine.processHypothesis({ ...partial, receivedAt: clock + 800, isFinal: true }).currentIndex).toBe(7);
    expect(engine.processHypothesis({ ...partial, receivedAt: clock + 900, utteranceId: "u2" }).currentIndex).toBe(8);
  });

  it("consumes current-line revisions then matches a next-line prefix in continuous ASR", () => {
    const first = demoScript.segments[0]!.matchText[0]!;
    const second = demoScript.segments[1]!.matchText[0]!;
    const partial = { text: first.slice(0, 6), confidence: 0.98, receivedAt: 100, speechActive: true, utteranceId: "u1" };
    expect(engine.processHypothesis(partial).currentIndex).toBe(0);
    for (let index = 7; index < first.length; index++) {
      expect(engine.processHypothesis({ ...partial, text: first.slice(0, index), receivedAt: 100 + index * 100 }).currentIndex).toBe(0);
    }
    expect(engine.snapshot().searchMode).toBe("NORMAL");
    expect(engine.processHypothesis({ ...partial, text: first + " " + second.slice(0, 8), receivedAt: 5000 }).currentIndex).toBe(1);
  });
  it("advances in script order", () => {
    expect(speak(demoScript.segments[0]!.matchText[0]!).currentIndex).toBe(0);
    expect(speak(demoScript.segments[1]!.matchText[0]!).currentIndex).toBe(1);
  });

  it("handles same actor consecutive segments", () => {
    speak(demoScript.segments[0]!.matchText[0]!);
    speak(demoScript.segments[1]!.matchText[0]!);
    const state = speak(demoScript.segments[2]!.matchText[0]!);
    expect(state.currentSegment?.captions[0]?.actor).toBe("해온");
    expect(state.currentIndex).toBe(2);
  });

  it("does not care when the actor changes", () => {
    engine.jumpTo(2, clock);
    const state = speak("지금");
    expect(state.currentIndex).toBe(3);
    expect(state.currentSegment?.captions[0]?.actor).toBe("리안");
  });

  it("never advances on a long pause", () => {
    speak(demoScript.segments[0]!.matchText[0]!);
    const before = engine.snapshot().currentIndex;
    engine.speechEnd();
    clock += 3_500;
    expect(engine.snapshot().currentIndex).toBe(before);
  });

  it("tracks repeated phrases by order", () => {
    engine.jumpTo(6, clock);
    expect(speak("다시 시작해").currentIndex).toBe(7);
    expect(speak("다시 시작해").currentIndex).toBe(8);
  });

  it("prevents false positives from one syllable", () => {
    const state = speak("어", 1);
    expect(state.currentIndex).toBe(-1);
  });

  it("recovers a one-segment skip within the local window", () => {
    const state = speak(demoScript.segments[1]!.matchText[0]!);
    expect(state.currentIndex).toBe(1);
  });

  it("widens the search window after confidence loss", () => {
    for (let index = 0; index < 4; index += 1) speak("관계없는 문장입니다");
    expect(engine.snapshot().searchMode).toBe("RESYNC");
    const state = speak(demoScript.segments[7]!.matchText[0]!);
    expect(state.currentIndex).toBe(7);
  });

  it("keeps every overlap caption on the triggered segment", () => {
    engine.jumpTo(8, clock);
    const state = speak(demoScript.segments[9]!.matchText[0]!);
    expect(state.currentSegment?.type).toBe("OVERLAP");
    expect(state.displayedSegment?.captions).toHaveLength(2);
  });

  it("renders chorus as one prepared caption", () => {
    engine.jumpTo(10, clock);
    const state = speak(demoScript.segments[11]!.matchText[0]!);
    expect(state.currentSegment?.type).toBe("CHORUS");
    expect(state.displayedSegment?.captions).toHaveLength(1);
  });

  it("supports manual next, previous, hold, and resync", () => {
    expect(engine.manualNext(clock).currentIndex).toBe(0);
    expect(engine.manualNext(clock).currentIndex).toBe(1);
    expect(engine.manualPrevious(clock).currentIndex).toBe(0);
    engine.toggleHold();
    expect(speak(demoScript.segments[1]!.matchText[0]!).currentIndex).toBe(0);
    engine.toggleHold();
    expect(engine.forceResync().searchMode).toBe("RESYNC");
  });
});
