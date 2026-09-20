import { ScriptFollowingEngine, type ScriptEngineSnapshot, type RuntimeTelemetryEvent } from "@stage/script-engine";
import type { PerformanceScript } from "@stage/script-schema";
import type { ASRReplayEvidence } from "./recording-profile";
import { DiscriminativeWordMatcher, PrefixFuzzyMatcher } from "@stage/alignment";

/** HTMLAudioElement satisfies this port. Tests use a controllable MEDIA clock. */
export interface ReplayAudioClock {
  currentTime: number; duration: number; playbackRate: number;
  readonly paused: boolean; readonly ended: boolean; readonly seeking: boolean;
  play(): Promise<void>; pause(): void;
}
export type ReplayState = "ready" | "starting" | "playing" | "paused" | "stopped" | "ended" | "error";
export interface ReplayEvidenceEvent {
  utteranceId: string; text: string; wordText: string;
  onsetMs: number; wordStartMs: number; dueAtMs: number; first: boolean; final: boolean;
}
export interface RecordingRuntimeTrigger {
  cueId: string; atMs: number; source: "automatic" | "manual" | "fallback";
  evidenceDueAtMs: number | null; evidenceStartMs: number | null;
}
export interface ReplayDelivery {
  evidence?: ReplayEvidenceEvent;
  matcherTrace?: RuntimeTelemetryEvent[];
  index: number; atMs: number; dueAtMs: number; expectedCueId: string | null;
  resultingCueId: string | null; decision: string; discarded: boolean;
}
export interface RealtimeReplaySnapshot {
  state: ReplayState; generation: number; audioTimeMs: number; durationMs: number;
  evidenceCursor: number; evidenceCount: number; latestEvidence: ReplayEvidenceEvent | null;
  engine: ScriptEngineSnapshot; triggers: RecordingRuntimeTrigger[]; deliveries: ReplayDelivery[];
  error: string | null;
}

/** References and canonical text are deliberately not arguments to this scheduler. */
export function buildReplayEvidenceEvents(evidence: ASRReplayEvidence): ReplayEvidenceEvent[] {
  if (evidence.version !== 1 || evidence.deliveryBasis !== "saved-word-end-simulation" || evidence.liveLatencyMeasured !== false || evidence.wordConfidence !== "unavailable" || !Array.isArray(evidence.transcript) || evidence.sourceSegmentCount !== evidence.transcript.length) throw new Error("Invalid saved replay evidence provenance");
  const events: ReplayEvidenceEvent[] = [];
  const ids = new Set<string>();
  for (const span of evidence.transcript) {
    if (!span.id || ids.has(span.id) || !span.words?.length || span.confidence !== null || !Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.startMs < 0 || span.endMs < span.startMs) throw new Error("Replay requires unique saved spans and original words with unavailable confidence");
    ids.add(span.id);
    let cumulative = "";
    span.words.forEach((word, index) => {
      if (!word.text?.trim() || word.confidence !== null || word.confidenceBasis !== "unavailable" || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < span.startMs || word.endMs > span.endMs || word.endMs < word.startMs || word.endMs < (events.at(-1)?.dueAtMs ?? 0)) throw new Error("Invalid or non-monotonic saved word evidence");
      cumulative += `${cumulative ? " " : ""}${word.text}`;
      events.push({ utteranceId: span.id, text: cumulative, wordText: word.text, onsetMs: span.startMs,
        wordStartMs: word.startMs, dueAtMs: word.endMs, first: index === 0, final: index === span.words!.length - 1 });
    });
  }
  if (events.length !== evidence.sourceWordCount || !events.length) throw new Error("Saved word count mismatch");
  return events;
}

/** Real-time lifecycle around the unchanged engine. No reference, timers, wall clock,
 * ASR clients, auto-skip/resync, or synthetic captions exist in this controller. */
