"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { useScriptFollower } from "@/hooks/use-script-follower";
import { CaptionDisplay } from "./CaptionDisplay";
import { DebugPanel } from "./DebugPanel";
import { SimulationControls } from "./SimulationControls";
import { CueQueue } from "./CueQueue";
import { MicrophoneMonitor } from "./MicrophoneMonitor";

const HologramAvatar = dynamic(
  () => import("./HologramAvatar").then((module) => module.HologramAvatar),
  { ssr: false, loading: () => <div className="avatar-shell" /> }
);

function metric(value: number | null) {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

export function DemoExperience() {
  const follower = useScriptFollower();
  const { snapshot, latency, microphone, actions } = follower;
  const { recordPaint } = actions;
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).get("debug") === "true");
  }, []);

  const handlePaint = useCallback(() => {
    const trigger = snapshot.lastTrigger;
    if (trigger) recordPaint(trigger.triggeredAt, trigger.speechOnsetAt, trigger.source);
  }, [recordPaint, snapshot.lastTrigger]);

  const isLive = microphone.status === "live";
  const isRequesting = microphone.status === "requesting";
  const signalLevel = isLive
    ? microphone.level
    : snapshot.speechActive
      ? Math.max(0.12, snapshot.confidence * 0.42)
      : 0;
  const displayNumber = snapshot.currentIndex < 0 ? "000" : String(snapshot.currentIndex + 1).padStart(3, "0");
  const inputError = microphone.error ?? (isLive && !microphone.backendASR ? follower.asrError : null);
  const onAir = snapshot.currentIndex >= 0 && !snapshot.finished;
  const outputState = snapshot.finished ? "complete" : onAir ? "on-air" : "standby";
  const manualCue = snapshot.lastTrigger?.source === "manual" && snapshot.partial === "MANUAL";

  return (
    <main className={`minimal-experience ${debug ? "with-debug" : ""}`}>
      <section className="metric-strip" aria-label="Realtime caption metrics">
        <div><span>SEGMENT</span><strong>{displayNumber}</strong></div>
        <div title={manualCue ? "수동 송출에는 음성 매칭 신뢰도가 없습니다." : "대본과 입력 음성의 매칭 신뢰도"}><span>SYNC CONFIDENCE</span><strong>{manualCue ? "—" : `${(snapshot.confidence * 100).toFixed(1)}%`}</strong></div>
        <div title={follower.latencyBasis === "recognition" ? "연속 발화의 다음 대사는 정확한 음성 시작 시각을 알 수 없어, 인식 결과 수신부터 표시까지 측정합니다. ASR 대기 시간은 포함되지 않습니다." : manualCue ? "수동 큐 실행부터 화면 표시까지" : "음성 시작부터 자막 표시까지"}><span>LATENCY{follower.latencyBasis ? <em>{follower.latencyBasis === "speech" ? "음성→표시" : follower.latencyBasis === "recognition" ? "인식→표시" : "수동→표시"}</em> : null}</span><strong>{metric(latency.last)}</strong></div>
      </section>

      <div className="performance-layout">
        <section className="live-stage" aria-label="Stage presentation">
          <div className="stage-identity"><span>{follower.script.title}</span><span>{snapshot.currentSegment?.metadata?.scene ?? "1막"} <i /> LIVE CAPTION</span></div>
          <div className="orb-stage">
            <HologramAvatar signal={{ level: signalLevel, bands: microphone.bands, speechActive: snapshot.speechActive }} />
            <div className="stage-horizon" aria-hidden="true" />
          </div>
          <section className={`stage-output is-${outputState}`} aria-label="Stage caption output" data-state={outputState} data-source={snapshot.lastTrigger?.source ?? "preview"}>
            <header className="output-heading"><div><span className="eyebrow">STAGE OUTPUT</span><h1>무대 송출 자막</h1></div><span className={`output-badge ${snapshot.hold ? "is-held" : ""}`}><i />{snapshot.finished ? "COMPLETE" : snapshot.hold ? "HOLD" : onAir ? "ON AIR" : "자막 대기중"}</span></header>
            <CaptionDisplay segment={snapshot.displayedSegment} previewSegment={follower.script.segments[0]!} triggerKey={snapshot.lastTrigger?.triggeredAt ?? null} onPaint={handlePaint} />
            <footer className="output-footer"><span>{snapshot.finished ? "송출 완료 · 마지막 자막 유지" : onAir ? "확정 대본 · 관객에게 보이는 자막" : "대본 미리보기 · 아직 송출되지 않았습니다"}</span><span>{onAir ? `${snapshot.lastTrigger?.source === "manual" ? "MANUAL" : "SYNC"} / CUE ${displayNumber}` : snapshot.finished ? "END OF SCENE" : "STANDBY"}</span></footer>
            {onAir ? <span key={snapshot.lastTrigger?.triggeredAt} className="cue-flash" aria-hidden="true" /> : null}
          </section>
        </section>

        <aside className="operator-rail" aria-label="Cue and microphone controls">
          <CueQueue script={follower.script} snapshot={snapshot} />
          <div className="cue-controls" aria-label="Presentation controls">
            <button className="icon-control" onClick={actions.manualPrevious} disabled={snapshot.currentIndex <= 0} aria-label="Previous cue" title="이전 큐">←</button>
            <button className={`icon-control ${snapshot.hold ? "is-held" : ""}`} onClick={actions.toggleHold} aria-label={snapshot.hold ? "Resume automatic cues" : "Hold automatic cues"} aria-pressed={snapshot.hold} title={snapshot.hold ? "자동 송출 재개" : "자동 송출 보류"}>{snapshot.hold ? "▶" : "Ⅱ"}</button>
            <button className="next-cue-button" onClick={actions.manualNext} disabled={snapshot.finished} aria-label={snapshot.nextSegment ? "Send next cue" : "Complete final cue"}>{snapshot.finished ? "송출 완료" : snapshot.nextSegment ? "다음 큐 송출" : "마지막 큐 완료"}<span aria-hidden="true">↗</span></button>
            <button className="icon-control" onClick={actions.reset} aria-label="Reset performance" title="처음부터">↺</button>
          </div>
          <MicrophoneMonitor live={isLive} requesting={isRequesting} level={isLive ? microphone.level : 0} heardText={follower.heardText} error={inputError} hasAudio={microphone.hasAudio} onToggle={isLive ? () => void actions.stopLive() : () => void actions.startLive()} />
        </aside>
      </div>

      {debug ? (
        <div className="debug-layer">
          <DebugPanel snapshot={snapshot} vad={snapshot.speechActive} level={signalLevel} />
          <SimulationControls
            live={isLive}
            hold={snapshot.hold}
            onStartLive={() => void actions.startLive()}
            onStopLive={() => void actions.stopLive()}
            onPartial={actions.nextPartial}
            onTrigger={actions.triggerExpected}
            onPause={actions.simulatePause}
            onWrong={actions.simulateWrongPhrase}
            onSkip={actions.simulateSkip}
            onOverlap={actions.simulateOverlap}
            onPrevious={actions.manualPrevious}
            onNext={actions.manualNext}
            onHold={actions.toggleHold}
            onResync={actions.forceResync}
            onReset={actions.reset}
          />
        </div>
      ) : null}
    </main>
  );
}
