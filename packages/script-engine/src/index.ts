import { normalizeKorean, PrefixFuzzyMatcher, type MatchResult, type ScriptMatcher, type StreamingHypothesis } from "@stage/alignment";
import { parseCueProfiles, type CueProfile, type OperatingMode, type PerformanceScript, type ScriptSegment } from "@stage/script-schema";
import { HypothesisCursor } from "./hypothesis-cursor";
export { ShowRuntime, type ShowPhase, type ShowRuntimeSnapshot, type ShowRuntimeConfig, type RuntimeReadiness, type IntermissionOutput } from "./show-runtime";

export type EnginePhase =
  | "IDLE"
  | "ARMED"
  | "LISTENING"
  | "MATCHING"
  | "TRIGGERED"
  | "DISPLAYING"
  | "LOW_CONFIDENCE"
  | "UNMATCHED_SPEECH"
  | "FALLBACK_READY"
  | "RESYNC";

export type SearchMode = "NORMAL" | "RESYNC" | "FULL_RESYNC";

export interface TriggerEvent {
  segment: ScriptSegment;
  index: number;
  confidence: number;
  hypothesis: string;
  triggeredAt: number;
  speechOnsetAt: number | null;
  source: "automatic" | "fallback" | "manual";
}

export interface ScriptEngineSnapshot {
  phase: EnginePhase;
  searchMode: SearchMode;
  currentIndex: number;
  currentSegment: ScriptSegment | null;
  nextSegment: ScriptSegment | null;
  displayedSegment: ScriptSegment | null;
  confidence: number;
  partial: string;
  expected: string;
  speechActive: boolean;
  hold: boolean;
  lowConfidenceCount: number;
  lastTrigger: TriggerEvent | null;
  completedIndexes: number[];
  finished: boolean;
}

export interface EngineConfig {
  normalLookahead: number;
  resyncLookbehind: number;
  resyncLookahead: number;
  lowConfidenceAttempts: number;
  fullResyncAttempts: number;
  triggerCooldownMs: number;
  operatingMode: OperatingMode;
  profiles: CueProfile[];
  telemetryLimit: number;
}

export interface RuntimeTelemetryEvent {
  sequence?: number;
  timestamp: number;
  event: "hypothesis" | "matcher" | "trigger" | "manual" | "resync" | "show-state" | "hold";
  match?: MatchResult;
  currentCue: string | null;
  candidateCue?: string;
  rawAsr?: string;
  normalizedAsr?: string;
  scores?: MatchResult["components"];
  selectedAnchor?: string;
  matchRange?: [number, number];
  timingPrior?: number;
  cursorFloor?: number;
  decision?: string;
  source?: TriggerEvent["source"];
  transition?: string;
}

const defaultConfig: EngineConfig = {
  normalLookahead: 3,
  resyncLookbehind: 5,
  resyncLookahead: 10,
  lowConfidenceAttempts: 4,
  fullResyncAttempts: 9,
  triggerCooldownMs: 0,
  operatingMode: "DEMO",
  profiles: [],
  telemetryLimit: 2000
};

export class ScriptFollowingEngine {
  private readonly matcher: ScriptMatcher;
  private readonly config: EngineConfig;
  private state: ScriptEngineSnapshot;
  private speechOnsetAt: number | null = null;
  private readonly cursor = new HypothesisCursor();
  private speechSequence = 0;
  private lastTriggerSpeechSequence = 0;
  private manualCheckpointAt = Number.NEGATIVE_INFINITY;
  private freshSpeechRequiredAfter: number | null = null;
  private readonly retiredManualStreams = new Set<string>();
  private readonly telemetry: RuntimeTelemetryEvent[] = [];
  private telemetrySequence = 0;
  private profiles: CueProfile[];

  constructor(
    private readonly script: PerformanceScript,
    matcher: ScriptMatcher = new PrefixFuzzyMatcher(),
    config: Partial<EngineConfig> = {}
  ) {
    this.matcher = matcher;
    this.config = { ...defaultConfig, ...config };
    this.profiles = parseCueProfiles(this.config.profiles);
    this.state = this.initialState();
  }

