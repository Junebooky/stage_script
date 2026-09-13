import type { StreamingHypothesis } from "@stage/alignment";

/** Only a matching reset ACK can reopen the post-navigation recognition path. */
export class RecognitionGenerationGate {
  generation = 0;
  pending = false;
  reset() { this.generation = 0; this.pending = false; }
  advance() { this.pending = true; return ++this.generation; }
  acknowledge(generation: unknown): boolean {
    if (generation !== this.generation) return false;
    this.pending = false;
    return true;
  }
  accepts(generation: unknown): boolean { return !this.pending && generation === this.generation; }
}

// Server monotonic clocks have a different origin; matching uses browser receipt time.
export function decodeAudioHypothesis(raw: unknown, receivedAt: number): StreamingHypothesis | null {
  if (typeof raw !== "string") return null;
  try {
    const payload = JSON.parse(raw);
    if (payload.type !== "hypothesis" || typeof payload.text !== "string" || !payload.text.trim()) return null;
    if (typeof payload.confidence !== "number" || !Number.isFinite(payload.confidence)) return null;
    return {
      text: payload.text.trim(),
      confidence: Math.max(0, Math.min(1, payload.confidence)),
      isFinal: payload.is_final === true,
      utteranceId: typeof payload.utterance_id === "string" ? payload.utterance_id : undefined,
      streamId: typeof payload.stream_id === "string" ? payload.stream_id : undefined,
      contextText: typeof payload.context_text === "string" ? payload.context_text : undefined,
      receivedAt,
      speechActive: true
    };
  } catch {
    return null;
  }
}
