import { availableConfidence, editSimilarity, normalizeKorean, PrefixFuzzyMatcher, type MatchResult, type ScriptContext, type ScriptMatcher, type StreamingHypothesis } from "./index";
import type { ScriptSegment } from "@stage/script-schema";

/** Common short deictics/pronouns are not standalone identification evidence. */
const WEAK_SINGLE_WORDS = new Set(["우리", "너희", "저희", "나는", "너는", "저는", "내가", "네가", "이것", "그것", "저것"]);
const FUNCTION_WORDS = new Set([...WEAK_SINGLE_WORDS, "그", "이", "저", "내", "네", "나", "너", "음", "어", "아", "저기", "뭐랄까", "그리고", "그러나", "하지만", "그래서", "또한", "또는", "그런데", "그러면", "그러니", "그러므로", "그렇지만", "따라서", "그래도", "그럼", "이제", "다시"]);
const splitWords = (raw: string) => raw.normalize("NFC").toLocaleLowerCase("ko-KR")
  .replace(/[.,!?…~\-—_:;"'“”‘’()[\]{}<>/\\|·]/g, " ").split(/\s+/).filter(Boolean);

function words(raw: string) {
  let offset = 0;
  return raw.normalize("NFC").toLocaleLowerCase("ko-KR")
    .replace(/[.,!?…~\-—_:;"'“”‘’()[\]{}<>/\\|·]/g, " ").split(/\s+/)
    .map(normalizeKorean).filter(Boolean).map((text) => {
      const start = offset; offset += text.length;
      return { text, start, end: offset };
    });
}

/** Production leading-token evidence, shared by live partials and saved input.
 * No timing, reference, cue IDs, recording names, ASR corrections or profile
 * learning are used. Only the ordered next candidate can take this path.
 * Nearby cues are negative examples (including previous lyric tails), never
 * selectable runner-ups. Distant repeats rely on the existing ordered cursor.
 */
export class DiscriminativeWordMatcher implements ScriptMatcher {
  private readonly baseline = new PrefixFuzzyMatcher();
  private readonly canonical = new WeakMap<ScriptSegment, { expected: string; leading: string; weak: boolean }[]>();
  private raw = "";
  private rawWords: ReturnType<typeof words> = [];

  private sources(segment: ScriptSegment) {
    let sources = this.canonical.get(segment);
    if (!sources) {
      sources = segment.matchText.map((source) => {
        const first = splitWords(source)[0] ?? "";
        return { expected: normalizeKorean(source), leading: normalizeKorean(first), weak: FUNCTION_WORDS.has(first) };
      });
      this.canonical.set(segment, sources);
    }
    return sources;
  }

  private leadingEvidence(hypothesis: StreamingHypothesis, segment: ScriptSegment, context: ScriptContext): MatchResult | null {
    if (context.operatingMode !== "PERFORMANCE_LOCAL" || context.mode !== "NORMAL" || context.candidateOffset !== 0 ||
      !hypothesis.speechActive || segment.type === "IMAGE" || context.rawTranscript === undefined || !context.nearbySegments) return null;
    const offset = context.normalizedOffset ?? 0;
    const normalized = context.normalizedTranscript ?? normalizeKorean(context.rawTranscript);
    const observed = normalized.slice(offset);
    if (observed !== (context.normalizedTranscript === undefined ? normalizeKorean(hypothesis.text) : hypothesis.text)) return null;
    if (this.raw !== context.rawTranscript) { this.raw = context.rawTranscript; this.rawWords = words(this.raw); }
    const others = context.nearbySegments.filter((cue) => cue.id !== segment.id)
      .flatMap((cue) => this.sources(cue).map(({ expected }) => ({ cueId: cue.id, text: expected })));
    for (const source of this.sources(segment)) {
      // Function-word openings and authored tiny cues keep their original gates.
      if (source.weak || source.expected.length < 4 || source.leading.length < 2) continue;
      for (const token of this.rawWords) {
        // Do not cut an observed word or reuse a word already consumed by cursor.
        if (token.start < offset || !/^[가-힣]{2,}$/.test(token.text) || FUNCTION_WORDS.has(token.text) || !source.leading.startsWith(token.text)) continue;
        let competitor: MatchResult["competitor"] = null;
        for (const other of others) {
          let score = 0;
          for (let start = 0; start < other.text.length; start++) score = Math.max(score, editSimilarity(token.text, other.text.slice(start, start + token.text.length)));
          if (!competitor || score > competitor.score) competitor = { cueId: other.cueId, score };
        }
        const margin = 1 - (competitor?.score ?? 0);
        if (margin < 1 / 3 - 1e-9) continue;
        // Text 0.50 + position-weighted anchor 0.15 + sequence 0.15 +
        // speech 0.05. Leading position gets 1.5x, other positions stay baseline.
        // Missing native confidence is excluded, never synthesized.
        const positionWeight = 1.5;
        const asr = availableConfidence(hypothesis.confidence);
        const score = Math.min(1, asr === null ? (0.5 + 0.15 * positionWeight + 0.15 + 0.05) / 0.85
          : 0.5 + 0.15 * positionWeight + 0.15 + 0.05 + 0.15 * asr);
        const threshold = Math.max(0.72, context.profile?.thresholds.text ?? 0.82);
        if (score < threshold) continue;
        return { segmentId: segment.id, observed, expected: source.expected, score, prefixScore: 1,
          coverage: token.text.length / source.expected.length, start: token.start - offset, end: token.end - offset,
          eligible: true, fast: true, selectedAnchor: token.text, competitor,
          reason: "leading-discriminative-prefix", earlyEvidence: { positionWeight, margin, threshold },
          components: { text: 1, anchor: 1, sequence: 1, speech: 1, timing: 0, asr } };
      }
    }
    return null;
  }

  match(hypothesis: StreamingHypothesis, segment: ScriptSegment, context: ScriptContext): MatchResult {
    const observed = context.normalizedTranscript?.slice(context.normalizedOffset ?? 0) ?? normalizeKorean(hypothesis.text);
    // Preserve established full/strong evidence (and its consumed range). The
    // new two/three-syllable hot path never pays for baseline fuzzy scanning.
    let baseline = observed.length >= 4 ? this.baseline.match(hypothesis, segment, context) : null;
    if (baseline?.eligible && context.operatingMode === "PERFORMANCE_LOCAL" && this.sources(segment).some((source) =>
      source.weak && source.expected === baseline!.expected && source.leading === observed && observed !== source.expected)) {
      return { ...baseline, eligible: false, fast: false, reason: "function-word-awaiting-evidence" };
    }
    if (baseline?.eligible) return baseline;
    const leading = this.leadingEvidence(hypothesis, segment, context);
    if (leading) return leading;
    baseline ??= this.baseline.match(hypothesis, segment, context);
    if (baseline.eligible || context.operatingMode !== "PERFORMANCE_LOCAL" || context.mode !== "NORMAL" || context.candidateOffset !== 0 ||
      !hypothesis.speechActive || segment.type === "IMAGE" || hypothesis.evidenceBasis !== "saved-completed-words" || context.rawTranscript === undefined || !context.nearbySegments) return baseline;
    const offset = context.normalizedOffset ?? 0;
    const tokens = words(context.rawTranscript).filter((word) => word.start >= offset);
    // Reject inconsistent provenance/boundaries instead of matching a cut word.
    if (normalizeKorean(context.rawTranscript).slice(offset) !== normalizeKorean(hypothesis.text)) return baseline;
    const others = (context.nearbySegments ?? []).filter((cue) => cue.id !== segment.id)
      .flatMap((cue) => cue.matchText.map((text) => ({ cueId: cue.id, text: normalizeKorean(text) })));
    let rejection: MatchResult | null = null;
    // Shortest complete observed token sequence first. The engine still owns
    // consumed evidence and rejects anchors in the previous cue's continuation.
    for (let count = 1; count <= 2; count++) {
      for (let first = 0; first + count <= tokens.length; first++) {
        const selected = tokens.slice(first, first + count);
        const anchor = selected.map((token) => token.text).join("");
        if (anchor.length < 2 || (count === 1 && FUNCTION_WORDS.has(anchor))) continue;
        for (const source of segment.matchText) {
          const expected = normalizeKorean(source);
          if (expected.length < 4) continue; // Preserve the native-confidence gate for authored tiny cues.
          const prefix = expected.startsWith(anchor);
          // An internal recovery needs two words / >=3 syllables and an authored
          // word boundary. A single generic internal word cannot trigger early.
          const internal = count === 2 && anchor.length >= 3 && words(source).some((token) => expected.slice(token.start).startsWith(anchor));
          if (!prefix && !internal) continue;
          let competitor: MatchResult["competitor"] = null;
          for (const other of others) {
            let score = 0;
            for (let start = 0; start < other.text.length; start++) {
              score = Math.max(score, editSimilarity(anchor, other.text.slice(start, start + anchor.length)));
            }
            if (!competitor || score > competitor.score) competitor = { cueId: other.cueId, score };
          }
          // Exact candidate evidence only. At least one-third edit-distance
          // margin to EVERY nearby lyric fragment; shared openings must wait.
          const distinctive = 1 - (competitor?.score ?? 0) >= 1 / 3 - 1e-9;
          const result: MatchResult = { segmentId: segment.id, observed: normalizeKorean(hypothesis.text), expected,
            score: 1, prefixScore: 1, coverage: anchor.length / expected.length,
            start: selected[0]!.start - offset, end: selected.at(-1)!.end - offset,
            eligible: distinctive, fast: distinctive, selectedAnchor: anchor, competitor,
            reason: distinctive ? prefix ? "unique-completed-word-prefix" : "unique-two-word-internal" : "ambiguous-short-evidence",
            components: { text: 1, anchor: 1, sequence: 1, timing: 0, asr: hypothesis.confidence, speech: 1 } };
          if (distinctive) return result;
          rejection = result;
        }
      }
    }
    return rejection ?? baseline;
  }
}