  private initialState(): ScriptEngineSnapshot {
    return {
      phase: "IDLE",
      searchMode: "NORMAL",
      currentIndex: -1,
      currentSegment: null,
      nextSegment: this.script.segments[0] ?? null,
      displayedSegment: null,
      confidence: 0,
      partial: "",
      expected: this.script.segments[0]?.matchText[0] ?? "",
      speechActive: false,
      hold: false,
      lowConfidenceCount: 0,
      lastTrigger: null,
      completedIndexes: [],
      finished: false
    };
  }

  arm(): ScriptEngineSnapshot {
    if (this.state.phase === "IDLE") this.state = { ...this.state, phase: "ARMED" };
    return this.snapshot();
  }

  reset(): ScriptEngineSnapshot {
    this.state = this.initialState();
    this.speechOnsetAt = null;
    this.freshSpeechRequiredAfter = null;
    this.retiredManualStreams.clear();
    this.cursor.discard();
    return this.arm();
  }

  speechStart(at: number): ScriptEngineSnapshot {
    this.speechOnsetAt = at;
    this.speechSequence += 1;
    this.state = { ...this.state, phase: "LISTENING", speechActive: true };
    if (this.fallbackReadiness(at)) this.state = { ...this.state, phase: "FALLBACK_READY" };
    return this.snapshot();
  }

  speechEnd(): ScriptEngineSnapshot {
    this.state = {
      ...this.state,
      phase: this.state.displayedSegment ? "DISPLAYING" : "ARMED",
      speechActive: false,
      partial: ""
    };
    return this.snapshot();
  }

  toggleHold(): ScriptEngineSnapshot {
    return this.setHold(!this.state.hold);
  }

  setHold(hold: boolean, at = Date.now()): ScriptEngineSnapshot {
    this.state = { ...this.state, hold };
    this.log({ timestamp: at, event: "hold", currentCue: this.state.currentSegment?.id ?? null, cursorFloor: this.cursor.floor, decision: hold ? "hold" : "resume" });
    return this.snapshot();
  }

  manualNext(at: number): ScriptEngineSnapshot {
    if (this.state.currentIndex === this.script.segments.length - 1) return this.finish();
    return this.manualMove(Math.min(this.script.segments.length - 1, this.state.currentIndex + 1), at);
  }

  finish(): ScriptEngineSnapshot {
    if (this.state.currentIndex !== this.script.segments.length - 1) return this.snapshot();
    this.state = {
      ...this.state,
      finished: true,
      phase: "DISPLAYING",
      completedIndexes: [...new Set([...this.state.completedIndexes, this.state.currentIndex])]
    };
    return this.snapshot();
  }

  manualPrevious(at: number): ScriptEngineSnapshot {
    return this.manualMove(Math.max(0, this.state.currentIndex - 1), at);
  }

  jumpTo(index: number, at: number): ScriptEngineSnapshot {
    return this.manualMove(Math.max(0, Math.min(this.script.segments.length - 1, index)), at);
  }

  private manualMove(index: number, at: number): ScriptEngineSnapshot {
    const segment = this.script.segments[index];
    if (!segment) return this.snapshot();
    if (this.config.operatingMode === "PERFORMANCE_LOCAL" && (this.cursor.text.length === 0 || this.freshSpeechRequiredAfter !== null)) this.freshSpeechRequiredAfter = at;
    this.cursor.discard();
    this.manualCheckpointAt = at;
    this.log({ timestamp: at, event: "manual", currentCue: this.state.currentSegment?.id ?? null, candidateCue: segment.id, cursorFloor: this.cursor.floor, decision: "checkpoint", source: "manual" });
    this.state = this.trigger(segment, index, 1, "MANUAL", at, "manual");
    return this.snapshot();
  }

  forceResync(at = Date.now()): ScriptEngineSnapshot {
    this.cursor.discard();
    this.log({ timestamp: at, event: "resync", currentCue: this.state.currentSegment?.id ?? null, cursorFloor: this.cursor.floor, decision: "operator-resync" });
    this.state = { ...this.state, phase: "RESYNC", searchMode: "RESYNC", lowConfidenceCount: 0 };
    return this.snapshot();
  }

