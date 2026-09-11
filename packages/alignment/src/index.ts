import type { ScriptSegment } from "@stage/script-schema";

export interface StreamingHypothesis {
  utteranceId?: string;
  /** Optional cumulative context across ASR result boundaries; text stays raw UI input. */
  streamId?: string;
  contextText?: string;
  text: string;
  confidence: number;
  isFinal?: boolean;
  receivedAt: number;
  speechActive: boolean;
}

export interface ScriptContext {
  candidateOffset: number;
  mode: "NORMAL" | "RESYNC" | "FULL_RESYNC";
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
    const observed = normalizeKorean(hypothesis.text);
    const scriptPrior = context.mode === "NORMAL"
      ? Math.max(0.25, 1 - context.candidateOffset * 0.18)
      : context.mode === "RESYNC"
        ? Math.max(0.65, 0.85 - context.candidateOffset * 0.03)
        : 0.5;
    const weights = this.config.weights;
    const priorScore = scriptPrior * weights.scriptPrior
      + Math.max(0, Math.min(1, hypothesis.confidence)) * weights.asrConfidence
      + (hypothesis.speechActive ? 1 : 0) * weights.speechOnset;
    let best: MatchResult = { segmentId: segment.id, score: priorScore, prefixScore: 0, coverage: 0, observed, expected: "", eligible: false, start: 0, end: 0, fast: false };

    for (const text of segment.matchText) {
      const expected = normalizeKorean(text);
      const minimum = Math.max(2, this.config.minimumEvidenceCharacters);
      const fastStart = observed.indexOf(expected.slice(0, minimum));
      // Deliberately aggressive ONLY for the next ordered cue. No final-result,
      // sentence-coverage, confidence, or silence gate on an exact two-syllable prefix.
      if (context.candidateOffset === 0 && hypothesis.speechActive && expected.length >= minimum && fastStart >= 0) {
        return { segmentId: segment.id, observed, expected, score: Math.max(this.config.triggerThreshold, priorScore + weights.prefixMatch), prefixScore: 1, coverage: minimum / expected.length, eligible: true, start: fastStart, end: fastStart + minimum, fast: true };
      }
      // Wider-window recovery needs stronger evidence than the fast ordered path.
      const evidenceMinimum = Math.max(4, minimum);
      for (let start = 0; start <= observed.length - evidenceMinimum; start += 1) {
        const length = Math.min(observed.length - start, expected.length);
        if (length < evidenceMinimum) continue;
        const quality = editSimilarity(observed.slice(start, start + length), expected.slice(0, length));
        const coverage = Math.min(1, length / Math.max(6, expected.length * 0.5));
        const prefixScore = quality * (0.55 + coverage * 0.45);
        const score = priorScore + prefixScore * weights.prefixMatch;
        const eligible = quality >= 0.75 && score >= this.config.triggerThreshold;
        if ((eligible && !best.eligible) || (eligible === best.eligible && score > best.score)) {
          best = { segmentId: segment.id, observed, expected, score, prefixScore, coverage, eligible, start, end: start + length, fast: false };
        }
      }
    }
    return best;
  }
}
