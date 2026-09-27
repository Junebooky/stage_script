import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { PrefixFuzzyMatcher, type StreamingHypothesis } from "@stage/alignment";
import type { PerformanceScript, Show } from "@stage/script-schema";
import { ScriptFollowingEngine, ShowRuntime } from "./index";
import { HypothesisCursor } from "./hypothesis-cursor";

const script: PerformanceScript = { title: "Production prefix regression", locale: "ko-KR", segments:
  ["운명이 이끄는 저 먼 세상", "바다가 부르는 새로운 노래", "별빛이 비추는 외로운 골목", "햇살이 따스한 고요한 아침"].map((text, i) =>
    ({ id: `cue-${i}`, order: i + 1, type: "CAPTION", matchText: [text], captions: [{ actor: "A", text }] })) };
const h = (text: string, receivedAt = 100, utteranceId = "one"): StreamingHypothesis => ({ text, receivedAt, utteranceId, confidence: null, isFinal: false, speechActive: true });
const engine = () => { const engine = new ScriptFollowingEngine(script, undefined, { operatingMode: "PERFORMANCE_LOCAL" }); engine.arm(); return engine; };

describe("single production leading-evidence runtime", () => {
  it("triggers inside the first discriminative interim call, with no word.end/final/timer", () => {
    const e = engine();
    expect(e.processHypothesis(h("운", 10)).currentIndex).toBe(-1);
    expect(e.processHypothesis(h("운명", 20))).toMatchObject({ currentIndex: 0, lastTrigger: { triggeredAt: 20, source: "automatic" } });
    expect(e.exportTelemetry().find((event) => event.match?.earlyEvidence)?.match).toMatchObject({ reason: "leading-discriminative-prefix", earlyEvidence: { positionWeight: 1.5 } });
    expect(e.processHypothesis(h("운명이", 30)).currentIndex).toBe(0);
    expect(e.processHypothesis(h("운명이 이끄는 저 먼 세상 바다", 40)).currentIndex).toBe(1);
  });
  it("fences cancelled leading evidence and never turns a revision into the next cue", () => {
    const e = engine(); e.processHypothesis(h("운명"));
    expect(e.processHypothesis(h("바다", 110)).currentIndex).toBe(0);
    expect(e.processHypothesis({ ...h("바다가", 120), isFinal: true }).currentIndex).toBe(0);
    expect(e.processHypothesis(h("바다", 130, "fresh")).currentIndex).toBe(1);
    expect(e.processHypothesis(h("운명", 140, "old-repeat")).currentIndex).toBe(1);
  });
  it("cannot skip one or two pending cues using short prefix evidence, even after long elapsed time", () => {
    const e = engine(); e.processHypothesis(h("운명"));
    expect(e.processHypothesis(h("별빛", 10000, "future-1")).currentIndex).toBe(0);
    expect(e.processHypothesis(h("햇살", 20000, "future-2")).currentIndex).toBe(0);
    expect(e.snapshot().skippedIndexes).toEqual([]);
    expect(e.processHypothesis(h("바다", 21000, "next")).currentIndex).toBe(1);
  });
  it("retains HOLD/manual/reset fences for early evidence", () => {
    const e = engine(); e.setHold(true);
    e.processHypothesis(h("운명")); e.setHold(false);
    expect(e.processHypothesis(h("운명이", 110)).currentIndex).toBe(-1);
    expect(e.processHypothesis(h("운명", 120, "fresh")).currentIndex).toBe(0);
    e.manualNext(130);
    expect(e.processHypothesis(h("별빛", 129, "late")).currentIndex).toBe(1);
    e.reset();
    expect(e.processHypothesis(h("운명", 140, "fresh")).currentIndex).toBe(-1);
  });
  it("ShowRuntime defaults to the same production matcher and still requires readiness/GO", () => {
    const show: Show = { id: "show", title: script.title, locale: script.locale, acts: [{ id: "act", title: "Act", numbers: [{ id: "number", title: "Number", cues: script.segments }] }] };
    const runtime = new ShowRuntime(show);
    runtime.armAct(0, 0);
    expect(runtime.processHypothesis(h("운명", 1)).engine.currentIndex).toBe(-1);
    expect(runtime.go(2).phase).toBe("ACT_ARMED");
    runtime.setReadiness({ microphone: true, asr: true, assets: true, output: true }); runtime.go(3);
    expect(runtime.processHypothesis(h("운명", 4, "post-go")).engine.currentIndex).toBe(0);
  });
  it("append-only cursor preserves consumed floors while deletion fences an early trigger", () => {
    const cursor = new HypothesisCursor(); cursor.update("u", "운명"); cursor.consume(0, 2, "운명이이끄는세상", true);
    cursor.update("u", "운명이이끄는세상"); expect(cursor.floor).toBe(2);
    expect(cursor.isCurrentLine(2, 4)).toBe(true);
    cursor.update("u", "운"); expect(cursor.floor).toBe(1);
    cursor.update("u", "운명"); expect(cursor.floor).toBe(1);
    cursor.update("new", "바다"); expect(cursor.floor).toBe(0);
  });
  it("reports synthetic receipt-to-decision timing separately from acoustic latency", () => {
    const improvedTimes: number[] = [], baselineTimes: number[] = [];
    const arrivals = [h("운", 100), h("운명", 160), h("운명이", 250), h("운명이 이끄는", 700)];
    const baseline = new ScriptFollowingEngine(script, new PrefixFuzzyMatcher(), { operatingMode: "PERFORMANCE_LOCAL" }); baseline.arm();
    const improved = engine();
    let improvedAt: number | null = null, baselineAt: number | null = null;
    for (const input of arrivals) {
      let start = performance.now(); const next = improved.processHypothesis(input); improvedTimes.push(performance.now() - start);
      if (improvedAt === null && next.lastTrigger) improvedAt = next.lastTrigger.triggeredAt;
      start = performance.now(); const old = baseline.processHypothesis(input); baselineTimes.push(performance.now() - start);
      if (baselineAt === null && old.lastTrigger) baselineAt = old.lastTrigger.triggeredAt;
    }
    expect(improvedAt).toBe(160); expect(baselineAt).toBe(700);
    console.log(JSON.stringify({ syntheticEvidenceLeadMs: baselineAt! - improvedAt!, improvedDecisionMs: improvedTimes, baselineDecisionMs: baselineTimes, liveLatencyMeasured: false }));
  });
});
