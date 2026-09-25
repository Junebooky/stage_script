import { describe, expect, it } from "vitest";
import type { PerformanceScript } from "@stage/script-schema";
import { buildWordDemoCues } from "./demo-word-timeline";

const script: PerformanceScript = { title: "Synthetic", locale: "ko-KR", segments: [
  { id: "a", order: 1, type: "CAPTION", matchText: ["그 위에서 만난"], captions: [{ actor: "A", text: "그 위에서 만난" }] },
  { id: "b", order: 2, type: "CAPTION", matchText: ["내 음악이 흐른다"], captions: [{ actor: "A", text: "내 음악이 흐른다" }] },
] };
const words = [{ word: "그", start: 1, end: 2 }, { word: "위에서", start: 2, end: 3 }, { word: "만난", start: 3, end: 4 },
  { word: "내", start: 10, end: 11 }, { word: "음악이", start: 10.8, end: 12 }, { word: "흐른다", start: 12, end: 13 }];
describe("offline word-derived demo cue timing", () => {
  it("preserves sung filler words and real instrumental gaps without interpolation", () => {
    const cues = buildWordDemoCues(script, words, 14000);
    expect(cues.map((cue) => cue.referenceStartMs)).toEqual([1000, 10000]);
    expect(cues[0]?.firstWordIndex).toBe(0);
    expect(cues.every((cue) => !cue.humanConfirmed)).toBe(true);
    expect(words[4]?.start).toBe(10.8); // no correction of raw overlapping timestamps
  });
  it("does not fabricate a time for missing words or out-of-range audio", () => {
    expect(() => buildWordDemoCues(script, words.slice(0, 3), 14000)).toThrow();
    expect(() => buildWordDemoCues(script, words, 1000)).toThrow();
    expect(() => buildWordDemoCues(script, [], 14000)).toThrow();
  });
});
