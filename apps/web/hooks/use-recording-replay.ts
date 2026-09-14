"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeReplayController, type ASRReplayEvidence, type RealtimeReplaySnapshot } from "@stage/rehearsal";
import type { PerformanceScript } from "@stage/script-schema";

/** Polling never supplies time. currentTime on the real audio is the sole clock. */
export function useRecordingReplay(script: PerformanceScript, evidence: ASRReplayEvidence) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<RealtimeReplayController | null>(null);
  const [snapshot, setSnapshot] = useState<RealtimeReplaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!audioRef.current) return;
    let controller: RealtimeReplayController;
    try { controller = new RealtimeReplayController(script, evidence, audioRef.current); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "리플레이 초기화 실패"); return; }
    controllerRef.current = controller;
    setError(null);
    setSnapshot(controller.snapshot());
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      setSnapshot(controller.tick());
    };
    // RAF stops in background tabs, even while real audio continues. Media events
    // keep the cursor moving when the operator focuses the separate audience tab.
    // The interval is just a foreground polling cadence, not an elapsed-time clock.
    const timer = setInterval(poll, 40);
    const audio = audioRef.current;
    audio.addEventListener("timeupdate", poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      audio.removeEventListener("timeupdate", poll);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [script, evidence]);

  const command = useCallback(async (action: "start" | "pause" | "resume" | "stop" | "restart" | "next" | "previous" | "hold") => {
    const controller = controllerRef.current;
    if (!controller) return;
    const pending = action === "next" || action === "previous" ? controller.manual(action)
      : action === "hold" ? controller.setHold(!controller.snapshot().engine.hold) : controller[action]();
    setSnapshot(controller.snapshot());
    await pending;
    if (controllerRef.current === controller) setSnapshot(controller.snapshot());
  }, []);
  const audioEvent = useCallback((event: "ended" | "error" | "seeking" | "ratechange") => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (event === "error") controller.fail("등록 원본 오디오를 읽지 못했습니다. 서버와 SHA-256 검증 상태를 확인하세요.");
    if (event === "seeking" && ["playing", "paused"].includes(controller.snapshot().state)) controller.fail("임의 탐색은 지원하지 않습니다. RESTART를 사용하세요.");
    if (event === "ratechange" && audioRef.current?.playbackRate !== 1) controller.fail("리플레이는 원본 타임라인 1.0×만 지원합니다.");
    setSnapshot(controller.tick());
  }, []);
  return { audioRef, snapshot, error: error ?? snapshot?.error, command, audioEvent };
}
