import { ScriptFollowingEngine } from "@stage/script-engine";
import { flattenShow, type CueProfile, type Show } from "@stage/script-schema";
import type { CueObservation, RehearsalAnalysis, ReplayMetrics, ReplayReport, ReplayTrigger } from "./types";
import { percentile } from "./calibration";

export interface MetricOptions {
  earlyToleranceMs?: number;
  lateToleranceMs?: number;
  reviewRequired?: number;
  timestampBasis?: ReplayMetrics["timestampBasis"];
  manualInterventions?: number;
  excludedRegions?: number;
}

export function evaluateTriggers(triggers: readonly ReplayTrigger[], observations: readonly CueObservation[], options: MetricOptions = {}): ReplayMetrics {
  const truth = observations.filter((item) => item.reviewStatus !== "review-required");
  const remaining = new Set(truth.map((_, index) => index));
  const latency: number[] = [], imageEntry: number[] = [], imageExit: number[] = [], recovery: number[] = [];
  let wrongTriggers = 0, earlyTriggers = 0, lateTriggers = 0, failureAt: number | null = null;
  for (let triggerIndex = 0; triggerIndex < triggers.length; triggerIndex += 1) {
    const trigger = triggers[triggerIndex]!;
    const candidates = [...remaining].filter((index) => truth[index]!.cueId === trigger.cueId);
    const index = candidates.sort((a, b) => Math.abs(truth[a]!.startMs - trigger.atMs) - Math.abs(truth[b]!.startMs - trigger.atMs))[0];
    if (index === undefined) {
      wrongTriggers += 1;
      failureAt ??= trigger.atMs;
      continue;
    }
    const expected = truth[index]!;
    remaining.delete(index);
    const delta = trigger.atMs - expected.startMs;
    if (expected.timingReliable !== false) {
      latency.push(delta);
      if (delta < -(options.earlyToleranceMs ?? 250)) earlyTriggers += 1;
      if (delta > (options.lateToleranceMs ?? 1500)) lateTriggers += 1;
    }
    if (failureAt !== null && trigger.atMs >= failureAt) {
      recovery.push(trigger.atMs - failureAt);
      failureAt = null;
    }
    if (trigger.image || expected.imageDurationMs !== undefined) {
      imageEntry.push(Math.abs(delta));
      const exit = triggers[triggerIndex + 1];
      if (exit && expected.imageDurationMs !== undefined) imageExit.push(Math.abs(exit.atMs - (expected.startMs + expected.imageDurationMs)));
    }
  }
  // Miss-to-recovery time is measured to the next observed correct trigger, if any.
  for (const index of remaining) {
    const missed = truth[index]!;
    const recovered = triggers.find((trigger) => trigger.atMs >= missed.startMs && truth.some((item) => item.cueId === trigger.cueId && item.startMs >= missed.startMs));
    if (recovered) recovery.push(recovered.atMs - missed.startMs);
  }
  return {
    cueAccuracy: truth.length ? Math.max(0, (truth.length - remaining.size - earlyTriggers - lateTriggers) / (truth.length + wrongTriggers)) : 0,
    evaluatedCues: truth.length, missedCues: remaining.size, wrongTriggers, earlyTriggers, lateTriggers,
    latencyP50Ms: percentile(latency, 0.5), latencyP95Ms: percentile(latency, 0.95), recoveryTimeMs: percentile(recovery, 0.5),
    manualInterventions: options.manualInterventions ?? triggers.filter((trigger) => trigger.source === "manual").length,
    fallbackTriggers: triggers.filter((trigger) => trigger.source === "fallback").length,
    imageEntryErrorMs: percentile(imageEntry, 0.5), imageExitErrorMs: percentile(imageExit, 0.5),
    reviewRequired: options.reviewRequired ?? observations.filter((item) => item.reviewStatus === "review-required").length,
    humanConfirmedCues: truth.filter((item) => item.groundTruth === "human").length,
    pseudoGroundTruthCues: truth.filter((item) => item.groundTruth === "pseudo").length,
    excludedRegions: options.excludedRegions ?? 0,
    timestampBasis: options.timestampBasis ?? "simulated-asr-delivery",
  };
}

/** Replay uses the SAME conservative live engine; offline alignment never triggers cues. */
export function replayRehearsal(show: Show, analysis: RehearsalAnalysis, profiles: readonly CueProfile[] = []): ReplayReport {
  const engines = new Map(show.acts.map((act) => {
    const engine = new ScriptFollowingEngine(flattenShow(show, act.id), undefined,
      { operatingMode: "PERFORMANCE_LOCAL", profiles: [...profiles] });
    engine.arm();
    return [act.id, engine] as const;
  }));
  const triggers: ReplayTrigger[] = [];
  const controls = [...analysis.controls].sort((a, b) => a.atMs - b.atMs);
  let controlIndex = 0;
  const capture = (engine: ScriptFollowingEngine, previous: unknown) => {
    const trigger = engine.snapshot().lastTrigger;
    if (trigger && trigger !== previous) triggers.push({ cueId: trigger.segment.id, atMs: trigger.triggeredAt,
      source: trigger.source, image: trigger.segment.type === "IMAGE" });
  };
  const runControls = (until: number) => {
    while (controls[controlIndex] && controls[controlIndex]!.atMs <= until) {
      const control = controls[controlIndex++]!;
      const engine = engines.get(control.actId);
      if (!engine) continue;
      const previous = engine.snapshot().lastTrigger;
      if (control.type === "manual-next") engine.manualNext(control.atMs);
      else if (control.type === "manual-previous") engine.manualPrevious(control.atMs);
      else if (control.type === "hold") engine.setHold(true, control.atMs);
      else if (control.type === "resume") engine.setHold(false, control.atMs);
      else engine.forceResync(control.atMs);
      capture(engine, previous);
    }
  };
  for (const segment of analysis.transcript) {
    const region = analysis.numberRegions.find((item) => item.startMs <= segment.startMs && item.endMs >= segment.startMs);
    const engine = region ? engines.get(region.actId) : undefined;
    if (!engine) continue;
    runControls(segment.startMs);
    engine.speechStart(segment.startMs);
    const words = segment.words?.length ? segment.words : [{ text: segment.text, startMs: segment.startMs, endMs: segment.endMs, confidence: segment.confidence }];
    let partial = "";
    words.forEach((word, index) => {
      partial += `${partial ? " " : ""}${word.text}`;
      const atMs = segment.receivedAtMs ?? word.endMs;
      runControls(atMs);
      const previous = engine.snapshot().lastTrigger;
      engine.processHypothesis({ text: partial, confidence: word.confidence, receivedAt: atMs, speechActive: true,
        utteranceId: `replay:${segment.id}`, isFinal: index === words.length - 1 });
      capture(engine, previous);
    });
    engine.speechEnd();
  }
  runControls(Infinity);
  triggers.sort((a, b) => a.atMs - b.atMs);
  return { rehearsalId: analysis.rehearsalId, triggers,
    metrics: evaluateTriggers(triggers, analysis.observations, {
      reviewRequired: analysis.reviewQueue.length,
      excludedRegions: analysis.reviewDecisions?.filter((decision) => decision.decision === "excluded-from-evaluation").length ?? 0,
      manualInterventions: controls.filter((item) => item.type === "manual-next" || item.type === "manual-previous" || item.type === "resync").length,
      timestampBasis: analysis.transcript.every((segment) => segment.receivedAtMs !== undefined) ? "recorded-asr-delivery" : "simulated-asr-delivery",
    }) };
}
