import { describe, expect, it } from "vitest";
import { loadProductionCatalog, requireCanonical } from "@stage/script-schema/production";
import { flattenShow, parseCueProfiles, parseShow } from "@stage/script-schema";
import { normalizeKorean } from "@stage/alignment";
import { ScriptFollowingEngine } from "@stage/script-engine";
import { analyzeNumberRehearsal, buildASRBenchmark, formatASRBenchmarkReport, buildCueProfiles, canonicalFingerprint, compareCandidate, confirmObservation, type TimestampedASR } from "./index";

// Authoritative real script + SYNTHETIC observations. Not an acoustic benchmark.
const catalog = loadProductionCatalog();
const show = requireCanonical(catalog);
const numberId = catalog.defaultNumberId;
const script = flattenShow(show);
const cues = script.segments;
const id = (index: number) => cues[index]!.id;
function transcript(indexes = cues.map((_, index) => index)): TimestampedASR[] {
  return indexes.map((index, occurrence) => {
    const text = cues[index]!.captions[0]!.text;
    const startMs = 1000 + occurrence * 2000;
    const words = text.split(" ").map((text, word) => ({ text, startMs: startMs + word * 80, endMs: startMs + (word + 1) * 80, confidence: 0.99 }));
    return { id: `synthetic-${occurrence}`, text, startMs, endMs: words.at(-1)!.endMs, confidence: 0.99, words };
  });
}
function analyze(input = transcript()) { return analyzeNumberRehearsal(show, numberId, input, { rehearsalId: "synthetic-not-real-audio", now: 0 }); }
function engine() { const result = new ScriptFollowingEngine(script, undefined, { operatingMode: "PERFORMANCE_LOCAL" }); result.arm(); return result; }
function speak(runtime: ScriptFollowingEngine, text: string, at: number, utteranceId = `speech-${at}`) {
  runtime.speechStart(at);
  return runtime.processHypothesis({ text, receivedAt: at + 1, utteranceId, isFinal: false, speechActive: true, confidence: 0.99 });
}

describe("M05-2 canonical foundation", () => {
  it("is the sole default real dataset, with 36 immutable canonical cues and unique stable IDs", () => {
    expect(catalog.defaultNumberId).toBe("M05-2");
    expect(catalog.datasets).toHaveLength(1);
    expect(cues).toHaveLength(36);
    expect(cues.map((cue) => cue.id)).toEqual(Array.from({ length: 36 }, (_, index) => `M05-2_C${String(index + 1).padStart(3, "0")}`));
    expect(cues[0]!.captions[0]!.text).toBe("창가로 스며드는 외로운 저 달빛");
    expect(cues[13]!.captions[0]!.text).toBe("그렇고 말고, 이제 선생님 말고 이모라 불러.");
    expect(cues.at(-1)!.captions[0]!.text).toBe("창가로 스며드는 운명의 별이여");
    expect(cues.every((cue) => cue.type !== "IMAGE")).toBe(true);
  });
  it("preserves sung → spoken → sung, shared duet/chorus and distinct repeated occurrences", () => {
    expect(cues.map((cue) => cue.metadata?.delivery)).toEqual([...Array(8).fill("sung"), ...Array(9).fill("spoken"), ...Array(19).fill("sung")]);
    expect(cues[34]!.metadata?.ensemble).toBe("duet");
    expect(cues[34]!.captions).toHaveLength(1); // Shared lyric, not invented simultaneous different words.
    expect(cues[29]!.type).toBe("CHORUS");
    expect(cues[17]!.metadata?.repeatOccurrence).toBe(2);
    expect(cues[0]!.metadata?.repeatGroup).toBe(cues[17]!.metadata?.repeatGroup);
  });
  it("never accepts audio/ASR as missing canonical material", () => {
    expect(() => requireCanonical(catalog, "M06")).toThrow("CANONICAL SCRIPT REQUIRED");
    expect(() => analyzeNumberRehearsal(show, "M06", transcript(), { rehearsalId: "x" })).toThrow("CANONICAL SCRIPT REQUIRED");
    expect(parseShow(show)).toEqual(show);
  });
});

