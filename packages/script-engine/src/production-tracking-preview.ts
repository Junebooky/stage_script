import { DiscriminativeWordMatcher, type ScriptMatcher, type StreamingHypothesis } from "@stage/alignment";
import { parseProductionPackageDraft, type ProductionPackageDraft, type ProductionFrame, type ScriptSegment } from "@stage/script-schema";
import { ScriptFollowingEngine } from "./index";
import { ProductionFrameController, type FrameControlSnapshot } from "./production-frame-controller";

export interface PreviewRecognitionEpoch { sessionId: string; generation: number }
export interface PreviewHypothesis extends PreviewRecognitionEpoch { sequence: number; hypothesis: StreamingHypothesis }
export type PreviewRecognitionResult = "ignored" | "listening" | "matched" | "blocked";
export interface ProductionPreviewSnapshot extends FrameControlSnapshot {
  recognitionReady: boolean;
  fault: "FRAME_GATE_REJECTED" | null;
}

/** Draft preview only. This class has no projector publisher, no approval bypass,
 * no network or device ownership. The trusted audio adapter must tag audio at
 * ingestion, reset the provider, and attest the matching reset ACK.
 */
export class ProductionTrackingPreview {
  private readonly draft: ProductionPackageDraft;
  private readonly controller: ProductionFrameController;
  private engine: ScriptFollowingEngine | null = null;
  private segments: ScriptSegment[] = [];
  private ready = false;
  private lastSequence = -1;
  private lastReceivedAt = Number.NEGATIVE_INFINITY;
  private fault: ProductionPreviewSnapshot["fault"] = null;

  constructor(input: unknown) {
    this.draft = parseProductionPackageDraft(input);
    this.controller = new ProductionFrameController(this.draft);
  }

  snapshot(): ProductionPreviewSnapshot {
    return { ...this.controller.snapshot(), recognitionReady: this.ready, fault: this.fault };
  }
  private invalidate(): void {
    this.engine = null;
    this.segments = [];
    this.ready = false;
    this.lastSequence = -1;
    this.lastReceivedAt = Number.NEGATIVE_INFINITY;
    this.fault = null;
  }
  private control(action: () => boolean): boolean {
    if (!action()) return false;
    this.invalidate();
    return true;
  }
  selectAct(id: string): boolean { return this.control(() => this.controller.selectAct(id)); }
  endAct(): void { this.controller.endAct(); this.invalidate(); }
  manualShow(id: string): boolean { return this.control(() => this.controller.manualShow(id)); }
  manualNext(): boolean { return this.control(() => this.controller.manualNext()); }
  manualPrevious(): boolean { return this.control(() => this.controller.manualPrevious()); }
  forceBlack(): void { this.controller.forceBlack(); this.invalidate(); }
  hold(): void { this.controller.hold(); this.invalidate(); }
  blackAuto(id: string): boolean {
    if (!this.control(() => this.controller.blackAuto(id))) return false;
    return this.prepareMatcher();
  }
  resumeAuto(cueId: string): boolean {
    if (!this.control(() => this.controller.resumeAuto(cueId))) return false;
    return this.prepareMatcher();
  }

  private prepareMatcher(): boolean {
    const state = this.controller.snapshot();
    const cues = this.draft.trackingCues.filter(c => c.actId === state.actId);
    const start = cues.findIndex(c => c.id === state.expectedCueId);
    const frames = this.draft.frames.filter(f => f.actId === state.actId);
    const current = frames.findIndex(f => f.id === state.frameId);
    if (start < 0 || current < 0) { this.hold(); return false; }
    const audible = (f: ProductionFrame) => f.kind === "TEXT" &&
      (f.role === "LYRIC" || f.role === "DIALOGUE" || f.role === "NARRATION") && f.trigger.kind === "SPEECH";
    const allowed = new Set<string>();
    for (let i = current; i < frames.length; i++) {
      const f = frames[i]!;
      if (i === current && state.mode === "BLACK_AUTO") continue;
      if (!audible(f)) break;
      allowed.add(f.id);
    }
    // Private matcher-only projections. No fake speech, no display text, never
    // serialized as a legacy canonical show or sent to CaptionDisplay.
    const context: ScriptSegment[] = cues.map((c, order) => ({
      id: c.id, order, type: c.kind === "LYRIC" ? "SOLO" : "CAPTION",
      captions: [], matchText: [...c.matchText],
    }));
    const end = cues.findIndex((c, i) => i >= start && (!c.frameId || !allowed.has(c.frameId)));
    this.segments = context.slice(start, end < 0 ? undefined : end);
    if (!this.segments.length) { this.hold(); return false; }
    // Keep negative examples on both sides of the active window. They cannot
    // trigger across the barrier, but can suppress an ambiguous leading word.
    const index = new Map(context.map((c, i) => [c.id, i]));
    const matcher = new DiscriminativeWordMatcher();
    const contextual: ScriptMatcher = { match: (h, c, ctx) => {
      const i = index.get(c.id)!;
      return matcher.match(h, c, { ...ctx, nearbySegments: context.slice(Math.max(0, i - 3), i + 4) });
    } };
    this.engine = new ScriptFollowingEngine({ title: this.draft.title, locale: this.draft.locale, segments: this.segments }, contextual,
      { operatingMode: "PERFORMANCE_LOCAL", profiles: [] });
    this.engine.arm();
    return true;
  }

  private currentEpoch(epoch: PreviewRecognitionEpoch): boolean {
    const s = this.controller.snapshot();
    return epoch.sessionId === s.sessionId && epoch.generation === s.generation;
  }
  /** Only the trusted provider adapter may call after reset acknowledgment.
   * No implicit readiness on receipt of a transcript. */
  acknowledgeRecognitionReset(epoch: PreviewRecognitionEpoch): boolean {
    if (!this.engine || !this.currentEpoch(epoch)) return false;
    this.ready = true;
    return true;
  }

  processHypothesis(event: PreviewHypothesis): PreviewRecognitionResult {
    if (!this.engine || !this.ready || !this.currentEpoch(event)) return "ignored";
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= this.lastSequence) return "ignored";
    const h = event.hypothesis;
    if (!h.boundaryVerified || h.evidenceBasis === "saved-completed-words" || !Number.isFinite(h.receivedAt) || h.receivedAt < this.lastReceivedAt) return "ignored";
    this.lastSequence = event.sequence;
    this.lastReceivedAt = h.receivedAt;
    const before = this.engine.snapshot();
    const after = this.engine.processHypothesis(h);
    if (!after.lastTrigger || after.lastTrigger === before.lastTrigger) return "listening";
    const trigger = after.lastTrigger;
    // Only actual engine evidence is accepted. Fallback/manual trigger routes
    // cannot enter this gate; profiles and pre-recorded timing are absent.
    const skip = trigger.index - before.currentIndex - 1;
    const skipped = skip === 1 && after.skippedIndexes.includes(trigger.index - 1) ? this.segments[trigger.index - 1]?.id : undefined;
    if (trigger.source !== "automatic" || skip < 0 || skip > 1 || (skip === 1 && !skipped) ||
        !this.controller.acceptMatch({ sessionId: event.sessionId, generation: event.generation, sequence: event.sequence,
          cueId: trigger.segment.id, ...(skipped ? { skippedCueId: skipped } : {}) })) {
      // Engine cursor has advanced but the output did not. Never silently
      // continue with inconsistent pointers; operator must explicitly resume.
      this.hold();
      this.fault = "FRAME_GATE_REJECTED";
      return "blocked";
    }
    return "matched";
  }
}
