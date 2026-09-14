"use client";

import { useMemo, useState } from "react";
import type { Show } from "@stage/script-schema";
import { buildRecordingReplayScript, evaluateRecordingReplay, validateRecordingReference, type RegisteredReplayData } from "@stage/rehearsal";
import { useRecordingReplay } from "@/hooks/use-recording-replay";
import { useAudiencePublisher } from "@/hooks/use-audience-publisher";
import type { AudienceView } from "@/lib/audience-protocol";
import { downloadJSON, localBackendUrl, localRequest } from "@/lib/local-runtime";
import { CaptionDisplay } from "./CaptionDisplay";

const ignorePaint = () => {};
const clock = (ms: number) => Number.isFinite(ms) ? `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${(ms / 1000 % 60).toFixed(2).padStart(5, "0")}` : "—";

export function RecordingReplay({ show, numberId, onStart }: { show: Show; numberId: string; onStart: () => void }) {
  const [data, setData] = useState<RegisteredReplayData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registered = show.id === "decadence-gyeongseong" && numberId === "M05-2";
  async function prepare() {
    setBusy(true); setError(null);
    try {
      const loaded = await localRequest<RegisteredReplayData>("/replay-recordings/R001-M05-2");
      buildRecordingReplayScript(show, loaded.profile);
      validateRecordingReference(loaded.profile, loaded.reference);
      if (loaded.evidence.recordingId !== loaded.profile.recordingId || loaded.evidence.sourceAudioSha256 !== loaded.profile.sourceAudioSha256 || loaded.evidence.sourceArtifactSha256 !== loaded.profile.asrEvidenceSource.sha256) throw new Error("Saved replay evidence provenance mismatch");
      setData(loaded);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "저장된 리플레이를 불러오지 못했습니다."); }
    finally { setBusy(false); }
  }
  return <section className="replay-panel" aria-label="Realtime recording replay">
    <span className="eyebrow">04 / REALTIME REPLAY DEMO</span>
    <h2>녹음은 그대로, 자막은 확정 대본으로</h2>
    <p className="operation-note">실제 원본 WAV 1.0× + 저장된 Groq 단어 증거 → 기존 공연 matcher → 확정 자막. 새 ASR 호출·마이크·자동 복구·fallback OFF.</p>
    {!data ? <>
      <button disabled={!registered || busy} onClick={() => void prepare()}>{busy ? "로컬 파일·해시 검증 중…" : "R001 리플레이 준비"}</button>
      <p className="operation-note">준비 후 START REPLAY를 누르세요. 별도 운영 창이 열려 있으면 닫아야 송출 권한을 확보할 수 있습니다. {registered ? "등록된 원본과 저장 ASR이 이 컴퓨터에 필요합니다." : "현재 대본에는 등록된 리플레이가 없습니다."}</p>
    </> : <ReplaySession show={show} data={data} onStart={onStart} />}
    {error ? <p className="operation-alert" role="alert">{error}</p> : null}
  </section>;
}

