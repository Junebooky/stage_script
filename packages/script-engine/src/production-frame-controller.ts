import { parseProductionPackageDraft, type ProductionFrame, type ProductionTrackingCue, type FrameColumn } from "@stage/script-schema";

export type FrameControlMode = "MANUAL" | "LOCATION_LOCK" | "BLACK_LOCK" | "BLACK_AUTO" | "AUTO_LIVE" | "HOLD";
export type ControlledView =
  | { kind: "BLACK" }
  | { kind: "TEXT"; frameId: string; columns: FrameColumn[] }
  | { kind: "IMAGE"; frameId: string; src: string; alt: string };
export interface FrameControlSnapshot {
  actId: string | null;
  mode: FrameControlMode;
  frameId: string | null;
  trackingCueId: string | null;
  expectedCueId: string | null;
  sessionId: string;
  generation: number;
  view: ControlledView;
}
/** Trusted matcher decision, not an ASR transcript. Generation must be captured at
 * audio ingestion, never stamped on a delayed result at delivery time. */
export interface MatchedCueEvent { sessionId: string; generation: number; sequence: number; cueId: string; skippedCueId?: string }

/** Experimental draft-only state machine. Not wired to ShowRuntime or a projector.
 * All automatic changes are forward, local to the selected act and explicit frames.
 * No timing fallback, no global search, no authority or approval bypass.
 */
export class ProductionFrameController {
  private readonly frames: ProductionFrame[];
  private readonly cues: ProductionTrackingCue[];
  private readonly acts: Set<string>;
  private readonly frameIndex: Map<string, number>;
  private readonly cueIndex: Map<string, number>;
  private actId: string | null = null;
  private mode: FrameControlMode = "BLACK_LOCK";
  private position = -1;
  private tracking = -1;
  private expected = -1;
  private readonly sessionId = crypto.randomUUID();
  private generation = 0;
  private lastSequence = -1;
  private view: ControlledView = { kind: "BLACK" };

  constructor(draft: unknown) {
    const p = parseProductionPackageDraft(draft);
    this.frames = p.frames;
    this.cues = p.trackingCues;
    this.acts = new Set(p.acts.map(a => a.id));
    this.frameIndex = new Map(this.frames.map((f, i) => [f.id, i]));
    this.cueIndex = new Map(this.cues.map((c, i) => [c.id, i]));
  }

  private invalidate(): void {
    this.generation += 1;
    this.lastSequence = -1;
    this.expected = -1;
  }
  private frameInAct(index: number): ProductionFrame | undefined {
    const frame = this.frames[index];
    return this.actId !== null && frame?.actId === this.actId ? frame : undefined;
  }
  private cueInAct(index: number): ProductionTrackingCue | undefined {
    const cue = this.cues[index];
    return this.actId !== null && cue?.actId === this.actId ? cue : undefined;
  }
  private firstFrame(): number { return this.frames.findIndex(f => f.actId === this.actId); }
  private paint(index: number, frame: ProductionFrame): void {
    this.position = index;
    switch (frame.kind) {
      case "BLACK": this.view = { kind: "BLACK" }; break;
      case "TEXT": this.view = { kind: "TEXT", frameId: frame.id, columns: structuredClone(frame.columns) }; break;
      case "IMAGE": this.view = { kind: "IMAGE", frameId: frame.id, src: frame.image.src, alt: frame.image.alt }; break;
    }
  }
  private lockMode(frame: ProductionFrame): FrameControlMode {
    return frame.kind === "BLACK" ? "BLACK_LOCK" : frame.kind === "TEXT" && frame.role === "LOCATION" ? "LOCATION_LOCK" : "MANUAL";
  }
  private isAudibleText(frame: ProductionFrame | undefined): frame is Extract<ProductionFrame, { kind: "TEXT" }> {
    return frame?.kind === "TEXT" && (frame.role === "LYRIC" || frame.role === "DIALOGUE" || frame.role === "NARRATION");
  }

  /** Explicit act selection is a preview boundary, not permission to GO live. */
  selectAct(actId: string): boolean {
    if (!this.acts.has(actId)) return false;
    this.invalidate();
    this.actId = actId;
    this.position = -1;
    this.tracking = -1;
    this.mode = "BLACK_LOCK";
    this.view = { kind: "BLACK" };
    return true;
  }
  endAct(): void {
    this.invalidate();
    this.actId = null;
    this.position = -1;
    this.tracking = -1;
    this.mode = "BLACK_LOCK";
    this.view = { kind: "BLACK" };
  }

