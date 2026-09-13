"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamingHypothesis } from "@stage/alignment";
import { decodeAudioHypothesis, RecognitionGenerationGate } from "@/lib/audio-protocol";
import { performanceSocketUrl } from "@/lib/local-runtime";

type MicStatus = "idle" | "requesting" | "live" | "denied" | "unsupported" | "error";
type SocketStatus = "offline" | "connecting" | "connected";

interface ProcessorMessage {
  type: "audio" | "speech-start" | "speech-end";
  level?: number;
  low?: number;
  mid?: number;
  high?: number;
  pcm?: Float32Array;
}

interface UseMicrophoneOptions {
  localOnly?: boolean;
  backendDisabled?: boolean;
  onSpeechStart: (at: number) => void;
  onSpeechEnd: () => void;
  onHypothesis: (hypothesis: StreamingHypothesis) => void;
}

export function useMicrophone(options: UseMicrophoneOptions) {
  const [status, setStatus] = useState<MicStatus>("idle");
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("offline");
  const [level, setLevel] = useState(0);
  const [bands, setBands] = useState([0, 0, 0]);
  const [error, setError] = useState<string | null>(null);
  const [backendASR, setBackendASR] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  const recognitionGateRef = useRef(new RecognitionGenerationGate());
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCallbacks = useRef(options);
  useEffect(() => { latestCallbacks.current = options; }, [options]);

  const release = useCallback(() => {
    generationRef.current += 1;
    startingRef.current = false;
    recognitionGateRef.current.reset();
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
    if (processorRef.current) {
      processorRef.current.port.onmessage = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
  }, []);

  const stop = useCallback(async () => {
    release();
    setStatus("idle");
    setSocketStatus("offline");
    setBackendASR(false);
    setBackendError(null);
    setLevel(0);
    setBands([0, 0, 0]);
    setHasAudio(false);
    setError(null);
  }, [release]);

  const resetRecognition = useCallback(() => {
    const socket = socketRef.current;
    if (!latestCallbacks.current.localOnly || socket?.readyState !== WebSocket.OPEN) return;
    const generation = recognitionGateRef.current.advance();
    socket.send(JSON.stringify({ type: "reset", generation }));
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      if (!recognitionGateRef.current.pending) return;
      setBackendASR(false);
      setBackendError("LOCAL ASR UNAVAILABLE — 새 발화 경계 확인이 지연됩니다. 수동 송출은 계속 사용할 수 있습니다.");
    }, 3000);
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current) return false;
    if (streamRef.current) return true;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      setStatus("unsupported");
      setError("이 브라우저에서 마이크를 사용할 수 없습니다. localhost 또는 HTTPS로 열어주세요.");
      return false;
    }
    const generation = ++generationRef.current;
    startingRef.current = true;
    setStatus("requesting");
    setError(null);
    setHasAudio(false);
    setBackendError(null);
    try {
      // Resume while still in the click gesture, before the permission dialog resolves.
      const context = new AudioContext({ latencyHint: "interactive" });
      contextRef.current = context;
      const resumed = context.resume().then(() => null, (cause: unknown) => cause);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: !latestCallbacks.current.localOnly, noiseSuppression: !latestCallbacks.current.localOnly, autoGainControl: !latestCallbacks.current.localOnly }
      });
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      streamRef.current = stream;
      const resumeError = await resumed;
      if (resumeError) throw resumeError;
      await context.audioWorklet.addModule("/audio-processor.js");
      if (generation !== generationRef.current) return false;
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "caption-audio-processor");
      processorRef.current = processor;
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(processor).connect(mute).connect(context.destination);

      // Audio rendering and VAD stay available even when the optional backend is offline.
      const configuredUrl = process.env.NEXT_PUBLIC_AUDIO_WS_URL;
      const localUrl = location.protocol === "http:" && ["localhost", "127.0.0.1"].includes(location.hostname)
        ? "ws://localhost:8000/ws/audio" : null;
      const socketUrl = latestCallbacks.current.localOnly ? performanceSocketUrl(configuredUrl) : configuredUrl || localUrl;
      if (socketUrl && !latestCallbacks.current.backendDisabled) {
        try {
          const socket = new WebSocket(socketUrl);
          socketRef.current = socket;
          setSocketStatus("connecting");
          socket.binaryType = "arraybuffer";
          socket.onopen = () => {
            if (generation === generationRef.current) setSocketStatus("connected");
          };
          const disconnected = () => {
            if (generation !== generationRef.current) return;
            setSocketStatus("offline");
            setBackendASR(false);
            if (latestCallbacks.current.localOnly) setBackendError("LOCAL ASR UNAVAILABLE — 로컬 오디오 엔진 연결을 확인하세요.");
          };
          socket.onclose = disconnected;
          socket.onerror = disconnected;
          socket.onmessage = (event) => {
            if (generation !== generationRef.current) return;
            const hypothesis = decodeAudioHypothesis(event.data, performance.now());
            if (hypothesis) {
              if (latestCallbacks.current.localOnly) {
                const payload = JSON.parse(event.data);
                const gate = recognitionGateRef.current;
                if (!gate.accepts(payload.generation)) return;
                latestCallbacks.current.onHypothesis({ ...hypothesis, boundaryVerified: gate.generation > 0 });
              } else latestCallbacks.current.onHypothesis(hypothesis);
              return;
            }
            try {
              const payload = JSON.parse(event.data);
              // The shipped mock transport must never be advertised as working ASR.
              if (payload.type === "ready") {
                const real = typeof payload.adapter === "string" && !payload.adapter.includes("mock") && (!latestCallbacks.current.localOnly || (payload.local_ready === true && payload.reset_generation === true));
                setBackendASR(real);
                if (latestCallbacks.current.localOnly && !real) setBackendError(payload.reason || "LOCAL ASR UNAVAILABLE");
              }
              if (payload.type === "reset_ack" && recognitionGateRef.current.acknowledge(payload.generation)) {
                if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
                resetTimerRef.current = null;
              }
              if (payload.type === "error") { setBackendASR(false); setBackendError(typeof payload.detail === "string" ? payload.detail : "LOCAL ASR UNAVAILABLE"); }
            } catch { /* Ignore unknown protocol messages. */ }
          };
        } catch {
          setSocketStatus("offline");
        }
      }

      let lastMeterAt = 0;
      processor.port.onmessage = (event: MessageEvent<ProcessorMessage>) => {
        if (generation !== generationRef.current) return;
        const message = event.data;
        const now = performance.now();
        if (message.type === "speech-start") latestCallbacks.current.onSpeechStart(now);
        if (message.type === "speech-end") latestCallbacks.current.onSpeechEnd();
        if (message.type !== "audio") return;
        if (now - lastMeterAt >= 32) {
          lastMeterAt = now;
          setLevel(message.level ?? 0);
          setBands([message.low ?? 0, message.mid ?? 0, message.high ?? 0]);
          if ((message.level ?? 0) > 0.04) setHasAudio(true);
        }
        const socket = socketRef.current;
        if (message.pcm && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 64_000 && (!latestCallbacks.current.localOnly || !recognitionGateRef.current.pending)) {
          const pcm16 = new Int16Array(message.pcm.length);
          for (let index = 0; index < message.pcm.length; index += 1) {
            const sample = Math.max(-1, Math.min(1, message.pcm[index] ?? 0));
            pcm16[index] = sample < 0 ? sample * 32768 : sample * 32767;
          }
          socket.send(pcm16.buffer);
        }
      };
      processor.onprocessorerror = () => {
        if (generation !== generationRef.current) return;
        release();
        setStatus("error");
        setLevel(0);
        setBackendASR(false);
        setError("오디오 처리가 중단되었습니다. 마이크를 다시 켜주세요.");
      };
      startingRef.current = false;
      setStatus("live");
      return true;
    } catch (cause) {
      if (generation !== generationRef.current) return false;
      release();
      const denied = cause instanceof DOMException && cause.name === "NotAllowedError";
      setStatus(denied ? "denied" : "error");
      setError(denied
        ? "마이크 권한이 차단되었습니다. 주소창의 마이크 권한을 허용해주세요."
        : "마이크를 시작하지 못했습니다. 입력 장치를 확인하고 다시 시도해주세요.");
      return false;
    }
  }, [release]);

  useEffect(() => release, [release]);
  return { start, stop, resetRecognition, status, socketStatus, level, bands, error, backendASR, backendError, hasAudio };
}
