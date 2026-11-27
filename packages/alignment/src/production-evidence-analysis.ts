import { parseProductionPackageDraft, type ScriptSegment, type TrackingKind } from "@stage/script-schema";
import { normalizeKorean, type StreamingHypothesis } from "./index";
import { DiscriminativeWordMatcher } from "./discriminative-word-matcher";

export interface PrefixProbe {
  prefix: string;
  /** Existing matcher decision on synthetic exact text, NOT acoustic performance. */
  matcherAccepted: boolean;
  earlyEvidence: boolean;
  reason: string | null;
  exactNearbyCueIds: string[];
  /** Orthographic Hangul jamo neighbor; not a phoneme or probability estimate. */
  jamoNearbyCueIds: string[];
}
export interface AlternativeEvidence {
  sourceIndex: number;
  normalizedLength: number;
  exactRepeatCueIds: string[];
  nearbyRepeatCueIds: string[];
  prefixProbes: PrefixProbe[];
  recommendation: "EARLY_CANDIDATE" | "WAIT_FOR_MORE" | "REVIEW_REPEAT" | "REVIEW_JAMO" | "REVIEW_NO_EVIDENCE" | "REVIEW_UNSUPPORTED_LOCALE";
}
export interface CueEvidence {
  cueId: string;
  actId: string;
  frameId?: string;
  kind: TrackingKind;
  alternatives: AlternativeEvidence[];
}
export interface ProductionEvidenceReport {
  version: 1;
  productionId: string;
  revisionId: string;
  evidenceBasis: "SCRIPT_ONLY_SYNTHETIC";
  acousticValidated: false;
  cues: CueEvidence[];
  manualFrameIds: string[];
  speechFrameIds: string[];
}

const HANGUL = /^[가-힣]+$/;
const koreanLocale = (locale: string) => /^ko(?:[-_]|$)/i.test(locale);
function firstWord(text: string): string {
  return normalizeKorean(text.normalize("NFC").split(/[\s.,!?…~\-—_:;"'“”‘’()[\]{}<>/\\|·]+/).find(Boolean) ?? "");
}
function jamoSlots(syllable: string): number[] {
  const code = syllable.charCodeAt(0) - 0xac00;
  return [Math.floor(code / 588), Math.floor((code % 588) / 28), code % 28];
}
/** Same-length Hangul substrings differing in exactly one onset/vowel/coda slot.
 * Deliberately narrow spelling heuristic; no pronunciation rules or audio claims. */
function containsOneJamoNeighbor(text: string, prefix: string): boolean {
  if (!HANGUL.test(prefix)) return false;
  const target = [...prefix].map(jamoSlots);
  for (let i = 0; i <= text.length - prefix.length; i++) {
    const slice = text.slice(i, i + prefix.length);
    if (slice === prefix || !HANGUL.test(slice)) continue;
    let differences = 0;
    for (let j = 0; j < slice.length && differences <= 1; j++) {
      const slots = jamoSlots(slice[j]!);
      for (let k = 0; k < 3; k++) if (slots[k] !== target[j]![k]) differences++;
    }
    if (differences === 1) return true;
  }
  return false;
}

/** Offline authoring diagnostic. No timestamps, recordings, learned cue profiles,
 * synthetic confidence, or automatic promotion. Use the exact existing matcher
 * on short synthetic prefixes with the same +/-3 act context as the preview.
 * Report spelling collisions separately; do not alter live thresholds. */
export function analyzeProductionEvidence(input: unknown): ProductionEvidenceReport {
  const p = parseProductionPackageDraft(input);
  const korean = koreanLocale(p.locale);
  const cues: CueEvidence[] = [];
  for (const act of p.acts) {
    const tracking = p.trackingCues.filter(c => c.actId === act.id);
    const segments: ScriptSegment[] = tracking.map((c, order) => ({
      id: c.id, order, type: c.kind === "LYRIC" ? "SOLO" : "CAPTION", captions: [], matchText: [...c.matchText],
    }));
    const normalized = segments.map(s => s.matchText.map(normalizeKorean));
    const occurrences = new Map<string, Set<string>>();
    segments.forEach((s, i) => normalized[i]!.forEach(text => {
      if (!text) return;
      const ids = occurrences.get(text) ?? new Set<string>();
      ids.add(s.id); occurrences.set(text, ids);
    }));
    const matcher = new DiscriminativeWordMatcher();
    tracking.forEach((cue, i) => {
      const segment = segments[i]!;
      const lo = Math.max(0, i - 3), hi = Math.min(segments.length, i + 4);
      const nearby = segments.slice(lo, hi);
      const others = nearby.filter(s => s.id !== cue.id);
      const nearbyIds = new Set(others.map(s => s.id));
      const alternatives: AlternativeEvidence[] = cue.matchText.map((source, sourceIndex) => {
        const expected = normalized[i]![sourceIndex]!;
        const repeats = [...(occurrences.get(expected) ?? [])].filter(id => id !== cue.id);
        const nearbyRepeats = repeats.filter(id => nearbyIds.has(id));
        const word = firstWord(source);
        const probes: PrefixProbe[] = [];
        if (korean && HANGUL.test(word) && expected.startsWith(word) && expected.length >= 4) {
          for (const length of [2, 3]) {
            if (word.length < length) continue;
            const prefix = word.slice(0, length);
            const hypothesis: StreamingHypothesis = { text: prefix, confidence: null, confidenceBasis: "unavailable",
              speechActive: true, isFinal: false, receivedAt: 0 };
            const result = matcher.match(hypothesis, segment, { candidateOffset: 0, mode: "NORMAL", operatingMode: "PERFORMANCE_LOCAL",
              rawTranscript: prefix, normalizedTranscript: prefix, normalizedOffset: 0, nearbySegments: nearby });
            probes.push({ prefix, matcherAccepted: result.eligible && result.expected === expected,
              earlyEvidence: result.eligible && result.expected === expected && Boolean(result.earlyEvidence), reason: result.reason ?? null,
              exactNearbyCueIds: others.filter(s => s.matchText.some(t => normalizeKorean(t).includes(prefix))).map(s => s.id),
              jamoNearbyCueIds: others.filter(s => s.matchText.some(t => containsOneJamoNeighbor(normalizeKorean(t), prefix))).map(s => s.id) });
          }
        }
        const accepted = probes.filter(v => v.earlyEvidence && !v.exactNearbyCueIds.length);
        const recommendation: AlternativeEvidence["recommendation"] =
          !expected ? "REVIEW_NO_EVIDENCE" :
          !korean ? "REVIEW_UNSUPPORTED_LOCALE" :
          repeats.length ? "REVIEW_REPEAT" :
          accepted.some(v => !v.jamoNearbyCueIds.length) ? "EARLY_CANDIDATE" :
          accepted.length ? "REVIEW_JAMO" :
          "WAIT_FOR_MORE";
        return { sourceIndex, normalizedLength: expected.length, exactRepeatCueIds: repeats,
          nearbyRepeatCueIds: nearbyRepeats, prefixProbes: probes, recommendation };
      });
      cues.push({ cueId: cue.id, actId: cue.actId, ...(cue.frameId === undefined ? {} : { frameId: cue.frameId }), kind: cue.kind, alternatives });
    });
  }
  return { version: 1, productionId: p.productionId, revisionId: p.revisionId,
    evidenceBasis: "SCRIPT_ONLY_SYNTHETIC", acousticValidated: false, cues,
    manualFrameIds: p.frames.filter(f => f.trigger.kind === "MANUAL").map(f => f.id),
    speechFrameIds: p.frames.filter(f => f.trigger.kind === "SPEECH").map(f => f.id) };
}
