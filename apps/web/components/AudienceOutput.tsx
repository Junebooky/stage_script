"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { AudienceReplica, OUTPUT_CHANNEL, OUTPUT_HEARTBEAT_MS, OUTPUT_TIMEOUT_MS, type AudienceFrame } from "@/lib/audience-protocol";

function resourceKey(frame: AudienceFrame): string | null {
  const view = frame.view;
  return view.kind === "image" ? JSON.stringify([frame.session, view.cueId, view.src]) : null;
}

/** Fetch cannot follow an external redirect; only a verified local raster is displayed. */
function LocalAudienceImage({ src, alt, onReady }: { src: string; alt: string; onReady(ready: boolean): void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const statusRef = useRef(onReady);
  useEffect(() => { statusRef.current = onReady; }, [onReady]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | undefined;
    statusRef.current(false);
    void fetch(src, { mode: "same-origin", credentials: "same-origin", redirect: "error", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok || !/^image\/(?:avif|gif|jpeg|png|webp)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Unavailable local raster");
        const blob = await response.blob();
        if (blob.size > 32 * 1024 * 1024) throw new Error("Local image exceeds display limit");
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (active) statusRef.current(false); });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (!url) return null;
  return <Image src={url} alt={alt} fill unoptimized sizes="100vw" style={{ objectFit: "contain", visibility: loaded ? "visible" : "hidden" }}
    onLoad={() => { setLoaded(true); statusRef.current(true); }}
    onError={() => { setLoaded(false); statusRef.current(false); }} />;
}

export function AudienceOutput() {
  const [frame, setFrame] = useState<AudienceFrame | null>(null);
  const [connection, setConnection] = useState<"waiting" | "live" | "held" | "unsupported">("waiting");
  const channelRef = useRef<BroadcastChannel | null>(null);
  const audienceRef = useRef("");
  const frameRef = useRef<AudienceFrame | null>(null);
  const imageReadyRef = useRef<{ key: string; ready: boolean } | null>(null);

  const acknowledge = useCallback((current: AudienceFrame, ready: boolean) => {
    if (current !== frameRef.current) return;
    channelRef.current?.postMessage({ type: "ack", version: 1, audience: audienceRef.current, session: current.session, epoch: current.epoch, sequence: current.sequence, ready });
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") { setConnection("unsupported"); return; }
    const replica = new AudienceReplica();
    const channel = new BroadcastChannel(OUTPUT_CHANNEL);
    audienceRef.current = crypto.randomUUID();
    channelRef.current = channel;
    let receivedAt = Number.NEGATIVE_INFINITY;
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      const next = replica.accept(data);
      if (!next) return;
      receivedAt = performance.now();
      frameRef.current = next;
      setFrame(next);
      setConnection("live");
    };
    const hello = () => channel.postMessage({ type: "hello", version: 1, audience: audienceRef.current });
    hello();
    const timer = setInterval(() => {
      if (performance.now() - receivedAt >= OUTPUT_TIMEOUT_MS) {
        if (frameRef.current) setConnection("held");
        hello();
      }
    }, OUTPUT_HEARTBEAT_MS);
    const fullscreen = () => {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) void document.documentElement.requestFullscreen().catch(() => {});
    };
    const onKey = (event: KeyboardEvent) => { if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) fullscreen(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("dblclick", fullscreen);
    return () => {
      clearInterval(timer);
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dblclick", fullscreen);
    };
  }, []);

  useEffect(() => {
    if (!frame) return;
    const key = resourceKey(frame);
    acknowledge(frame, key === null || (imageReadyRef.current?.key === key && imageReadyRef.current.ready));
  }, [frame, acknowledge]);

  const view = frame?.view;
  const key = frame ? resourceKey(frame) : null;
  return (
    <main className="audience-output" aria-label="Audience caption output" data-kind={view?.kind ?? "black"} data-connection={connection} data-cue={view && view.kind !== "black" ? view.cueId : undefined}>
      {view?.kind === "caption" ? <div className="audience-lines" aria-live="polite" aria-atomic="true">{view.lines.map((text, index) => <p key={index}>{text}</p>)}</div> : null}
      {view?.kind === "image" && key ? <LocalAudienceImage key={key} src={view.src} alt={view.alt} onReady={(ready) => {
        const current = frameRef.current;
        if (!current || resourceKey(current) !== key) return;
        imageReadyRef.current = { key, ready };
        acknowledge(current, ready);
      }} /> : null}
    </main>
  );
}
