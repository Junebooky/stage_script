"use client";

import type { StreamingHypothesis } from "@stage/alignment";
import { ShowRuntime, type ShowRuntimeSnapshot, type IntermissionOutput } from "@stage/script-engine";
import { parseCueProfiles, type Show } from "@stage/script-schema";
import { canonicalFingerprint } from "@stage/rehearsal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudienceView } from "@/lib/audience-protocol";
import { localRequest, downloadJSON } from "@/lib/local-runtime";
import { useAudiencePublisher } from "./use-audience-publisher";
import { useMicrophone } from "./use-microphone";
import { useBrowserPerformanceASR } from "./use-browser-performance-asr";

export interface LocalReadiness { status: string; local_ready: boolean; reason?: string; adapter?: string }

export type PerformanceASRSource = "local" | "browser-preview";

export function usePerformanceSession(show: Show, intermissionOutput: IntermissionOutput, asrSource: PerformanceASRSource = "local") {
  const [runtime] = useState(() => new ShowRuntime(show, { operatingMode: "PERFORMANCE_LOCAL", intermissionOutput }));
  const [state, setState] = useState(() => runtime.snapshot());
  const [heardText, setHeardText] = useState("");
  const [localASR, setLocalASR] = useState<LocalReadiness>({ status: "LOCAL ASR UNAVAILABLE", local_ready: false, reason: "로컬 오디오 엔진 연결 확인 중" });
  const [assetsReady, setAssetsReady] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState("기본 안전 기준 · fallback 꺼짐");
  const [latency, setLatency] = useState<{ ms: number; basis: string } | null>(null);
  const authorityRef = useRef(false);
  const outputReadyRef = useRef(false);
  const pendingHypothesisRef = useRef<StreamingHypothesis | null>(null);
  const paintRef = useRef<number | null>(null);
  const micAttemptRef = useRef(0);
  const publish = useCallback((next: ShowRuntimeSnapshot) => setState(next), []);

  const onHypothesis = useCallback((hypothesis: StreamingHypothesis) => {
    if (!authorityRef.current) return;
    const phase = runtime.snapshot().phase;
    if (phase !== "ACT_LIVE" && phase !== "ACT_ARMED") return;
    setHeardText(hypothesis.text);
    // The engine checkpoints armed evidence; it can never cue before explicit GO.
    if (phase === "ACT_ARMED" || outputReadyRef.current) publish(runtime.processHypothesis(hypothesis));
    else pendingHypothesisRef.current = hypothesis;
  }, [runtime, publish]);
  const onSpeechStart = useCallback((at: number) => { if (authorityRef.current) publish(runtime.speechStart(at)); }, [runtime, publish]);
  const onSpeechEnd = useCallback(() => { if (authorityRef.current) publish(runtime.speechEnd()); }, [runtime, publish]);
  const browserPreview = asrSource === "browser-preview";
  const microphone = useMicrophone({ localOnly: !browserPreview, backendDisabled: browserPreview, onHypothesis, onSpeechStart, onSpeechEnd });
  const browser = useBrowserPerformanceASR(browserPreview, onHypothesis);
  const asrReady = browserPreview ? browser.ready : microphone.backendASR;
  useEffect(() => {
    if (["idle", "denied", "unsupported", "error"].includes(microphone.status)) browser.stop();
  }, [microphone.status, browser.stop]);
  const stopMic = useCallback(() => {
    micAttemptRef.current += 1;
    pendingHypothesisRef.current = null;
    browser.stop();
    void microphone.stop();
    publish(runtime.speechEnd());
  }, [browser.stop, microphone.stop, publish, runtime]);

  const audienceView = useMemo<AudienceView>(() => {
    const segment = state.engine.displayedSegment;
    if (state.output === "black" || state.output === "clear" || !segment) return { kind: "black" };
    if (segment.type === "IMAGE" && segment.image) return { kind: "image", cueId: segment.id, src: segment.image.src, alt: segment.image.alt };
    return { kind: "caption", cueId: segment.id, lines: segment.captions.map((caption) => caption.text) };
  }, [state.output, state.engine.displayedSegment]);
  const output = useAudiencePublisher(audienceView);
  useEffect(() => { authorityRef.current = output.authority; outputReadyRef.current = output.connected; }, [output.authority, output.connected]);
  useEffect(() => {
    if (!output.authority || !output.connected || !asrReady || !pendingHypothesisRef.current) return;
    const hypothesis = pendingHypothesisRef.current;
    pendingHypothesisRef.current = null;
    if (runtime.snapshot().phase === "ACT_LIVE") publish(runtime.processHypothesis(hypothesis));
  }, [output.authority, output.connected, asrReady, runtime, publish]);

  useEffect(() => {
    let cancelled = false;
    setAssetsReady(false);
    setAssetError(null);
    const images = state.script.segments.flatMap((cue) => cue.image ? [cue.image.src] : []);
    const abort = new AbortController();
    void Promise.all(images.map(async (src) => {
      const response = await fetch(src, { redirect: "error", signal: abort.signal });
      if (!response.ok) throw new Error(`이미지를 읽지 못했습니다: ${src}`);
      const bitmap = await createImageBitmap(await response.blob());
      bitmap.close();
    })).then(() => { if (!cancelled) setAssetsReady(true); }, (error: unknown) => { if (!cancelled) setAssetError(error instanceof Error ? error.message : "로컬 이미지 준비 실패"); });
    return () => { cancelled = true; abort.abort(); };
  }, [state.script, state.actIndex]);

  useEffect(() => {
    publish(runtime.setReadiness({ microphone: microphone.status === "live", asr: asrReady, assets: assetsReady, output: output.connected && output.authority }));
  }, [runtime, publish, microphone.status, asrReady, assetsReady, output.connected, output.authority, state.actIndex]);

  useEffect(() => {
    if (browserPreview) return;
    let cancelled = false;
    let busy = false;
    const abort = new AbortController();
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await localRequest<LocalReadiness>("/readiness", { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) });
        if (!cancelled) setLocalASR(result);
      } catch {
        if (!cancelled) setLocalASR({ status: "LOCAL ASR UNAVAILABLE", local_ready: false, reason: "localhost:8000 오디오 엔진을 실행하세요. 클라우드로 전환하지 않습니다." });
      } finally { busy = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 3000);
    return () => { cancelled = true; abort.abort(); clearInterval(timer); };
  }, [browserPreview]);

  const loadProfiles = useCallback(async () => {
    try {
      const numbers = show.acts.flatMap((act) => act.numbers);
      const scope = numbers.length === 1 ? `&numberId=${encodeURIComponent(numbers[0]!.id)}` : "";
      const result = await localRequest<{ champion: { id: string; profiles: unknown; canonicalFingerprint: string } | null }>(`/profiles?showId=${encodeURIComponent(show.id)}${scope}`);
      if (!result.champion) { setProfileStatus("승인된 프로필 없음 · fallback 꺼짐"); return; }
      if (result.champion.canonicalFingerprint !== canonicalFingerprint(show)) throw new Error("승인 프로필의 대본 버전이 다릅니다. 재분석·회귀 검증 후 다시 승인하세요.");
      const profiles = parseCueProfiles(result.champion.profiles);
      if (!runtime.setProfiles(profiles)) { setProfileStatus("공연 중 프로필 교체 금지 · 다음 막 준비 때 다시 불러오세요."); return; }
      setProfileStatus(`CHAMPION · ${profiles.length} cues · ${result.champion.id.slice(0, 8)}`);
    } catch (error) { setProfileStatus(error instanceof Error ? error.message : "프로필을 불러오지 못했습니다."); }
  }, [runtime, show]);

  const control = useCallback((action: () => ShowRuntimeSnapshot) => {
    if (!authorityRef.current) return;
    pendingHypothesisRef.current = null;
    microphone.resetRecognition();
    browser.reset();
    publish(action());
  }, [publish, microphone.resetRecognition, browser.reset]);
  const next = useCallback(() => control(() => runtime.manualNext(performance.now())), [control, runtime]);
  const previous = useCallback(() => control(() => runtime.manualPrevious(performance.now())), [control, runtime]);
  const hold = useCallback(() => control(() => runtime.toggleHold()), [control, runtime]);
  const resync = useCallback(() => control(() => runtime.forceResync(performance.now())), [control, runtime]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest("input,textarea,select,button,a,[contenteditable=true]") || event.repeat) return;
      if (event.code === "Space" || event.code === "ArrowRight") { event.preventDefault(); next(); }
      else if (event.code === "ArrowLeft") { event.preventDefault(); previous(); }
      else if (event.key.toLowerCase() === "h") hold();
      else if (event.key.toLowerCase() === "r") resync();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, hold, resync]);

  const recordPaint = useCallback(() => {
    const trigger = runtime.snapshot().engine.lastTrigger;
    if (!trigger) return;
    if (paintRef.current !== null) cancelAnimationFrame(paintRef.current);
    paintRef.current = requestAnimationFrame(() => {
      paintRef.current = requestAnimationFrame(() => {
        paintRef.current = null;
        if (runtime.snapshot().engine.lastTrigger !== trigger) return;
        setLatency({ ms: performance.now() - (trigger.speechOnsetAt ?? trigger.triggeredAt), basis: trigger.source === "manual" ? "수동→미리보기" : trigger.speechOnsetAt === null ? "인식→미리보기" : "음성→미리보기" });
        publish(runtime.markDisplayed());
      });
    });
  }, [runtime, publish]);
  useEffect(() => () => { if (paintRef.current !== null) cancelAnimationFrame(paintRef.current); }, []);

  return {
    state, microphone, localASR, output, heardText, latency, profileStatus, assetError, asrSource, browserError: browser.error,
    actions: {
      next, previous, hold, resync, recordPaint, loadProfiles,
      arm: () => { setHeardText(""); setLatency(null); control(() => runtime.armAct(undefined, performance.now())); },
      go: () => control(() => runtime.go(performance.now())),
      intermission: () => { stopMic(); control(() => runtime.enterIntermission(performance.now())); setHeardText(""); },
      reset: () => { stopMic(); setHeardText(""); setLatency(null); control(() => runtime.reset(performance.now())); },
      manualOnly: (value: boolean) => control(() => runtime.setManualOnly(value)),
      startMic: () => {
        if (!authorityRef.current || !["PRE_SHOW", "ACT_ARMED", "ACT_LIVE"].includes(runtime.snapshot().phase)) return;
        const attempt = ++micAttemptRef.current;
        browser.start(); // Within the user gesture; interim results never wait for final.
        void microphone.start().then((started) => { if (!started && micAttemptRef.current === attempt) browser.stop(); });
      },
      stopMic,
      exportLog: () => downloadJSON(`cueflow-${show.id}-events.json`, { showId: show.id, asrSource, productionValidated: false, exportedAt: new Date().toISOString(), events: runtime.exportTelemetry() })
    }
  };
}
