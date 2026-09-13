import { describe, expect, it } from "vitest";
import { demoShow, type CueProfile, type PerformanceScript, type Show } from "@stage/script-schema";
import { ScriptFollowingEngine, ShowRuntime } from "./index";

const script: PerformanceScript = { title: "Canonical", locale: "ko-KR", segments: [
  { id: "one", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "가장 어려운 곳에 주님의 사랑이" }], matchText: ["가장 어려운 곳에 주님의 사랑이"] },
  { id: "two", order: 2, type: "CAPTION", captions: [{ actor: "B", text: "우리의 노래가 세상을 밝히리" }], matchText: ["우리의 노래가 세상을 밝히리"] },
  { id: "three", order: 3, type: "CHORUS", captions: [{ actor: "ALL", text: "영원히 기억해 소중한 마음을" }], matchText: ["영원히 기억해 소중한 마음을"] }
] };
const profile: CueProfile = { cueId: "two", anchors: [{ text: "노래가세상을", reliability: 0.95 }], timing: { medianAfterPreviousMs: 1000, earlyToleranceMs: 200, lateToleranceMs: 200, varianceMs2: 100 }, thresholds: { text: 0.82, fallback: 0.86 }, fallback: { enabled: true }, sampleCount: 5, confidence: 0.95 };
const hypothesis = (text: string, receivedAt: number, streamId = "live") => ({ text, receivedAt, streamId, confidence: 0.95, speechActive: true, isFinal: false });