describe("known-number local rehearsal alignment", () => {
  it("aligns both complete passes in order without global number detection or canonical writes", () => {
    const before = JSON.stringify(show), fingerprint = canonicalFingerprint(show);
    const result = analyze();
    expect(result.alignmentMode).toBe("known-number-local");
    expect(result.observations.map((item) => item.cueId)).toEqual(cues.map((cue) => cue.id));
    expect(result.skippedCueIds).toEqual([]);
    expect(result.observations[0]!.repetition?.resolvedBy).toBe("sequence-context");
    expect(result.observations[17]!.repetition?.resolvedBy).toBe("sequence-context");
    expect(result.reviewQueue).toEqual([]);
    expect(JSON.stringify(show)).toBe(before);
    expect(canonicalFingerprint(show)).toBe(fingerprint);
  });
  it("marks an isolated repeated opening ambiguous instead of inventing its occurrence", () => {
    const result = analyze(transcript([0, 1, 2, 3]));
    expect(result.observations.every((item) => item.reviewStatus === "review-required")).toBe(true);
    expect(result.reviewQueue.length).toBeGreaterThanOrEqual(4);
  });
  it("uses following unique context to recognize a recording starting at the second pass", () => {
    const result = analyze(transcript([17, 18, 19, 20, 21, 22]));
    expect(result.observations.map((item) => item.cueId)).toEqual([17, 18, 19, 20, 21, 22].map(id));
    expect(result.observations[0]!.repetition?.resolvedBy).toBe("sequence-context");
  });
  it("allows offline skips, omitted dialogue and local restarts", () => {
    const indexes = [4, 5, 6, 7, 17, 18, 19, 20, 21, 22, 4, 5, 6];
    expect(analyze(transcript(indexes)).observations.map((item) => item.cueId)).toEqual(indexes.map(id));
  });
  it("separates multiple cues inside one ASR segment", () => {
    const pieces = transcript([4, 5]);
    const merged = { ...pieces[0]!, text: pieces.map((item) => item.text).join(" "), endMs: pieces[1]!.endMs, words: pieces.flatMap((item) => item.words!) };
    expect(analyze([merged]).observations.map((item) => item.cueId)).toEqual([id(4), id(5)]);
  });
  it("keeps unknown speech unmatched and rejects invalid timestamp/word ordering", () => {
    const noise = { id: "noise", text: "오늘 점심 메뉴는 김치볶음밥 입니다", startMs: 0, endMs: 1000, confidence: 0.95 };
    expect(analyze([noise]).observations).toEqual([]);
    expect(analyze([noise]).reviewQueue[0]!.reason).toContain("UNMATCHED_SPEECH");
    expect(() => analyze([{ ...noise, endMs: -1 }])).toThrow("Invalid timestamped ASR");
    expect(() => analyze([{ ...noise, words: [{ text: "오늘", startMs: 2000, endMs: 2500, confidence: 1 }] }])).toThrow("Invalid ASR word ordering");
  });
  it("does not present interpolated span timing as measured latency or a timing sample", () => {
    const result = analyze(transcript([4, 5]).map(({ words: _, ...span }) => span));
    expect(result.reviewQueue).toHaveLength(2);
    expect(result.observations.every((item) => !item.timingReliable)).toBe(true);
    const comparison = compareCandidate(show, result);
    expect(comparison.baseline.metrics.latencyP50Ms).toBeNull();
    expect(comparison.profiles.every((profile) => profile.timing.sampleCount === 0)).toBe(true);
    const confirmed = confirmObservation(result, result.observations[0]!.id, { startMs: 1000, endMs: 1400, reviewer: "human-test" });
    expect(confirmed.observations[0]!.timingBasis).toBe("human-confirmed");
  });
  it("produces one-recording candidates, collision metadata and no champion/fallback", () => {
    const result = analyze(), profiles = buildCueProfiles(show, [result], { fallbackEnabledCueIds: cues.map((cue) => cue.id) });
    expect(profiles.every((profile) => profile.sampleCount === 1 && profile.status === "candidate" && !profile.fallback.enabled && !profile.timing.distributionReady)).toBe(true);
    expect(profiles[0]!.anchors.some((anchor) => anchor.competingCueIds?.includes(id(17)) && anchor.repetitionRisk === 1)).toBe(true);
    expect(parseCueProfiles(profiles)).toEqual(profiles);
    const comparison = compareCandidate(show, result);
    expect(comparison.sampleCount).toBe(1);
    expect(comparison.promotion.recommended).toBe(false);
    expect(comparison.baseline.metrics.wrongTriggers).toBe(0);
    expect(comparison.baseline.triggers.map((item) => item.cueId)).toEqual(cues.map((cue) => cue.id));
    expect(comparison.baseline.repeatedLyricConfusions).toBe(0);
  });
});

