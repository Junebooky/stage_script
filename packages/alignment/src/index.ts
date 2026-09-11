import type { ScriptSegment } from "@stage/script-schema";

export interface StreamingHypothesis {
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
  minimumEvidenceCharacters: 3,
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

function prefixEvidence(observed: string, expected: string): { quality: number; coverage: number } {
  const comparedLength = Math.min(observed.length, expected.length);
  if (comparedLength === 0) return { quality: 0, coverage: 0 };
  const observedPrefix = observed.slice(-comparedLength);
  const expectedPrefix = expected.slice(0, comparedLength);
  const quality = editSimilarity(observedPrefix, expectedPrefix);
  const coverage = Math.min(1, observed.length / Math.max(6, expected.length * 0.5));
  return { quality, coverage };
}

export class PrefixFuzzyMatcher implements ScriptMatcher {
  constructor(private readonly config: MatcherConfig = defaultMatcherConfig) {}

  match(hypothesis: StreamingHypothesis, segment: ScriptSegment, context: ScriptContext): MatchResult {
    const observed = normalizeKorean(hypothesis.text);
    let bestExpected = "";
    let bestPrefixScore = 0;
    let bestCoverage = 0;

    for (const text of segment.matchText) {
      const expected = normalizeKorean(text);
      const evidence = prefixEvidence(observed, expected);
      const score = evidence.quality * (0.55 + evidence.coverage * 0.45);
      if (score > bestPrefixScore) {
        bestPrefixScore = score;
        bestCoverage = evidence.coverage;
        bestExpected = expected;
      }
    }

    const scriptPrior = context.mode === "NORMAL"
      ? Math.max(0.25, 1 - context.candidateOffset * 0.18)
      : context.mode === "RESYNC"
        ? Math.max(0.65, 0.85 - context.candidateOffset * 0.03)
        : 0.5;
    const weights = this.config.weights;
    const score =
      scriptPrior * weights.scriptPrior +
      bestPrefixScore * weights.prefixMatch +
      Math.max(0, Math.min(1, hypothesis.confidence)) * weights.asrConfidence +
      (hypothesis.speechActive ? 1 : 0) * weights.speechOnset;
    const isExactShortUtterance = observed.length >= 2 && observed === bestExpected;
    const eligible = observed.length >= this.config.minimumEvidenceCharacters || isExactShortUtterance;

    return {
      segmentId: segment.id,
      score,
      prefixScore: bestPrefixScore,
      coverage: bestCoverage,
      observed,
      expected: bestExpected,
      eligible: eligible && score >= this.config.triggerThreshold
    };
  }
}
