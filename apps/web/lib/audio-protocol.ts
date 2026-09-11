import type { StreamingHypothesis } from "@stage/alignment";

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
      receivedAt,
      speechActive: true
    };
  } catch {
    return null;
  }
}
