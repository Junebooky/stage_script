"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamingHypothesis } from "@stage/alignment";
import { BrowserSpeechASRAdapter, type ASRStatus } from "@/lib/browser-speech-asr";

/** Explicit online preview, never an automatic fallback from local performance. */
export function useBrowserPerformanceASR(enabled: boolean, onHypothesis: (hypothesis: StreamingHypothesis) => void) {
  const [status, setStatus] = useState<ASRStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const adapterRef = useRef<BrowserSpeechASRAdapter | null>(null);
  const callbackRef = useRef(onHypothesis);
  const epochRef = useRef(0);
  useEffect(() => { callbackRef.current = onHypothesis; }, [onHypothesis]);
  const stop = useCallback(() => {
    const previous = adapterRef.current;
    adapterRef.current = null; // Invalidate callbacks before abort can deliver a late final.
    previous?.stop();
    setStatus("idle");
  }, []);
  const start = useCallback(() => {
    if (!enabled) return;
    stop();
    const epoch = ++epochRef.current;
    setError(null);
    const adapter = new BrowserSpeechASRAdapter((hypothesis) => {
      if (adapterRef.current !== adapter) return;
      callbackRef.current({ ...hypothesis, streamId: `preview-${epoch}-${hypothesis.streamId}`,
        utteranceId: `preview-${epoch}-${hypothesis.utteranceId}` });
    }, (next, detail) => {
      if (adapterRef.current !== adapter) return;
      setStatus(next);
      if (detail) setError(detail);
    });
    adapterRef.current = adapter;
    adapter.start();
  }, [enabled, stop]);
  const reset = useCallback(() => { if (adapterRef.current) start(); }, [start]);
  useEffect(() => () => {
    const previous = adapterRef.current;
    adapterRef.current = null;
    previous?.stop();
  }, []);
  return { start, stop, reset, status, error, ready: status === "listening" };
}