describe("M05-2 live conservative interim matching", () => {
  for (const [name, text] of [
    ["complete opening", "창가로 스며드는 외로운 저 달빛"],
    ["missing first syllable", "가로 스며드는 외로운 저 달빛"],
    ["missing first word", "스며드는 외로운 저 달빛"],
    ["internal-only evidence", "외로운 저 달빛"],
    ["mangled stretched opening", "차아아앙가르 스며드는 외로운 저 달빛"],
  ]) it(`handles ${name} without waiting for a final result`, () => {
    expect(speak(engine(), text!, 100).currentSegment?.id).toBe(id(0));
  });
  it("rejects two syllables, unrelated speech, and a shared short phrase", () => {
    for (const text of ["창가", "그대", "이 밤", "점심을 먹으러 식당으로 가요"]) {
      const result = speak(engine(), text, 100);
      expect(result.currentSegment).toBeNull();
      expect(result.phase).toBe(normalizeKorean(text).length < 4 ? "MATCHING" : "UNMATCHED_SPEECH");
    }
  });
  it("advances all 36 ordered cues, never jumps from first to second repetition, and completes", () => {
    const runtime = engine();
    cues.forEach((cue, index) => {
      const result = speak(runtime, cue.captions[0]!.text, index * 2000 + 100);
      expect(result.currentSegment?.id, cue.id).toBe(cue.id);
      expect(result.lastTrigger?.source).toBe("automatic");
      runtime.speechEnd();
    });
    expect(runtime.finish().finished).toBe(true);
    expect(runtime.snapshot().completedIndexes).toHaveLength(36);
  });
  it("manual NEXT/PREV/JUMP/HOLD/RESYNC fence stale recognition without changing canonical", () => {
    const runtime = engine();
    speak(runtime, cues[0]!.captions[0]!.text, 100, "old");
    runtime.manualNext(200);
    expect(runtime.processHypothesis({ text: cues[2]!.captions[0]!.text, utteranceId: "old", receivedAt: 150, confidence: 1, speechActive: true }).currentSegment?.id).toBe(id(1));
    runtime.manualPrevious(300);
    expect(runtime.snapshot().currentSegment?.id).toBe(id(0));
    runtime.jumpTo(17, 400);
    expect(runtime.snapshot().currentSegment?.id).toBe(id(17));
    runtime.setHold(true, 500);
    expect(speak(runtime, cues[18]!.captions[0]!.text, 600).currentSegment?.id).toBe(id(17));
    runtime.setHold(false, 700);
    runtime.forceResync(800);
    expect(speak(runtime, cues[18]!.captions[0]!.text, 900).currentSegment?.id).toBe(id(18));
    expect(runtime.exportTelemetry().some((event) => event.event === "hold")).toBe(true);
    expect(normalizeKorean(cues[17]!.captions[0]!.text)).toBe(normalizeKorean(cues[0]!.captions[0]!.text));
  });
});

