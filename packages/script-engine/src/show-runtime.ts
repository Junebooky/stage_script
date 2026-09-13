import { flattenShow, parseCueProfiles, parseShow, type Act, type CueProfile, type OperatingMode, type PerformanceScript, type Show } from "@stage/script-schema";
import type { StreamingHypothesis } from "@stage/alignment";
import { ScriptFollowingEngine, type EngineConfig, type RuntimeTelemetryEvent, type ScriptEngineSnapshot } from "./index";

export type ShowPhase = "PRE_SHOW" | "ACT_ARMED" | "ACT_LIVE" | "ACT_COMPLETE" | "INTERMISSION" | "SHOW_COMPLETE";
export type IntermissionOutput = "black" | "clear" | "last-caption";
export interface RuntimeReadiness { microphone: boolean; asr: boolean; assets: boolean; output: boolean }
export interface ShowRuntimeSnapshot {
  phase: ShowPhase;
  actIndex: number;
  act: Act | null;
  script: PerformanceScript;
  engine: ScriptEngineSnapshot;
  output: "live" | IntermissionOutput;
  readiness: RuntimeReadiness;
  ready: boolean;
  relativeClockStartedAt: number | null;
  operatingMode: OperatingMode;
  manualOnly: boolean;
}
export interface ShowRuntimeConfig extends Partial<EngineConfig> { intermissionOutput?: IntermissionOutput }

/** The operator owns act boundaries. Audience windows only render its snapshot. */
export class ShowRuntime {
  readonly show: Show;
  private phase: ShowPhase = "PRE_SHOW";
  private actIndex = -1;
  private script: PerformanceScript;
  private engine: ScriptFollowingEngine;
  private readiness: RuntimeReadiness = { microphone: false, asr: false, assets: false, output: false };
  private clockStartedAt: number | null = null;
  private profiles: CueProfile[];
  private readonly events: RuntimeTelemetryEvent[] = [];
  private readonly config: ShowRuntimeConfig;
  private manualOnly = false;
  private lastHypothesis: StreamingHypothesis | null = null;

  constructor(show: Show, config: ShowRuntimeConfig = {}) {
    this.show = parseShow(show);
    this.config = { ...config, operatingMode: config.operatingMode ?? "PERFORMANCE_LOCAL", intermissionOutput: config.intermissionOutput ?? "black" };
    this.profiles = parseCueProfiles(config.profiles ?? []);
    this.script = flattenShow(this.show, this.show.acts[0]!.id);
    this.engine = this.createEngine();
    if (this.lastHypothesis) this.engine.checkpointHypothesis(this.lastHypothesis);
  }

  private createEngine() { return new ScriptFollowingEngine(this.script, undefined, { ...this.config, profiles: this.profiles }); }
  private transition(phase: ShowPhase, at: number) {
    this.events.push({ timestamp: at, event: "show-state", currentCue: this.engine.snapshot().currentSegment?.id ?? null, transition: `${this.phase}→${phase}` });
    if (this.events.length > 2000) this.events.shift();
    this.phase = phase;
  }

  armAct(index = this.actIndex + 1, at = Date.now()): ShowRuntimeSnapshot {
    if (!Number.isInteger(index) || !this.show.acts[index]) return this.snapshot();
    if (this.phase === "ACT_LIVE" || this.phase === "ACT_ARMED" || this.phase === "SHOW_COMPLETE") return this.snapshot();
    // Sequential acts require explicit intermission after completion.
    if (this.phase === "ACT_COMPLETE" || index !== this.actIndex + 1) return this.snapshot();
    this.events.push(...this.engine.exportTelemetry());
    this.actIndex = index;
    this.script = flattenShow(this.show, this.show.acts[index]!.id);
    this.engine = this.createEngine();
    if (this.lastHypothesis) this.engine.checkpointHypothesis(this.lastHypothesis);
    this.engine.arm();
    this.clockStartedAt = null;
    this.readiness = { microphone: false, asr: false, assets: false, output: false };
    this.transition("ACT_ARMED", at);
    return this.snapshot();
  }

  setReadiness(readiness: Partial<RuntimeReadiness>): ShowRuntimeSnapshot {
    this.readiness = { ...this.readiness, ...readiness };
    return this.snapshot();
  }

  setManualOnly(value: boolean): ShowRuntimeSnapshot {
    if (this.phase !== "ACT_LIVE") this.manualOnly = value;
    return this.snapshot();
  }

