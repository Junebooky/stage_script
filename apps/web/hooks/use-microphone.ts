"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type MicStatus = "idle" | "requesting" | "live" | "denied" | "unsupported";
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
  onSpeechStart: (at: number) => void;
  onSpeechEnd: () => void;
}

export function useMicrophone({ onSpeechStart, onSpeechEnd }: UseMicrophoneOptions) {
  const [status, setStatus] = useState<MicStatus>("idle");
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("offline");
  const [level, setLevel] = useState(0);
  const [bands, setBands] = useState([0, 0, 0]);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const latestCallbacks = useRef({ onSpeechStart, onSpeechEnd });

  useEffect(() => {
    latestCallbacks.current = { onSpeechStart, onSpeechEnd };
  }, [onSpeechStart, onSpeechEnd]);

  const stop = useCallback(async () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    await contextRef.current?.close();
    contextRef.current = null;
    setStatus("idle");
    setSocketStatus("offline");
    setLevel(0);
    setBands([0, 0, 0]);
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      setStatus("unsupported");
      return false;
    }
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      await context.audioWorklet.addModule("/audio-processor.js");
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "caption-audio-processor");
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(processor).connect(mute).connect(context.destination);

      const socketUrl = process.env.NEXT_PUBLIC_AUDIO_WS_URL ?? "ws://localhost:8000/ws/audio";
      setSocketStatus("connecting");
      const socket = new WebSocket(socketUrl);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => setSocketStatus("connected");
      socket.onclose = () => setSocketStatus("offline");
      socket.onerror = () => setSocketStatus("offline");

      processor.port.onmessage = (event: MessageEvent<ProcessorMessage>) => {
        const message = event.data;
        if (message.type === "speech-start") latestCallbacks.current.onSpeechStart(performance.now());
        if (message.type === "speech-end") latestCallbacks.current.onSpeechEnd();
        if (message.type === "audio") {
          setLevel(message.level ?? 0);
          setBands([message.low ?? 0, message.mid ?? 0, message.high ?? 0]);
          if (message.pcm && socket.readyState === WebSocket.OPEN) {
            const pcm16 = new Int16Array(message.pcm.length);
            for (let index = 0; index < message.pcm.length; index += 1) {
              const sample = Math.max(-1, Math.min(1, message.pcm[index] ?? 0));
              pcm16[index] = sample < 0 ? sample * 32768 : sample * 32767;
            }
            socket.send(pcm16.buffer);
          }
        }
      };

      contextRef.current = context;
      streamRef.current = stream;
      socketRef.current = socket;
      setStatus("live");
      return true;
    } catch (error) {
      console.error("Microphone initialization failed", error);
      setStatus("denied");
      return false;
    }
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    socketRef.current?.close();
    void contextRef.current?.close();
  }, []);

  return { start, stop, status, socketStatus, level, bands };
}

