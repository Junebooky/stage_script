import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseShow, type PerformanceScript } from "@stage/script-schema";
import { ScriptFollowingEngine } from "@stage/script-engine";
import rawShow from "../../../data/productions/decadence-gyeongseong/numbers/M05-2.json";
import rawProfile from "../../../data/replay-recordings/R001-M05-2.profile.json";
import rawReference from "../../../data/replay-recordings/R001-M05-2.reference.json";
import { canonicalFingerprint } from "./alignment";
import { buildRecordingReplayScript, validateRecordingReplayProfile, validateRecordingReference, type ASRReplayEvidence } from "./recording-profile";
import { buildReplayEvidenceEvents, RealtimeReplayController, type RecordingRuntimeTrigger, type ReplayAudioClock } from "./realtime-replay";
import { evaluateRecordingReplay, REPLAY_EARLY_TOLERANCE_MS, REPLAY_LATE_TOLERANCE_MS } from "./recording-evaluation";

const show = parseShow(rawShow);
const profile = validateRecordingReplayProfile(show, rawProfile);
const reference = validateRecordingReference(profile, rawReference);
const projected = buildRecordingReplayScript(show, profile);
const id = (number: number) => `M05-2_C${String(number).padStart(3, "0")}`;

class AudioClock implements ReplayAudioClock {
  currentTime = 0; duration = 226.138; playbackRate = 1; paused = true; ended = false; seeking = false;
  async play() { this.paused = false; this.ended = false; }
  pause() { this.paused = true; }
}

/** Public synthetic text fixtures, NOT a transcript or a claim about real ASR. */
function evidenceFor(script = projected): ASRReplayEvidence {
  const transcript = script.segments.map((cue, index) => {
    const startMs = index * 5000 + 1000, endMs = startMs + 1000;
    const text = cue.matchText.join(" ");
    return { id: `synthetic-${index}`, text, startMs, endMs, confidence: null,
      words: [{ text, startMs, endMs, confidence: null, confidenceBasis: "unavailable" as const }] };
  });
  return { version: 1, recordingId: profile.recordingId, sourceAudioSha256: profile.sourceAudioSha256,
    sourceArtifactSha256: profile.asrEvidenceSource.sha256, runId: "synthetic-test-not-real-asr", provider: "synthetic", model: "none",
    deliveryBasis: "saved-word-end-simulation", liveLatencyMeasured: false, wordConfidence: "unavailable",
    sourceSegmentCount: transcript.length, sourceWordCount: transcript.length, derivation: "Synthetic canonical-only unit fixture, not real ASR", warnings: [], transcript };
}
function setup(script = projected, evidence = evidenceFor(script)) {
  const audio = new AudioClock();
  return { audio, controller: new RealtimeReplayController(script, evidence, audio), evidence };
}
function tickAt(controller: RealtimeReplayController, audio: AudioClock, ms: number) { audio.currentTime = ms / 1000; return controller.tick(); }
function trigger(cueId: string, atMs: number): RecordingRuntimeTrigger { return { cueId, atMs, source: "automatic", evidenceDueAtMs: atMs, evidenceStartMs: atMs }; }