  processHypothesis(hypothesis: StreamingHypothesis): ScriptEngineSnapshot {
    if (this.state.finished || !hypothesis.text.trim() || hypothesis.receivedAt < this.manualCheckpointAt) return this.snapshot();
    // Keep the legacy demo's paused-input behavior. Performance mode retires
    // held evidence below and requires fresh evidence after resuming.
    if (this.state.hold && this.config.operatingMode === "DEMO") return this.snapshot();
    const normalized = normalizeKorean(hypothesis.contextText ?? hypothesis.text);
    const stream = hypothesis.streamId ?? hypothesis.utteranceId ?? `speech-${this.speechSequence}`;
    if (this.freshSpeechRequiredAfter !== null) {
      if (!hypothesis.boundaryVerified && (this.speechOnsetAt === null || this.speechOnsetAt <= this.freshSpeechRequiredAfter || this.retiredManualStreams.has(stream))) {
        this.retiredManualStreams.add(stream);
        this.checkpointHypothesis(hypothesis);
        this.log({ timestamp: hypothesis.receivedAt, event: "hypothesis", currentCue: this.state.currentSegment?.id ?? null, decision: "manual-awaiting-fresh-speech", cursorFloor: this.cursor.floor });
        return this.snapshot();
      }
      // With no previous transcript there is nothing to checkpoint textually.
      // Require a post-navigation VAD onset and do not reuse an already retired
      // utterance. Receipt time alone is never evidence of a fresh utterance.
      this.freshSpeechRequiredAfter = null;
      this.retiredManualStreams.clear();
    }
    if (!this.cursor.update(stream, normalized)) return this.snapshot();
    if (this.state.hold) { this.cursor.discard(); return this.snapshot(); }
    const candidates = this.candidateIndexes();
    let best: { index: number; result: MatchResult } | null = null;

    for (const index of candidates) {
      const segment = this.script.segments[index];
      if (!segment) continue;
      if (segment.type === "IMAGE") continue;
      const profile = this.profiles.find((profile) => profile.cueId === segment.id) ?? segment.profile;
      const expectedNext = Math.max(0, this.state.currentIndex + 1);
      let offset = Math.max(this.cursor.floor, normalized.length - 512);
      while (offset < normalized.length) {
        const result = this.matcher.match({ ...hypothesis, text: normalized.slice(offset) }, segment, {
          candidateOffset: Math.abs(index - expectedNext),
          mode: this.state.searchMode,
          operatingMode: this.config.operatingMode,
          rawTranscript: hypothesis.contextText ?? hypothesis.text,
          normalizedOffset: offset,
          nearbySegments: this.script.segments.slice(Math.max(0, index - 3), index + 4),
          profile,
          timingPrior: this.timingPrior(profile, hypothesis.receivedAt)
        });
        result.start += offset;
        result.end += offset;
        const currentLine = result.eligible && this.cursor.isCurrentLine(result.start, result.end);
        this.log({ timestamp: hypothesis.receivedAt, event: "matcher", currentCue: this.state.currentSegment?.id ?? null,
          candidateCue: segment.id, match: { ...result }, cursorFloor: this.cursor.floor,
          decision: currentLine ? "previous-cue-trailing-evidence" : result.reason ?? (result.eligible ? "eligible" : "unmatched") });
        if (currentLine) {
          offset = Math.max(offset + 1, result.end);
          continue;
        }
        if (!best || (result.eligible && !best.result.eligible) || (result.eligible === best.result.eligible && result.score > best.result.score)) best = { index, result };
        break;
      }
      // The next cue's two syllables take priority over speculative skips.
      if (best?.index === expectedNext && best.result.eligible) break;
    }

    if (!best) return this.snapshot();
    const segment = this.script.segments[best.index]!;
    const nextLowCount = best.result.eligible ? 0 : this.state.lowConfidenceCount + (hypothesis.isFinal === false || this.cursor.hasCue ? 0 : 1);
    const lastAt = this.state.lastTrigger?.triggeredAt ?? Number.NEGATIVE_INFINITY;
    const cooledDown = hypothesis.receivedAt - lastAt >= this.config.triggerCooldownMs;
    this.log({ timestamp: hypothesis.receivedAt, event: "hypothesis", currentCue: this.state.currentSegment?.id ?? null, candidateCue: segment.id, rawAsr: hypothesis.text, normalizedAsr: normalized, scores: best.result.components, selectedAnchor: best.result.selectedAnchor, matchRange: [best.result.start, best.result.end], timingPrior: best.result.components?.timing, cursorFloor: this.cursor.floor, decision: best.result.eligible ? "match" : "unmatched" });

    if (best.result.eligible && cooledDown) {
      this.cursor.consume(best.result.start, best.result.end, best.result.expected);
      this.state = this.trigger(
        segment,
        best.index,
        best.result.score,
        hypothesis.text,
        hypothesis.receivedAt,
        "automatic"
      );
      return this.snapshot();
    }

    const fallback = this.fallbackCandidate(hypothesis, normalized);
    if (fallback) {
      this.cursor.consume(this.cursor.floor, normalized.length, normalizeKorean(fallback.segment.matchText[0] ?? ""));
      this.state = this.trigger(fallback.segment, fallback.index, fallback.confidence, hypothesis.text, hypothesis.receivedAt, "fallback");
      return this.snapshot();
    }

    let searchMode = this.state.searchMode;
    let phase: EnginePhase = this.config.operatingMode === "PERFORMANCE_LOCAL" && hypothesis.speechActive && normalized.length - this.cursor.floor >= 3 ? "UNMATCHED_SPEECH" : "MATCHING";
    if (this.config.operatingMode === "DEMO" && nextLowCount >= this.config.fullResyncAttempts) {
      searchMode = "FULL_RESYNC";
      phase = "RESYNC";
    } else if (this.config.operatingMode === "DEMO" && nextLowCount >= this.config.lowConfidenceAttempts) {
      searchMode = "RESYNC";
      phase = "LOW_CONFIDENCE";
    }
    this.state = {
      ...this.state,
      phase,
      searchMode,
      speechActive: hypothesis.speechActive,
      confidence: best.result.score,
      partial: hypothesis.text,
      expected: segment.matchText[0] ?? "",
      lowConfidenceCount: nextLowCount
    };
    return this.snapshot();
  }

