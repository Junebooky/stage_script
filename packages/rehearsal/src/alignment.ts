import { normalizeKorean } from "@stage/alignment";
import { flattenShow, type ScriptSegment, type Show } from "@stage/script-schema";
import type { AnalysisOptions, CueObservation, NumberRegion, RehearsalAnalysis, ReviewItem, ReviewStatus, TimestampedASR } from "./types";

interface LocalMatch { score: number; start: number; end: number; anchor: string }
interface NumberInfo { actId: string; numberId: string; cues: ScriptSegment[]; index: number }

/** Non-cryptographic change detector, not a security signature. */
export function canonicalFingerprint(show: Show): string {
  let hash = 2166136261;
  for (const char of JSON.stringify(show)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Broad offline local alignment. Unlike live matching it can recover arbitrary starts. */
export function localMatch(expected: string, observed: string): LocalMatch {
  if (!expected || !observed) return { score: 0, start: 0, end: 0, anchor: "" };
  const exact = observed.indexOf(expected);
  if (exact >= 0) return { score: 1, start: exact, end: exact + expected.length, anchor: expected };
  // Smith-Waterman local sequence alignment; omissions/mangled leading words do
  // not force a prefix match. A four-character contiguous anchor remains required.
  const a = expected.slice(0, 240), b = observed.slice(0, 1500);
  let previous = new Float64Array(b.length + 1);
  let previousStart = new Int32Array(b.length + 1);
  let previousRun = new Int32Array(b.length + 1);
  let best = { score: 0, start: 0, end: 0, anchor: "" };
  let bestValue = 0;
  let longest = "";
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Float64Array(b.length + 1);
    const starts = new Int32Array(b.length + 1);
    const runs = new Int32Array(b.length + 1);
    for (let j = 1; j <= b.length; j += 1) {
      const same = a[i - 1] === b[j - 1];
      const diagonal = previous[j - 1]! + (same ? 2 : -1.5);
      const deletion = previous[j]! - 1.2;
      const insertion = current[j - 1]! - 1.2;
      const value = Math.max(0, diagonal, deletion, insertion);
      current[j] = value;
      if (value === 0) starts[j] = j;
      else if (value === diagonal) starts[j] = previous[j - 1]! > 0 ? previousStart[j - 1]! : j - 1;
      else if (value === deletion) starts[j] = previousStart[j]!;
      else starts[j] = starts[j - 1]!;
      runs[j] = same ? previousRun[j - 1]! + 1 : 0;
      if (runs[j]! > longest.length) longest = b.slice(j - runs[j]!, j);
      if (value > bestValue) {
        bestValue = value;
        best = { score: 0, start: starts[j]!, end: j, anchor: "" };
      }
    }
    previous = current; previousStart = starts; previousRun = runs;
  }
  if (longest.length < Math.min(4, expected.length)) return { ...best, score: 0, anchor: "" };
  const coverage = Math.min(1, bestValue / (a.length * 2));
  const quality = Math.min(1, bestValue / Math.max(1, (best.end - best.start) * 2));
  return { ...best, score: Math.min(0.98, quality * 0.65 + coverage * 0.35), anchor: longest };
}

function cueMatch(cue: ScriptSegment, observed: string): LocalMatch {
  return cue.matchText.map((text) => localMatch(normalizeKorean(text), observed))
    .reduce((best, item) => item.score > best.score ? item : best, { score: 0, start: 0, end: 0, anchor: "" });
}

function transitionScore(previous: number, next: number): number {
  if (previous === next) return 0.055;
  if (next === previous + 1) return 0.025;
  // Broad/recoverable offline policy: any number skip or rehearsal restart is legal.
  return next > previous ? -0.025 * Math.min(4, next - previous - 1) : -0.08;
}

function globalNumberAlignment(numbers: NumberInfo[], transcript: TimestampedASR[]): { numberIndex: number; confidence: number }[] {
  if (!transcript.length) return [];
  const emissions = transcript.map((segment) => numbers.map((number) => {
    const observed = normalizeKorean(segment.text);
    return Math.max(0, ...number.cues.filter((cue) => cue.type !== "IMAGE").map((cue) => cueMatch(cue, observed).score));
  }));
  let scores = numbers.map((_, index) => emissions[0]![index]!);
  const parents: number[][] = [numbers.map(() => -1)];
  for (let time = 1; time < transcript.length; time += 1) {
    const rowParents: number[] = [];
    const nextScores = numbers.map((_, next) => {
      let best = -Infinity, parent = 0;
      for (let previous = 0; previous < numbers.length; previous += 1) {
        const value = scores[previous]! + transitionScore(previous, next);
        if (value > best) { best = value; parent = previous; }
      }
      rowParents.push(parent);
      return best + emissions[time]![next]!;
    });
    scores = nextScores;
    parents.push(rowParents);
  }
  let current = scores.indexOf(Math.max(...scores));
  const output: { numberIndex: number; confidence: number }[] = [];
  for (let time = transcript.length - 1; time >= 0; time -= 1) {
    const score = emissions[time]![current]!;
    const runnerUp = Math.max(0, ...emissions[time]!.filter((_, index) => index !== current));
    // Identical lyrics in two numbers are ambiguous even if sequence prior wins.
    const certainty = Math.min(1, Math.max(0, score - runnerUp) / 0.2);
    output[time] = { numberIndex: current, confidence: score * (0.7 + certainty * 0.3) };
    current = parents[time]![current]!;
  }
  return output;
}

export function spanTime(segment: TimestampedASR, start: number, end: number): [number, number] {
  if (segment.words?.length) {
    let cursor = 0, first: number | undefined, last = segment.endMs;
    for (const word of segment.words) {
      const length = normalizeKorean(word.text).length;
      if (first === undefined && cursor + length > start) first = word.startMs;
      if (cursor < end) last = word.endMs;
      cursor += length;
    }
    return [first ?? segment.startMs, Math.max(first ?? segment.startMs, last)];
  }
  const length = Math.max(1, normalizeKorean(segment.text).length);
  const duration = segment.endMs - segment.startMs;
  return [segment.startMs + duration * start / length, segment.startMs + duration * end / length];
}

export function analyzeRehearsal(show: Show, input: readonly TimestampedASR[], options: AnalysisOptions): RehearsalAnalysis {
  const accepted = options.acceptedThreshold ?? 0.9, warning = options.warningThreshold ?? 0.7;
  const minimum = options.minimumAlignmentScore ?? 0.64;
  if (!(0 <= minimum && minimum <= warning && warning <= accepted && accepted <= 1)) throw new Error("Invalid review confidence thresholds");
  const transcript = structuredClone([...input]).sort((a, b) => a.startMs - b.startMs);
  for (const segment of transcript) {
    if (!segment.id || typeof segment.text !== "string" || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)
      || segment.startMs < 0 || segment.endMs < segment.startMs || (segment.confidence !== null && (!Number.isFinite(segment.confidence)
      || segment.confidence < 0 || segment.confidence > 1))) throw new Error("Invalid timestamped ASR segment");
  }
  const numbers: NumberInfo[] = show.acts.flatMap((act) => act.numbers.map((number) => ({
    actId: act.id, numberId: number.id, cues: number.cues, index: 0
  }))).map((number, index) => ({ ...number, index }));
  const orderedCues = flattenShow(show).segments;
  const global = globalNumberAlignment(numbers, transcript);
  const observations: CueObservation[] = [], reviewQueue: ReviewItem[] = [], numberRegions: NumberRegion[] = [];
  let previousNumber = -1, cuePointer = -1;
  transcript.forEach((segment, segmentIndex) => {
    const detection = global[segmentIndex]!;
    const number = numbers[detection.numberIndex]!;
    const observed = normalizeKorean(segment.text);
    if (!number || !observed) return;
    if (previousNumber !== number.index) {
      const transition: NumberRegion["transition"] = previousNumber < 0 ? "start" : number.index <= previousNumber ? "restart" : number.index === previousNumber + 1 ? "ordered" : "skip";
      numberRegions.push({ actId: number.actId, numberId: number.numberId, startMs: segment.startMs, endMs: segment.endMs,
        confidence: detection.confidence, occurrence: numberRegions.filter((item) => item.numberId === number.numberId).length + 1, transition });
      cuePointer = -1;
    } else {
      const region = numberRegions[numberRegions.length - 1]!;
      region.endMs = segment.endMs;
      region.confidence = Math.min(region.confidence, detection.confidence);
    }
    previousNumber = number.index;
    const candidates = number.cues.map((cue, cueIndex) => ({ cue, cueIndex, match: cueMatch(cue, observed) }))
      .filter((item) => item.cue.type !== "IMAGE" && item.match.score >= minimum)
      .sort((a, b) => a.match.start - b.match.start || b.match.score - a.match.score || Math.abs(a.cueIndex - cuePointer - 1) - Math.abs(b.cueIndex - cuePointer - 1));
    let floor = 0, matched = 0;
    for (const candidate of candidates) {
      if (candidate.match.start < floor) continue;
      const collision = candidates.filter((other) => other.cue.id !== candidate.cue.id && other.match.start === candidate.match.start && other.match.score >= candidate.match.score - 0.04);
      const collisionRisk = collision.length ? 1 : 0;
      const confidence = Math.min(1, candidate.match.score * (segment.confidence === null ? 1 : 0.82 + segment.confidence * 0.18)
        * (0.72 + detection.confidence * 0.28) * (collisionRisk ? 0.7 : 1));
      const status: ReviewStatus = confidence >= accepted ? "accepted" : confidence >= warning ? "warning" : "review-required";
      const [startMs, endMs] = spanTime(segment, candidate.match.start, candidate.match.end);
      const previous = observations[observations.length - 1];
      const currentOrder = orderedCues.findIndex((cue) => cue.id === candidate.cue.id);
      const canonicalPrevious = orderedCues[currentOrder - 1];
      const followsPrevious = !!previous && previous.actId === number.actId && previous.cueId === canonicalPrevious?.id;
      const observation: CueObservation = {
        id: `${options.rehearsalId}:${observations.length}`, cueId: candidate.cue.id, actId: number.actId,
        numberId: number.numberId, startMs, endMs, asrText: segment.text,
        alignmentConfidence: confidence, reviewStatus: status, groundTruth: "pseudo",
        anchors: candidate.match.anchor.length >= 4 ? [candidate.match.anchor] : [],
        previousCueId: followsPrevious ? previous.cueId : null,
        relativeAfterPreviousMs: followsPrevious ? startMs - previous.startMs : null,
        gapBeforeMs: previous ? Math.max(0, startMs - previous.endMs) : 0, collisionRisk,
      };
      observations.push(observation);
      if (status === "review-required") reviewQueue.push({ id: `review:${observation.id}`, observationId: observation.id,
        cueId: observation.cueId, transcriptId: segment.id, startMs, reason: collisionRisk ? "Repeated lyric collision" : "Low alignment confidence" });
      floor = candidate.match.end;
      cuePointer = candidate.cueIndex;
      matched += 1;
    }
    if (!matched && observed.length >= 4) reviewQueue.push({ id: `unmatched:${segment.id}`, observationId: null, cueId: null,
      transcriptId: segment.id, startMs: segment.startMs, reason: "Unmatched rehearsal speech; not classified as ad-lib" });
  });
  const seenCues = new Set(observations.map((item) => item.cueId));
  const seenNumbers = new Set(observations.map((item) => item.numberId));
  return { version: 1, rehearsalId: options.rehearsalId, showId: show.id, canonicalFingerprint: canonicalFingerprint(show),
    createdAt: options.now ?? Date.now(), timestampBasis: "local-asr-pseudo", transcript, observations, numberRegions,
    skippedCueIds: orderedCues.filter((cue) => cue.type !== "IMAGE" && !seenCues.has(cue.id)).map((cue) => cue.id),
    skippedNumberIds: numbers.filter((number) => !seenNumbers.has(number.numberId)).map((number) => number.numberId), reviewQueue, controls: [] };
}

