"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { parseShow, type Show } from "@stage/script-schema";
import type { ProductionCatalog } from "@stage/script-schema/production-types";
import type { IntermissionOutput } from "@stage/script-engine";
import { usePerformanceSession, type PerformanceASRSource } from "@/hooks/use-performance-session";
import { readSelectedShow, storeSelectedShow } from "@/lib/show-storage";
import { CaptionDisplay } from "./CaptionDisplay";
import { CueQueue } from "./CueQueue";
import { MicrophoneMonitor } from "./MicrophoneMonitor";
import { ProductionSelector } from "./ProductionSelector";

const HologramAvatar = dynamic(() => import("./HologramAvatar").then((module) => module.HologramAvatar), { ssr: false });

export function OperatorExperience({ initialShow, catalog }: { initialShow: Show; catalog: ProductionCatalog }) {
  const [show, setShow] = useState<Show>(initialShow);
  const [hydrated, setHydrated] = useState(false);
  const [revision, setRevision] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);
  const [intermission, setIntermission] = useState<IntermissionOutput>("black");
  const [asrSource, setASRSource] = useState<PerformanceASRSource>("browser-preview");
  useEffect(() => { setShow(readSelectedShow(initialShow)); setHydrated(true); }, [initialShow]);
  const replaceShow = (next: Show) => { setStorageWarning(!storeSelectedShow(next)); setShow(next); setRevision((value) => value + 1); };
  // Construct the one authoritative runtime only after reading the saved show.
  // A saved revision may keep the same show ID as the bundled demo.
  if (!hydrated) return <main className="minimal-experience"><p role="status">로컬 공연 대본을 준비하고 있습니다.</p></main>;
  return <>{storageWarning ? <p className="operation-alert" role="alert">브라우저 저장소를 사용할 수 없습니다. 현재 창에서는 선택한 대본을 사용하지만 새로고침하면 다시 선택해야 합니다.</p> : null}<PerformanceConsole key={`${show.id}-${revision}-${intermission}-${asrSource}`} show={show} catalog={catalog} intermission={intermission} onIntermission={setIntermission} onShow={replaceShow} asrSource={asrSource} onASRSource={setASRSource} /></>;
}

