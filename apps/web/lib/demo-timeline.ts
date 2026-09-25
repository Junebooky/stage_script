import type { PerformanceScript } from "@stage/script-schema";

/** Presentation choreography only. Never input to an ASR matcher or benchmark. */
export interface DemoTimeline {
  recordingId: string;
  script: PerformanceScript;
  cues: { cueId: string; referenceStartMs: number }[];
}

export function validateDemoTimeline(timeline: DemoTimeline): DemoTimeline {
  if (!timeline.cues.length || timeline.cues.length !== timeline.script.segments.length ||
    timeline.cues.some((cue, i) => cue.cueId !== timeline.script.segments[i]?.id ||
      !Number.isFinite(cue.referenceStartMs) || cue.referenceStartMs < 0 ||
      (i > 0 && cue.referenceStartMs <= timeline.cues[i - 1]!.referenceStartMs))) {
    throw new Error("음원 시연 타임라인과 확정 대본이 일치하지 않습니다.");
  }
  return timeline;
}

export function timelineIndex(timeline: DemoTimeline, timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) return -1;
  let index = -1;
  for (let i = 0; i < timeline.cues.length && timeline.cues[i]!.referenceStartMs <= timeMs; i++) index = i;
  return index;
}

export function timelineQueue(timeline: DemoTimeline, index: number, ended = false) {
  const currentIndex = Math.max(-1, Math.min(timeline.script.segments.length - 1, index));
  return {
    currentIndex,
    completedIndexes: Array.from({ length: Math.max(0, currentIndex + (ended ? 1 : 0)) }, (_, i) => i),
    skippedIndexes: [],
    nextSegment: timeline.script.segments[currentIndex + 1] ?? null,
    finished: ended,
  };
}

export function demoClock(seconds: number) {
  const centiseconds = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100);
  return `${String(Math.floor(centiseconds / 6000)).padStart(2, "0")}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}