function ReplaySession({ show, data, onStart }: { show: Show; data: RegisteredReplayData; onStart: () => void }) {
  const script = useMemo(() => buildRecordingReplayScript(show, data.profile), [show, data.profile]);
  const { audioRef, snapshot, error, command, audioEvent } = useRecordingReplay(script, data.evidence);
  const visible = snapshot && ["playing", "paused", "ended"].includes(snapshot.state) ? snapshot.engine.displayedSegment : null;
  const view = useMemo<AudienceView>(() => visible?.type === "IMAGE" && visible.image ? { kind: "image", cueId: visible.id, src: visible.image.src, alt: visible.image.alt }
    : visible ? { kind: "caption", cueId: visible.id, lines: visible.captions.map((line) => line.text) } : { kind: "black" }, [visible]);
  const output = useAudiencePublisher(view);
  const report = useMemo(() => evaluateRecordingReplay(data.profile, data.reference, snapshot?.triggers ?? [], {
    complete: snapshot?.state === "ended", throughMs: snapshot?.audioTimeMs ?? 0, deliveries: snapshot?.deliveries ?? [],
  }), [data, snapshot]);
  const last = snapshot?.triggers.at(-1);
  const lastEvaluation = report.cues.find((cue) => cue.cueId === last?.cueId);
  const state = snapshot?.state ?? "ready";
  const active = state === "playing" || state === "paused";
  const postTake = data.profile.nonCanonicalEvents.find((event) => (snapshot?.latestEvidence?.dueAtMs ?? -1) >= event.startMs);
  async function act(action: Parameters<typeof command>[0]) {
    if (["start", "resume", "restart"].includes(action)) {
      if (!output.authority) return;
      onStart();
    }
    await command(action);
  }
  return <div className="recording-replay" data-replay-state={state}>
    <div className="replay-title"><strong>{data.profile.recordingId} · M5-2_외로운별 _0420.wav</strong><span>{state.toUpperCase()} · 1.0×</span></div>
    <audio ref={audioRef} preload="metadata" src={localBackendUrl(`/replay-recordings/${encodeURIComponent(data.profile.recordingId)}/audio`)} aria-label="Registered replay original audio"
      onEnded={() => audioEvent("ended")} onError={() => audioEvent("error")} onSeeking={() => audioEvent("seeking")} onRateChange={() => audioEvent("ratechange")} />
    <div className="replay-controls" role="group" aria-label="Replay transport">
      <button disabled={!snapshot || !output.authority || !["ready", "stopped", "ended", "error"].includes(state)} onClick={() => void act("start")}>START REPLAY</button>
      <button disabled={state !== "playing" && state !== "starting"} onClick={() => void act("pause")}>PAUSE</button>
      <button disabled={state !== "paused" || !output.authority} onClick={() => void act("resume")}>RESUME</button>
      <button disabled={!snapshot || state === "stopped" || state === "ready"} onClick={() => void act("stop")}>STOP</button>
      <button disabled={!snapshot || !output.authority} onClick={() => void act("restart")}>RESTART</button>
      <a href="/output" target="_blank" rel="noopener noreferrer">관객 송출 ↗</a>
    </div>
    <div className="replay-time"><time data-testid="replay-clock">{clock(snapshot?.audioTimeMs ?? 0)}</time><span>/ {clock(data.durationMs)}</span><progress aria-label="Replay progress" max={data.durationMs} value={snapshot?.audioTimeMs ?? 0} /></div>
    <p className="operation-note">{output.authority ? "단일 송출 권한 확보" : "송출 권한 대기"} · {output.connected ? "관객 화면 연결됨" : "관객 화면 미연결"} · 저장 증거 {snapshot?.evidenceCursor ?? 0}/{data.evidence.sourceWordCount} words · {data.evidence.sourceSegmentCount} segments</p>
    {output.error || error ? <p className="operation-alert" role="alert">{output.error ?? error}</p> : null}
    <div className="replay-columns">
      <div className="replay-stage"><span className="eyebrow">STAGE OUTPUT · CANONICAL ONLY</span><CaptionDisplay segment={visible} triggerKey={last?.atMs ?? null} onPaint={ignorePaint} />
        <dl className="replay-details"><div><dt>현재 큐</dt><dd data-testid="replay-current-cue">{visible?.id ?? "—"}</dd></div><div><dt>다음 대기</dt><dd data-testid="replay-next-cue">{snapshot?.engine.nextSegment?.id ?? "END"}</dd></div></dl>
      </div>
      <div className="replay-evidence"><span className="eyebrow">SAVED ASR · OPERATOR ONLY</span><p data-testid="replay-asr">{snapshot?.latestEvidence?.text ?? "오디오 시계에 맞춰 단어 증거를 기다립니다."}</p>
        <dl className="replay-details"><div><dt>마지막 trigger</dt><dd>{last?.source ?? "—"} · {last ? clock(last.atMs) : "—"}</dd></div><div><dt>Silver 기준 시작</dt><dd>{lastEvaluation ? clock(lastEvaluation.referenceStartMs) : "—"}</dd></div><div><dt>Signed timing error</dt><dd>{lastEvaluation?.timingErrorMs == null ? "—" : `${lastEvaluation.timingErrorMs >= 0 ? "+" : ""}${Math.round(lastEvaluation.timingErrorMs)} ms · ${lastEvaluation.category}`}</dd></div><div><dt>녹음별 생략</dt><dd>{data.profile.absentCueIds.length} cues · C009–C017</dd></div></dl>
        <p className="operation-note" data-testid="replay-post-take">{postTake ? `POST_TAKE_SPEECH · ${postTake.text} · 진단 전용 / 오송출 ${report.metrics.postTakeFalseTriggerCount}` : "POST_TAKE_SPEECH · 아직 도달하지 않음"}</p>
      </div>
    </div>
    <div className="replay-controls" role="group" aria-label="Replay manual operator controls"><span>운영자 수동 개입</span>
      <button disabled={!active || !output.authority} onClick={() => void act("previous")}>이전 큐</button><button disabled={!active || !output.authority} onClick={() => void act("next")}>다음 큐 송출</button>
      <button disabled={!active || !output.authority} aria-pressed={snapshot?.engine.hold ?? false} onClick={() => void act("hold")}>{snapshot?.engine.hold ? "HOLD 해제" : "HOLD"}</button>
    </div>
    <p className="operation-note">단어 종료 시각에 증거를 전달하는 저장 ASR 시뮬레이션입니다. 실제 실시간 ASR 지연이 아닙니다. 기준은 human-confirmed가 아닌 silver-reference이며 자동 송출에 사용하지 않습니다.</p>
    <div className="analysis-summary" data-testid="replay-summary"><strong>{report.metrics.correctTriggerCount} / {report.metrics.performedCueCount} correct</strong><span>{report.metrics.missedCueCount} missed</span><span>{report.metrics.wrongTriggerCount} wrong</span><span>{report.metrics.earlyCount} early / {report.metrics.lateCount} late</span><span>{report.metrics.primaryBlockingFailureCount} primary / {report.metrics.cascadeBlockedCount} cascade</span></div>
    {report.metrics.coalescedAutomaticTriggerCount > 0 ? <p className="operation-alert" role="alert">같은 오디오 poll에서 여러 큐가 처리된 경우 {report.metrics.coalescedAutomaticTriggerCount}회. 일부 중간 자막은 화면에서 합쳐졌을 수 있습니다. correct 수치는 실제 관객 렌더 수가 아닙니다. RESTART 후 관객 출력을 확인하세요.</p> : null}
    <details className="replay-evaluation"><summary>27개 큐 평가 · {state === "ended" ? "완료" : "진행/부분 결과"} · 조기 −250ms / 지연 +1500ms</summary>
      <p className="operation-note">|오차| 중앙값 {report.metrics.medianAbsoluteTimingErrorMs?.toFixed(0) ?? "—"}ms · P95 {report.metrics.p95AbsoluteTimingErrorMs?.toFixed(0) ?? "—"}ms · 반복 혼동 {report.metrics.repeatedLyricConfusionCount} · 예상 밖 건너뜀 {report.metrics.unexpectedReplaySkipCount} · fallback {report.metrics.fallbackTriggerCount} · 수동 {report.metrics.manualTriggerCount}</p>
      <div className="replay-table-scroll"><table><thead><tr><th>Cue</th><th>Reference</th><th>Trigger</th><th>Δ ms</th><th>Source / Result</th><th>검토·블로커</th></tr></thead><tbody>{report.cues.map((cue) => <tr key={cue.cueId}><th scope="row">{cue.cueId}</th><td>{clock(cue.referenceStartMs)}</td><td>{cue.actualTriggerMs === null ? "—" : clock(cue.actualTriggerMs)}</td><td>{cue.timingErrorMs?.toFixed(0) ?? "—"}</td><td>{cue.triggerSource ?? "—"} / {cue.category}</td><td>{cue.failure ? `${cue.failure}${cue.blockedByCueId ? ` ← ${cue.blockedByCueId}` : ""}` : cue.warnings.join(" ") || "—"}</td></tr>)}</tbody></table></div>
      <button onClick={() => downloadJSON(`${data.profile.recordingId}-browser-replay.json`, { validationMode: "browser-audio-clock", ...report, sourceAudioSha256: data.profile.sourceAudioSha256, sourceASRSha256: data.evidence.sourceArtifactSha256, state: snapshot })}>로컬 평가 JSON 저장</button>
    </details>
  </div>;
}
