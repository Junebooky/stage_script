"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeReplayController, type ASRReplayEvidence, type RealtimeReplaySnapshot } from "@stage/rehearsal";
import type { PerformanceScript } from "@stage/script-schema";
import { timelineIndex, type DemoTimeline } from "@/lib/demo-timeline";

/** Explicit reference-driven DEMO, separate from saved-ASR replay below.
 * Media currentTime is authoritative, including seek and background playback.
 * Nothing here enters a matcher, ASR telemetry or latency evaluation. */
export function useTimelineDemonstration(timeline: DemoTimeline) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<{ index: number; clockIndex: number } | null>(null);
  const generation = useRef(0);
  const clockIndex = timelineIndex(timeline, time * 1000);
  const index = active ? override?.clockIndex === clockIndex ? override.index : clockIndex : -1;

  const sync = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setTime(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    setPlaying(!audio.paused && !audio.ended);
    setEnded(audio.ended);
  }, []);
  const stop = useCallback(() => {
    generation.current++;
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    setActive(false); setOverride(null); setEnded(false); sync();
  }, [sync]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const timer = setInterval(sync, 40);
    return () => { generation.current++; clearInterval(timer); audio.pause(); };
  }, [sync]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    const attempt = ++generation.current;
    if (!audio.paused) { audio.pause(); sync(); return; }
    if (audio.ended) { audio.currentTime = 0; setOverride(null); }
    setError(null);
    try {
      audio.playbackRate = 1;
      await audio.play();
      if (attempt !== generation.current) { audio.pause(); return; }
      setActive(true); sync();
    } catch {
      if (attempt === generation.current) { setPlaying(false); setError("음원을 재생할 수 없습니다. 음원 파일을 선택하거나 public/ 경로를 확인하세요."); }
    }
  };
  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds) || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    setOverride(null); setActive(true); sync();
  };
  const manual = useCallback((direction: number) => {
    if (!active) return;
    setOverride({ index: Math.max(-1, Math.min(timeline.cues.length - 1, index + direction)), clockIndex });
  }, [active, index, clockIndex, timeline.cues.length]);
  const resync = useCallback(() => { setOverride(null); sync(); }, [sync]);
  const fail = () => { stop(); setError("음원을 읽지 못했습니다. 같은 R001 녹음 파일을 선택하거나 로컬 서버를 확인하세요."); };
  return { audioRef, time, duration, playing, ended, active, index, error, toggle, stop, seek, manual, resync, sync, fail };
}

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
