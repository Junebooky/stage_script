"use client";

import { useEffect, useMemo, useState } from "react";
import { useTimelineDemonstration } from "@/hooks/use-recording-replay";
import { useAudiencePublisher } from "@/hooks/use-audience-publisher";
import { demoClock, timelineQueue, type DemoTimeline } from "@/lib/demo-timeline";
import { localBackendUrl } from "@/lib/local-runtime";
import type { AudienceView } from "@/lib/audience-protocol";
import { CaptionDisplay } from "./CaptionDisplay";
import { CueQueue } from "./CueQueue";

const publicTrack = "/M5-2_외로운별_0420.wav";
const ignorePaint = () => {};

export function AudioTrackConsole({ timeline }: { timeline: DemoTimeline }) {
  const [source, setSource] = useState({ url: publicTrack, label: "M5-2_외로운별_0420.wav", kind: "public" });
  useEffect(() => () => { if (source.kind === "file") URL.revokeObjectURL(source.url); }, [source]);
  return <AudioTrackSession key={source.url} timeline={timeline} source={source} onSource={setSource} />;
}

function AudioTrackSession({ timeline, source, onSource }: {
  timeline: DemoTimeline;
  source: { url: string; label: string; kind: string };
  onSource: (source: { url: string; label: string; kind: string }) => void;
}) {
  const replay = useTimelineDemonstration(timeline);
  const segment = timeline.script.segments[replay.index] ?? null;
  const view = useMemo<AudienceView>(() => segment?.type === "IMAGE" && segment.image
    ? { kind: "image", cueId: segment.id, src: segment.image.src, alt: segment.image.alt }
    : segment ? { kind: "caption", cueId: segment.id, lines: segment.captions.map((line) => line.text) } : { kind: "black" }, [segment]);
  const output = useAudiencePublisher(view);
  useEffect(() => { if (!output.authority) replay.stop(); }, [output.authority, replay.stop]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!output.authority || event.repeat || (event.target as HTMLElement | null)?.closest("input,textarea,select,button,a,summary,audio,[contenteditable=true]")) return;
      if (event.code === "Space" || event.code === "ArrowRight") { event.preventDefault(); replay.manual(1); }
      else if (event.code === "ArrowLeft") { event.preventDefault(); replay.manual(-1); }
      else if (event.key.toLowerCase() === "r") { event.preventDefault(); replay.resync(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [output.authority, replay.manual, replay.resync]);
  const queue = useMemo(() => timelineQueue(timeline, replay.index, replay.ended), [timeline, replay.index, replay.ended]);
  // Prevent presenting a truncated/different-length recording as the R001 demo.
  const durationMismatch = replay.duration > 0 && Math.abs(replay.duration - 226.138479) > 1;
  useEffect(() => { if (durationMismatch) replay.stop(); }, [durationMismatch, replay.stop]);

  return <section className="demo-mode-panel" aria-label="음원 시연 콘솔" data-demo-state={replay.playing ? "playing" : replay.ended ? "ended" : replay.active ? "paused" : "ready"}>
    <div className="demo-transport">
      <button className="demo-primary" onClick={() => { if (output.authority) void replay.toggle(); }} disabled={!output.authority || durationMismatch}>
        {replay.playing ? "일시정지" : replay.ended ? "다시 재생" : replay.active ? "재생 계속" : "재생 시작"}
      </button>
      <button onClick={replay.stop} disabled={!output.authority || !replay.active}>정지</button>
      <span className="demo-act-status">M05-2 · {replay.ended ? "완료" : replay.playing ? "시연 중" : "음원 시연 준비"}</span>
      <span className="demo-connection" data-ready={output.connected}>{output.connected ? "● 관객 연결됨" : "○ 관객 미연결 · 미리보기"}</span>
    </div>
    <p className="operation-note">기준 음원 타임라인 시연 · 실제 ASR 인식이나 live latency 측정이 아닙니다.</p>
    <audio ref={replay.audioRef} src={source.url} preload="metadata" aria-label="시연 음원"
      onTimeUpdate={replay.sync} onLoadedMetadata={replay.sync} onDurationChange={replay.sync}
      onPlay={replay.sync} onPause={replay.sync} onEnded={replay.sync} onSeeked={replay.sync} onError={replay.fail} />
    <div className="demo-audio-track">
      <div className="demo-track-label"><strong>{source.label}</strong><time data-testid="demo-timecode">{demoClock(replay.time)} / {demoClock(replay.duration)}</time></div>
      <input type="range" min="0" max={replay.duration || 1} step="0.01" value={replay.time} aria-label="음원 탐색" disabled={!output.authority || !replay.duration || durationMismatch} onChange={(event) => { if (output.authority) replay.seek(Number(event.target.value)); }} />
      <label className="file-button">음원 파일 선택<input type="file" accept="audio/*,.wav" aria-label="시연 음원 파일 선택" disabled={!output.authority} onChange={(event) => {
        const file = event.target.files?.[0];
        if (file && output.authority) { replay.stop(); onSource({ url: URL.createObjectURL(file), label: file.name, kind: "file" }); }
      }} /></label>
    </div>
    {output.error || replay.error || durationMismatch ? <p className="operation-alert" role="alert">{output.error ?? (durationMismatch ? "R001 기준 음원(226.138초)과 길이가 다릅니다. 편집하지 않은 원본 음원을 선택하세요." : replay.error)}</p> : null}
    <div className="performance-layout demo-layout">
      <section className="stage-output demo-track-stage" aria-label="Stage caption output" data-source="reference-timeline-demo">
        <header className="output-heading"><div><span className="eyebrow">CANONICAL / TRACK DEMO</span><h2>무대 송출 자막</h2></div><span className="output-badge">{segment ? "ON AIR" : "대기"}</span></header>
        <CaptionDisplay segment={segment} triggerKey={replay.index} onPaint={ignorePaint} />
        <footer className="output-footer"><span>{segment?.id ?? "음원 재생을 기다립니다"}</span><span>확정 대본만 송출</span></footer>
      </section>
      <aside className="operator-rail" aria-label="Cue controls">
        <CueQueue script={timeline.script} snapshot={queue} />
        <div className="cue-controls">
          <button className="icon-control" aria-label="Previous cue" disabled={!output.authority || !replay.active || replay.index < 0} onClick={() => { if (output.authority) replay.manual(-1); }}>←</button>
          <button className="next-cue-button" aria-label="Send next cue" disabled={!output.authority || !replay.active || replay.index >= timeline.cues.length - 1} onClick={() => { if (output.authority) replay.manual(1); }}>다음 큐 송출 ↗</button>
          <button className="icon-control" aria-label="Resync" disabled={!output.authority || !replay.active} onClick={() => { if (output.authority) replay.resync(); }}>R</button>
        </div>
        <p className="operation-note">Space 다음 큐 · R 음원 시각으로 복귀</p>
      </aside>
    </div>
    <details className="engineering-settings"><summary>엔지니어링 설정 (Advanced Settings)</summary>
      <div className="operator-settings">
        <label>음원 위치 <select aria-label="시연 음원 위치" value={source.kind} disabled={!output.authority} onChange={(event) => {
          replay.stop();
          onSource(event.target.value === "registered" ? { kind: "registered", url: localBackendUrl(`/replay-recordings/${timeline.recordingId}/audio`), label: "R001 등록 원본 · 로컬 서버" } : { kind: "public", url: publicTrack, label: "M5-2_외로운별_0420.wav" });
        }}><option value="public">public/ 음원</option><option value="registered">등록 원본 · localhost:8000</option>{source.kind === "file" ? <option value="file">선택한 파일</option> : null}</select></label>
        <a href="/rehearsal">저장 ASR replay · 프로필 · 분석 로그 ↗</a>
      </div>
      <p className="operation-note">R001 전용 27개 큐 · canonical 36개는 변경하지 않습니다. Silver reference 기반 연출이며 정확도 평가에 사용하지 않습니다. 다른 편집본은 길이가 같아도 동기화를 보장하지 않습니다. 파일은 이 브라우저에서만 재생하며 서버에 업로드하지 않습니다.</p>
    </details>
  </section>;
}