describe("performance runtime safety", () => {
  const setup = (profiles: CueProfile[] = []) => { const engine = new ScriptFollowingEngine(script, undefined, { operatingMode: "PERFORMANCE_LOCAL", profiles }); engine.arm(); return engine; };

  it("labels unmatched speech without assuming ad-lib or widening live search automatically", () => {
    const engine = setup();
    for (let index = 0; index < 15; index++) engine.processHypothesis(hypothesis(`관객분들은 휴대폰을 꺼주십시오 ${index}`, index * 100));
    expect(engine.snapshot().phase).toBe("UNMATCHED_SPEECH");
    expect(engine.snapshot().currentIndex).toBe(-1);
    expect(engine.snapshot().searchMode).toBe("NORMAL");
  });

  it("uses internal evidence but retains the unchanged canonical caption", () => {
    const engine = setup();
    const result = engine.processHypothesis(hypothesis("어려운 곳에 주님의 사랑이", 100));
    expect(result.currentIndex).toBe(0);
    expect(result.displayedSegment?.captions[0]!.text).toBe("가장 어려운 곳에 주님의 사랑이");
    expect(engine.exportTelemetry().some((event) => event.selectedAnchor && event.scores)).toBe(true);
  });

  it("triggers a canonical fallback only for calibrated synchronized fresh speech in its relative window", () => {
    const engine = setup([profile]);
    engine.manualNext(100);
    engine.speechStart(1090);
    const state = engine.processHypothesis(hypothesis("전혀 다른 가사를 불렀어요", 1100));
    expect(state.currentIndex).toBe(1);
    expect(state.lastTrigger?.source).toBe("fallback");
    expect(state.displayedSegment?.captions).toEqual(script.segments[1]!.captions);
  });

  it("shows FALLBACK_READY on a qualified fresh onset without timer-only dispatch", () => {
    const engine = setup([profile]);
    engine.manualNext(100);
    expect(engine.speechStart(1090).phase).toBe("FALLBACK_READY");
    expect(engine.snapshot().currentIndex).toBe(0);
    expect(engine.speechEnd().phase).toBe("DISPLAYING");
    expect(engine.speechStart(1600).phase).toBe("LISTENING");
    expect(engine.snapshot().currentIndex).toBe(0);
  });

  it("accepts a verified adapter generation after manual navigation during continuous speech", () => {
    const engine = setup();
    engine.manualNext(100);
    expect(engine.processHypothesis({ ...hypothesis(script.segments[1]!.matchText[0]!, 200, "post-reset"), boundaryVerified: true }).currentIndex).toBe(1);
  });

  it.each([
    ["disabled", { ...profile, fallback: { enabled: false } }, 1100, 1090],
    ["too few rehearsals", { ...profile, sampleCount: 1 }, 1100, 1090],
    ["low profile confidence", { ...profile, confidence: 0.5 }, 1100, 1090],
    ["early window", profile, 500, 490],
    ["late window", profile, 1600, 1590],
    ["old speech within a later result", profile, 1100, 200]
  ])("does not fallback with %s", (_label, value, at, onset) => {
    const engine = setup([value as CueProfile]);
    engine.manualNext(100); engine.speechStart(onset as number);
    expect(engine.processHypothesis(hypothesis("완전히 다른 말을 합니다", at as number)).currentIndex).toBe(0);
  });

  it("does not fallback from silence, continuous old speech, an unknown pointer, or a fallback chain", () => {
    const engine = setup([profile, { ...profile, cueId: "three" }]);
    engine.speechStart(1);
    engine.processHypothesis(hypothesis(script.segments[0]!.matchText[0]!, 100));
    expect(engine.processHypothesis(hypothesis("완전히 다른 말을 합니다", 1100, "other")).currentIndex).toBe(0);
    engine.speechStart(1100);
    engine.processHypothesis(hypothesis("완전히 다른 가사를 합니다", 1150, "third"));
    expect(engine.snapshot().lastTrigger?.source).toBe("fallback");
    engine.speechStart(2140);
    expect(engine.processHypothesis(hypothesis("또 다른 가사를 합니다", 2150, "fourth")).currentIndex).toBe(1);
    expect(setup([profile]).processHypothesis(hypothesis("완전히 다른 말을 합니다", 1100)).currentIndex).toBe(-1);
  });

  it("manual next, previous, and jump checkpoint stale cumulative recognition including late rewrites", () => {
    for (const move of ["next", "previous", "jump"] as const) {
      const engine = setup();
      engine.processHypothesis(hypothesis(script.segments[0]!.matchText[0]!, 100));
      const old = script.segments[0]!.matchText[0]! + " " + script.segments[1]!.matchText[0]!;
      engine.processHypothesis(hypothesis(old, 200));
      if (move === "next") engine.manualNext(250);
      else if (move === "previous") engine.manualPrevious(250);
      else engine.jumpTo(0, 250);
      const before = engine.snapshot().currentIndex;
      expect(engine.processHypothesis({ ...hypothesis(old, 260), isFinal: true }).currentIndex).toBe(before);
      expect(engine.processHypothesis({ ...hypothesis("가아아장 " + old, 270), isFinal: true }).currentIndex).toBe(before);
    }
  });

  it("does not fuzzy-advance when a previous near-identical lyric is repeated in a fresh utterance", () => {
    const lyrics = ["우리는 함께 걸어와", "우리는 함께 걸어가"];
    const collisionScript = { ...script, segments: lyrics.map((text, index) => ({ ...script.segments[index]!, matchText: [text], captions: [{ actor: "A", text }] })) };
    const engine = new ScriptFollowingEngine(collisionScript, undefined, { operatingMode: "PERFORMANCE_LOCAL" });
    expect(engine.processHypothesis(hypothesis(lyrics[0]!, 100, "first")).currentIndex).toBe(0);
    expect(engine.processHypothesis(hypothesis(lyrics[0]!, 200, "repeated")).currentIndex).toBe(0);
    expect(engine.processHypothesis(hypothesis(lyrics[1]!, 300, "correct")).currentIndex).toBe(1);
  });

  it("an empty manual checkpoint requires fresh VAD and never reuses the delayed retired utterance", () => {
    const engine = setup();
    engine.manualNext(100);
    const old = script.segments[0]!.matchText[0]! + " " + script.segments[1]!.matchText[0]!;
    expect(engine.processHypothesis(hypothesis(old, 200, "pending-before-manual")).currentIndex).toBe(0);
    engine.speechStart(250);
    expect(engine.processHypothesis({ ...hypothesis(old + "!", 260, "pending-before-manual"), isFinal: true }).currentIndex).toBe(0);
    expect(engine.processHypothesis(hypothesis(script.segments[1]!.matchText[0]!, 300, "new-utterance")).currentIndex).toBe(1);
    expect(engine.exportTelemetry().some((event) => event.decision === "manual-awaiting-fresh-speech")).toBe(true);
  });

  it("manual navigation remains available while automatic re-arming waits for a fresh speech onset", () => {
    const engine = setup();
    engine.manualNext(100);
    expect(engine.manualNext(200).currentIndex).toBe(1);
    expect(engine.manualPrevious(300).currentIndex).toBe(0);
    expect(engine.processHypothesis(hypothesis(script.segments[1]!.matchText[0]!, 400, "pending")).currentIndex).toBe(0);
    expect(engine.manualNext(500).currentIndex).toBe(1);
  });

  it("HOLD checkpoints incoming evidence and explicit RESYNC recovers a local skipped cue", () => {
    const engine = setup(); engine.setHold(true);
    engine.processHypothesis(hypothesis(script.segments[0]!.matchText[0]!, 100));
    engine.setHold(false);
    expect(engine.processHypothesis(hypothesis(script.segments[0]!.matchText[0]!, 110)).currentIndex).toBe(-1);
    engine.forceResync(120);
    expect(engine.processHypothesis(hypothesis(script.segments[1]!.matchText[0]!, 150, "fresh")).currentIndex).toBe(1);
  });

  it("enters IMAGE only explicitly and advances from it on fresh next-caption speech", () => {
    const imageScript = { ...script, segments: [script.segments[0]!, { id: "image", order: 2, type: "IMAGE" as const, captions: [], matchText: [], image: { src: "/scene.png", alt: "scene" } }, { ...script.segments[1]!, order: 3 }] };
    const engine = new ScriptFollowingEngine(imageScript, undefined, { operatingMode: "PERFORMANCE_LOCAL" });
    engine.manualNext(100); engine.speechEnd();
    expect(engine.processHypothesis(hypothesis(script.segments[1]!.matchText[0]!, 200)).currentIndex).toBe(0);
    expect(engine.manualNext(250).displayedSegment?.type).toBe("IMAGE");
    engine.speechStart(290);
    expect(engine.processHypothesis(hypothesis(script.segments[1]!.matchText[0]!, 300, "fresh")).currentIndex).toBe(2);
  });
});

