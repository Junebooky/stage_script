import { normalizeKorean, PrefixFuzzyMatcher, type MatchResult, type ScriptContext, type ScriptMatcher, type StreamingHypothesis } from "@stage/alignment";
import { ScriptFollowingEngine, type RuntimeTelemetryEvent } from "@stage/script-engine";
import type { PerformanceScript, ScriptSegment } from "@stage/script-schema";

export interface LiveObservation {
  sequence: number; receivedAtMs: number; sentAudioThroughMs: number;
  message: { type: string; text: string; confidence: number | null; utterance_id?: string;
    is_final: boolean; start_ms?: number; end_ms?: number; generation?: number };
}

/** A contiguous edit envelope. Preserves raw old/new text and explicitly marks
 * replacement vs pure append/delete; not a claim to be minimal edit distance. */
export function revisionDiff(previous: string, current: string) {
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(previous.length, current.length) && previous[prefix] === current[prefix]) prefix++;
  while (suffix < Math.min(previous.length, current.length) - prefix && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix++;
  const removed = previous.slice(prefix, previous.length - suffix);
  const added = current.slice(prefix, current.length - suffix);
  return { at: prefix, removed, added, kind: !removed && !added ? "unchanged" : !removed ? "addition" : !added ? "deletion" : "replacement" };
}

/** Measurement-only gate: baseline matching PLUS observed stability, never a
 * relaxed performance matcher. No reference, saved-word flag or audience API. */
export class StableShadowMatcher implements ScriptMatcher {
  private baseline = new PrefixFuzzyMatcher();
  private pending = new Map<string, { stream: string; anchor: string; since: number; text: string; updates: number }>();
  constructor(private readonly minimumMs = 150) {}
  match(h: StreamingHypothesis, cue: ScriptSegment, context: ScriptContext): MatchResult {
    const result = this.baseline.match(h, cue, context);
    const anchor = result.selectedAnchor;
    const stream = h.utteranceId ?? "unknown";
    if (!result.eligible || !anchor) { this.pending.delete(cue.id); return result; }
    let prior = this.pending.get(cue.id);
    if (!prior || prior.stream !== stream || !normalizeKorean(h.text).includes(prior.anchor)) {
      prior = { stream, anchor, since: h.receivedAt, text: h.text, updates: 1 };
      this.pending.set(cue.id, prior);
    } else if (prior.text !== h.text) { prior.updates++; prior.text = h.text; }
    const stable = prior.updates >= 2 && h.receivedAt - prior.since >= this.minimumMs;
    return { ...result, eligible: stable, reason: stable ? "shadow-stable-baseline-evidence" : "shadow-awaiting-evidence-stability" };
  }
}

