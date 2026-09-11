import { normalizeKorean, PrefixFuzzyMatcher, type MatchResult, type ScriptMatcher, type StreamingHypothesis } from "@stage/alignment";
import type { PerformanceScript, ScriptSegment } from "@stage/script-schema";
import { HypothesisCursor } from "./hypothesis-cursor";

export type EnginePhase =
  | "IDLE"
  | "ARMED"
  | "LISTENING"
  | "MATCHING"
  | "TRIGGERED"
  | "DISPLAYING"
  | "LOW_CONFIDENCE"
  | "RESYNC";

export type SearchMode = "NORMAL" | "RESYNC" | "FULL_RESYNC";

export interface TriggerEvent {
  segment: ScriptSegment;
  index: number;
  confidence: number;
  hypothesis: string;
  triggeredAt: number;
  speechOnsetAt: number | null;
  source: "automatic" | "manual";
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
}

const defaultConfig: EngineConfig = {
  normalLookahead: 3,
  resyncLookbehind: 5,
  resyncLookahead: 10,
  lowConfidenceAttempts: 4,
  fullResyncAttempts: 9,
  triggerCooldownMs: 0
};

export class ScriptFollowingEngine {
  private readonly matcher: ScriptMatcher;
  private readonly config: EngineConfig;
  private state: ScriptEngineSnapshot;
  private speechOnsetAt: number | null = null;
  private readonly cursor = new HypothesisCursor();
  private speechSequence = 0;

  constructor(
    private readonly script: PerformanceScript,
    matcher: ScriptMatcher = new PrefixFuzzyMatcher(),
    config: Partial<EngineConfig> = {}
  ) {
    this.matcher = matcher;
    this.config = { ...defaultConfig, ...config };
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
    this.cursor.discard();
    return this.arm();
  }

  speechStart(at: number): ScriptEngineSnapshot {
    this.speechOnsetAt = at;
    this.speechSequence += 1;
    this.state = { ...this.state, phase: "LISTENING", speechActive: true };
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
    this.state = { ...this.state, hold: !this.state.hold };
    return this.snapshot();
  }

  setHold(hold: boolean): ScriptEngineSnapshot {
    this.state = { ...this.state, hold };
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
    this.state = this.trigger(segment, index, 1, "MANUAL", at, "manual");
    return this.snapshot();
  }

  forceResync(): ScriptEngineSnapshot {
    this.state = { ...this.state, phase: "RESYNC", searchMode: "RESYNC", lowConfidenceCount: 0 };
    return this.snapshot();
  }

  processHypothesis(hypothesis: StreamingHypothesis): ScriptEngineSnapshot {
    if (this.state.hold || this.state.finished || !hypothesis.text.trim()) return this.snapshot();
    const normalized = normalizeKorean(hypothesis.contextText ?? hypothesis.text);
    const stream = hypothesis.streamId ?? hypothesis.utteranceId ?? `speech-${this.speechSequence}`;
    if (!this.cursor.update(stream, normalized)) return this.snapshot();
    const candidates = this.candidateIndexes();
    let best: { index: number; result: MatchResult } | null = null;

    for (const index of candidates) {
      const segment = this.script.segments[index];
      if (!segment) continue;
      const expectedNext = Math.max(0, this.state.currentIndex + 1);
      let offset = Math.max(this.cursor.floor, normalized.length - 512);
      while (offset < normalized.length) {
        const result = this.matcher.match({ ...hypothesis, text: normalized.slice(offset) }, segment, {
          candidateOffset: Math.abs(index - expectedNext),
          mode: this.state.searchMode
        });
        result.start += offset;
        result.end += offset;
        if (result.eligible && this.cursor.isCurrentLine(result.start, result.end)) {
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

    let searchMode = this.state.searchMode;
    let phase: EnginePhase = "MATCHING";
    if (nextLowCount >= this.config.fullResyncAttempts) {
      searchMode = "FULL_RESYNC";
      phase = "RESYNC";
    } else if (nextLowCount >= this.config.lowConfidenceAttempts) {
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

  private trigger(
    segment: ScriptSegment,
    index: number,
    confidence: number,
    hypothesis: string,
    at: number,
    source: TriggerEvent["source"]
  ): ScriptEngineSnapshot {
    const nextSegment = this.script.segments[index + 1] ?? null;
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
    const length = this.state.searchMode === "RESYNC" ? this.config.resyncLookahead + this.config.resyncLookbehind + 1 : this.config.normalLookahead;
    return Array.from({ length }, (_, offset) => start + offset).filter((index) => index < this.script.segments.length);
  }

  markDisplayed(): ScriptEngineSnapshot {
    if (this.state.phase === "TRIGGERED") this.state = { ...this.state, phase: "DISPLAYING" };
    return this.snapshot();
  }

  snapshot(): ScriptEngineSnapshot {
    return { ...this.state };
  }
}
