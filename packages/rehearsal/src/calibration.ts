import { normalizeKorean } from "@stage/alignment";
import { flattenShow, type CueProfile, type Show } from "@stage/script-schema";
import { canonicalFingerprint } from "./alignment";
import type { ChallengerEvaluation, RehearsalAnalysis } from "./types";
import { replayRehearsal } from "./replay";

export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export interface ProfileOptions {
  /** Fallback is an explicit cue-by-cue operator choice, never enabled by analysis. */
  fallbackEnabledCueIds?: readonly string[];
  minimumRehearsals?: number;
}

export function buildCueProfiles(show: Show, analyses: readonly RehearsalAnalysis[], options: ProfileOptions = {}): CueProfile[] {
  const fingerprint = canonicalFingerprint(show);
  if (analyses.some((analysis) => analysis.showId !== show.id || analysis.canonicalFingerprint !== fingerprint)) {
    throw new Error("Rehearsal belongs to a different canonical show revision; reanalyze first");
  }
  const minimum = options.minimumRehearsals ?? 3;
  const segments = flattenShow(show).segments;
  return segments.filter((cue) => cue.type !== "IMAGE").map((cue, cueIndex) => {
    const samples = analyses.flatMap((analysis) => analysis.observations.filter((item) => item.cueId === cue.id && item.reviewStatus !== "review-required")
      .map((observation) => ({ rehearsalId: analysis.rehearsalId, observation })));
    const sampleCount = new Set(samples.map((sample) => sample.rehearsalId)).size;
    const confidence = samples.length ? samples.reduce((sum, sample) => sum + sample.observation.alignmentConfidence, 0) / samples.length
      * Math.min(1, Math.sqrt(sampleCount / minimum)) : 0;
    const normalized = cue.matchText.map(normalizeKorean);
    const nearby = segments.slice(Math.max(0, cueIndex - 4), cueIndex + 5).filter((other) => other.id !== cue.id)
      .flatMap((other) => other.matchText.map(normalizeKorean));
    const candidates = new Set<string>();
    for (const expected of normalized) {
      for (let size = 4; size <= Math.min(10, expected.length); size += 1) {
        for (let start = 0; start <= expected.length - size; start += 1) {
          const text = expected.slice(start, start + size);
          if (!nearby.some((other) => other.includes(text))) candidates.add(text);
        }
      }
    }
    const anchors = [...candidates].map((text) => ({ text,
      competingCueIds: segments.filter((other) => other.id !== cue.id && other.matchText.some((line) => normalizeKorean(line).includes(text))).map((other) => other.id),
      repetitionRisk: segments.some((other) => other.id !== cue.id && other.matchText.some((line) => normalizeKorean(line).includes(text))) ? 1 : 0,
      reliability: sampleCount ? new Set(samples.filter((sample) => {
        const normalized = normalizeKorean(sample.observation.asrText), range = sample.observation.normalizedMatchRange;
        return (range ? normalized.slice(range[0], range[1]) : normalized).includes(text);
      })
        .map((sample) => sample.rehearsalId)).size / sampleCount : 0,
    })).filter((anchor) => anchor.reliability >= 0.7)
      .sort((a, b) => b.reliability - a.reliability || b.text.length - a.text.length)
      .filter((anchor, index, all) => !all.slice(0, index).some((other) => other.text.includes(anchor.text)))
      .slice(0, 8);
    const timingSamples = samples.filter((sample) => sample.observation.timingReliable !== false && sample.observation.relativeAfterPreviousMs !== null
      && sample.observation.relativeAfterPreviousMs! >= 0 && sample.observation.relativeAfterPreviousMs! <= 180_000);
    const timing = timingSamples.map((sample) => sample.observation.relativeAfterPreviousMs!);
    const median = percentile(timing, 0.5) ?? 0;
    const mean = timing.reduce((sum, value) => sum + value, 0) / Math.max(1, timing.length);
    const variance = timing.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, timing.length);
    const relativeRecordingCount = new Set(timingSamples.map((sample) => sample.rehearsalId)).size;
    return {
      cueId: cue.id, status: "candidate", anchors, sampleCount, confidence,
      timing: { medianAfterPreviousMs: median, varianceMs2: variance, sampleCount: relativeRecordingCount, distributionReady: relativeRecordingCount >= Math.max(3, minimum),
        earlyToleranceMs: timing.length ? Math.max(250, median - (percentile(timing, 0.1) ?? median)) : 0,
        lateToleranceMs: timing.length ? Math.max(500, (percentile(timing, 0.9) ?? median) - median) : 0 },
      thresholds: { text: Math.max(0.76, Math.min(0.86, 0.84 - confidence * 0.06)), fallback: 0.9 },
      fallback: { enabled: !!options.fallbackEnabledCueIds?.includes(cue.id)
        && sampleCount >= minimum && relativeRecordingCount >= minimum && confidence >= 0.85
        && anchors.some((anchor) => anchor.repetitionRisk === 0) && variance <= Math.max(250_000, median ** 2 * 0.04) },
    };
  });
}

