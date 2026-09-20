import { editSimilarity, normalizeKorean, PrefixFuzzyMatcher, type MatchResult, type ScriptContext, type ScriptMatcher, type StreamingHypothesis } from "./index";
import type { ScriptSegment } from "@stage/script-schema";

/** Common short deictics/pronouns are not standalone identification evidence. */
const WEAK_SINGLE_WORDS = new Set(["우리", "너희", "저희", "나는", "너는", "저는", "내가", "네가", "이것", "그것", "저것"]);

function words(raw: string) {
  let offset = 0;
  return raw.normalize("NFC").toLocaleLowerCase("ko-KR")
    .replace(/[.,!?…~\-—_:;"'“”‘’()[\]{}<>/\\|·]/g, " ").split(/\s+/)
    .map(normalizeKorean).filter(Boolean).map((text) => {
      const start = offset; offset += text.length;
      return { text, start, end: offset };
    });
}

/** Opt-in saved COMPLETED-word policy. Baseline fuzzy thresholds are unchanged.
 * No timing, reference, cue IDs, recording names, ASR corrections or profile
 * learning are used. Only the ordered next candidate can take this path.
 * Nearby cues are negative examples (including previous lyric tails), never
 * selectable runner-ups. Distant repeats rely on the existing ordered cursor.
 */
export class DiscriminativeWordMatcher implements ScriptMatcher {
  private readonly baseline = new PrefixFuzzyMatcher();

  match(hypothesis: StreamingHypothesis, segment: ScriptSegment, context: ScriptContext): MatchResult {
    const baseline = this.baseline.match(hypothesis, segment, context);
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
        if (anchor.length < 2 || (count === 1 && WEAK_SINGLE_WORDS.has(anchor))) continue;
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