describe("recording-scoped canonical projection", () => {
  it("01-02: keeps the 36 canonical IDs, bytes and fingerprint unchanged", () => {
    expect(show.acts[0]!.numbers[0]!.cues.map((cue) => cue.id)).toEqual(Array.from({ length: 36 }, (_, index) => id(index + 1)));
    expect(canonicalFingerprint(show)).toBe("0d6009c3");
    expect(createHash("sha256").update(readFileSync("data/productions/decadence-gyeongseong/numbers/M05-2.json")).digest("hex")).toBe("823e4630702aa3c1be4b2b59fed7fd10507ae3c0a459dcf8bb098407bfe73e74");
  });
  it("03-05: partitions exactly 27 performed + 9 absent, disjoint and exhaustive", () => {
    expect(profile.absentCueIds).toEqual(Array.from({ length: 9 }, (_, index) => id(index + 9)));
    expect(profile.performedCueIds).toHaveLength(27);
    expect(new Set([...profile.performedCueIds, ...profile.absentCueIds]).size).toBe(36);
  });
  it("06-09: projects 27 original IDs, text, order, metadata; C008 next is C018", () => {
    const before = structuredClone(show);
    const replay = buildRecordingReplayScript(show, { ...profile, performedCueIds: [...profile.performedCueIds].reverse() });
    expect(replay.segments).toHaveLength(27);
    expect(replay.segments.map((cue) => cue.id)).toEqual(profile.performedCueIds);
    expect(replay.segments[7]!.id).toBe(id(8)); expect(replay.segments[8]!.id).toBe(id(18));
    for (const cue of replay.segments) expect(cue).toEqual(show.acts[0]!.numbers[0]!.cues.find((item) => item.id === cue.id));
    replay.segments[0]!.captions[0]!.text = "changed copy";
    expect(show).toEqual(before);
  });
  it.each([
    ["unknown", { performedCueIds: ["unknown", ...profile.performedCueIds.slice(1)] }],
    ["duplicate", { performedCueIds: [...profile.performedCueIds, id(1)] }],
    ["overlap", { absentCueIds: [...profile.absentCueIds, id(1)] }],
    ["missing", { absentCueIds: profile.absentCueIds.slice(1) }],
    ["fingerprint", { canonicalFingerprint: "bad" }],
    ["number", { numberId: "wrong" }],
    ["audio provenance", { sourceAudioSha256: "bad" }],
  ])("rejects inconsistent %s profile", (_name, changed) => {
    expect(() => buildRecordingReplayScript(show, { ...profile, ...changed })).toThrow();
  });
  it("reference is separate silver data with 27 cues and six retained warnings", () => {
    expect(reference.cues).toHaveLength(27);
    expect(reference.quality).toBe("silver-reference");
    expect(reference.cues.filter((cue) => cue.warnings?.length).map((cue) => cue.cueId)).toEqual([7, 8, 24, 27, 35, 36].map(id));
    expect(() => validateRecordingReference(profile, { ...reference, quality: "human-confirmed" })).toThrow();
    expect(() => validateRecordingReference(profile, { ...reference, cues: reference.cues.slice(1) })).toThrow();
  });
});

