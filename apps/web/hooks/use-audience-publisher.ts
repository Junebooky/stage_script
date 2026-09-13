"use client";

import { useEffect, useRef, useState } from "react";
import { AudienceReadiness, decodeAudienceFrame, OPERATOR_LOCK, OUTPUT_CHANNEL, OUTPUT_HEARTBEAT_MS, type AudienceView } from "@/lib/audience-protocol";

const EPOCH_STORAGE = "cueflow-operator-epoch-v1";
// Wait for this document's previous request to resolve (and actually release
// its browser lock) before a keyed console remount tries to acquire it again.
let previousLease: Promise<void> = Promise.resolve();

function nextEpoch(): number {
  // Called only while holding the Web Lock: reloads stay newer even if the
  // system clock moves backwards. Storage failure is surfaced, not bypassed.
  const previous = Number(localStorage.getItem(EPOCH_STORAGE) ?? 0);
  const epoch = Math.max(Date.now(), Number.isSafeInteger(previous) ? previous + 1 : 0);
  localStorage.setItem(EPOCH_STORAGE, String(epoch));
  return epoch;
}

export function useAudiencePublisher(view: AudienceView) {
  const [authority, setAuthority] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef(view);
  const sendRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    viewRef.current = view;
    sendRef.current?.();
  }, [view]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined" || !navigator.locks) {
      setError("이 브라우저는 안전한 로컬 출력 동기화를 지원하지 않습니다.");
      return;
    }
    let cancelled = false;
    let release: (() => void) | undefined;
    let channel: BroadcastChannel | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let ownedSend: (() => void) | undefined;
    const precedingLease = previousLease;
    let finishLease!: () => void;
    previousLease = new Promise<void>((resolve) => { finishLease = resolve; });
    const readiness = new AudienceReadiness();
    const cleanup = () => {
      if (timer) clearInterval(timer);
      channel?.close();
      if (sendRef.current === ownedSend) sendRef.current = null;
      release?.();
    };

    // Defer one microtask so StrictMode's discarded effect cannot contend with
    // its replacement. ifAvailable is non-queued and cannot be combined with
    // AbortSignal; cancelled guards handle a late lock callback on navigation.
    void precedingLease.then(async () => {
      if (cancelled) return;
      await navigator.locks.request(OPERATOR_LOCK, { ifAvailable: true }, async (lock) => {
        if (cancelled) return;
        if (!lock) {
          setError("다른 운영 창이 송출 중입니다. 그 창을 사용하거나 닫은 뒤 새로고침하세요.");
          return;
        }
        const session = crypto.randomUUID();
        const epoch = nextEpoch();
        let sequence = 0;
        channel = new BroadcastChannel(OUTPUT_CHANNEL);
        const held = new Promise<void>((resolve) => { release = resolve; });
        const send = () => {
          if (cancelled) return;
          const raw = { type: "state", version: 1, session, epoch, sequence: ++sequence, view: viewRef.current };
          // Even unexpected runtime input is whitelisted before crossing windows.
          const frame = decodeAudienceFrame(raw) ?? decodeAudienceFrame({ ...raw, view: { kind: "black" } })!;
          readiness.sent(frame);
          channel?.postMessage(frame);
          setConnected(readiness.connected(performance.now()));
        };
        ownedSend = send;
        sendRef.current = send;
        channel.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (cancelled || !data || typeof data !== "object") return;
          const message = data as Record<string, unknown>;
          if (message.type === "hello" && message.version === 1) send();
          if (readiness.accept(data, performance.now())) setConnected(readiness.connected(performance.now()));
        };
        setAuthority(true);
        setError(null);
        send();
        timer = setInterval(send, OUTPUT_HEARTBEAT_MS);
        await held;
      });
    }).catch((cause: unknown) => {
      cleanup();
      if (!cancelled) {
        console.error("audience_authority_failed", cause);
        setAuthority(false);
        setConnected(false);
        setError("운영 창 잠금 또는 로컬 출력 채널을 확보하지 못했습니다. 자동 송출이 차단되었습니다.");
      }
    }).finally(finishLease);

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  return { authority, connected, error };
}