function PerformanceConsole({ show, catalog, intermission, onIntermission, onShow, asrSource, onASRSource }: { show: Show; catalog: ProductionCatalog; intermission: IntermissionOutput; onIntermission: (value: IntermissionOutput) => void; onShow: (show: Show) => void; asrSource: PerformanceASRSource; onASRSource: (source: PerformanceASRSource) => void }) {
  const session = usePerformanceSession(show, intermission, asrSource);
  const { state, actions, microphone, output } = session;
  const snapshot = state.engine;
  const live = state.phase === "ACT_LIVE";
  const preShow = state.phase === "PRE_SHOW";
  const lastCue = snapshot.currentIndex === state.script.segments.length - 1;
  const source = snapshot.lastTrigger?.source;
  const sourceLabel = source === "fallback" ? "FALLBACK" : source === "manual" ? "MANUAL" : source ? "AUTO" : "—";
  const engineLabel = snapshot.hold ? "HOLD" : snapshot.phase === "UNMATCHED_SPEECH" ? "UNMATCHED SPEECH" : snapshot.phase === "FALLBACK_READY" ? "FALLBACK READY" : snapshot.phase === "RESYNC" || snapshot.phase === "LOW_CONFIDENCE" ? "RESYNC" : "AUTO MATCH";
  const [importError, setImportError] = useState<string | null>(null);
  const inputError = microphone.error ?? (asrSource === "browser-preview" ? session.browserError : microphone.backendError ?? (!session.localASR.local_ready ? `${session.localASR.status} · ${session.localASR.reason ?? "로컬 모델을 준비하세요."}` : null));

  async function importShow(file?: File) {
    if (!file || !preShow) return;
    try { onShow(parseShow(JSON.parse(await file.text()))); }
    catch (error) { setImportError(error instanceof Error ? error.message : "대본 파일을 읽지 못했습니다."); }
  }

  return (
    <main className="minimal-experience performance-console">
      <header className="workspace-header">
        <div><span className="eyebrow">CUEFLOW / {asrSource === "browser-preview" ? "ONLINE PREVIEW" : "LOCAL PERFORMANCE"}</span><h1>{show.title}</h1></div>
        <nav aria-label="Workspace"><a href="/demo">데모</a><a href="/rehearsal">리허설 보정</a><a href="/output" target="_blank" rel="noopener">관객 화면 열기 ↗</a></nav>
      </header>

      <section className="show-control" aria-label="Show lifecycle" data-show-state={state.phase}>
        <div className="show-state"><span className="eyebrow">SHOW STATE</span><strong>{state.phase.replaceAll("_", " ")}</strong><span>{state.act?.title ?? "공연 시작 전"} · {state.actIndex < 0 ? show.acts.length : `${state.actIndex + 1} / ${show.acts.length}`} ACTS</span></div>
        <div className="readiness-list" aria-label="Performance readiness">
          <span data-ready={output.authority}>{output.authority ? "●" : "○"} 운영권</span>
          <span data-ready={state.readiness.microphone}>{state.readiness.microphone ? "●" : "○"} 마이크</span>
          <span data-ready={state.readiness.asr}>{state.readiness.asr ? "●" : "○"} {asrSource === "browser-preview" ? "BROWSER ASR" : "LOCAL ASR"}</span>
          <span data-ready={state.readiness.assets}>{state.readiness.assets ? "●" : "○"} 로컬 에셋</span>
          <span data-ready={output.connected}>{output.connected ? "●" : "○"} 관객 화면</span>
        </div>
        <div className="act-actions">
          {preShow || state.phase === "INTERMISSION" ? <button onClick={actions.arm} disabled={!output.authority} aria-label="Arm next act">ARM {state.actIndex + 2}막</button> : null}
          {state.phase === "ACT_ARMED" ? <button className="go-button" onClick={actions.go} disabled={!state.ready || !output.authority} aria-label="Go act">GO {state.actIndex + 1}막</button> : null}
          {state.phase === "ACT_COMPLETE" ? <button onClick={actions.intermission} disabled={!output.authority} aria-label="Enter intermission">ENTER INTERMISSION</button> : null}
          {state.phase === "SHOW_COMPLETE" ? <button onClick={actions.reset} disabled={!output.authority}>새 공연 준비</button> : null}
          <label className="manual-option"><input type="checkbox" checked={state.manualOnly} disabled={live || !output.authority} onChange={(event) => actions.manualOnly(event.target.checked)} />수동 운용 · 자동 인식 끄기</label>
        </div>
      </section>

      {output.error || session.assetError || importError ? <p className="operation-alert" role="alert">{output.error ?? session.assetError ?? importError}</p> : null}
      {state.phase === "ACT_ARMED" && !state.ready ? <p className="operation-note">관객 화면을 같은 브라우저에서 연 뒤 마이크와 선택한 ASR을 켜주세요. 수동 운용은 모델 없이 사용할 수 있습니다.</p> : null}
      {asrSource === "browser-preview" ? <p className="operation-note">온라인 시연 모드 · 마이크를 켜면 브라우저 제공 음성 서비스로 음성이 전송될 수 있습니다. 최종 문장 완성을 기다리지 않습니다. 로컬 전용·실공연 검증 모드가 아닙니다.</p> : null}
      {live && !output.connected ? <p className="operation-alert" role="alert">관객 화면 연결을 확인하세요. 자동 매칭은 대기합니다.</p> : null}

      <div className="performance-layout">
        <section className="live-stage" aria-label="Stage presentation">
          <div className="operator-metrics" aria-label="Realtime caption metrics">
            <div><span>CURRENT CUE</span><strong>{snapshot.currentSegment?.id ?? "—"}</strong></div>
            <div><span>MATCH CONFIDENCE</span><strong>{source === "manual" ? "—" : `${Math.round(snapshot.confidence * 100)}%`}</strong></div>
            <div><span>LATENCY · {session.latency?.basis ?? "미리보기"}</span><strong>{session.latency ? `${Math.round(session.latency.ms)} ms` : "—"}</strong></div>
          </div>
          <div className="orb-stage"><HologramAvatar signal={{ level: microphone.level, bands: microphone.bands, speechActive: snapshot.speechActive }} /></div>
          <section className={`stage-output ${snapshot.currentSegment ? "is-on-air" : ""}`} aria-label="Stage caption output" data-source={source ?? "preview"}>
            <header className="output-heading"><div><span className="eyebrow">CANONICAL OUTPUT / OPERATOR PREVIEW</span><h2>무대 송출 자막</h2></div><span className="output-badge">{state.output === "black" || state.output === "clear" ? "BLACK" : sourceLabel}</span></header>
            <CaptionDisplay segment={snapshot.displayedSegment} previewSegment={state.script.segments[0]} triggerKey={snapshot.lastTrigger?.triggeredAt ?? null} onPaint={actions.recordPaint} />
            <footer className="output-footer"><span>{snapshot.currentSegment?.captions.map((line) => line.actor).join(" · ") || "확정 대본 미리보기"}</span><span>관객 화면은 별도 창에서 송출</span></footer>
          </section>
        </section>

        <aside className="operator-rail" aria-label="Cue and microphone controls">
          <div className="engine-status"><span data-engine-state={engineLabel}>{state.manualOnly ? "MANUAL ONLY" : engineLabel}</span><b>{sourceLabel}</b></div>
          <CueQueue script={state.script} snapshot={snapshot} />
          <div className="cue-controls" aria-label="Presentation controls">
            <button className="icon-control" onClick={actions.previous} disabled={!live || !output.authority || snapshot.currentIndex <= 0} aria-label="Previous cue">←</button>
            <button className="icon-control" onClick={actions.hold} disabled={!live || !output.authority} aria-label={snapshot.hold ? "Resume automatic cues" : "Hold automatic cues"} aria-pressed={snapshot.hold}>{snapshot.hold ? "▶" : "Ⅱ"}</button>
            <button className="next-cue-button" onClick={actions.next} disabled={!live || !output.authority} aria-label={lastCue ? "Complete act" : "Send next cue"}>{lastCue ? "이 막 완료" : "NEXT / 다음 큐"}<span>↗</span></button>
            <button className="icon-control" onClick={actions.resync} disabled={!live || !output.authority} aria-label="Resync">R</button>
          </div>
          <MicrophoneMonitor live={microphone.status === "live"} requesting={microphone.status === "requesting"} level={microphone.level} heardText={session.heardText} error={inputError} hasAudio={microphone.hasAudio} onToggle={microphone.status === "live" ? actions.stopMic : actions.startMic} />
        </aside>
      </div>

      <footer className="operator-settings">
        <label>음성 인식 <select aria-label="Performance ASR source" value={asrSource} disabled={!preShow || !output.authority || microphone.status === "live" || microphone.status === "requesting"} onChange={(event) => onASRSource(event.target.value as PerformanceASRSource)}><option value="browser-preview">기존 브라우저 모델 · 온라인 시연</option><option value="local">로컬 모델 · 오프라인 공연</option></select></label>
        <ProductionSelector catalog={catalog} show={show} disabled={!preShow || !output.authority} onSelect={onShow} />
        <label>인터미션 출력 <select aria-label="Intermission output" value={intermission} disabled={!preShow} onChange={(event) => onIntermission(event.target.value as IntermissionOutput)}><option value="black">검은 화면</option><option value="clear">자막 지우기</option><option value="last-caption">마지막 자막 유지</option></select></label>
        <label className="file-button">대본 JSON 불러오기<input aria-label="Import canonical show" type="file" accept="application/json,.json" disabled={!preShow} onChange={(event) => void importShow(event.target.files?.[0])} /></label>
        <button onClick={() => void actions.loadProfiles()} disabled={live}>승인 프로필 불러오기</button>
        <button onClick={actions.exportLog}>운영 로그 JSON</button>
        <span>{session.profileStatus}</span>
      </footer>
      <p className="operation-note">확정 대본만 송출합니다. HDMI 확장 디스플레이로 관객 창을 옮기고 F 또는 더블클릭으로 전체 화면 전환 · Space/→ NEXT · ← PREVIOUS · H HOLD · R RESYNC</p>
    </main>
  );
}
