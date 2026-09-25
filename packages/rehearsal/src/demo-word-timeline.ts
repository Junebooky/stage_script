import type { PerformanceScript } from "@stage/script-schema";
import { localMatch } from "./alignment";

export interface RawTimedWord { word: string; start: number; end: number }

// Unlike the LIVE normalizer, preserve lyric tokens such as 그/이. These are
// meaningful at a sung cue onset even when the live matcher treats them as filler.
const lyricText = (text: string) => text.normalize("NFC").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");

/** Offline presentation choreography from ORIGINAL word times, not a live
 * matcher, not human ground truth, and never a champion/fallback profile.
 * Fail closed when any cue is missing or boundaries cannot be ordered. */
export function buildWordDemoCues(script: PerformanceScript, words: RawTimedWord[], durationMs: number) {
  if (!words.length || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Missing word timeline");
  let cursor = 0;
  const ranges = words.map((word, index) => {
    if (typeof word.word !== "string" || !lyricText(word.word) || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
      word.start < 0 || word.end < word.start || word.end * 1000 > durationMs + 1 || (index > 0 && word.end < words[index - 1]!.end)) throw new Error("Invalid raw word timeline");
    const start = cursor;
    cursor += lyricText(word.word).length;
    return { start, end: cursor };
  });
  const observed = words.map((word) => lyricText(word.word)).join("");
  let floor = 0, previousOnset = -1;
  return script.segments.map((cue) => {
    const match = cue.matchText.map((text) => localMatch(lyricText(text), observed.slice(floor)))
      .sort((a, b) => b.score - a.score)[0];
    if (!match || match.score < 0.7 || !match.anchor) throw new Error(`Missing trustworthy text alignment: ${cue.id}`);
    const start = floor + match.start, end = floor + match.end;
    const first = ranges.findIndex((range) => range.end > start);
    const last = ranges.findIndex((range) => range.end >= end);
    if (first < 0 || last < first) throw new Error(`Missing word boundaries: ${cue.id}`);
    const onset = words[first]!.start * 1000;
    if (onset <= previousOnset) throw new Error(`Unordered cue boundaries: ${cue.id}`);
    const warnings = ["ASR word estimate; independent audio onset review required."];
    if (match.score < 1) warnings.push("Canonical/ASR text differs; canonical is unchanged.");
    if (start > floor) warnings.push("Unassigned preceding ASR characters; review onset attribution.");
    if (first > 0 && words[first]!.start < words[first - 1]!.end) warnings.push("Raw word overlaps the preceding word; timestamps retained without correction.");
    previousOnset = onset;
    floor = ranges[last]!.end;
    return { cueId: cue.id, referenceStartMs: Math.round(onset * 1000) / 1000,
      referenceEndMs: Math.round(words[last]!.end * 1e6) / 1000, timingBasis: "raw-asr-word-estimate" as const,
      firstWordIndex: first, lastWordIndex: last, matchScore: match.score, humanConfirmed: false, warnings };
  });
}