describe("Groq-compatible missing acoustic confidence (synthetic, not real audio)", () => {
  function missingConfidence(): TimestampedASR[] {
    return transcript().map((span) => ({ ...span, confidence: null, confidenceBasis: "unavailable",
      words: span.words!.map((word) => ({ ...word, confidence: null, confidenceBasis: "unavailable" })) }));
  }
  it("retains null evidence through alignment and replay without rewriting canonical", () => {
    const before = JSON.stringify(show);
    const result = analyze(missingConfidence());
    expect(result.observations.map((item) => item.cueId)).toEqual(cues.map((cue) => cue.id));
    expect(result.observations.every((item) => item.asrConfidence === null && item.asrConfidenceBasis === "unavailable"
      && item.alignmentEvidenceBasis === "text-sequence-only" && item.groundTruth === "pseudo")).toBe(true);
    const replay = compareCandidate(show, result);
    expect(replay.baseline.triggers.map((item) => item.cueId)).toEqual(cues.map((cue) => cue.id));
    expect(result.transcript.flatMap((span) => span.words!).every((word) => word.confidence === null)).toBe(true);
    expect(replay.profiles.every((profile) => profile.status === "candidate" && !profile.fallback.enabled)).toBe(true);
    expect(JSON.stringify(show)).toBe(before);
  });
  it("rejects contradictory confidence provenance and reviews weak derived acoustic evidence", () => {
    const span = transcript([4])[0]!;
    expect(() => analyze([{ ...span, confidence: null, confidenceBasis: "provider-native" }])).toThrow("Missing ASR confidence");
    expect(() => analyze([{ ...span, confidenceBasis: "unavailable" }])).toThrow("Unavailable ASR confidence");
    for (const evidence of [{ confidence: 0.2, providerMetadata: { avg_logprob: Math.log(0.2) } },
      { confidence: 0.95, providerMetadata: { no_speech_prob: 0.9 } }]) {
      const result = analyze([{ ...span, ...evidence, confidenceBasis: "segment-logprob-derived" }]);
      expect(result.observations[0]!.reviewStatus).toBe("review-required");
      expect(result.observations[0]!.timingReliable).toBe(false);
      expect(result.reviewQueue).toHaveLength(1);
    }
  });
  it("reports same-input identity and all 22 sections without inventing real accuracy or live latency", () => {
    const result = analyzeNumberRehearsal(show, numberId, missingConfidence(), {
      rehearsalId: "synthetic-groq-benchmark", asrProvider: "groq", model: "whisper-large-v3", timestampBasis: "cloud-asr-pseudo", now: 0 });
    const report = buildASRBenchmark(show, result, { provider: "groq/whisper-large-v3", model: "whisper-large-v3",
      audioSha256: "synthetic-audio-identity", transcriptionWallTimeMs: 1234 }, { synthetic: true }, compareCandidate(show, result));
    expect(report.canonicalCueCount).toBe(36);
    expect(report.alignedCueCount).toBe(36);
    expect(report.canonicalCueCoverage).toBe(1);
    expect(report.repeatedLyrics.map((row) => row.cueId)).toEqual([0, 1, 2, 3, 17, 18, 19, 20].map(id));
    expect(report.transitions.map((transition) => transition.sections)).toEqual(["A → B", "B → C"]);
    expect(report.wordConfidence.unavailable).toBe(report.wordCount);
    expect(report.wordConfidence.native).toBe(0);
    expect(report.liveLatency).toEqual({ measured: false, p50Ms: null, p95Ms: null, p99Ms: null });
    expect(report.transcriptQuality.wordErrorRate).toBeNull();
    expect(report.transcriptQuality.humanVerifiedWrongAlignmentCount).toBeNull();
    expect(report.audioSha256).toBe("synthetic-audio-identity");
    expect(report.productionReady).toBe(false);
    expect(formatASRBenchmarkReport(report).match(/^## \d+\./gm)).toHaveLength(22);
  });
  it("records zero matches and unmatched speech without generating a candidate", () => {
    const result = analyze([{ id: "noise", text: "오늘 점심 메뉴는 김치볶음밥 입니다", startMs: 0, endMs: 1000, confidence: null }]);
    const report = buildASRBenchmark(show, result, { provider: "groq/whisper-large-v3", audioSha256: "synthetic", transcriptionWallTimeMs: 100 }, {}, null);
    expect(report.alignedCueCount).toBe(0);
    expect(report.missedCueIds).toHaveLength(36);
    expect(report.unmatchedRegions).toHaveLength(1);
    expect(report.candidateProfile.generated).toBe(false);
  });
});
