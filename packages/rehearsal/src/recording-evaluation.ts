import { percentile } from "./calibration";
import { validateRecordingReference, type RecordingReference, type RecordingReplayProfile } from "./recording-profile";
import type { RecordingRuntimeTrigger, ReplayDelivery } from "./realtime-replay";

// Same initial tolerances as existing evaluateTriggers. Not tuned to R001.
export const REPLAY_EARLY_TOLERANCE_MS = 250;
export const REPLAY_LATE_TOLERANCE_MS = 1500;
export interface RecordingCueEvaluation {
  cueId: string; referenceStartMs: number; actualTriggerMs: number | null; timingErrorMs: number | null;
  triggerSource: RecordingRuntimeTrigger["source"] | null; correctCue: boolean;
  early: boolean; late: boolean; missed: boolean; wrongCue: boolean;
  category: "PENDING" | "ON_TIME" | "EARLY" | "LATE" | "MISSED" | "WRONG";
  failure: "PRIMARY_BLOCKING_FAILURE" | "CASCADE_BLOCKED" | null;
  blockedByCueId: string | null;
  evidenceAttemptCount: number;
  warnings: string[];
}

/** Downstream observer only: this function cannot call or change the engine. */
export function evaluateRecordingReplay(profile: RecordingReplayProfile, value: RecordingReference,
  triggers: readonly RecordingRuntimeTrigger[], options: { complete?: boolean; throughMs?: number; deliveries?: readonly ReplayDelivery[] } = {}) {
  const reference = validateRecordingReference(profile, value);
  const complete = options.complete ?? true;
  const throughMs = options.throughMs ?? Infinity;
  const ordered = reference.cues;
  const indexOf = (id: string) => ordered.findIndex((cue) => cue.cueId === id);
  let repeatedLyricConfusionCount = 0, unexpectedReplaySkipCount = 0, postTakeFalseTriggerCount = 0;
  let previousIndex = -1;
  const accepted = new Map<string, RecordingRuntimeTrigger>();
  const wrong = new Set<RecordingRuntimeTrigger>();
  for (const trigger of triggers) {
    const index = indexOf(trigger.cueId);
    const cue = ordered[index];
    const postTake = profile.nonCanonicalEvents.some((event) => {
      const time = trigger.evidenceDueAtMs ?? trigger.atMs;
      return time >= event.startMs - 1 && time <= event.endMs + 1;
    });
    if (postTake) postTakeFalseTriggerCount += 1;
    const repeated = cue?.repeatGroup ? ordered.filter((other) => other.repeatGroup === cue.repeatGroup) : [];
    const nearestOccurrence = [...repeated].sort((a, b) => Math.abs(a.referenceStartMs - trigger.atMs) - Math.abs(b.referenceStartMs - trigger.atMs))[0];
    const confused = !!nearestOccurrence && nearestOccurrence.cueId !== cue?.cueId;
    if (confused) repeatedLyricConfusionCount += 1;
    if (trigger.source !== "manual" && (index < 0 || index > previousIndex + 1)) unexpectedReplaySkipCount += index < 0 ? 1 : index - previousIndex - 1;
    if (!cue || accepted.has(trigger.cueId) || confused || postTake || (trigger.source !== "manual" && index <= previousIndex)) wrong.add(trigger);
    else accepted.set(trigger.cueId, trigger);
    if (index >= 0) previousIndex = index;
  }

  const cues: RecordingCueEvaluation[] = ordered.map((cue, index) => {
    const trigger = accepted.get(cue.cueId);
    const wrongCue = [...wrong].some((item) => item.cueId === cue.cueId);
    const due = complete || throughMs > cue.referenceStartMs + REPLAY_LATE_TOLERANCE_MS;
    const missed = !trigger && due;
    const error = trigger ? trigger.atMs - cue.referenceStartMs : null;
    const early = error !== null && error < -REPLAY_EARLY_TOLERANCE_MS;
    const late = error !== null && error > REPLAY_LATE_TOLERANCE_MS;
    // If an earlier expected cue was still unresolved during this cue's window,
    // downstream absence is a cascade, not an independent recognition failure.
    // Actual deliveries give the best evidence; a trigger-based checkpoint is
    // the conservative fallback for callers without a delivery trace.
    const end = ordered[index + 1]?.referenceStartMs ?? Infinity;
    const attempts = (options.deliveries ?? []).filter((event) => event.atMs >= cue.referenceStartMs && event.atMs < end && !event.discarded);
    const firstExpected = attempts[0]?.expectedCueId;
    const past = triggers.filter((item) => item.atMs <= cue.referenceStartMs + REPLAY_LATE_TOLERANCE_MS && indexOf(item.cueId) >= 0).at(-1);
    const expectedIndex = firstExpected ? indexOf(firstExpected) : past ? indexOf(past.cueId) + 1 : 0;
    const blockedBy = missed && expectedIndex >= 0 && expectedIndex < index ? ordered[expectedIndex]!.cueId : null;
    return { cueId: cue.cueId, referenceStartMs: cue.referenceStartMs, actualTriggerMs: trigger?.atMs ?? null, timingErrorMs: error,
      triggerSource: trigger?.source ?? null, correctCue: !!trigger, early, late, missed, wrongCue,
      category: trigger ? early ? "EARLY" : late ? "LATE" : "ON_TIME" : wrongCue ? "WRONG" : missed ? "MISSED" : "PENDING",
      failure: missed ? blockedBy ? "CASCADE_BLOCKED" : "PRIMARY_BLOCKING_FAILURE" : null,
      blockedByCueId: blockedBy, evidenceAttemptCount: attempts.filter((event) => event.expectedCueId === cue.cueId).length,
      warnings: cue.warnings ?? [] };
  });
  const absoluteErrors = cues.flatMap((cue) => cue.timingErrorMs === null ? [] : [Math.abs(cue.timingErrorMs)]);
  return { version: 1 as const, recordingId: profile.recordingId, referenceQuality: reference.quality,
    deliveryBasis: "saved-word-end-simulation" as const, liveLatencyMeasured: false as const, complete,
    thresholds: { earlyToleranceMs: REPLAY_EARLY_TOLERANCE_MS, lateToleranceMs: REPLAY_LATE_TOLERANCE_MS },
    metrics: {
      performedCueCount: cues.length, correctTriggerCount: accepted.size, missedCueCount: cues.filter((cue) => cue.missed).length,
      wrongTriggerCount: wrong.size, earlyCount: cues.filter((cue) => cue.early).length, lateCount: cues.filter((cue) => cue.late).length,
      medianAbsoluteTimingErrorMs: percentile(absoluteErrors, 0.5), p95AbsoluteTimingErrorMs: percentile(absoluteErrors, 0.95),
      recordingAbsentCueCount: profile.absentCueIds.length, unexpectedReplaySkipCount, repeatedLyricConfusionCount, postTakeFalseTriggerCount,
      primaryBlockingFailureCount: cues.filter((cue) => cue.failure === "PRIMARY_BLOCKING_FAILURE").length,
      cascadeBlockedCount: cues.filter((cue) => cue.failure === "CASCADE_BLOCKED").length,
      manualTriggerCount: triggers.filter((trigger) => trigger.source === "manual").length,
      fallbackTriggerCount: triggers.filter((trigger) => trigger.source === "fallback").length,
      maxEvidenceDispatchLagMs: Math.max(0, ...(options.deliveries ?? []).filter((event) => !event.discarded).map((event) => event.atMs - event.dueAtMs)),
      // Multiple automatic cues processed in one media-clock poll may coalesce
      // into one React/audience paint. Do not call a trigger log proof of rendering.
      coalescedAutomaticTriggerCount: triggers.filter((trigger, index) => index > 0 && trigger.source === "automatic" && triggers[index - 1]!.source === "automatic" && trigger.atMs === triggers[index - 1]!.atMs).length,
    }, cues, wrongTriggers: [...wrong] };
}