  /** Retire recognition heard while not LIVE or after an operator checkpoint. */
  checkpointHypothesis(hypothesis: StreamingHypothesis): void {
    const stream = hypothesis.streamId ?? hypothesis.utteranceId ?? `speech-${this.speechSequence}`;
    this.cursor.update(stream, normalizeKorean(hypothesis.contextText ?? hypothesis.text));
    this.cursor.discard();
  }

  private trigger(
    segment: ScriptSegment,
    index: number,
    confidence: number,
    hypothesis: string,
    at: number,
    source: TriggerEvent["source"]
  ): ScriptEngineSnapshot {
    const nextSegment = this.script.segments[index + 1] ?? null;
    this.lastTriggerSpeechSequence = this.speechSequence;
    this.log({ timestamp: at, event: "trigger", currentCue: this.state.currentSegment?.id ?? null, candidateCue: segment.id, source, decision: source, cursorFloor: this.cursor.floor });
    const speechOnsetAt = source === "manual" ? null : this.speechOnsetAt;
    // VAD marks a speech bout, not every line in an uninterrupted monologue.
    this.speechOnsetAt = null;
    // Only a caption that was actually on air can become Complete. Skips are not completions.
    const completed = new Set(this.state.completedIndexes.filter((completedIndex) => completedIndex < index));
    if (this.state.currentIndex >= 0 && this.state.currentIndex < index) completed.add(this.state.currentIndex);
    return {
      ...this.state,
      phase: "TRIGGERED",
      searchMode: "NORMAL",
      currentIndex: index,
      currentSegment: segment,
      displayedSegment: segment,
      nextSegment,
      confidence,
      partial: hypothesis,
      expected: nextSegment?.matchText[0] ?? "",
      lowConfidenceCount: 0,
      completedIndexes: [...completed].sort((left, right) => left - right),
      finished: false,
      lastTrigger: {
        segment,
        index,
        confidence,
        hypothesis,
        triggeredAt: at,
        speechOnsetAt,
        source
      }
    };
  }