describe("unchanged live matcher authority", () => {
  it("10-11,29: full canonical engine still blocks at absent B; no generic skip, lookahead or auto-resync", () => {
    const engine = new ScriptFollowingEngine({ ...projected, segments: show.acts[0]!.numbers[0]!.cues }, undefined, { operatingMode: "PERFORMANCE_LOCAL" });
    engine.arm();
    for (let n = 1; n <= 8; n++) {
      engine.speechStart(n * 1000);
      engine.processHypothesis({ text: show.acts[0]!.numbers[0]!.cues[n - 1]!.matchText.join(" "), confidence: null, receivedAt: n * 1000 + 500, speechActive: true, utteranceId: String(n) });
    }
    expect(engine.snapshot().currentSegment?.id).toBe(id(8));
    for (let attempt = 0; attempt < 30; attempt++) {
      engine.speechStart(10000 + attempt * 1000);
      engine.processHypothesis({ text: projected.segments[8]!.matchText.join(" "), confidence: null, receivedAt: 10500 + attempt * 1000, speechActive: true, utteranceId: `unmatched-${attempt}`, isFinal: true });
    }
    expect(engine.snapshot().currentSegment?.id).toBe(id(8));
    expect(engine.snapshot().nextSegment?.id).toBe(id(9));
    expect(engine.snapshot().searchMode).toBe("NORMAL");
  });
  it("12,15-21,26: synthetic 27-cue sequence retains repeated occurrences; absent cues and post-take never dispatch", async () => {
    const { controller, audio, evidence } = setup();
    await controller.start();
    for (const event of buildReplayEvidenceEvents(evidence)) tickAt(controller, audio, event.dueAtMs);
    expect(controller.snapshot().triggers.map((item) => item.cueId)).toEqual(profile.performedCueIds);
    expect(controller.snapshot().triggers.every((item) => item.source === "automatic")).toBe(true);
    const post = evidenceFor();
    post.transcript.push({ id: "post-take", text: "감사합니다.", startMs: 223709, endMs: 224409, confidence: null,
      words: [{ text: "감사합니다.", startMs: 223709, endMs: 224409, confidence: null, confidenceBasis: "unavailable" }] });
    post.sourceWordCount++; post.sourceSegmentCount++;
    const run = setup(projected, post); await run.controller.start();
    const end = tickAt(run.controller, run.audio, 224409);
    expect(end.triggers.map((item) => item.cueId)).toEqual(profile.performedCueIds);
    expect(end.engine.currentSegment?.id).toBe(id(36));
    expect(end.engine.searchMode).toBe("NORMAL");
    expect(end.latestEvidence?.text).toBe("감사합니다.");
    expect(end.triggers.some((item) => item.cueId === id(16))).toBe(false);
  });
  it("14: reference times alone cannot dispatch captions", async () => {
    const evidence = evidenceFor();
    evidence.transcript.forEach((span) => { span.text = "잡음만 있습니다"; span.words![0]!.text = span.text; });
    const { controller, audio } = setup(projected, evidence); await controller.start();
    for (const cue of reference.cues) tickAt(controller, audio, cue.referenceStartMs);
    expect(controller.snapshot().triggers).toEqual([]);
    evaluateRecordingReplay(profile, reference, []);
    expect(controller.snapshot().engine.currentSegment).toBeNull();
  });
  it("26: calibrated/embedded profiles cannot enable fallback in this replay", () => {
    const modified = structuredClone(projected);
    modified.segments[0]!.profile = { cueId: id(1) } as never;
    expect(() => setup(modified)).toThrow(/fallback/);
  });
});