export interface PromotionOptions { minimumHistoricalRehearsals?: number }

/** Strict no-regression gate, followed by mandatory human promotion confirmation. */
export function evaluateChallenger(show: Show, analyses: readonly RehearsalAnalysis[], champion: readonly CueProfile[],
  challenger: readonly CueProfile[], options: PromotionOptions = {}): ChallengerEvaluation {
  const reasons: string[] = [];
  const minimum = options.minimumHistoricalRehearsals ?? 3;
  if (analyses.length < minimum) reasons.push(`At least ${minimum} historical rehearsals are required`);
  if (new Set(analyses.map((analysis) => analysis.rehearsalId)).size !== analyses.length) reasons.push("Duplicate historical rehearsal IDs");
  const fingerprint = canonicalFingerprint(show);
  if (analyses.some((analysis) => analysis.showId !== show.id || analysis.canonicalFingerprint !== fingerprint)) {
    throw new Error("Historical rehearsal canonical revision differs; reanalyze before calibration");
  }
  const replays = analyses.map((analysis) => ({ rehearsalId: analysis.rehearsalId,
    analysisCreatedAt: analysis.createdAt, analysisRevision: analysis.revision ?? 0,
    champion: replayRehearsal(show, analysis, champion).metrics,
    challenger: replayRehearsal(show, analysis, challenger).metrics }));
  let improved = false;
  for (const row of replays) {
    if (row.challenger.reviewRequired > 0) reasons.push(`${row.rehearsalId}: unresolved review queue`);
    if (!row.challenger.evaluatedCues) reasons.push(`${row.rehearsalId}: no evaluable cues`);
    if (row.challenger.cueAccuracy < row.champion.cueAccuracy) reasons.push(`${row.rehearsalId}: cue accuracy regressed`);
    if (row.challenger.cueAccuracy > row.champion.cueAccuracy) improved = true;
    const lowerIsBetter = ["missedCues", "wrongTriggers", "earlyTriggers", "lateTriggers", "manualInterventions", "fallbackTriggers",
      "latencyP50Ms", "latencyP95Ms", "recoveryTimeMs", "imageEntryErrorMs", "imageExitErrorMs"] as const;
    for (const metric of lowerIsBetter) {
      const before = row.champion[metric], after = row.challenger[metric];
      if (before === null && after === null) continue;
      if (before === null || after === null) {
        reasons.push(`${row.rehearsalId}: ${metric} is not comparable`);
      } else if (after > before) {
        reasons.push(`${row.rehearsalId}: ${metric} regressed`);
      } else if (after < before) improved = true;
    }
  }
  if (!improved) reasons.push("No measurable improvement over the current champion");
  const human = replays.reduce((count, row) => count + row.challenger.humanConfirmedCues, 0);
  const pseudo = replays.reduce((count, row) => count + row.challenger.pseudoGroundTruthCues, 0);
  return { recommended: reasons.length === 0, reasons: [...new Set(reasons)],
    evidence: human && pseudo ? "mixed" : human ? "human" : "pseudo", replays,
    policy: { requireAllHistorical: true, allowRegression: false, operatorConfirmationRequired: true } };
}
