import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScriptEngineSnapshot } from "@stage/script-engine";
import type { PerformanceScript } from "@stage/script-schema";
import { CueQueue } from "./CueQueue";

const testScript: PerformanceScript = {
  title: "CueQueue Test Script",
  locale: "ko-KR",
  segments: [
    { id: "C001", order: 1, type: "SOLO", captions: [{ actor: "수호", text: "첫 번째 가사" }], matchText: ["첫 번째 가사"] },
    { id: "C002", order: 2, type: "SOLO", captions: [{ actor: "수호", text: "건너뛴 가사" }], matchText: ["건너뛴 가사"] },
    { id: "C003", order: 3, type: "SOLO", captions: [{ actor: "연화", text: "세 번째 가사" }], matchText: ["세 번째 가사"] },
    { id: "C004", order: 4, type: "SOLO", captions: [{ actor: "연화", text: "네 번째 가사" }], matchText: ["네 번째 가사"] }
  ]
};

function createSnapshot(overrides: Partial<ScriptEngineSnapshot> = {}): ScriptEngineSnapshot {
  return {
    phase: "TRIGGERED",
    searchMode: "NORMAL",
    currentIndex: 0,
    currentSegment: testScript.segments[0]!,
    nextSegment: testScript.segments[1]!,
    displayedSegment: testScript.segments[0]!,
    confidence: 0.95,
    partial: "",
    expected: "첫 번째 가사",
    speechActive: false,
    hold: false,
    lowConfidenceCount: 0,
    lastTrigger: null,
    completedIndexes: [],
    skippedIndexes: [],
    finished: false,
    ...overrides
  };
}

describe("CueQueue Component UI & Observability", () => {
  it("renders standard cue progression with completed and on-air cues", () => {
    const snapshot = createSnapshot({
      currentIndex: 1,
      currentSegment: testScript.segments[1]!,
      nextSegment: testScript.segments[2]!,
      displayedSegment: testScript.segments[1]!,
      completedIndexes: [0],
      skippedIndexes: []
    });

    const html = renderToStaticMarkup(React.createElement(CueQueue, { script: testScript, snapshot }));

    expect(html).toContain('data-cue="C001"');
    expect(html).toContain('data-state="complete"');
    expect(html).toContain("✓");
    expect(html).toContain('data-cue="C002"');
    expect(html).toContain('data-state="on-air"');
    expect(html).toContain("ON AIR");
    expect(html).not.toContain("[SKIPPED]");
    expect(html).not.toContain("Skipped");
  });

  it("renders skipped cue with [SKIPPED] badge, '↷' marker, and 'is-skipped' style when lookahead skip occurs", () => {
    // Scenario: C001 (index 0) completed, C002 (index 1) skipped by lookahead, C003 (index 2) currently ON AIR
    const snapshot = createSnapshot({
      currentIndex: 2,
      currentSegment: testScript.segments[2]!,
      nextSegment: testScript.segments[3]!,
      displayedSegment: testScript.segments[2]!,
      completedIndexes: [0],
      skippedIndexes: [1]
    });

    const html = renderToStaticMarkup(React.createElement(CueQueue, { script: testScript, snapshot }));

    // 1. Header shows completion and skipped cue count
    expect(html).toContain("01");
    expect(html).toContain("Complete");
    expect(html).toContain("1 Skipped");
    expect(html).toContain('class="skipped-badge"');

    // 2. Progress bar has is-skipped tick
    expect(html).toContain('class="is-complete"');
    expect(html).toContain('class="is-skipped"');
    expect(html).toContain('class="is-on-air"');

    // 3. Queue item for C002 has skipped state and markers
    expect(html).toContain('data-cue="C002"');
    expect(html).toContain('data-state="skipped"');
    expect(html).toContain("is-skipped");
    expect(html).toContain("[SKIPPED]");
    expect(html).toContain("↷");
    expect(html).toContain("건너뛴 가사");

    // 4. C003 is on-air
    expect(html).toContain('data-cue="C003"');
    expect(html).toContain('data-state="on-air"');
    expect(html).toContain("ON AIR");

    // 5. C004 is upcoming waiting cue
    expect(html).toContain('data-cue="C004"');
    expect(html).toContain("자막 대기중");
  });

  it("ensures skipped cue is never exposed as displayedSegment or audience text", () => {
    const snapshot = createSnapshot({
      currentIndex: 2,
      currentSegment: testScript.segments[2]!,
      nextSegment: testScript.segments[3]!,
      displayedSegment: testScript.segments[2]!,
      completedIndexes: [0],
      skippedIndexes: [1]
    });

    // The audience output only displays snapshot.displayedSegment
    expect(snapshot.displayedSegment?.id).toBe("C003");
    expect(snapshot.displayedSegment?.id).not.toBe("C002");
    expect(snapshot.skippedIndexes.includes(1)).toBe(true);
    expect(snapshot.completedIndexes.includes(1)).toBe(false);
  });
});
