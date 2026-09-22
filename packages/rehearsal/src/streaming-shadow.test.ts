import { describe, expect, it } from "vitest";
import type { PerformanceScript } from "@stage/script-schema";
import { evaluateStreamingShadows, revisionDiff, type LiveObservation } from "./streaming-shadow";

const script: PerformanceScript = { title: "Synthetic shadow", locale: "ko-KR", segments: [
  { id: "one", order: 1, type: "CAPTION", matchText: ["창가로 스며드는 달빛"], captions: [{ actor: "A", text: "창가로 스며드는 달빛" }] },
  { id: "two", order: 2, type: "CAPTION", matchText: ["이별은 없는 것"], captions: [{ actor: "B", text: "이별은 없는 것" }] },
] };
const event = (text: string, at: number, sequence: number, utterance_id = "a", is_final = false): LiveObservation => ({
  sequence, receivedAtMs: at, sentAudioThroughMs: at, message: { type: "hypothesis", text, confidence: .9, is_final, utterance_id },
});

describe("actual partial shadow measurement", () => {
  it("keeps baseline performance policy: saved-word fast prefixes never activate", () => {
    const report = evaluateStreamingShadows(script, [event("창가로", 1000, 0)]);
    expect(report.immediate.emittedCount).toBe(0);
    expect(report.stable.emittedCount).toBe(0);
  });
  it("compares immediate vs retained evidence without a final result", () => {
    const report = evaluateStreamingShadows(script, [event("창가로 스며드는", 1000, 0), event("창가로 스며드는 달빛", 1200, 1)]);
    expect(report.immediate.triggers[0]?.atMs).toBe(1000);
    expect(report.stable.triggers[0]?.atMs).toBe(1200);
    expect(report.finals).toBe(0);
    expect(report.stable.byCue[0]).toMatchObject({ t0: null, t1: null, t2: 1000, t3: 1200, t4: null, t5: 1200 });
  });
  it("does not treat duplicate packets or elapsed time alone as stability", () => {
    const report = evaluateStreamingShadows(script, [event("창가로 스며드는", 1000, 0), event("창가로 스며드는", 2000, 1)]);
    expect(report.stable.emittedCount).toBe(0);
  });
  it("resets stability on revision and labels removal as a risk proxy, not proven error", () => {
    const report = evaluateStreamingShadows(script, [event("창가로 스며드는", 1000, 0), event("전혀 다른 소리", 1200, 1)]);
    expect(report.immediate.anchorRemovalRate).toBe(1);
    expect(report.immediate.triggers[0]?.evidenceHeldMs).toBe(200);
    expect(report.immediate.unsafeEarlyTriggerRate).toBeNull();
    expect(report.stable.emittedCount).toBe(0);
    expect(report.revisionRate).toBe(1);
  });
  it("does not manufacture onset latency from ASR word timings", () => {
    const observation = event("창가로 스며드는", 1000, 0);
    observation.message.start_ms = 10;
    observation.message.end_ms = 900;
    const report = evaluateStreamingShadows(script, [observation]);
    expect(report.immediate.byCue[0]?.latency).toEqual({ t1: null, t2: null, t3: null, t5: null });
    expect(report.immediate.byCue[0]?.t0).toBeNull();
  });
  it("never widens a blocked pointer for future cues", () => {
    const report = evaluateStreamingShadows(script, [event("이별은 없는 것", 1000, 0), event("이별은 없는 것 끝", 2000, 1)]);
    expect(report.immediate.emittedCount).toBe(0);
    expect(report.stable.emittedCount).toBe(0);
  });
  it("records addition, deletion, replacement, and held duration separately", () => {
    expect(revisionDiff("가", "가 나").kind).toBe("addition");
    expect(revisionDiff("가 나", "가").kind).toBe("deletion");
    expect(revisionDiff("가 나", "가 다")).toMatchObject({ kind: "replacement", removed: "나", added: "다" });
    const report = evaluateStreamingShadows(script, [event("가", 0, 0), event("가 나", 200, 1), event("가 다", 500, 2), event("가 다", 900, 3, "a", true)]);
    expect(report.revisionRate).toBe(.5);
    expect(report.revisions[2]?.previousHeldMs).toBe(300);
    expect(report.finals).toBe(1);
  });
  it("rejects non-monotonic clocks and embedded fallback profiles", () => {
    expect(() => evaluateStreamingShadows(script, [event("가", 1000, 0), event("나", 500, 1)])).toThrow(/clock/);
    const calibrated = structuredClone(script);
    calibrated.segments[0]!.profile = { fallback: { enabled: true } } as never;
    expect(() => evaluateStreamingShadows(calibrated, [])).toThrow(/fallback/);
  });
});