  private isReady() { return this.readiness.assets && this.readiness.output && (this.manualOnly || (this.readiness.microphone && this.readiness.asr)); }

  go(at: number): ShowRuntimeSnapshot {
    if (this.phase !== "ACT_ARMED" || !this.isReady()) return this.snapshot();
    this.clockStartedAt = at;
    this.engine.reset();
    this.transition("ACT_LIVE", at);
    return this.snapshot();
  }

  completeAct(at: number): ShowRuntimeSnapshot {
    if (this.phase !== "ACT_LIVE" || this.engine.snapshot().currentIndex !== this.script.segments.length - 1) return this.snapshot();
    this.engine.finish();
    this.engine.setHold(true);
    this.transition(this.actIndex === this.show.acts.length - 1 ? "SHOW_COMPLETE" : "ACT_COMPLETE", at);
    return this.snapshot();
  }

  enterIntermission(at = Date.now()): ShowRuntimeSnapshot {
    if (this.phase !== "ACT_COMPLETE") return this.snapshot();
    this.clockStartedAt = null;
    this.transition("INTERMISSION", at);
    return this.snapshot();
  }

  manualNext(at: number): ShowRuntimeSnapshot {
    if (this.phase !== "ACT_LIVE") return this.snapshot();
    if (this.engine.snapshot().currentIndex === this.script.segments.length - 1) return this.completeAct(at);
    this.engine.manualNext(at);
    return this.snapshot();
  }
  manualPrevious(at: number): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE") this.engine.manualPrevious(at); return this.snapshot(); }
  jumpTo(index: number, at: number): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE") this.engine.jumpTo(index, at); return this.snapshot(); }
  processHypothesis(hypothesis: StreamingHypothesis): ShowRuntimeSnapshot {
    this.lastHypothesis = hypothesis;
    if (this.phase === "ACT_LIVE" && !this.manualOnly) this.engine.processHypothesis(hypothesis);
    else this.engine.checkpointHypothesis(hypothesis);
    return this.snapshot();
  }
  speechStart(at: number): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE" && !this.manualOnly) this.engine.speechStart(at); return this.snapshot(); }
  speechEnd(): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE" && !this.manualOnly) this.engine.speechEnd(); return this.snapshot(); }
  toggleHold(): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE") this.engine.toggleHold(); return this.snapshot(); }
  setHold(hold: boolean): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE") this.engine.setHold(hold); return this.snapshot(); }
  forceResync(at = Date.now()): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE") this.engine.forceResync(at); return this.snapshot(); }
  markDisplayed(): ShowRuntimeSnapshot { if (this.phase === "ACT_LIVE") this.engine.markDisplayed(); return this.snapshot(); }

  setProfiles(profiles: CueProfile[]): boolean {
    if (this.phase === "ACT_LIVE") return false;
    this.profiles = parseCueProfiles(profiles);
    this.engine.setProfiles(this.profiles);
    return true;
  }

  reset(at = Date.now()): ShowRuntimeSnapshot {
    this.events.push(...this.engine.exportTelemetry());
    this.actIndex = -1;
    this.script = flattenShow(this.show, this.show.acts[0]!.id);
    this.engine = this.createEngine();
    if (this.lastHypothesis) this.engine.checkpointHypothesis(this.lastHypothesis);
    this.clockStartedAt = null;
    this.readiness = { microphone: false, asr: false, assets: false, output: false };
    this.transition("PRE_SHOW", at);
    return this.snapshot();
  }

  snapshot(): ShowRuntimeSnapshot {
    const output = this.phase === "ACT_LIVE" || this.phase === "ACT_COMPLETE" ? "live" : this.phase === "INTERMISSION" || this.phase === "SHOW_COMPLETE" ? this.config.intermissionOutput! : "black";
    return { phase: this.phase, actIndex: this.actIndex, act: this.show.acts[this.actIndex] ?? null, script: this.script, engine: this.engine.snapshot(), output, readiness: { ...this.readiness }, ready: this.isReady(), relativeClockStartedAt: this.clockStartedAt, operatingMode: this.config.operatingMode!, manualOnly: this.manualOnly };
  }

  exportTelemetry(): RuntimeTelemetryEvent[] { return structuredClone([...this.events, ...this.engine.exportTelemetry()].slice(-4000).sort((a, b) => a.timestamp - b.timestamp)); }
}
