"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useScriptFollower } from "@/hooks/use-script-follower";
import { AudioWaveform } from "./AudioWaveform";
import { CaptionDisplay } from "./CaptionDisplay";
import { DebugPanel } from "./DebugPanel";
import { SimulationControls } from "./SimulationControls";

const HologramAvatar = dynamic(
  () => import("./HologramAvatar").then((module) => module.HologramAvatar),
  { ssr: false, loading: () => <div className="avatar-shell avatar-loading">INITIALIZING HOLOGRAM</div> }
);

function metric(value: number | null, suffix = "ms") {
  return value === null ? "—" : `${Math.round(value)} ${suffix}`;
}

export function DemoExperience() {
  const follower = useScriptFollower();
  const { snapshot, latency, microphone, actions } = follower;
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).get("debug") === "true");
  }, []);

  const handlePaint = useCallback(() => {
    const trigger = snapshot.lastTrigger;
    if (trigger) actions.recordPaint(trigger.triggeredAt, trigger.speechOnsetAt);
  }, [actions, snapshot.lastTrigger]);

  const signalLevel = microphone.status === "live" ? microphone.level : snapshot.speechActive ? Math.max(0.12, snapshot.confidence * 0.42) : 0.03;
  const displayNumber = snapshot.currentIndex < 0 ? "000" : String(snapshot.currentIndex + 1).padStart(3, "0");
  const isLive = microphone.status === "live";

  return (
    <main className="experience-shell">
      <div className="ambient-grid" />
      <header className="topbar">
        <a className="wordmark" href="/demo" aria-label="Cueflow demo home">
          <span className="wordmark-glyph">C</span>
          <span>CUEFLOW</span>
        </a>
        <div className="show-title">
          <span>PERFORMANCE SCRIPT</span>
          <strong>{follower.script.title}</strong>
        </div>
        <div className="topbar-actions">
          <button className={debug ? "debug-toggle active" : "debug-toggle"} onClick={() => setDebug((value) => !value)}>
            DEBUG
          </button>
          <div className={`system-pill phase-${snapshot.phase.toLowerCase()}`}>
            <span /> {snapshot.hold ? "HOLD" : snapshot.phase}
          </div>
        </div>
      </header>

      <section className="stage">
        <aside className="metric-rail left-rail">
          <div className="rail-heading">SCRIPT LOCK</div>
          <div className="large-metric"><span>SEGMENT</span><strong>{displayNumber}</strong></div>
          <div className="rail-metric"><span>SYNC CONFIDENCE</span><strong>{(snapshot.confidence * 100).toFixed(1)}<small>%</small></strong></div>
          <div className="confidence-track"><i style={{ width: `${snapshot.confidence * 100}%` }} /></div>
          <div className="rail-metric"><span>ARMED NEXT</span><strong className="text-value">{snapshot.nextSegment?.id.toUpperCase() ?? "END"}</strong></div>
          <div className="rail-metric"><span>SEARCH MODE</span><strong className="text-value accent">{snapshot.searchMode}</strong></div>
        </aside>

        <div className="stage-center">
          <div className="listening-state">
            <span className={snapshot.speechActive || isLive ? "listening-dot active" : "listening-dot"} />
            <strong>{isLive ? "LISTENING" : "SCRIPT ENGINE ARMED"}</strong>
            <small>{follower.notice}</small>
          </div>
          <HologramAvatar signal={{ level: signalLevel, bands: microphone.bands, speechActive: snapshot.speechActive || isLive }} />
          <AudioWaveform level={signalLevel} active={snapshot.speechActive || isLive} />
          <CaptionDisplay
            segment={snapshot.displayedSegment}
            triggerKey={snapshot.lastTrigger?.triggeredAt ?? null}
            onPaint={handlePaint}
          />
        </div>

        <aside className="metric-rail right-rail">
          <div className="rail-heading">END-TO-END</div>
          <div className="latency-primary"><span>LAST LATENCY</span><strong>{metric(latency.last)}</strong></div>
          <div className="latency-grid">
            <div><span>P50</span><strong>{metric(latency.p50, "")}</strong></div>
            <div><span>P95</span><strong>{metric(latency.p95, "")}</strong></div>
            <div><span>P99</span><strong>{metric(latency.p99, "")}</strong></div>
          </div>
          <div className="rail-rule" />
          <div className="connection-row"><span>INPUT</span><strong>{isLive ? "LAPTOP MIC" : "SIMULATION"}</strong></div>
          <div className="connection-row"><span>ASR</span><strong>{follower.asrStatus.toUpperCase()}</strong></div>
          <div className="connection-row"><span>AUDIO WS</span><strong className={`connection-${microphone.socketStatus}`}>{microphone.socketStatus.toUpperCase()}</strong></div>
          <div className="connection-row"><span>CHUNK</span><strong>20 MS / 16 K</strong></div>
        </aside>
      </section>

      {debug && <DebugPanel snapshot={snapshot} vad={snapshot.speechActive} level={signalLevel} />}

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

      <footer className="keyboard-help">
        <span><kbd>SPACE</kbd> NEXT</span>
        <span><kbd>←</kbd><kbd>→</kbd> NAVIGATE</span>
        <span><kbd>H</kbd> HOLD</span>
        <span><kbd>R</kbd> RESYNC</span>
      </footer>
    </main>
  );
}