export function evaluateStreamingShadows(script: PerformanceScript, observations: LiveObservation[]) {
  if (script.segments.some((cue) => cue.profile)) throw new Error("Shadow measurement requires fallback OFF / no profiles");
  const ordered = observations.filter((event) => event.message.type === "hypothesis");
  if (ordered.some((event, i) => !Number.isFinite(event.receivedAtMs) || (i > 0 && event.receivedAtMs < ordered[i - 1]!.receivedAtMs))) throw new Error("Non-monotonic observation clock");
  const revisions: { sequence: number; utteranceId: string; atMs: number; text: string; previousText: string | null;
    previousHeldMs: number | null; edit: ReturnType<typeof revisionDiff> | null; isFinal: boolean }[] = [];
  const previous = new Map<string, LiveObservation>();
  for (const event of ordered) {
    const stream = event.message.utterance_id ?? "unknown", prior = previous.get(stream);
    revisions.push({ sequence: event.sequence, utteranceId: stream, atMs: event.receivedAtMs, text: event.message.text,
      previousText: prior?.message.text ?? null, previousHeldMs: prior ? event.receivedAtMs - prior.receivedAtMs : null,
      edit: prior ? revisionDiff(prior.message.text, event.message.text) : null, isFinal: event.message.is_final });
    previous.set(stream, event);
  }
  const run = (stable: boolean) => {
    const engine = new ScriptFollowingEngine(script, stable ? new StableShadowMatcher() : undefined,
      { operatingMode: "PERFORMANCE_LOCAL", profiles: [] });
    engine.arm();
    const triggers: { cueId: string; atMs: number; source: string; sequence: number; utteranceId: string; anchor: string;
      laterRemovalAtMs: number | null; laterRemovalWindowShift: boolean | null; evidenceHeldMs: number | null }[] = [];
    const progression: { sequence: number; atMs: number; candidate: string | null; trace: RuntimeTelemetryEvent[] }[] = [];
    let lastStream: string | undefined;
    for (const event of ordered) {
      const msg = event.message;
      const before = engine.snapshot();
      const traceFrom = engine.exportTelemetry().at(-1)?.sequence ?? 0;
      if (lastStream !== msg.utterance_id) { engine.speechStart(event.receivedAtMs); lastStream = msg.utterance_id; }
      engine.processHypothesis({ text: msg.text, confidence: msg.confidence, confidenceBasis: "segment-logprob-derived",
        receivedAt: event.receivedAtMs, speechActive: true, utteranceId: msg.utterance_id, isFinal: msg.is_final });
      const trace = engine.exportTelemetry().filter((item) => (item.sequence ?? 0) > traceFrom);
      progression.push({ sequence: event.sequence, atMs: event.receivedAtMs, candidate: before.nextSegment?.id ?? null, trace });
      const after = engine.snapshot();
      if (after.lastTrigger && after.lastTrigger !== before.lastTrigger) {
        const match = trace.filter((item) => item.event === "matcher").at(-1)?.match;
        const anchor = match?.selectedAnchor ?? "";
        // Cancellations are review signals, NOT proof of a wrong cue. Rolling
        // window eviction can remove correct text. Do not equate the two rates.
        const later = ordered.find((item) => item.sequence > event.sequence && item.message.utterance_id === msg.utterance_id && anchor && !normalizeKorean(item.message.text).includes(anchor));
        triggers.push({ cueId: after.lastTrigger.segment.id, atMs: event.receivedAtMs, source: after.lastTrigger.source,
          sequence: event.sequence, utteranceId: msg.utterance_id ?? "unknown", anchor,
          laterRemovalAtMs: later?.receivedAtMs ?? null,
          laterRemovalWindowShift: later ? (later.message.start_ms ?? 0) > (msg.start_ms ?? 0) : null,
          evidenceHeldMs: later ? later.receivedAtMs - event.receivedAtMs : null });
      }
      if (msg.is_final) engine.speechEnd();
    }
    const byCue = script.segments.map((cue) => {
      const eligible = progression.flatMap((step) => step.trace.filter((trace) => trace.candidateCue === cue.id && trace.event === "matcher" &&
        trace.decision !== "previous-cue-trailing-evidence" &&
        (trace.match?.eligible || trace.match?.reason === "shadow-awaiting-evidence-stability")).map((trace) => ({ step, trace })));
      const first = eligible.find((item) => !ordered.find((event) => event.sequence === item.step.sequence)?.message.is_final);
      const trigger = triggers.find((item) => item.cueId === cue.id);
      const stream = first ? ordered.find((item) => item.sequence === first.step.sequence)?.message.utterance_id : undefined;
      const final = stream ? ordered.find((item) => item.message.utterance_id === stream && item.message.is_final && item.receivedAtMs >= first!.step.atMs) : undefined;
      return { cueId: cue.id, t0: null, t1: null, t2: first?.step.atMs ?? null,
        t3: stable ? trigger?.atMs ?? null : null, t4: final?.receivedAtMs ?? null, t5: trigger?.atMs ?? null,
        latency: { t1: null, t2: null, t3: null, t5: null },
        note: "t2/t3/t5 are observed candidate/decision times relative to stream origin, NOT onset-relative latency; t4 is containing-ASR-utterance final, not a cue-specific final. Requires independent reviewed onset attribution." };
    });
    return { triggers, progression, byCue, emittedCount: triggers.length,
      notTriggeredCount: script.segments.length - new Set(triggers.map((item) => item.cueId)).size,
      anchorRemovalCount: triggers.filter((item) => item.laterRemovalAtMs !== null).length,
      anchorRemovalRate: triggers.length ? triggers.filter((item) => item.laterRemovalAtMs !== null).length / triggers.length : null,
      unsafeEarlyTriggerRate: null, reason: "Independent audio review required; anchor removal is not acoustic ground truth" };
  };
  const comparable = revisions.filter((item) => item.edit !== null && !item.isFinal);
  const rewritten = comparable.filter((item) => item.edit!.kind === "replacement" || item.edit!.kind === "deletion");
  return { version: 1, mode: "real-local-asr-shadow-only", stabilityRule: "baseline eligible evidence retained across >=2 distinct texts and >=150 ms; no final bypass",
    hypotheses: ordered.length, partials: ordered.filter((e) => !e.message.is_final).length, finals: ordered.filter((e) => e.message.is_final).length,
    revisions, revisionRate: comparable.length ? rewritten.length / comparable.length : null,
    revisionNumerator: rewritten.length, revisionDenominator: comparable.length,
    immediate: run(false), stable: run(true) };
}
