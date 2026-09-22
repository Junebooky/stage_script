import { describe, expect, it } from "vitest";
import type { PerformanceScript } from "@stage/script-schema";
import { ScriptFollowingEngine } from "./index";

const script: PerformanceScript = {
  title: "Lookahead Skip Verification",
  locale: "ko-KR",
  segments: [
    { id: "cue-1", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "창가로 스며드는 외로운 저 달빛" }], matchText: ["창가로 스며드는 외로운 저 달빛"] },
    { id: "cue-2", order: 2, type: "CAPTION", captions: [{ actor: "A", text: "어두운 숲이여" }], matchText: ["어두운 숲이여"] },
    { id: "cue-3", order: 3, type: "CAPTION", captions: [{ actor: "B", text: "길을 열어 주오" }], matchText: ["길을 열어 주오"] },
    { id: "cue-4", order: 4, type: "CAPTION", captions: [{ actor: "B", text: "만날 수 있게" }], matchText: ["만날 수 있게"] }
  ]
};

const hyp = (text: string, receivedAt: number, streamId = "stream-1") => ({
  text, receivedAt, streamId, confidence: 0.95, speechActive: true, isFinal: false
});

describe("Bounded Lookahead Skip Recovery Policy", () => {
  const setup = () => {
    const engine = new ScriptFollowingEngine(script, undefined, {
      operatingMode: "PERFORMANCE_LOCAL",
      profiles: []
    });
    engine.arm();
    return engine;
  };

  it("prioritizes normal expected cue (offset 0) without skipping", () => {
    const engine = setup();
    expect(engine.processHypothesis(hyp("창가로 스며드는 달빛", 1000)).currentIndex).toBe(0);
    expect(engine.processHypothesis(hyp("어두운 숲이여", 5000)).currentIndex).toBe(1);
    expect(engine.snapshot().completedIndexes).toEqual([0]);
    expect(engine.snapshot().displayedSegment?.id).toBe("cue-2");
  });

  it("temporal guard rejects premature lookahead skip if elapsed time is insufficient", () => {
    const engine = setup();
    // Trigger cue-1 at 1000ms
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Cue-2 ("어두운 숲이여", 6 chars) requires at least Math.max(2000, 6 * 250) = 2000ms.
    // Try to trigger cue-3 ("길을 열어 주오") only 500ms later (at 1500ms):
    const state = engine.processHypothesis(hyp("길을 열어 주오", 1500));
    expect(state.currentIndex).toBe(0); // Still at cue-1!
    expect(engine.exportTelemetry().some((e) => e.decision?.includes("lookahead-skip-temporal-guard-active"))).toBe(true);
  });

  it("permits atomic lookahead skip when temporal, high-confidence, and disambiguation guards all pass", () => {
    const engine = setup();
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Elapsed time: 4000ms - 1000ms = 3000ms >= 2000ms (temporal guard passes)
    // Anchor: "열어주오" (4 chars >= 4), score >= 0.90 (high-confidence guard passes)
    // Disambiguation: "열어주오" vs "어두운 숲이여" (0 similarity), vs cue-1 (low similarity) (margin passes)
    const state = engine.processHypothesis(hyp("이래 열어주오", 4000));
    expect(state.currentIndex).toBe(2); // Jumped to cue-3 (index 2)!
    expect(state.displayedSegment?.id).toBe("cue-3"); // Atomic cut directly to cue-3!
    expect(state.completedIndexes).toEqual([0]); // cue-2 was never completed!

    // Verify telemetry recorded the skip
    const skipEvent = engine.exportTelemetry().find((e) => e.decision === "lookahead-skip-by-cue-3");
    expect(skipEvent).toBeDefined();
    expect(skipEvent?.currentCue).toBe("cue-2");
    expect(skipEvent?.candidateCue).toBe("cue-3");
    expect(skipEvent?.transition).toBe("skipped");

    // Subsequent cue (cue-4) triggers normally as offset 0
    const nextState = engine.processHypothesis(hyp("만날 수 있게", 8000));
    expect(nextState.currentIndex).toBe(3);
    expect(nextState.completedIndexes).toEqual([0, 2]);
  });

  it("forbids lookahead skip at the very first cue before any cue has triggered", () => {
    const engine = setup();
    // At the start, currentIndex is -1. Attempting cue-2 should not skip cue-1.
    const state = engine.processHypothesis(hyp("어두운 숲이여", 5000));
    expect(state.currentIndex).toBe(-1);
    expect(engine.exportTelemetry().some((e) => e.decision === "lookahead-skip-forbidden-before-first-trigger")).toBe(true);
  });

  it("high-confidence guard rejects skip if anchor is fewer than 4 characters", () => {
    const shortScript: PerformanceScript = {
      title: "Short Anchor Script",
      locale: "ko-KR",
      segments: [
        { id: "c1", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "가나다라마바사" }], matchText: ["가나다라마바사"] },
        { id: "c2", order: 2, type: "CAPTION", captions: [{ actor: "A", text: "아자차카타파하" }], matchText: ["아자차카타파하"] },
        { id: "c3", order: 3, type: "CAPTION", captions: [{ actor: "B", text: "봄날" }], matchText: ["봄날"] } // 2 chars
      ]
    };
    const engine = new ScriptFollowingEngine(shortScript, undefined, { operatingMode: "PERFORMANCE_LOCAL" });
    engine.arm();
    engine.processHypothesis(hyp("가나다라마바사", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Try to skip c2 using 2-character anchor at 5000ms
    const state = engine.processHypothesis(hyp("봄날", 5000));
    expect(state.currentIndex).toBe(0);
    expect(engine.exportTelemetry().some((e) => e.decision === "below-four-character-baseline" || e.decision === "lookahead-skip-anchor-below-four-characters")).toBe(true);
  });

  it("disambiguation guard rejects skip if candidate text collides with un-triggered cue", () => {
    const collidingScript: PerformanceScript = {
      title: "Colliding Script",
      locale: "ko-KR",
      segments: [
        { id: "c1", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "창가로 스며드는 달빛" }], matchText: ["창가로 스며드는 달빛"] },
        { id: "c2", order: 2, type: "CAPTION", captions: [{ actor: "A", text: "우리는 함께 걸어와" }], matchText: ["우리는 함께 걸어와"] },
        { id: "c3", order: 3, type: "CAPTION", captions: [{ actor: "B", text: "우리는 함께 걸어가" }], matchText: ["우리는 함께 걸어가"] } // Collides with c2 (similarity ~0.89)
      ]
    };
    const engine = new ScriptFollowingEngine(collidingScript, undefined, { operatingMode: "PERFORMANCE_LOCAL" });
    engine.arm();
    engine.processHypothesis(hyp("창가로 스며드는 달빛", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Try to trigger c3 at 5000ms with "우리는 함께 걸어가". It is too similar to c2 ("우리는 함께 걸어와")
    const state = engine.processHypothesis(hyp("우리는 함께 걸어가", 5000));
    expect(state.currentIndex).toBe(0); // Collision guard must reject the skip!
    expect(engine.exportTelemetry().some((e) => e.decision?.includes("lookahead-skip-current-cue-collision"))).toBe(true);
  });

  it("operator control (HOLD) completely blocks lookahead skip", () => {
    const engine = setup();
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    engine.setHold(true);
    const state = engine.processHypothesis(hyp("이래 열어주오", 5000));
    expect(state.currentIndex).toBe(0);
    expect(engine.snapshot().hold).toBe(true);
  });

  it("operator control (manual checkpoint) blocks lookahead skip until fresh speech", () => {
    const engine = setup();
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Operator triggers manual checkpoint
    engine.manualNext(2000); // Manually at cue-2
    expect(engine.snapshot().currentIndex).toBe(1);

    // Hypotheses before fresh speech onset cannot trigger lookahead skip
    const state = engine.processHypothesis(hyp("길을 열어 주오", 2100, "stream-1"));
    expect(state.currentIndex).toBe(1);
  });

  it("IMAGE cue acts as an impermeable barrier that is never skipped and never triggers via lookahead", () => {
    const barrierScript: PerformanceScript = {
      title: "Barrier Script",
      locale: "ko-KR",
      segments: [
        { id: "c1", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "첫 번째 가사입니다" }], matchText: ["첫 번째 가사입니다"] },
        { id: "c2", order: 2, type: "IMAGE", captions: [], matchText: [], image: { src: "/test.png", alt: "test" } },
        { id: "c3", order: 3, type: "CAPTION", captions: [{ actor: "B", text: "세 번째 가사입니다" }], matchText: ["세 번째 가사입니다"] }
      ]
    };
    const engine = new ScriptFollowingEngine(barrierScript, undefined, { operatingMode: "PERFORMANCE_LOCAL" });
    engine.arm();
    engine.processHypothesis(hyp("첫 번째 가사입니다", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Speech matching c3 cannot skip across the IMAGE barrier c2
    const state = engine.processHypothesis(hyp("세 번째 가사입니다", 5000));
    expect(state.currentIndex).toBe(0);
  });

  it("strictly forbids skipping 2 or more cues at once", () => {
    const engine = setup();
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Try to trigger cue-4 ("만날 수 있게") directly from cue-1 (offset +2)
    const state = engine.processHypothesis(hyp("만날 수 있게", 5000));
    expect(state.currentIndex).toBe(0); // Cannot jump 2 cues!
  });

  it("records skipped cue in skippedIndexes and leaves it out of completedIndexes", () => {
    const engine = setup();
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    expect(engine.snapshot().currentIndex).toBe(0);

    // Lookahead skip: cue-1 -> cue-3, skipping cue-2 (index 1)
    const state = engine.processHypothesis(hyp("이래 열어주오", 4000));
    expect(state.currentIndex).toBe(2);
    expect(state.completedIndexes).toEqual([0]);
    expect(state.skippedIndexes).toEqual([1]);

    // Subsequent normal trigger (cue-4, index 3) completes cue-3, while cue-2 remains skipped
    const nextState = engine.processHypothesis(hyp("만날 수 있게", 8000));
    expect(nextState.currentIndex).toBe(3);
    expect(nextState.completedIndexes).toEqual([0, 2]);
    expect(nextState.skippedIndexes).toEqual([1]);
  });

  it("operator manualPrevious re-enters skipped cue and clears it from skippedIndexes", () => {
    const engine = setup();
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    engine.processHypothesis(hyp("이래 열어주오", 4000));
    expect(engine.snapshot().currentIndex).toBe(2);
    expect(engine.snapshot().skippedIndexes).toEqual([1]);

    // Operator rewinds to the skipped cue
    const rewindState = engine.manualPrevious(5000);
    expect(rewindState.currentIndex).toBe(1);
    expect(rewindState.displayedSegment?.id).toBe("cue-2");
    expect(rewindState.skippedIndexes).toEqual([]);
    expect(rewindState.completedIndexes).toEqual([0]);

    // Operator advances through rewound cue: cue-2 now completes properly
    const advanceState = engine.manualNext(6000);
    expect(advanceState.currentIndex).toBe(2);
    expect(advanceState.completedIndexes).toEqual([0, 1]);
    expect(advanceState.skippedIndexes).toEqual([]);
  });

  it("operator jumpTo and reset correctly synchronize and clear skippedIndexes", () => {
    const engine = setup();
    engine.processHypothesis(hyp("창가로 스며드는 외로운 저 달빛", 1000));
    engine.processHypothesis(hyp("이래 열어주오", 4000));
    expect(engine.snapshot().skippedIndexes).toEqual([1]);

    // jumpTo(0) rewinds before the skipped cue: skippedIndexes must be cleared
    const jumpState = engine.jumpTo(0, 5000);
    expect(jumpState.currentIndex).toBe(0);
    expect(jumpState.skippedIndexes).toEqual([]);

    // Provide fresh speech onset to clear manual checkpoint and re-test lookahead skip
    engine.speechStart(8000);
    engine.processHypothesis(hyp("이래 열어주오", 9000, "stream-2"));
    expect(engine.snapshot().skippedIndexes).toEqual([1]);

    // reset() clears everything
    const resetState = engine.reset();
    expect(resetState.currentIndex).toBe(-1);
    expect(resetState.skippedIndexes).toEqual([]);
    expect(resetState.completedIndexes).toEqual([]);
  });
});