/** Review edits observations only; canonical show data is never accepted as a target. */
export function confirmObservation(analysis: RehearsalAnalysis, observationId: string,
  correction: { startMs: number; endMs: number; reviewer: string }): RehearsalAnalysis {
  if (!correction.reviewer.trim() || !Number.isFinite(correction.startMs) || correction.startMs < 0
    || !Number.isFinite(correction.endMs) || correction.endMs < correction.startMs) throw new Error("Valid human review and timestamps are required");
  const result = structuredClone(analysis);
  const observation = result.observations.find((item) => item.id === observationId);
  if (!observation) throw new Error("Observation not found");
  Object.assign(observation, correction, { groundTruth: "human", reviewStatus: "accepted", alignmentConfidence: 1, timingBasis: "human-confirmed", timingReliable: true });
  result.revision = (result.revision ?? 0) + 1;
  result.reviewQueue = result.reviewQueue.filter((item) => item.observationId !== observationId);
  // Recompute neighboring relative timing after an onset correction, never across acts.
  result.observations.forEach((item, index) => {
    const previous = result.observations[index - 1];
    item.relativeAfterPreviousMs = previous && previous.actId === item.actId && item.previousCueId === previous.cueId
      ? item.startMs - previous.startMs : null;
  });
  return result;
}

/** An operator may exclude ambiguous/noise regions, but this never creates truth. */
export function dismissReviewItem(analysis: RehearsalAnalysis, reviewItemId: string,
  decision: { reviewer: string; reason: string; at?: number }): RehearsalAnalysis {
  if (!decision.reviewer.trim() || !decision.reason.trim()) throw new Error("Reviewer and exclusion reason are required");
  const result = structuredClone(analysis);
  const item = result.reviewQueue.find((entry) => entry.id === reviewItemId);
  if (!item) throw new Error("Review item not found");
  result.reviewQueue = result.reviewQueue.filter((entry) => entry.id !== reviewItemId);
  result.revision = (result.revision ?? 0) + 1;
  // Keep the original observation review-required so metrics exclude it even
  // though the operator has resolved the review queue item.
  result.reviewDecisions = [...(result.reviewDecisions ?? []), { reviewItemId,
    reviewer: decision.reviewer, reason: decision.reason, decision: "excluded-from-evaluation", at: decision.at ?? Date.now() }];
  return result;
}
