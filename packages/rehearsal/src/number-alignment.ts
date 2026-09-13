import { normalizeKorean } from "@stage/alignment";
import { flattenShow, type ScriptSegment, type Show } from "@stage/script-schema";
import { canonicalFingerprint, localMatch, spanTime } from "./alignment";
import type { AnalysisOptions, CueObservation, RehearsalAnalysis, ReviewItem, TimestampedASR } from "./types";

interface Candidate { index: number; cue: ScriptSegment; score: number; start: number; end: number; anchor: string }
interface Slot { segment: TimestampedASR; candidates: Candidate[] }
interface Path { score: number; choices: Candidate[] }

function validateTranscript(input: readonly TimestampedASR[]): TimestampedASR[] {
  const transcript = structuredClone([...input]).sort((a, b) => a.startMs - b.startMs);
  const ids = new Set<string>();
  for (const segment of transcript) {
    if (!segment.id || ids.has(segment.id)) throw new Error("ASR segment IDs must be unique");
    ids.add(segment.id);
    let previousEnd = segment.startMs;
    for (const word of [segment, ...(segment.words ?? [])]) {
      if (typeof word.text !== "string" || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
        || word.startMs < 0 || word.endMs < word.startMs || (word.confidence !== null && (!Number.isFinite(word.confidence)
        || word.confidence < 0 || word.confidence > 1))) throw new Error("Invalid timestamped ASR");
      if (word.confidenceBasis && !["provider-native", "segment-logprob-derived", "unavailable"].includes(word.confidenceBasis)) throw new Error("Invalid ASR confidence basis");
      if (word.confidenceBasis === "unavailable" && word.confidence !== null) throw new Error("Unavailable ASR confidence cannot be numeric");
      if (word.confidence === null && word.confidenceBasis && word.confidenceBasis !== "unavailable") throw new Error("Missing ASR confidence cannot claim a measurement");
      if (word !== segment) {
        if (word.startMs < previousEnd || word.endMs > segment.endMs) throw new Error("Invalid ASR word ordering");
        previousEnd = word.endMs;
      }
    }
  }
  return transcript;
}

function candidatesFor(segment: TimestampedASR, cues: ScriptSegment[], minimum: number): Slot[] {
  const observed = normalizeKorean(segment.text);
  const candidates: Candidate[] = [];
  cues.forEach((cue, index) => {
    if (cue.type === "IMAGE") return;
    const seen = new Set<string>();
    for (const text of cue.matchText) {
      const expected = normalizeKorean(text);
      let floor = 0;
      while (floor < observed.length) {
        const match = localMatch(expected, observed.slice(floor));
        if (match.score < minimum || !match.anchor) break;
        const start = match.start + floor, end = match.end + floor;
        const key = `${start}:${end}`;
        if (!seen.has(key)) candidates.push({ ...match, cue, index, start, end });
        seen.add(key);
        floor = end;
      }
    }
  });
  // Preserve repeated-lyric alternatives until offline sequence disambiguation.
  const slots: Slot[] = [];
  for (const candidate of candidates.sort((a, b) => a.start - b.start || b.score - a.score)) {
    const slot = slots.find((item) => item.candidates.some((other) => {
      const overlap = Math.min(other.end, candidate.end) - Math.max(other.start, candidate.start);
      return overlap > 0 && overlap / Math.min(other.end - other.start, candidate.end - candidate.start) >= 0.6;
    }));
    if (slot) slot.candidates.push(candidate);
    else slots.push({ segment, candidates: [candidate] });
  }
  for (const slot of slots) {
    const best = Math.max(...slot.candidates.map((item) => item.score));
    slot.candidates = slot.candidates.filter((item) => item.score >= best - 0.1);
  }
  return slots;
}

function sequenceScore(previous: number | undefined, next: number): number {
  if (previous === undefined) return -Math.min(0.05, next * 0.002);
  if (next === previous + 1) return 0.24;
  if (next === previous) return -0.12;
  if (next > previous) return -Math.min(0.3, (next - previous - 1) * 0.045);
  return -0.35; // Offline restarts are legal; this is never a live auto-rewind rule.
}

/** Known-number recordings NEVER enter whole-show number detection. Offline
 * sequence evidence may look ahead; live decisions still use the live engine. */
