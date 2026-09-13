import { describe, expect, it } from "vitest";
import { parseCueProfiles, type Cue, type Show } from "@stage/script-schema";
import { analyzeRehearsal, buildCueProfiles, confirmObservation, evaluateChallenger, evaluateTriggers, replayRehearsal } from "./index";
import type { CueObservation, TimestampedASR } from "./types";

const cue = (id: string, text: string, order: number): Cue => ({ id, type: "CAPTION", order,
  captions: [{ actor: "ACTOR", text }], matchText: [text] });
const show: Show = {
  id: "fixture-show", title: "Synthetic rehearsal fixture", locale: "ko-KR",
  acts: [
    { id: "act-1", title: "Act 1", numbers: [
      { id: "M01", title: "Opening", cues: [cue("c1", "가장 어려운 곳에 주님의 사랑이", 1), cue("c2", "우리의 노래는 하늘을 향해", 2)] },
      { id: "M02", title: "Skipped number", cues: [cue("c3", "꽃잎이 흩날리는 봄날", 3)] },
      { id: "M03", title: "Finale", cues: [cue("c4", "마지막 불빛을 따라 걸어가", 4)] },
    ] },
    { id: "act-2", title: "Act 2", numbers: [
      { id: "M04", title: "Return", cues: [cue("c5", "새로운 아침이 밝아 오네", 5), cue("c6", "내일의 우리를 기억해", 6)] },
    ] },
  ],
};
const segment = (id: string, text: string, startMs: number, duration = 1500): TimestampedASR => ({ id, text, startMs,
  endMs: startMs + duration, confidence: 0.99 });
const transcript: TimestampedASR[] = [
  segment("s1", "어려운 곳에 주님의 사랑이", 1000),
  segment("s2", "우리의 노래는 하늘을 향해", 5000),
  segment("s3", "마지막 불빛을 따라 걸어가", 9000),
  segment("s4", "가장 어려운 곳에 주님의 사랑이", 15000),
  segment("s5", "우리의 노래는 하늘을 향해", 19000),
  segment("s6", "새로운 아침이 밝아 오네", 900000),
  segment("s7", "내일의 우리를 기억해", 904000),
];

