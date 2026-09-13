import type { CueProfile, OperatingMode, ScriptSegment } from "@stage/script-schema";

export type ConfidenceBasis = "provider-native" | "segment-logprob-derived" | "unavailable";

/** Missing acoustic confidence is not a neutral probability or measured zero. */
export function availableConfidence(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

export interface StreamingHypothesis {
  /** Adapter verified a post-operator audio generation via reset acknowledgment. */
  boundaryVerified?: boolean;
  utteranceId?: string;
  /** Optional cumulative context across ASR result boundaries; text stays raw UI input. */
  streamId?: string;
  contextText?: string;
  text: string;
  confidence: number | null;
  confidenceBasis?: ConfidenceBasis;
  isFinal?: boolean;
  receivedAt: number;
  speechActive: boolean;
}

export interface ScriptContext {
  candidateOffset: number;
  mode: "NORMAL" | "RESYNC" | "FULL_RESYNC";
  operatingMode?: OperatingMode;
  nearbySegments?: ScriptSegment[];
  profile?: CueProfile;
  timingPrior?: number;
}

export interface MatchResult {
  segmentId: string;
  score: number;
  prefixScore: number;
  coverage: number;
  observed: string;
  expected: string;
  eligible: boolean;
  start: number;
  end: number;
  fast: boolean;
  selectedAnchor?: string;
  components?: { text: number; anchor: number; sequence: number; timing: number; asr: number | null; speech: number };
}

export interface ScriptMatcher {
  match(observed: StreamingHypothesis, expected: ScriptSegment, context: ScriptContext): MatchResult;
}

export interface MatcherConfig {
  triggerThreshold: number;
  minimumEvidenceCharacters: number;
  weights: {
    scriptPrior: number;
    prefixMatch: number;
    asrConfidence: number;
    speechOnset: number;
  };
}

export const defaultMatcherConfig: MatcherConfig = {
  triggerThreshold: 0.78,
  minimumEvidenceCharacters: 2,
  weights: {
    scriptPrior: 0.4,
    prefixMatch: 0.35,
    asrConfidence: 0.15,
    speechOnset: 0.1
  }
};

const FILLERS = new Set(["음", "어", "아", "그", "저기", "뭐랄까"]);

export function normalizeKorean(input: string): string {
  return input
    .normalize("NFC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[.,!?…~\-—_:;"'“”‘’()[\]{}<>/\\|·]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !FILLERS.has(token))
    .join("");
}

function editSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length);
}

export class PrefixFuzzyMatcher implements ScriptMatcher {
  constructor(private readonly config: MatcherConfig = defaultMatcherConfig) {}

  match(hypothesis: StreamingHypothesis, segment: ScriptSegment, context: ScriptContext): MatchResult {
    if (context.operatingMode === "PERFORMANCE_LOCAL") return matchPerformance(hypothesis, segment, context);
    const observed = normalizeKorean(hypothesis.text);
    const scriptPrior = context.mode === "NORMAL"
      ? Math.max(0.25, 1 - context.candidateOffset * 0.18)
      : context.mode === "RESYNC"
        ? Math.max(0.65, 0.85 - context.candidateOffset * 0.03)
        : 0.5;
    const weights = this.config.weights;
    const asr = availableConfidence(hypothesis.confidence);
    const availableWeight = asr === null ? 1 - weights.asrConfidence : 1;
    const priorScore = scriptPrior * weights.scriptPrior
      + (asr === null ? 0 : asr * weights.asrConfidence)
      + (hypothesis.speechActive ? 1 : 0) * weights.speechOnset;
    let best: MatchResult = { segmentId: segment.id, score: priorScore, prefixScore: 0, coverage: 0, observed, expected: "", eligible: false, start: 0, end: 0, fast: false };

    for (const text of segment.matchText) {
      const expected = normalizeKorean(text);
      const minimum = Math.max(2, this.config.minimumEvidenceCharacters);
      const fastStart = observed.indexOf(expected.slice(0, minimum));
      // Deliberately aggressive ONLY for the next ordered cue. No final-result,
      // sentence-coverage, confidence, or silence gate on an exact two-syllable prefix.
      if (context.candidateOffset === 0 && hypothesis.speechActive && expected.length >= minimum && fastStart >= 0) {
        return { segmentId: segment.id, observed, expected, score: Math.max(this.config.triggerThreshold, (priorScore + weights.prefixMatch) / availableWeight), prefixScore: 1, coverage: minimum / expected.length, eligible: true, start: fastStart, end: fastStart + minimum, fast: true };
      }
      // Wider-window recovery needs stronger evidence than the fast ordered path.
      const evidenceMinimum = Math.max(4, minimum);
      for (let start = 0; start <= observed.length - evidenceMinimum; start += 1) {
        const length = Math.min(observed.length - start, expected.length);
        if (length < evidenceMinimum) continue;
        const quality = editSimilarity(observed.slice(start, start + length), expected.slice(0, length));
        const coverage = Math.min(1, length / Math.max(6, expected.length * 0.5));
        const prefixScore = quality * (0.55 + coverage * 0.45);
        const score = (priorScore + prefixScore * weights.prefixMatch) / availableWeight;
        const eligible = quality >= 0.75 && score >= this.config.triggerThreshold;
        if ((eligible && !best.eligible) || (eligible === best.eligible && score > best.score)) {
          best = { segmentId: segment.id, observed, expected, score, prefixScore, coverage, eligible, start, end: start + length, fast: false };
        }
      }
    }
    return best;
  }
}

