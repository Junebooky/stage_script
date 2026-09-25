import { describe, expect, it } from "vitest";
import { demoClock, timelineIndex, timelineQueue, validateDemoTimeline, type DemoTimeline } from "./demo-timeline";

const timeline: DemoTimeline = { recordingId: "fixture", script: { title: "Demo", locale: "ko-KR", segments: [
  { id: "one", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "같은 가사" }], matchText: ["같은 가사"] },
  { id: "repeat", order: 2, type: "CAPTION", captions: [{ actor: "A", text: "같은 가사" }], matchText: ["같은 가사"] },
] }, cues: [{ cueId: "one", referenceStartMs: 1000 }, { cueId: "repeat", referenceStartMs: 5000 }] };

describe("reference choreography (not ASR replay)", () => {
  it("uses exact boundaries and media time, including backward seeks and intro", () => {
    expect(timelineIndex(timeline, 999)).toBe(-1);
    expect(timelineIndex(timeline, 1000)).toBe(0);
    expect(timelineIndex(timeline, 6000)).toBe(1);
    expect(timelineIndex(timeline, 1100)).toBe(0);
    expect(timelineIndex(timeline, 0)).toBe(-1);
    expect(timelineIndex(timeline, NaN)).toBe(-1);
  });
  it("keeps repeated text as distinct canonical cue IDs without a matcher", () => {
    expect(timeline.script.segments[timelineIndex(timeline, 5500)]?.id).toBe("repeat");
  });
  it("resets completion on backward seek and marks completion at end", () => {
    expect(timelineQueue(timeline, 1).completedIndexes).toEqual([0]);
    expect(timelineQueue(timeline, 0).completedIndexes).toEqual([]);
    expect(timelineQueue(timeline, 1, true)).toMatchObject({ finished: true, completedIndexes: [0, 1] });
  });
  it("rejects reordered, missing, or nonmonotonic schedules", () => {
    expect(validateDemoTimeline(timeline)).toBe(timeline);
    expect(() => validateDemoTimeline({ ...timeline, cues: [...timeline.cues].reverse() })).toThrow();
    expect(() => validateDemoTimeline({ ...timeline, cues: timeline.cues.slice(1) })).toThrow();
    expect(() => validateDemoTimeline({ ...timeline, cues: [{ ...timeline.cues[0]!, referenceStartMs: -1 }, timeline.cues[1]!] })).toThrow();
  });
  it("formats media time without rounding 59.999 seconds into 00:60", () => {
    expect(demoClock(59.999)).toBe("00:59.99");
    expect(demoClock(226.138)).toBe("03:46.13");
    expect(demoClock(NaN)).toBe("00:00.00");
  });
});
