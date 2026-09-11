import { PrefixFuzzyMatcher, type MatchResult, type ScriptMatcher, type StreamingHypothesis } from "@stage/alignment";
import type { PerformanceScript, ScriptSegment } from "@stage/script-schema";

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
  triggerCooldownMs: 420
};

export class ScriptFollowingEngine {
  private readonly matcher: ScriptMatcher;
  private readonly config: EngineConfig;
  private state: ScriptEngineSnapshot;
  private speechOnsetAt: number | null = null;

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
      lastTrigger: null
    };
  }

  arm(): ScriptEngineSnapshot {
    if (this.state.phase === "IDLE") this.state = { ...this.state, phase: "ARMED" };
    return this.snapshot();
  }

  reset(): ScriptEngineSnapshot {
    this.state = this.initialState();
    this.speechOnsetAt = null;
    return this.arm();
  }

  speechStart(at: number): ScriptEngineSnapshot {
    this.speechOnsetAt = at;
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
    return this.manualMove(Math.min(this.script.segments.length - 1, this.state.currentIndex + 1), at);
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
    if (this.state.hold || !hypothesis.text.trim()) return this.snapshot();
    const candidates = this.candidateIndexes();
    let best: { index: number; result: MatchResult } | null = null;

    for (const index of candidates) {
      const segment = this.script.segments[index];
      if (!segment) continue;
      const expectedNext = Math.max(0, this.state.currentIndex + 1);
      const result = this.matcher.match(hypothesis, segment, {
        candidateOffset: Math.abs(index - expectedNext),
        mode: this.state.searchMode
      });
      if (!best || result.score > best.result.score) best = { index, result };
    }

    if (!best) return this.snapshot();
    const segment = this.script.segments[best.index]!;
    const nextLowCount = best.result.eligible ? 0 : this.state.lowConfidenceCount + 1;
    const lastAt = this.state.lastTrigger?.triggeredAt ?? Number.NEGATIVE_INFINITY;
    const cooledDown = hypothesis.receivedAt - lastAt >= this.config.triggerCooldownMs;

    if (best.result.eligible && cooledDown) {
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
      lastTrigger: {
        segment,
        index,
        confidence,
        hypothesis,
        triggeredAt: at,
        speechOnsetAt: source === "manual" ? null : this.speechOnsetAt,
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