describe("act lifecycle", () => {
  const show: Show = { id: "two-acts", title: "Show", locale: "ko-KR", acts: [
    { id: "act-1", title: "Act 1", numbers: [{ id: "m01", title: "First", cues: [script.segments[0]!] }] },
    { id: "act-2", title: "Act 2", numbers: [{ id: "m02", title: "Second", cues: [script.segments[1]!] }] }
  ] };
  const ready = { microphone: true, asr: true, assets: true, output: true };

  it("requires readiness and explicit ARM / GO, locks NEXT in intermission, and resets act timing", () => {
    const runtime = new ShowRuntime(show);
    expect(runtime.manualNext(0).engine.currentIndex).toBe(-1);
    expect(runtime.armAct(0, 10).phase).toBe("ACT_ARMED");
    expect(runtime.go(20).phase).toBe("ACT_ARMED");
    expect(runtime.manualNext(25).engine.currentIndex).toBe(-1);
    runtime.setReadiness(ready);
    expect(runtime.go(30).relativeClockStartedAt).toBe(30);
    expect(runtime.manualNext(40).engine.currentIndex).toBe(0);
    expect(runtime.manualNext(50).phase).toBe("ACT_COMPLETE");
    expect(runtime.armAct(1, 55).phase).toBe("ACT_COMPLETE");
    expect(runtime.enterIntermission(60).phase).toBe("INTERMISSION");
    expect(runtime.manualNext(1000).engine.currentSegment?.id).toBe("one");
    expect(runtime.processHypothesis(hypothesis(script.segments[1]!.matchText[0]!, 2000)).engine.currentSegment?.id).toBe("one");
    expect(runtime.armAct(1, 10_000).engine.displayedSegment).toBeNull();
    expect(runtime.go(10_010).phase).toBe("ACT_ARMED");
    runtime.setReadiness(ready);
    expect(runtime.go(10_020).relativeClockStartedAt).toBe(10_020);
    expect(runtime.snapshot().engine.lastTrigger).toBeNull();
    expect(runtime.manualNext(10_030).engine.currentSegment?.id).toBe("two");
    expect(runtime.manualNext(10_040).phase).toBe("SHOW_COMPLETE");
    expect(runtime.exportTelemetry().some((event) => event.transition === "ACT_COMPLETE→INTERMISSION")).toBe(true);
  });

  it("checkpoints recognition heard during ARM and reset rather than replaying it at GO", () => {
    const runtime = new ShowRuntime(show);
    runtime.armAct(0, 10); runtime.setReadiness(ready);
    const old = hypothesis(script.segments[0]!.matchText[0]!, 20);
    runtime.processHypothesis(old);
    runtime.go(30);
    expect(runtime.processHypothesis({ ...old, receivedAt: 40, isFinal: true }).engine.currentIndex).toBe(-1);
    expect(runtime.processHypothesis({ ...old, text: old.text + " " + old.text, receivedAt: 50 }).engine.currentIndex).toBe(0);
    runtime.reset(60); runtime.armAct(0, 70); runtime.setReadiness(ready); runtime.go(80);
    expect(runtime.processHypothesis({ ...old, text: old.text + " " + old.text, receivedAt: 90 }).engine.currentIndex).toBe(-1);
  });

  it("supports explicitly selected offline manual-only operation without pretending ASR is ready", () => {
    const runtime = new ShowRuntime(show);
    runtime.setManualOnly(true); runtime.armAct(0, 10);
    runtime.setReadiness({ assets: true, output: true });
    expect(runtime.go(20).phase).toBe("ACT_LIVE");
    expect(runtime.snapshot().readiness.asr).toBe(false);
    expect(runtime.processHypothesis(hypothesis(script.segments[0]!.matchText[0]!, 30)).engine.currentIndex).toBe(-1);
    expect(runtime.setManualOnly(false).manualOnly).toBe(true);
    expect(runtime.manualNext(40).engine.currentIndex).toBe(0);
  });

  it("blocks profile changes in LIVE and accepts them only outside the active act", () => {
    const runtime = new ShowRuntime(demoShow);
    expect(runtime.setProfiles([profile])).toBe(true);
    runtime.armAct(0); runtime.setReadiness(ready); runtime.go(1);
    expect(runtime.setProfiles([])).toBe(false);
  });
});
