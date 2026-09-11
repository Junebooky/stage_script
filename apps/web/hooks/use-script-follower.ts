"use client";

import type { StreamingHypothesis } from "@stage/alignment";
import { ScriptFollowingEngine, type ScriptEngineSnapshot } from "@stage/script-engine";
import { demoScript, type SegmentType } from "@stage/script-schema";
import { LatencyTracker, type LatencySnapshot } from "@stage/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserSpeechASRAdapter } from "@/lib/browser-speech-asr";
import { useMicrophone } from "./use-microphone";

const EMPTY_LATENCY: LatencySnapshot = { last: null, p50: null, p95: null, p99: null, samples: 0 };

export function useScriptFollower() {
  const engineRef = useRef<ScriptFollowingEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new ScriptFollowingEngine(demoScript);
    engineRef.current.arm();
  }
  const [snapshot, setSnapshot] = useState<ScriptEngineSnapshot>(() => engineRef.current!.snapshot());
  const [latency, setLatency] = useState<LatencySnapshot>(EMPTY_LATENCY);
  const [asrStatus, setAsrStatus] = useState<"idle" | "listening" | "error" | "unavailable">("idle");
  const [notice, setNotice] = useState("SIMULATION READY");
  const latencyRef = useRef(new LatencyTracker());
  const partialStepRef = useRef(0);
  const asrRef = useRef<BrowserSpeechASRAdapter | null>(null);

  const publish = useCallback((next: ScriptEngineSnapshot) => setSnapshot(next), []);

  const processHypothesis = useCallback((hypothesis: StreamingHypothesis) => {
    const engine = engineRef.current!;
    const previousIndex = engine.snapshot().currentIndex;
    const next = engine.processHypothesis(hypothesis);
    if (next.currentIndex !== previousIndex) {
      partialStepRef.current = 0;
      setNotice(`${next.currentSegment?.type ?? "SEGMENT"} CUE LOCKED`);
    } else if (next.phase === "RESYNC" || next.phase === "LOW_CONFIDENCE") {
      setNotice("SEARCH WINDOW EXPANDED");
    }
    publish(next);
  }, [publish]);

  const onSpeechStart = useCallback((at: number) => {
    setNotice("VOICE ACTIVITY DETECTED");
    publish(engineRef.current!.speechStart(at));
  }, [publish]);

  const onSpeechEnd = useCallback(() => {
    setNotice("PAUSE — POINTER HELD");
    publish(engineRef.current!.speechEnd());
  }, [publish]);

  const microphone = useMicrophone({ onSpeechStart, onSpeechEnd });

  useEffect(() => {
    const adapter = new BrowserSpeechASRAdapter(processHypothesis, (status) => setAsrStatus(status));
    asrRef.current = adapter;
    if (!adapter.available) setAsrStatus("unavailable");
    return () => adapter.stop();
  }, [processHypothesis]);

  const startLive = useCallback(async () => {
    const started = await microphone.start();
    if (started) {
      asrRef.current?.start();
      setNotice(asrRef.current?.available ? "LIVE SCRIPT FOLLOWING" : "AUDIO REACTIVE MODE");
    }
  }, [microphone]);

  const stopLive = useCallback(async () => {
    asrRef.current?.stop();
    await microphone.stop();
    setNotice("SIMULATION READY");
  }, [microphone]);

  const ensureSimulationSpeech = useCallback(() => {
    const current = engineRef.current!.snapshot();
    if (!current.speechActive || partialStepRef.current === 0) {
      publish(engineRef.current!.speechStart(performance.now()));
    }
  }, [publish]);

  const nextPartial = useCallback(() => {
    const engine = engineRef.current!;
    const current = engine.snapshot();
    const target = demoScript.segments[current.currentIndex + 1];
    if (!target) {
      setNotice("END OF SCRIPT");
      return;
    }
    ensureSimulationSpeech();
    const source = target.matchText[0]!;
    const ratios = [0.18, 0.36, 0.58, 0.82, 1];
    const step = partialStepRef.current % ratios.length;
    const text = source.slice(0, Math.max(1, Math.ceil(source.length * ratios[step]!)));
    partialStepRef.current += 1;
    setNotice(`PARTIAL ${step + 1}/${ratios.length}`);
    processHypothesis({ text, confidence: 0.88, receivedAt: performance.now(), speechActive: true, isFinal: step === 4 });
  }, [ensureSimulationSpeech, processHypothesis]);

  const triggerExpected = useCallback(() => {
    const current = engineRef.current!.snapshot();
    const target = demoScript.segments[current.currentIndex + 1];
    if (!target) return;
    ensureSimulationSpeech();
    processHypothesis({
      text: target.matchText[0]!,
      confidence: 0.98,
      receivedAt: performance.now(),
      speechActive: true,
      isFinal: false
    });
  }, [ensureSimulationSpeech, processHypothesis]);

  const simulateWrongPhrase = useCallback(() => {
    ensureSimulationSpeech();
    processHypothesis({
      text: "창밖에는 낯선 바람만 지나가고 있어",
      confidence: 0.92,
      receivedAt: performance.now(),
      speechActive: true
    });
    setNotice("NO MATCH — POINTER HELD");
  }, [ensureSimulationSpeech, processHypothesis]);

  const simulateSkip = useCallback(() => {
    const current = engineRef.current!.snapshot();
    const target = demoScript.segments[Math.min(demoScript.segments.length - 1, current.currentIndex + 2)];
    if (!target) return;
    ensureSimulationSpeech();
    processHypothesis({
      text: target.matchText[0]!,
      confidence: 0.98,
      receivedAt: performance.now(),
      speechActive: true
    });
    setNotice("SKIP RECOVERED IN LOCAL WINDOW");
  }, [ensureSimulationSpeech, processHypothesis]);

  const simulateType = useCallback((type: SegmentType) => {
    const engine = engineRef.current!;
    const current = engine.snapshot();
    const index = demoScript.segments.findIndex((segment, candidate) => candidate > current.currentIndex && segment.type === type);
    if (index < 0) {
      setNotice(`NO NEXT ${type}`);
      return;
    }
    setNotice(`${type} CUE SIMULATED`);
    publish(engine.jumpTo(index, performance.now()));
  }, [publish]);

  const manualNext = useCallback(() => {
    setNotice("MANUAL NEXT");
    publish(engineRef.current!.manualNext(performance.now()));
  }, [publish]);

  const manualPrevious = useCallback(() => {
    setNotice("MANUAL PREVIOUS");
    publish(engineRef.current!.manualPrevious(performance.now()));
  }, [publish]);

  const toggleHold = useCallback(() => {
    const next = engineRef.current!.toggleHold();
    setNotice(next.hold ? "AUTO ADVANCE HELD" : "AUTO ADVANCE ARMED");
    publish(next);
  }, [publish]);

  const forceResync = useCallback(() => {
    setNotice("RESYNC WINDOW OPEN");
    publish(engineRef.current!.forceResync());
  }, [publish]);

  const simulatePause = useCallback(() => {
    partialStepRef.current = 0;
    onSpeechEnd();
  }, [onSpeechEnd]);

  const reset = useCallback(() => {
    partialStepRef.current = 0;
    latencyRef.current.reset();
    setLatency(EMPTY_LATENCY);
    setNotice("SCRIPT RESET");
    publish(engineRef.current!.reset());
  }, [publish]);

  const recordPaint = useCallback((triggeredAt: number, speechOnsetAt: number | null) => {
    const origin = speechOnsetAt ?? triggeredAt;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const value = performance.now() - origin;
        setLatency(latencyRef.current.record(value));
        publish(engineRef.current!.markDisplayed());
        console.debug("caption_latency", { totalMs: Number(value.toFixed(2)), origin, paintedAt: performance.now() });
      });
    });
  }, [publish]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.code === "Space" || event.code === "ArrowRight") {
        event.preventDefault();
        manualNext();
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        manualPrevious();
      } else if (event.key.toLowerCase() === "h") {
        toggleHold();
      } else if (event.key.toLowerCase() === "r") {
        forceResync();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [forceResync, manualNext, manualPrevious, toggleHold]);

  return {
    script: demoScript,
    snapshot,
    latency,
    asrStatus,
    notice,
    microphone,
    actions: {
      startLive,
      stopLive,
      nextPartial,
      triggerExpected,
      simulatePause,
      simulateWrongPhrase,
      simulateSkip,
      simulateOverlap: () => simulateType("OVERLAP"),
      manualNext,
      manualPrevious,
      toggleHold,
      forceResync,
      reset,
      recordPaint
    }
  };
}