describe("whole-show rehearsal analysis", () => {
  it("globally finds musical numbers, permits number/cue skips and restart, then aligns local cues", () => {
    const result = analyzeRehearsal(show, transcript, { rehearsalId: "r1" });
    expect(result.observations.map((item) => item.cueId)).toEqual(["c1", "c2", "c4", "c1", "c2", "c5", "c6"]);
    expect(result.skippedCueIds).toEqual(["c3"]);
    expect(result.skippedNumberIds).toEqual(["M02"]);
    expect(result.numberRegions.map((region) => region.numberId)).toEqual(["M01", "M03", "M01", "M04"]);
    expect(result.numberRegions.map((region) => region.transition)).toEqual(["start", "skip", "restart", "skip"]);
    expect(result.observations[0]!.anchors[0]).toContain("어려운곳에");
  });

  it("never rewrites canonical captions and never learns intermission as relative timing", () => {
    const before = JSON.stringify(show);
    const result = analyzeRehearsal(show, transcript, { rehearsalId: "r1" });
    expect(JSON.stringify(show)).toBe(before);
    const act2 = result.observations.find((item) => item.cueId === "c5")!;
    expect(act2.relativeAfterPreviousMs).toBeNull();
    expect(act2.previousCueId).toBeNull();
    expect(result.observations.find((item) => item.cueId === "c6")!.relativeAfterPreviousMs).toBe(4000);
    expect(result.observations.every((item) => item.groundTruth === "pseudo")).toBe(true);
  });

  it("uses word timestamps rather than inventing word onsets from canonical text", () => {
    const result = analyzeRehearsal(show, [{ ...segment("s", "가장 어려운 곳에 주님의 사랑이", 1000), words: [
      { text: "가장", startMs: 1100, endMs: 1200, confidence: 0.99 },
      { text: "어려운 곳에 주님의 사랑이", startMs: 1800, endMs: 2300, confidence: 0.99 },
    ] }], { rehearsalId: "word-test" });
    expect(result.observations[0]!.startMs).toBe(1100);
    expect(result.observations[0]!.endMs).toBe(2300);
  });

  it("multiple canonical cues in one ASR segment retain distinct observed ranges", () => {
    const result = analyzeRehearsal(show, [segment("joined", "가장 어려운 곳에 주님의 사랑이 우리의 노래는 하늘을 향해", 1000, 8000)], { rehearsalId: "joined" });
    expect(result.observations.map((item) => item.cueId)).toEqual(["c1", "c2"]);
    expect(result.observations[1]!.startMs).toBeGreaterThan(result.observations[0]!.startMs);
  });

  it("repeated lyric collisions and unrelated speech go to a configurable review queue", () => {
    const repeated = structuredClone(show);
    repeated.acts[0]!.numbers[0]!.cues[1] = cue("c2", "가장 어려운 곳에 주님의 사랑이", 2);
    const result = analyzeRehearsal(repeated, [segment("a", "가장 어려운 곳에 주님의 사랑이", 0), segment("b", "조금 쉬었다가 다시 해볼까요", 4000)],
      { rehearsalId: "collision", warningThreshold: 0.8 });
    expect(result.reviewQueue.some((item) => item.reason === "Repeated lyric collision")).toBe(true);
    expect(result.reviewQueue.some((item) => item.reason.startsWith("Unmatched"))).toBe(true);
  });

  it("human confirmation is explicit, immutable and distinct from pseudo ground truth", () => {
    const result = analyzeRehearsal(show, transcript, { rehearsalId: "r1" });
    const reviewed = confirmObservation(result, result.observations[0]!.id, { startMs: 900, endMs: 2500, reviewer: "Stage manager" });
    expect(reviewed.observations[0]!.groundTruth).toBe("human");
    expect(result.observations[0]!.groundTruth).toBe("pseudo");
    expect(reviewed.observations[1]!.relativeAfterPreviousMs).toBe(4100);
    expect(() => confirmObservation(result, result.observations[0]!.id, { startMs: 0, endMs: 2, reviewer: " " })).toThrow();
  });

  it("rejects malformed timestamps and confidence configuration", () => {
    expect(() => analyzeRehearsal(show, [segment("bad", "bad", -1)], { rehearsalId: "r" })).toThrow();
    expect(() => analyzeRehearsal(show, transcript, { rehearsalId: "r", warningThreshold: 0.99, acceptedThreshold: 0.8 })).toThrow();
  });
});