describe("audio-clock lifecycle and evidence", () => {
  it("no future word or future cumulative text leaks before word end", async () => {
    const evidence = evidenceFor();
    const span = evidence.transcript[0]!;
    span.words = [{ text: "창가로", startMs: 1000, endMs: 2000, confidence: null, confidenceBasis: "unavailable" }, { text: "스며드는", startMs: 2000, endMs: 3000, confidence: null, confidenceBasis: "unavailable" }];
    span.endMs = 3000; evidence.sourceWordCount++;
    const { controller, audio } = setup(projected, evidence); await controller.start();
    expect(tickAt(controller, audio, 1999).evidenceCursor).toBe(0);
    expect(tickAt(controller, audio, 2000).latestEvidence?.text).toBe("창가로");
    expect(tickAt(controller, audio, 3000).latestEvidence?.text).toBe("창가로 스며드는");
  });
  it("22-23: pause freezes cursor; resume uses the same cumulative stream without duplicates", async () => {
    const { controller, audio } = setup(); await controller.start();
    const before = tickAt(controller, audio, 2000); controller.pause();
    for (let n = 0; n < 10; n++) controller.tick();
    expect(controller.snapshot().evidenceCursor).toBe(before.evidenceCursor);
    await controller.resume(); controller.tick();
    expect(controller.snapshot().triggers).toEqual(before.triggers);
    expect(tickAt(controller, audio, 7000).triggers.map((item) => item.cueId)).toEqual([id(1), id(2)]);
  });
  it("24: restart constructs a fresh engine, clock 0, cursor 0 and empty log", async () => {
    const { controller, audio } = setup(); await controller.start(); tickAt(controller, audio, 7000);
    await controller.restart();
    expect(audio.currentTime).toBe(0); expect(controller.snapshot().evidenceCursor).toBe(0);
    expect(controller.snapshot().engine.currentSegment).toBeNull(); expect(controller.snapshot().triggers).toEqual([]);
    expect(tickAt(controller, audio, 2000).triggers.map((item) => item.cueId)).toEqual([id(1)]);
  });
  it("25: stop invalidates stale callbacks and disposal never resumes processing", async () => {
    const { controller, audio } = setup(); await controller.start(); const generation = controller.snapshot().generation;
    tickAt(controller, audio, 2000); controller.stop(); audio.currentTime = 30;
    controller.tick(generation); expect(controller.snapshot().evidenceCursor).toBe(1);
    await controller.restart(); audio.currentTime = 30; controller.tick(generation);
    expect(controller.snapshot().evidenceCursor).toBe(0);
    controller.dispose(); await controller.start(); controller.tick();
    expect(controller.snapshot().state).toBe("stopped"); expect(audio.paused).toBe(true);
  });
  it("a late play promise cannot resurrect a stopped replay", async () => {
    const { controller, audio } = setup(); let resolve!: () => void;
    audio.play = () => new Promise<void>((done) => { resolve = () => { audio.paused = false; done(); }; });
    const starting = controller.start(); controller.stop(); resolve(); await starting;
    expect(audio.paused).toBe(true); expect(controller.snapshot().state).toBe("stopped");
  });
  it("play rejection fails closed without an ASR fallback", async () => {
    const { controller, audio } = setup(); audio.play = () => Promise.reject(new Error("blocked"));
    await controller.start(); expect(controller.snapshot().state).toBe("error");
    expect(controller.snapshot().triggers).toEqual([]);
  });
  it.each(["seek", "rate", "backward"])("rejects unsupported %s rather than replaying stale/future evidence", async (change) => {
    const { controller, audio } = setup(); await controller.start(); tickAt(controller, audio, 2000);
    if (change === "seek") audio.seeking = true;
    if (change === "rate") audio.playbackRate = 2;
    if (change === "backward") audio.currentTime = 0;
    expect(controller.tick().state).toBe("error"); expect(audio.paused).toBe(true);
  });
  it("27: manual next is authoritative and retires evidence already heard", async () => {
    const { controller, audio } = setup(); await controller.start(); audio.currentTime = 2;
    controller.manual("next"); controller.tick();
    expect(controller.snapshot().triggers.map((item) => item.source)).toEqual(["manual"]);
    expect(controller.snapshot().engine.currentSegment?.id).toBe(id(1));
    expect(tickAt(controller, audio, 7000).triggers.at(-1)?.cueId).toBe(id(2));
  });
  it("hold discards held evidence and cannot release a buffered trigger", async () => {
    const { controller, audio } = setup(); await controller.start(); controller.setHold(true);
    tickAt(controller, audio, 2000); expect(controller.snapshot().triggers).toEqual([]);
    controller.setHold(false); controller.tick(); expect(controller.snapshot().triggers).toEqual([]);
  });
  it("end-of-file consumes final due evidence and does not restart the number", async () => {
    const { controller, audio } = setup(); await controller.start(); audio.currentTime = audio.duration; audio.ended = true; audio.paused = true;
    const result = controller.tick(); expect(result.state).toBe("ended"); expect(result.engine.finished).toBe(true);
    expect(result.triggers).toHaveLength(27); controller.tick(); expect(controller.snapshot().triggers).toHaveLength(27);
  });
  it("rejects changed confidence, nonmonotonic words and count mismatches", () => {
    const evidence = evidenceFor(); evidence.transcript[0]!.words![0]!.confidence = 0.8 as never;
    expect(() => buildReplayEvidenceEvents(evidence)).toThrow();
    evidence.transcript[0]!.words![0]!.confidence = null;
    evidence.sourceWordCount++; expect(() => buildReplayEvidenceEvents(evidence)).toThrow();
    evidence.sourceWordCount--; evidence.transcript[1]!.words![0]!.endMs = 1;
    expect(() => buildReplayEvidenceEvents(evidence)).toThrow();
  });
});