export class RealtimeReplayController {
  private engine!: ScriptFollowingEngine;
  private state: ReplayState = "ready";
  private generation = 0;
  private run = 0;
  private cursor = 0;
  private lastTimeMs = 0;
  private latest: ReplayEvidenceEvent | null = null;
  private triggers: RecordingRuntimeTrigger[] = [];
  private deliveries: ReplayDelivery[] = [];
  private error: string | null = null;
  private disposed = false;
  private retiredUtterances = new Set<string>();
  private readonly script: PerformanceScript;
  private readonly events: ReplayEvidenceEvent[];

  constructor(script: PerformanceScript, evidence: ASRReplayEvidence, private readonly audio: ReplayAudioClock,
    private readonly matcherPolicy: "baseline" | "discriminative-words" = "discriminative-words") {
    this.script = structuredClone(script);
    // The projection preserves canonical metadata. This replay-only runtime copy
    // refuses any embedded calibration so fallback/timing priors cannot sneak in.
    if (this.script.segments.some((cue) => cue.profile)) throw new Error("Saved replay requires uncalibrated canonical cues; fallback must remain OFF");
    this.events = buildReplayEvidenceEvents(evidence);
    this.freshEngine();
  }

  private freshEngine() {
    this.run += 1;
    this.engine = new ScriptFollowingEngine(this.script,
      this.matcherPolicy === "baseline" ? new PrefixFuzzyMatcher() : new DiscriminativeWordMatcher(),
      { operatingMode: "PERFORMANCE_LOCAL", profiles: [] });
    this.engine.arm();
    this.cursor = 0; this.lastTimeMs = 0; this.latest = null; this.triggers = []; this.deliveries = [];
    this.retiredUtterances.clear(); this.error = null;
  }

  async start(): Promise<void> {
    if (this.disposed || !["ready", "stopped", "ended", "error"].includes(this.state)) return;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.playbackRate = 1;
    this.freshEngine();
    await this.play();
  }

  private async play() {
    const generation = ++this.generation;
    this.state = "starting";
    try {
      await this.audio.play();
      if (this.disposed || generation !== this.generation) {
        if (this.disposed || ["stopped", "paused", "error"].includes(this.state)) this.audio.pause();
        return;
      }
      this.state = "playing";
    } catch {
      if (this.disposed || generation !== this.generation) return;
      this.fail("원본 오디오를 재생하지 못했습니다. 로컬 서버·파일을 확인하고 START / RESTART로 다시 시작하세요.");
    }
  }

  pause(): void {
    if (!["playing", "starting"].includes(this.state)) return;
    this.audio.pause();
    this.generation += 1;
    this.state = "paused";
  }

  async resume(): Promise<void> {
    if (this.disposed || this.state !== "paused") return;
    await this.play();
  }

  stop(): void {
    this.generation += 1;
    this.audio.pause();
    this.state = "stopped";
    // Retain the partial evaluation, but stopped output is explicitly black.
  }

  async restart(): Promise<void> { this.stop(); await this.start(); }
  dispose(): void { this.stop(); this.disposed = true; }
  fail(message: string): void {
    this.stop(); this.state = "error"; this.error = message;
  }