  /** Manual selection always disarms automation and discards pending evidence. */
  manualShow(frameId: string): boolean {
    const index = this.frameIndex.get(frameId) ?? -1;
    const frame = this.frameInAct(index);
    if (!frame) return false;
    this.invalidate();
    this.tracking = -1;
    this.paint(index, frame);
    this.mode = this.lockMode(frame);
    return true;
  }
  manualNext(): boolean {
    const i = this.position === -1 ? this.firstFrame() : this.position + 1;
    const f = this.frameInAct(i);
    return !!f && this.manualShow(f.id);
  }
  manualPrevious(): boolean {
    const f = this.frameInAct(this.position - 1);
    return !!f && this.manualShow(f.id);
  }
  forceBlack(): void {
    this.invalidate();
    this.tracking = -1;
    this.mode = "BLACK_LOCK";
    this.view = { kind: "BLACK" };
  }
  hold(): void {
    this.invalidate();
    this.mode = "HOLD";
  }

  /** Operator chooses a scheduled black frame and arms only its immediate
   * next audible, speech-triggered frame. No silent skipping of manual barriers. */
  blackAuto(blackFrameId: string): boolean {
    const index = this.frameIndex.get(blackFrameId) ?? -1;
    const black = this.frameInAct(index);
    const next = this.frameInAct(index + 1);
    if (black?.kind !== "BLACK" || !this.isAudibleText(next) || next.trigger.kind !== "SPEECH") return false;
    const target = this.cueIndex.get(next.trigger.cueId) ?? -1;
    if (!this.cueInAct(target)) return false;
    this.invalidate();
    this.tracking = -1;
    this.paint(index, black);
    this.expected = target;
    this.mode = "BLACK_AUTO";
    return true;
  }

  /** Explicit resync/resume on an already displayed audible frame. A manually
   * locked location or forced black cannot be released implicitly. */
  resumeAuto(cueId: string): boolean {
    const current = this.frameInAct(this.position);
    if (!this.isAudibleText(current) || current.trigger.kind !== "SPEECH" || this.view.kind !== "TEXT" || this.view.frameId !== current.id) return false;
    const target = this.cueIndex.get(cueId) ?? -1;
    const cue = this.cueInAct(target);
    if (!cue) return false;
    const next = this.frameInAct(this.position + 1);
    const withinCurrent = cue.frameId === current.id;
    const nextTrigger = this.isAudibleText(next) && next.trigger.kind === "SPEECH" && next.trigger.cueId === cue.id;
    if (!withinCurrent && !nextTrigger) return false;
    this.invalidate();
    this.tracking = -1;
    this.expected = target;
    this.mode = "AUTO_LIVE";
    return true;
  }

  /** Accept exact-next or an engine-validated single skip INSIDE an already
   * visible frame. Never skip an unseen output frame or manual barrier. */
  acceptMatch(event: MatchedCueEvent): boolean {
    if (this.mode !== "BLACK_AUTO" && this.mode !== "AUTO_LIVE") return false;
    if (event.sessionId !== this.sessionId || event.generation !== this.generation || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= this.lastSequence) return false;
    this.lastSequence = event.sequence;
    let matchedIndex = this.expected;
    const expectedCue = this.cueInAct(this.expected);
    if (!expectedCue) return false;
    if (event.skippedCueId !== undefined) {
      const current = this.frameInAct(this.position);
      if (this.mode !== "AUTO_LIVE" || this.tracking < 0 || this.tracking + 1 !== this.expected ||
          !current || expectedCue.frameId !== current.id || expectedCue.id !== event.skippedCueId) return false;
      matchedIndex += 1;
    }
    const cue = this.cueInAct(matchedIndex);
    if (!cue || cue.id !== event.cueId) return false;
    const targetIndex = cue.frameId === undefined ? undefined : this.frameIndex.get(cue.frameId);
    if (this.mode === "BLACK_AUTO" && targetIndex !== this.position + 1) return false;
    if (targetIndex !== undefined && targetIndex !== this.position) {
      const target = this.frameInAct(targetIndex);
      if (targetIndex !== this.position + 1 || !this.isAudibleText(target) || target.trigger.kind !== "SPEECH" || target.trigger.cueId !== cue.id) return false;
      this.paint(targetIndex, target);
    }
    this.tracking = matchedIndex;
    this.expected = this.cueInAct(this.tracking + 1) ? this.tracking + 1 : -1;
    this.mode = "AUTO_LIVE";
    return true;
  }

  snapshot(): FrameControlSnapshot {
    return { actId: this.actId, mode: this.mode, frameId: this.frameInAct(this.position)?.id ?? null,
      trackingCueId: this.cueInAct(this.tracking)?.id ?? null, expectedCueId: this.cueInAct(this.expected)?.id ?? null,
      sessionId: this.sessionId, generation: this.generation, view: structuredClone(this.view) };
  }
}