describe("separate evaluation, never dispatch", () => {
  it("clock stalls are reported as possible coalesced audience paints, not proven rendered cues", () => {
    const report = evaluateRecordingReplay(profile, reference, [trigger(id(1), 19000), trigger(id(2), 19000)]);
    expect(report.metrics.correctTriggerCount).toBe(2);
    expect(report.metrics.coalescedAutomaticTriggerCount).toBe(1);
  });
  it("13: only performed cues count; nine absences are not matcher misses", () => {
    const report = evaluateRecordingReplay(profile, reference, []);
    expect(report.metrics.missedCueCount).toBe(27); expect(report.metrics.recordingAbsentCueCount).toBe(9);
    expect(report.cues.some((cue) => profile.absentCueIds.includes(cue.cueId))).toBe(false);
  });
  it("30: first failure and blocked successors are not independent ASR misses", () => {
    const triggers = reference.cues.slice(0, 14).map((cue) => trigger(cue.cueId, cue.referenceStartMs + 500));
    const report = evaluateRecordingReplay(profile, reference, triggers);
    expect(report.cues.find((cue) => cue.cueId === id(24))?.failure).toBe("PRIMARY_BLOCKING_FAILURE");
    expect(report.cues.find((cue) => cue.cueId === id(25))?.failure).toBe("CASCADE_BLOCKED");
    expect(report.metrics.primaryBlockingFailureCount).toBe(1); expect(report.metrics.cascadeBlockedCount).toBe(12);
  });
  it("recovery ends the cascade; later missing cue is a new primary failure", () => {
    const triggers = reference.cues.slice(0, 2).map((cue) => trigger(cue.cueId, cue.referenceStartMs));
    triggers.push({ ...trigger(id(5), 40420), source: "manual" });
    const report = evaluateRecordingReplay(profile, reference, triggers);
    expect(report.cues.find((cue) => cue.cueId === id(3))?.failure).toBe("PRIMARY_BLOCKING_FAILURE");
    expect(report.cues.find((cue) => cue.cueId === id(4))?.failure).toBe("CASCADE_BLOCKED");
    expect(report.cues.find((cue) => cue.cueId === id(6))?.failure).toBe("PRIMARY_BLOCKING_FAILURE");
  });
  it("reports signed timing and named, untuned 250/1500ms thresholds", () => {
    expect(REPLAY_EARLY_TOLERANCE_MS).toBe(250); expect(REPLAY_LATE_TOLERANCE_MS).toBe(1500);
    const report = evaluateRecordingReplay(profile, reference, [trigger(id(1), 8000), trigger(id(2), 18400)], { complete: false, throughMs: 19000 });
    expect(report.cues[0]!.timingErrorMs).toBe(-420); expect(report.cues[0]!.early).toBe(true);
    expect(report.cues[1]!.timingErrorMs).toBe(2000); expect(report.cues[1]!.late).toBe(true);
    expect(report.cues[2]!.category).toBe("PENDING");
  });
  it("detects repeated lyric occurrence confusion and post-take false dispatch in an injected bad log", () => {
    const report = evaluateRecordingReplay(profile, reference, [trigger(id(1), 78800), trigger(id(16), 224409)]);
    expect(report.metrics.repeatedLyricConfusionCount).toBe(1);
    expect(report.metrics.postTakeFalseTriggerCount).toBe(1); expect(report.metrics.wrongTriggerCount).toBe(2);
  });
});

const original = "recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav";
it.skipIf(!existsSync(original))("28: local original WAV remains byte-identical (optional private asset)", () => {
  expect(createHash("sha256").update(readFileSync(original)).digest("hex")).toBe(profile.sourceAudioSha256);
});
