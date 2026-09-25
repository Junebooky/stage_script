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
import { AudioTrackConsole } from "./AudioTrackConsole";
import type { DemoRecording } from "@/lib/demo-timeline";

const HologramAvatar = dynamic(() => import("./HologramAvatar").then((module) => module.HologramAvatar), { ssr: false });

export function OperatorExperience({ initialShow, catalog, recordings }: { initialShow: Show; catalog: ProductionCatalog; recordings: DemoRecording[] }) {
  const [demonstrationMode, setDemonstrationMode] = useState<"audio-replay" | "live-mic">("audio-replay");
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
  return <main className="minimal-experience performance-console demo-console">
    <header className="workspace-header"><div><span className="eyebrow">CUEFLOW / DEMONSTRATION CONSOLE</span><h1>{demonstrationMode === "audio-replay" ? initialShow.title : show.title}</h1></div>
      <nav aria-label="Workspace"><a href="/rehearsal">리허설 보정</a><a href="/output" target="_blank" rel="noopener">관객 화면 열기 ↗</a></nav>
    </header>
    <div className="demo-mode-switch" role="group" aria-label="시연 모드">
      <button aria-pressed={demonstrationMode === "audio-replay"} onClick={() => setDemonstrationMode("audio-replay")}>🎵 음원 시연 모드</button>
      <button aria-pressed={demonstrationMode === "live-mic"} onClick={() => setDemonstrationMode("live-mic")}>🎙️ 라이브 마이크 모드</button>
    </div>
    {storageWarning ? <p className="operation-alert" role="alert">브라우저 저장소를 사용할 수 없습니다. 현재 창에서는 선택한 대본을 사용하지만 새로고침하면 다시 선택해야 합니다.</p> : null}
    {/* Only one input and one audience publisher exist. Unmount releases media,
        pending permission requests, recognition generations and publisher lock. */}
    {demonstrationMode === "audio-replay" ? <AudioTrackConsole recordings={recordings} /> : <PerformanceConsole key={`${show.id}-${revision}-${intermission}-${asrSource}`} show={show} catalog={catalog} intermission={intermission} onIntermission={setIntermission} onShow={replaceShow} asrSource={asrSource} onASRSource={setASRSource} />}
  </main>;
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
    <section className="demo-mode-panel" aria-label="라이브 마이크 콘솔">
      <div className="demo-transport">
        <button className="demo-primary" aria-label={microphone.status === "live" || microphone.status === "requesting" ? "Stop microphone" : "Start microphone"} aria-pressed={microphone.status === "live"} disabled={!output.authority || (microphone.status !== "live" && microphone.status !== "requesting" && !["PRE_SHOW", "ACT_ARMED", "ACT_LIVE"].includes(state.phase))} onClick={() => microphone.status === "live" || microphone.status === "requesting" ? actions.stopMic() : actions.startMic(true)}>
          {microphone.status === "requesting" ? "마이크 연결 취소" : microphone.status === "live" ? "🎙️ 마이크 끄기" : "🎙️ 마이크 켜기"}
        </button>
        <span className="demo-act-status">{state.act?.title ?? "시연 준비"} · {live ? "진행 중" : state.phase === "ACT_ARMED" ? "입력·관객 연결 대기" : state.phase === "SHOW_COMPLETE" ? "완료" : "대기"}</span>
        <span className="demo-connection" data-ready={output.connected}>{output.connected ? "● 관객 연결됨" : "○ 관객 화면을 열어주세요"}</span>
        {state.phase === "SHOW_COMPLETE" ? <button onClick={actions.reset}>새 공연 준비</button> : null}
        {state.phase === "ACT_COMPLETE" ? <button onClick={actions.intermission}>인터미션 시작</button> : null}
        {state.phase === "INTERMISSION" ? <button onClick={actions.arm}>다음 막 준비</button> : null}
      </div>
      {output.error || session.assetError || importError ? <p className="operation-alert" role="alert">{output.error ?? session.assetError ?? importError}</p> : null}
      {asrSource === "browser-preview" ? <p className="operation-note">온라인 음성 인식 · 마이크 음성이 브라우저 음성 서비스로 전송될 수 있습니다.</p> : null}
      {live && !output.connected ? <p className="operation-alert" role="alert">관객 화면 연결을 확인하세요. 자동 매칭은 대기합니다.</p> : null}

      <div className="performance-layout demo-layout">
        <section className="live-stage" aria-label="Stage presentation">
          <section className={`stage-output ${snapshot.currentSegment ? "is-on-air" : ""}`} aria-label="Stage caption output" data-source={source ?? "preview"}>
            <header className="output-heading"><div><span className="eyebrow">CANONICAL / LIVE FOLLOWER</span><h2>무대 송출 자막</h2></div><span className="output-badge">{state.output === "black" || state.output === "clear" ? "BLACK" : sourceLabel}</span></header>
            <div className="demo-orb"><HologramAvatar signal={{ level: microphone.level, bands: microphone.bands, speechActive: snapshot.speechActive }} /></div>
            <CaptionDisplay segment={state.output === "black" || state.output === "clear" ? null : snapshot.displayedSegment} triggerKey={snapshot.lastTrigger?.triggeredAt ?? null} onPaint={actions.recordPaint} />
            <footer className="output-footer"><span>{snapshot.currentSegment?.id ?? "첫 대사를 기다립니다"}</span><span>확정 대본만 송출</span></footer>
          </section>
          <MicrophoneMonitor live={microphone.status === "live"} requesting={microphone.status === "requesting"} level={microphone.level} heardText={session.heardText} error={inputError} hasAudio={microphone.hasAudio} onToggle={actions.stopMic} showToggle={false} />
        </section>
        <aside className="operator-rail" aria-label="Cue controls">
          <CueQueue script={state.script} snapshot={snapshot} />
          <div className="cue-controls" aria-label="Presentation controls">
            <button className="icon-control" onClick={actions.previous} disabled={!live || !output.authority || snapshot.currentIndex <= 0} aria-label="Previous cue">←</button>
            <button className="icon-control" onClick={actions.hold} disabled={!live || !output.authority} aria-label={snapshot.hold ? "Resume automatic cues" : "Hold automatic cues"} aria-pressed={snapshot.hold}>{snapshot.hold ? "▶" : "Ⅱ"}</button>
            <button className="next-cue-button" onClick={actions.next} disabled={!live || !output.authority} aria-label={lastCue ? "Complete act" : "Send next cue"}>{lastCue ? "이 막 완료" : "다음 큐 송출"}<span>↗</span></button>
            <button className="icon-control" onClick={actions.resync} disabled={!live || !output.authority} aria-label="Resync">R</button>
          </div>
          <p className="operation-note">Space 다음 큐 · R 재동기화</p>
        </aside>
      </div>
      <details className="engineering-settings"><summary>엔지니어링 설정 (Advanced Settings)</summary>
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

          <div className="operator-metrics" aria-label="Realtime caption metrics">
            <div><span>CURRENT CUE</span><strong>{snapshot.currentSegment?.id ?? "—"}</strong></div>
            <div><span>MATCH CONFIDENCE</span><strong>{source === "manual" ? "—" : `${Math.round(snapshot.confidence * 100)}%`}</strong></div>
            <div><span>LATENCY · {session.latency?.basis ?? "미리보기"}</span><strong>{session.latency ? `${Math.round(session.latency.ms)} ms` : "—"}</strong></div>
          </div>
          <div className="engine-status"><span data-engine-state={engineLabel}>{state.manualOnly ? "MANUAL ONLY" : engineLabel}</span><b>{sourceLabel}</b></div>

      <footer className="operator-settings">
        <label>음성 인식 <select aria-label="Performance ASR source" value={asrSource} disabled={!preShow || !output.authority || microphone.status === "live" || microphone.status === "requesting"} onChange={(event) => onASRSource(event.target.value as PerformanceASRSource)}><option value="browser-preview">기존 브라우저 모델 · 온라인 시연</option><option value="local">로컬 모델 · 오프라인 공연</option></select></label>
        <ProductionSelector catalog={catalog} show={show} disabled={!preShow || !output.authority} onSelect={onShow} />
        <label>인터미션 출력 <select aria-label="Intermission output" value={intermission} disabled={!preShow} onChange={(event) => onIntermission(event.target.value as IntermissionOutput)}><option value="black">검은 화면</option><option value="clear">자막 지우기</option><option value="last-caption">마지막 자막 유지</option></select></label>
        <label className="file-button">대본 JSON 불러오기<input aria-label="Import canonical show" type="file" accept="application/json,.json" disabled={!preShow} onChange={(event) => void importShow(event.target.files?.[0])} /></label>
        <button onClick={() => void actions.loadProfiles()} disabled={live}>승인 프로필 불러오기</button>
        <button onClick={actions.exportLog}>운영 로그 JSON</button>
        <span>{session.profileStatus}</span>
      </footer>
      </details>
      <p className="operation-note">확정 대본만 송출합니다. HDMI 확장 디스플레이로 관객 창을 옮기고 F 또는 더블클릭으로 전체 화면 전환 · Space/→ NEXT · ← PREVIOUS · H HOLD · R RESYNC</p>
    </section>
  );
}