describe("profiles and challenger calibration", () => {
  const histories = [0, 1, 2].map((index) => analyzeRehearsal(show, transcript, { rehearsalId: `r${index}` }));

  it("extracts reliable canonical anchors and relative distributions with fallback off by default", () => {
    const profiles = buildCueProfiles(show, histories);
    expect(parseCueProfiles(profiles)).toEqual(profiles);
    expect(profiles.find((item) => item.cueId === "c2")!.sampleCount).toBe(3);
    expect(profiles.find((item) => item.cueId === "c2")!.timing.medianAfterPreviousMs).toBe(4000);
    expect(profiles.every((item) => item.fallback.enabled === false)).toBe(true);
    expect(profiles.find((item) => item.cueId === "c5")!.timing.medianAfterPreviousMs).toBe(0);
    expect(profiles.find((item) => item.cueId === "c1")!.anchors.some((anchor) => anchor.text.includes("어려운"))).toBe(true);
  });

  it("requires explicit per-cue choice and independent rehearsal samples for fallback", () => {
    const enabled = buildCueProfiles(show, histories, { fallbackEnabledCueIds: ["c2"] });
    expect(enabled.find((item) => item.cueId === "c2")!.fallback.enabled).toBe(true);
    const insufficient = buildCueProfiles(show, [histories[0]!], { fallbackEnabledCueIds: ["c2"] });
    expect(insufficient.find((item) => item.cueId === "c2")!.fallback.enabled).toBe(false);
  });

  it("requires all histories and measurable improvement; analysis never promotes a champion", () => {
    const profiles = buildCueProfiles(show, histories);
    const before = JSON.stringify(profiles);
    const report = evaluateChallenger(show, histories, profiles, profiles);
    expect(report.replays).toHaveLength(3);
    expect(report.recommended).toBe(false);
    expect(report.reasons).toContain("No measurable improvement over the current champion");
    expect(report.policy.operatorConfirmationRequired).toBe(true);
    expect(report.evidence).toBe("pseudo");
    expect(JSON.stringify(profiles)).toBe(before);
    expect(evaluateChallenger(show, [histories[0]!], [], profiles).reasons.some((reason) => reason.includes("At least 3"))).toBe(true);
  });

  it("refuses profile learning against changed canonical show content", () => {
    const changed = structuredClone(show);
    changed.acts[0]!.numbers[0]!.cues[0]!.captions[0]!.text = "Changed by author";
    expect(() => buildCueProfiles(changed, histories)).toThrow(/canonical/);
  });

  it("replay actually runs conservative runtime and labels synthetic delivery timing", () => {
    const report = replayRehearsal(show, histories[0]!, []);
    expect(report.triggers.length).toBeGreaterThan(0);
    expect(report.metrics.timestampBasis).toBe("simulated-asr-delivery");
    expect(report.metrics.pseudoGroundTruthCues).toBeGreaterThan(0);
    expect(report.metrics.humanConfirmedCues).toBe(0);
    // Conservative live runtime cannot silently leap an intentionally omitted number.
    expect(report.metrics.missedCues).toBeGreaterThan(0);
  });
});

describe("honest replay metrics", () => {
  const observation = (cueId: string, startMs: number, extra: Partial<CueObservation> = {}): CueObservation => ({
    id: cueId, cueId, actId: "act-1", numberId: "M01", startMs, endMs: startMs + 1000,
    asrText: "fixture", alignmentConfidence: 1, groundTruth: "human", reviewStatus: "accepted", anchors: [],
    relativeAfterPreviousMs: null, previousCueId: null, collisionRisk: 0, gapBeforeMs: 0, ...extra,
  });
  it("calculates wrong, missed, early, late, fallback/manual and image errors", () => {
    const result = evaluateTriggers([
      { cueId: "c1", atMs: 500, source: "automatic" },
      { cueId: "wrong", atMs: 1200, source: "automatic" },
      { cueId: "c2", atMs: 5000, source: "fallback" },
      { cueId: "image", atMs: 6100, source: "manual", image: true },
      { cueId: "c4", atMs: 8400, source: "automatic" },
    ], [observation("c1", 1000), observation("c2", 3000), observation("missing", 5500),
      observation("image", 6000, { imageDurationMs: 2000 }), observation("c4", 8000)]);
    expect(result.wrongTriggers).toBe(1);
    expect(result.missedCues).toBe(1);
    expect(result.earlyTriggers).toBe(1);
    expect(result.lateTriggers).toBe(1);
    expect(result.manualInterventions).toBe(1);
    expect(result.fallbackTriggers).toBe(1);
    expect(result.imageEntryErrorMs).toBe(100);
    expect(result.imageExitErrorMs).toBe(400);
    expect(result.latencyP95Ms).not.toBeNull();
    expect(result.recoveryTimeMs).not.toBeNull();
  });

  it("excludes unresolved pseudo-ground-truth from apparent accuracy", () => {
    const result = evaluateTriggers([], [observation("unknown", 1000, { groundTruth: "pseudo", reviewStatus: "review-required" })]);
    expect(result.evaluatedCues).toBe(0);
    expect(result.reviewRequired).toBe(1);
    expect(result.latencyP50Ms).toBeNull();
  });
});
