import { flattenShow, type Show } from "@stage/script-schema";
import { buildCueProfiles, evaluateChallenger } from "./calibration";
import { evaluateTriggers, replayRehearsal } from "./replay";
import type { RehearsalAnalysis, ReplayReport } from "./types";

/** Baseline is the existing uncalibrated PERFORMANCE_LOCAL matcher, NOT demo's
 * two-syllable path. Live matcher policy is unchanged in this milestone. */
export function compareCandidate(show: Show, analysis: RehearsalAnalysis) {
  const baseline = replayRehearsal(show, analysis);
  const profiles = buildCueProfiles(show, [analysis]);
  const candidate = replayRehearsal(show, analysis, profiles);
  const cues = flattenShow(show).segments;
  const breakdown = (report: ReplayReport) => {
    const subsets = Object.fromEntries(["spoken", "sung", "solo", "duet", "chorus"].map((label) => {
      const ids = new Set(cues.filter((cue) => cue.metadata?.delivery === label || cue.metadata?.ensemble === label).map((cue) => cue.id));
      return [label, evaluateTriggers(report.triggers.filter((trigger) => ids.has(trigger.cueId)), analysis.observations.filter((item) => ids.has(item.cueId)))];
    }));
    const repeatedLyricConfusions = report.triggers.filter((trigger) => {
      const cue = cues.find((item) => item.id === trigger.cueId);
      if (!cue?.metadata?.repeatGroup) return false;
      // Count only a wrong occurrence inside another observed repeated cue's
      // acoustic span; unresolved observations are not fabricated ground truth.
      return analysis.observations.some((item) => item.reviewStatus !== "review-required" && item.cueId !== cue.id
        && item.startMs <= trigger.atMs && trigger.atMs <= item.endMs
        && cues.find((other) => other.id === item.cueId)?.metadata?.repeatGroup === cue.metadata?.repeatGroup);
    }).length;
    return { ...report, automaticTriggers: report.triggers.filter((trigger) => trigger.source === "automatic").length,
      repeatedLyricConfusions, breakdown: subsets };
  };
  return {
    status: "candidate" as const, sampleCount: 1, productionReady: false,
    baselineLabel: "CURRENT BASELINE — PERFORMANCE_LOCAL, no calibration",
    candidateLabel: "CANDIDATE — same live matcher with one-recording cue profiles",
    evaluationKind: "in-sample ASR observation replay; not independent validation or measured live latency",
    baseline: breakdown(baseline), candidate: breakdown(candidate), profiles,
    promotion: evaluateChallenger(show, [analysis], [], profiles),
  };
}