  private candidateIndexes(): number[] {
    if (this.state.searchMode === "FULL_RESYNC") {
      return this.script.segments.map((_, index) => index);
    }
    const expectedNext = Math.max(0, this.state.currentIndex + 1);
    const start = this.state.searchMode === "RESYNC"
      ? Math.max(0, expectedNext - this.config.resyncLookbehind)
      : expectedNext;
    const length = this.state.searchMode === "RESYNC" ? this.config.resyncLookahead + this.config.resyncLookbehind + 1 : this.config.operatingMode === "PERFORMANCE_LOCAL" ? 1 : this.config.normalLookahead;
    const indexes = Array.from({ length }, (_, offset) => start + offset).filter((index) => index < this.script.segments.length);
    // An explicit IMAGE cue is a manual barrier; silence never creates or skips one.
    const barrier = indexes.findIndex((index) => index >= expectedNext && this.script.segments[index]?.type === "IMAGE");
    return barrier >= 0 ? indexes.slice(0, barrier) : indexes;
  }

  private timingPrior(profile: CueProfile | undefined, at: number): number {
    const previous = this.state.lastTrigger;
    if (!profile || !previous) return 0;
    const delta = at - previous.triggeredAt - profile.timing.medianAfterPreviousMs;
    const tolerance = delta < 0 ? profile.timing.earlyToleranceMs : profile.timing.lateToleranceMs;
    return Math.abs(delta) <= tolerance ? 1 : 0;
  }

  /** A fresh onset can arm fallback, but never dispatch a cue without ASR evidence. */
  private fallbackReadiness(at: number) {
    if (this.config.operatingMode !== "PERFORMANCE_LOCAL" || this.state.hold || !this.state.speechActive) return null;
    const index = this.state.currentIndex + 1;
    const segment = this.script.segments[index];
    const profile = this.profiles.find((profile) => profile.cueId === segment?.id) ?? segment?.profile;
    const previous = this.state.lastTrigger;
    if (!segment || segment.type === "IMAGE" || !profile?.fallback.enabled || profile.sampleCount < 3 || profile.confidence < 0.85 || !previous || previous.source === "fallback" || previous.confidence < 0.85 || this.state.searchMode !== "NORMAL") return null;
    if (this.speechSequence <= this.lastTriggerSpeechSequence || this.speechOnsetAt === null || this.speechOnsetAt <= previous.triggeredAt) return null;
    const timing = this.timingPrior(profile, at);
    if (!timing || !this.timingPrior(profile, this.speechOnsetAt)) return null;
    // No fallback chains, no pure timer cueing, no one-rehearsal calibration.
    const confidence = profile.confidence * 0.5 + timing * 0.3 + Math.min(1, profile.sampleCount / 5) * 0.2;
    if (confidence < Math.max(0.86, profile.thresholds.fallback)) return null;
    return { segment, index, confidence };
  }

  private fallbackCandidate(hypothesis: StreamingHypothesis, normalized: string) {
    if (!hypothesis.speechActive || hypothesis.confidence === null || !Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0.35 || normalized.length - this.cursor.floor < 3) return null;
    return this.fallbackReadiness(hypothesis.receivedAt);
  }

  setProfiles(profiles: CueProfile[]): void { this.profiles = parseCueProfiles(profiles); }

  private log(event: RuntimeTelemetryEvent): void {
    this.telemetry.push({ ...event, sequence: ++this.telemetrySequence });
    if (this.telemetry.length > this.config.telemetryLimit) this.telemetry.splice(0, this.telemetry.length - this.config.telemetryLimit);
  }

  exportTelemetry(): RuntimeTelemetryEvent[] { return structuredClone(this.telemetry); }

  markDisplayed(): ScriptEngineSnapshot {
    if (this.state.phase === "TRIGGERED") this.state = { ...this.state, phase: "DISPLAYING" };
    return this.snapshot();
  }

  snapshot(): ScriptEngineSnapshot {
    return { ...this.state };
  }
}