  /** Poll via RAF/timeupdate. Stale callbacks can optionally supply their generation. */
  tick(generation = this.generation): RealtimeReplaySnapshot {
    if (this.disposed || generation !== this.generation || this.state !== "playing") return this.snapshot();
    const atMs = this.audio.currentTime * 1000;
    if (this.audio.playbackRate !== 1 || !Number.isFinite(atMs) || atMs < this.lastTimeMs - 1) {
      this.fail("재생 속도 변경·역방향 탐색은 지원하지 않습니다. RESTART로 0초부터 시작하세요.");
      return this.snapshot();
    }
    // No native controls/seek UI. An external seek fails closed (never catches up
    // from future evidence). Browser buffering/RAF throttling isn't a seek.
    if (this.audio.seeking) {
      this.fail("임의 탐색은 차단되었습니다. RESTART로 새 리플레이를 시작하세요.");
      return this.snapshot();
    }
    if (this.audio.paused && !this.audio.ended) return this.snapshot();
    this.lastTimeMs = atMs;
    while (this.events[this.cursor] && this.events[this.cursor]!.dueAtMs <= atMs) {
      const event = this.events[this.cursor]!;
      const expected = this.engine.snapshot().nextSegment?.id ?? null;
      const previous = this.engine.snapshot().lastTrigger;
      const discarded = this.retiredUtterances.has(event.utteranceId);
      const telemetryStart = this.engine.exportTelemetry().at(-1)?.sequence ?? 0;
      this.latest = event;
      if (!discarded) {
        if (event.first) this.engine.speechStart(event.onsetMs);
        this.engine.processHypothesis({ text: event.text, confidence: null, confidenceBasis: "unavailable",
          evidenceBasis: "saved-completed-words",
          receivedAt: atMs, speechActive: true, utteranceId: `${this.run}:${event.utteranceId}`, isFinal: event.final });
        this.capture(previous, event);
      }
      const telemetry = this.engine.exportTelemetry();
      const trace = telemetry.filter((entry) => (entry.sequence ?? 0) > telemetryStart);
      this.deliveries.push({ index: this.cursor, atMs, dueAtMs: event.dueAtMs, expectedCueId: expected,
        evidence: event, matcherTrace: trace,
        resultingCueId: this.engine.snapshot().currentSegment?.id ?? null,
        decision: discarded ? "manual-retired-utterance" : trace.at(-1)?.decision ?? (this.engine.snapshot().hold ? "hold-checkpoint" : expected === null ? "no-next-candidate" : "unchanged-or-consumed-evidence"), discarded });
      this.cursor += 1;
      if (event.final) this.engine.speechEnd();
    }
    if (this.audio.ended) { this.engine.finish(); this.state = "ended"; }
    return this.snapshot();
  }

  private capture(previous: ScriptEngineSnapshot["lastTrigger"], event: ReplayEvidenceEvent | null) {
    const trigger = this.engine.snapshot().lastTrigger;
    if (trigger && trigger !== previous) this.triggers.push({ cueId: trigger.segment.id, atMs: trigger.triggeredAt,
      source: trigger.source, evidenceDueAtMs: event?.dueAtMs ?? null, evidenceStartMs: event?.wordStartMs ?? null });
  }

  /** Explicit operator actions only. Retire all evidence heard before this action,
   * including the cumulative remainder of a currently sounding utterance. */
  manual(direction: "next" | "previous"): void {
    if (this.disposed || !["playing", "paused"].includes(this.state)) return;
    const atMs = this.audio.currentTime * 1000;
    for (const event of this.events) if (event.onsetMs <= atMs && event.dueAtMs >= atMs) this.retiredUtterances.add(event.utteranceId);
    while (this.events[this.cursor] && this.events[this.cursor]!.dueAtMs <= atMs) {
      const event = this.events[this.cursor]!;
      this.retiredUtterances.add(event.utteranceId);
      this.deliveries.push({ index: this.cursor++, atMs, dueAtMs: event.dueAtMs, expectedCueId: this.engine.snapshot().nextSegment?.id ?? null,
        resultingCueId: this.engine.snapshot().currentSegment?.id ?? null, decision: "manual-checkpoint", discarded: true });
    }
    this.engine.speechEnd();
    const previous = this.engine.snapshot().lastTrigger;
    if (direction === "next") this.engine.manualNext(atMs); else this.engine.manualPrevious(atMs);
    this.capture(previous, null);
  }

  setHold(hold: boolean): void {
    if (this.disposed || !["playing", "paused"].includes(this.state)) return;
    // Releasing hold is a checkpoint too, not permission to replay accumulated text.
    if (!hold) {
      const atMs = this.audio.currentTime * 1000;
      for (const event of this.events) if (event.onsetMs <= atMs && event.dueAtMs >= atMs) this.retiredUtterances.add(event.utteranceId);
    }
    this.engine.setHold(hold, this.audio.currentTime * 1000);
  }

  snapshot(): RealtimeReplaySnapshot {
    return { state: this.state, generation: this.generation, audioTimeMs: this.audio.currentTime * 1000,
      durationMs: Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0,
      evidenceCursor: this.cursor, evidenceCount: this.events.length, latestEvidence: this.latest,
      engine: this.engine.snapshot(), triggers: [...this.triggers], deliveries: [...this.deliveries], error: this.error };
  }
}
