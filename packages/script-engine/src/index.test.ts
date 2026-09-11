import { beforeEach, describe, expect, it } from "vitest";
import { demoScript } from "@stage/script-schema";
import { ScriptFollowingEngine } from "./index";

let engine: ScriptFollowingEngine;
let clock: number;

beforeEach(() => {
  engine = new ScriptFollowingEngine(demoScript, undefined, { triggerCooldownMs: 0 });
  engine.arm();
  clock = 100;
});

function speak(text: string, confidence = 0.98) {
  clock += 100;
  engine.speechStart(clock - 10);
  return engine.processHypothesis({ text, confidence, receivedAt: clock, speechActive: true });
}

describe("script following state machine", () => {
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