export function analyzeNumberRehearsal(show: Show, numberId: string, input: readonly TimestampedASR[], options: AnalysisOptions): RehearsalAnalysis {
  const act = show.acts.find((item) => item.numbers.some((number) => number.id === numberId));
  const number = act?.numbers.find((item) => item.id === numberId);
  if (!act || !number?.cues.length) throw new Error(`CANONICAL SCRIPT REQUIRED: ${numberId}`);
  const minimum = options.minimumAlignmentScore ?? 0.64, warning = options.warningThreshold ?? 0.7, accepted = options.acceptedThreshold ?? 0.9;
  if (!(0 <= minimum && minimum <= warning && warning <= accepted && accepted <= 1)) throw new Error("Invalid review confidence thresholds");
  const transcript = validateTranscript(input);
  const cues = flattenShow({ ...show, acts: [{ ...act, numbers: [number] }] }).segments;
  const slots = transcript.flatMap((segment) => candidatesFor(segment, cues, minimum));
  let beam: Path[] = [{ score: 0, choices: [] }];
  for (const slot of slots) {
    const paths = beam.flatMap((path) => slot.candidates.map((candidate) => ({
      score: path.score + candidate.score + sequenceScore(path.choices.at(-1)?.index, candidate.index),
      choices: [...path.choices, candidate],
    }))).sort((a, b) => b.score - a.score);
    // Keep different endpoints and a second history per endpoint for uncertainty.
    const endpoints = new Map<number, number>();
    beam = paths.filter((path) => {
      const end = path.choices.at(-1)!.index, count = endpoints.get(end) ?? 0;
      endpoints.set(end, count + 1);
      return count < 2;
    }).slice(0, 96);
  }
  const best = beam[0]!;
  const observations: CueObservation[] = [], reviewQueue: ReviewItem[] = [];
  best.choices.forEach((candidate, slotIndex) => {
    const slot = slots[slotIndex]!, segment = slot.segment;
    const competitors = [...new Set(slot.candidates.filter((other) => other.cue.id !== candidate.cue.id && other.score >= candidate.score - 0.04).map((other) => other.cue.id))];
    const rival = beam.find((path) => path.choices[slotIndex]?.cue.id !== candidate.cue.id);
    // An isolated repeated opening cannot be resolved by the weak initial prior.
    const evidenceCount = best.choices.filter((choice, index) => index !== slotIndex
      && (slots[index]?.candidates.length === 1 || (index > 0 && choice.index === best.choices[index - 1]!.index + 1))).length;
    const resolved = !competitors.length || (evidenceCount >= 2 && (!rival || best.score - rival.score > 0.25));
    const acousticFactor = segment.confidence === null ? 1 : 0.82 + segment.confidence * 0.18;
    const confidence = Math.min(1, candidate.score * acousticFactor * (resolved ? 1 : 0.65));
    const acousticWarning = (segment.confidence !== null && segment.confidence < 0.55)
      || (typeof segment.providerMetadata?.no_speech_prob === "number" && segment.providerMetadata.no_speech_prob > 0.6);
    const status = acousticWarning ? "review-required" : confidence >= accepted ? "accepted" : confidence >= warning ? "warning" : "review-required";
    const [startMs, endMs] = spanTime(segment, candidate.start, candidate.end);
    const previous = observations.at(-1);
    const follows = !!previous && previous.cueId === cues[candidate.index - 1]?.id;
    const timingReliable = status !== "review-required" && !!segment.words?.length;
    const observation: CueObservation = {
      id: `${options.rehearsalId}:${observations.length}`, cueId: candidate.cue.id, actId: act.id, numberId,
      startMs, endMs, asrText: segment.text, transcriptId: segment.id, alignmentConfidence: confidence,
      asrConfidence: segment.confidence, asrConfidenceBasis: segment.confidenceBasis,
      alignmentEvidenceBasis: segment.confidence === null ? "text-sequence-only" : "text-sequence-and-asr",
      matchScore: candidate.score, normalizedMatchRange: [candidate.start, candidate.end],
      timingBasis: segment.words?.length ? "asr-word-estimate" : "asr-span-interpolation", timingReliable,
      groundTruth: "pseudo", reviewStatus: status, anchors: candidate.anchor.length >= 4 ? [candidate.anchor] : [],
      previousCueId: follows ? previous!.cueId : null,
      relativeAfterPreviousMs: follows ? startMs - previous!.startMs : null,
      gapBeforeMs: previous ? Math.max(0, startMs - previous.endMs) : 0,
      collisionRisk: competitors.length ? resolved ? 0.25 : 1 : 0,
      repetition: { competingCueIds: competitors, resolvedBy: competitors.length ? resolved ? "sequence-context" : "unresolved" : "unique-text" },
    };
    observations.push(observation);
    if (status === "review-required" || !timingReliable) reviewQueue.push({ id: `review:${observation.id}`, observationId: observation.id,
      cueId: observation.cueId, transcriptId: segment.id, startMs,
      reason: !resolved ? "Repeated lyric occurrence unresolved" : status === "review-required" ? "Low alignment confidence" : "Approximate span timing; word timestamps or human review required" });
  });
  for (const segment of transcript) {
    if (!observations.some((item) => item.transcriptId === segment.id) && normalizeKorean(segment.text).length >= 4) {
      reviewQueue.push({ id: `unmatched:${segment.id}`, observationId: null, cueId: null, transcriptId: segment.id,
        startMs: segment.startMs, reason: "UNMATCHED_SPEECH — no canonical cue; not classified as ad-lib" });
    }
  }
  const seen = new Set(observations.map((item) => item.cueId));
  return { version: 1, rehearsalId: options.rehearsalId, showId: show.id, canonicalFingerprint: canonicalFingerprint(show),
    createdAt: options.now ?? Date.now(), alignmentMode: "known-number-local", numberId, timestampBasis: options.timestampBasis ?? "local-asr-pseudo",
    asrProvider: options.asrProvider, model: options.model,
    transcript, observations, reviewQueue, controls: [], skippedNumberIds: seen.size ? [] : [numberId],
    skippedCueIds: cues.filter((cue) => cue.type !== "IMAGE" && !seen.has(cue.id)).map((cue) => cue.id),
    numberRegions: transcript.length ? [{ actId: act.id, numberId, startMs: transcript[0]!.startMs,
      endMs: Math.max(...transcript.map((item) => item.endMs)), confidence: observations.length ? Math.min(...observations.map((item) => item.alignmentConfidence)) : 0,
      occurrence: 1, transition: "start" }] : [],
  };
}