/** Conservative local performance policy; demo's two-syllable policy is isolated above. */
function matchPerformance(hypothesis: StreamingHypothesis, segment: ScriptSegment, context: ScriptContext): MatchResult {
  const observed = normalizeKorean(hypothesis.text);
  const sequence = Math.max(0.3, 1 - context.candidateOffset * 0.2);
  const asr = availableConfidence(hypothesis.confidence);
  const speech = hypothesis.speechActive ? 1 : 0;
  const timing = context.timingPrior ?? 0;
  const threshold = Math.max(0.72, context.profile?.thresholds.text ?? 0.82);
  let best: MatchResult = { segmentId: segment.id, observed, expected: "", score: 0, prefixScore: 0, coverage: 0, start: 0, end: 0, fast: false, eligible: false, components: { text: 0, anchor: 0, sequence, timing, asr, speech } };
  if (segment.type === "IMAGE" || !speech) return best;
  const otherTexts = (context.nearbySegments ?? []).filter((other) => other.id !== segment.id).flatMap((other) => other.matchText.map(normalizeKorean));
  const unique = (anchor: string) => !otherTexts.some((text) => text.includes(anchor));
  const competingEvidence = new Map<string, number>();
  const competingQuality = (evidence: string) => {
    const cached = competingEvidence.get(evidence);
    if (cached !== undefined) return cached;
    let score = 0;
    for (const other of otherTexts) {
      if (other.includes(evidence)) { score = 1; break; }
      for (let start = 0; start <= other.length - evidence.length; start += 1) score = Math.max(score, editSimilarity(evidence, other.slice(start, start + evidence.length)));
    }
    competingEvidence.set(evidence, score);
    return score;
  };
  const consider = (expected: string, start: number, length: number, quality: number, anchor: number, selectedAnchor?: string) => {
    const textAndContext = quality * 0.5 + anchor * 0.15 + sequence * 0.15 + speech * 0.05;
    const score = asr === null ? textAndContext / 0.85 : textAndContext + asr * 0.15;
    // A canonical anchor can be unique while its fuzzy observation is actually
    // a perfect previous/nearby lyric. Sequence prior must not override that.
    const distinctive = quality === 1 || quality - competingQuality(observed.slice(start, start + length)) > 0.03;
    const eligible = quality >= 0.84 && score >= threshold && distinctive;
    if ((eligible && !best.eligible) || (eligible === best.eligible && score > best.score)) best = { segmentId: segment.id, observed, expected, score, prefixScore: quality, coverage: length / expected.length, start, end: start + length, fast: false, eligible, selectedAnchor, components: { text: quality, anchor, sequence, timing, asr, speech } };
  };
  for (const source of segment.matchText) {
    const expected = normalizeKorean(source);
    // A complete short canonical cue is distinct from a shared short prefix.
    if (expected.length >= 2 && expected.length < 4 && context.candidateOffset === 0 && observed === expected && unique(expected) && asr !== null && asr >= 0.9) consider(expected, 0, expected.length, 1, 1, expected);
    // Full repeated lyrics are allowed only at the ordered pointer; cursor evidence
    // must establish a new occurrence, never a revision of the old occurrence.
    const full = observed.indexOf(expected);
    if (expected.length >= 4 && full >= 0 && (unique(expected) || context.candidateOffset === 0)) consider(expected, full, expected.length, 1, 1, expected);
    for (let length = Math.min(12, expected.length); length >= 4; length -= 1) {
      const prefix = expected.slice(0, length);
      const start = observed.indexOf(prefix);
      if (start >= 0 && unique(prefix)) consider(expected, start, length, 1, 1, prefix);
    }
    for (const anchor of context.profile?.anchors ?? []) {
      const text = normalizeKorean(anchor.text);
      const start = observed.indexOf(text);
      if (text.length >= 4 && anchor.reliability >= 0.75 && expected.includes(text) && start >= 0 && unique(text)) consider(expected, start, text.length, 1, anchor.reliability, text);
    }
    // Strong internal evidence recovers a missing/stretched opening lyric.
    for (let expectedStart = 0; expectedStart <= expected.length - 4; expectedStart += 1) {
      for (let length = Math.min(16, expected.length - expectedStart, observed.length); length >= 4; length -= 1) {
        const anchor = expected.slice(expectedStart, expectedStart + length);
        if (!unique(anchor)) continue;
        const exact = observed.indexOf(anchor);
        if (exact >= 0) consider(expected, exact, length, 1, 1, anchor);
        if (length < 6) continue;
        for (let start = 0; start <= observed.length - length; start += 1) {
          const quality = editSimilarity(observed.slice(start, start + length), anchor);
          if (quality >= 0.84) consider(expected, start, length, quality, quality, anchor);
        }
      }
    }
  }
  return best;
}
