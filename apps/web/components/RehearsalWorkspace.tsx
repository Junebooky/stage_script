"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flattenShow, type Show } from "@stage/script-schema";
import type { ProductionCatalog } from "@stage/script-schema/production-types";
import { analyzeNumberRehearsal, buildCueProfiles, canonicalFingerprint, confirmObservation, dismissReviewItem, evaluateChallenger, type CueObservation, type ProfileCandidate, type RehearsalAnalysis, type TimestampedASR } from "@stage/rehearsal";
import { localBackendUrl, localRequest, downloadJSON } from "@/lib/local-runtime";
import { readSelectedShow, storeSelectedShow } from "@/lib/show-storage";
import { ProductionSelector } from "./ProductionSelector";
import { RecordingReplay } from "./RecordingReplay";
import asrCatalog from "../../../data/asr-providers.json";

interface Manifest { id: string; filename: string; showId: string; numberId?: string; status: string; error?: string; warning?: string; durationMs?: number; asrProvider?: string; provider?: string; providerDisplayName?: string; model?: string }
interface ProfileStore { champion: ProfileCandidate | null; challengers: ProfileCandidate[] }

export function RehearsalWorkspace({ initialShow, catalog }: { initialShow: Show; catalog: ProductionCatalog }) {
  const [show, setShow] = useState<Show>(initialShow);
  const [hydrated, setHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  useEffect(() => { setShow(readSelectedShow(initialShow)); setHydrated(true); }, [initialShow]);
  if (!hydrated) return <main className="rehearsal-page"><p role="status">확정 대본을 준비합니다.</p></main>;
  return <>{storageWarning ? <p className="operation-alert" role="alert">브라우저 저장소를 사용할 수 없습니다. 새로고침하면 대본을 다시 선택해야 합니다.</p> : null}<NumberRehearsal key={canonicalFingerprint(show)} show={show} catalog={catalog} onShow={(next) => { setStorageWarning(!storeSelectedShow(next)); setShow(next); }} /></>;
}

function NumberRehearsal({ show, catalog, onShow }: { show: Show; catalog: ProductionCatalog; onShow: (show: Show) => void }) {
  const numbers = show.acts.flatMap((act) => act.numbers);
  const [numberId, setNumberId] = useState(numbers[0]!.id);
  return <RehearsalSession key={numberId} show={show} catalog={catalog} numberId={numberId} onNumber={setNumberId} onShow={onShow} />;
}

function RehearsalSession({ show, catalog, numberId, onNumber, onShow }: { show: Show; catalog: ProductionCatalog; numberId: string; onNumber: (numberId: string) => void; onShow: (show: Show) => void }) {
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [analyses, setAnalyses] = useState<RehearsalAnalysis[]>([]);
  const [profiles, setProfiles] = useState<ProfileStore>({ champion: null, challengers: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("ASR을 선택하세요. 확정 자막은 변경하지 않습니다.");
  const [asrProvider, setASRProvider] = useState(asrCatalog.defaultProviderId);
  const [allowCloudUpload, setAllowCloudUpload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [fallbackIds, setFallbackIds] = useState<string[]>([]);
  const refreshing = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dataset = catalog.datasets.find((item) => item.productionId === show.id && item.id === numberId);
  const providerMetadata = asrCatalog.providers.find((provider) => provider.id === asrProvider)!;

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [records, store] = await Promise.all([
        localRequest<Manifest[]>(`/rehearsals?showId=${encodeURIComponent(show.id)}&numberId=${encodeURIComponent(numberId)}`),
        localRequest<ProfileStore>(`/profiles?showId=${encodeURIComponent(show.id)}&numberId=${encodeURIComponent(numberId)}`)
      ]);
      setManifests(records);
      setProfiles({ champion: store.champion?.canonicalFingerprint === canonicalFingerprint(show) ? store.champion : null,
        challengers: store.challengers.filter((item) => item.canonicalFingerprint === canonicalFingerprint(show)) });
      const complete = records.filter((record) => record.status === "complete");
      const results = await Promise.all(complete.map(async (record) => {
        try {
          const saved = await localRequest<RehearsalAnalysis>(`/rehearsals/${record.id}/analysis`);
          if (saved.canonicalFingerprint !== canonicalFingerprint(show) || saved.numberId !== numberId || saved.alignmentMode !== "known-number-local") throw new Error("Reanalysis required for this canonical revision/number");
          return saved;
        }
        catch {
          const result = await localRequest<{ transcript: TimestampedASR[]; timestampBasis?: RehearsalAnalysis["timestampBasis"]; asrProvider?: string; model?: string }>(`/rehearsals/${record.id}/result`);
          const analysis = analyzeNumberRehearsal(show, numberId, result.transcript, { rehearsalId: record.id, timestampBasis: result.timestampBasis, asrProvider: result.asrProvider, model: result.model });
          await localRequest(`/rehearsals/${record.id}/analysis`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(analysis) });
          return analysis;
        }
      }));
      setAnalyses(results);
      setSelected((id) => id && records.some((record) => record.id === id) ? id : records[0]?.id ?? null);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "로컬 분석 서버에 연결하지 못했습니다."); }
    finally { refreshing.current = false; }
  }, [show, numberId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const pending = manifests.some((record) => ["uploading", "queued", "transcribing"].includes(record.status));
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  async function upload(file?: File) {
    if (!file) return;
    if (providerMetadata.requiresCloudConsent && !allowCloudUpload) { setError(`${providerMetadata.displayName}로 오디오를 전송하려면 동의가 필요합니다.`); return; }
    setBusy(true); setError(null);
    setNotice(`오디오 업로드 → ${providerMetadata.displayName} / ${providerMetadata.model} → ${numberId} 내부 큐 정렬 → 검토`);
    try {
      const manifest = await localRequest<Manifest>(`/rehearsals?filename=${encodeURIComponent(file.name)}&showId=${encodeURIComponent(show.id)}&numberId=${encodeURIComponent(numberId)}&provider=${asrProvider}&allowCloudUpload=${allowCloudUpload}`, {
        method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" }, signal: AbortSignal.timeout(120_000)
      });
      setManifests((records) => [manifest, ...records]); setSelected(manifest.id);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "오디오를 업로드하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function calibrate() {
    setBusy(true); setError(null); setConfirmed(false);
    try {
      const candidateProfiles = buildCueProfiles(show, analyses, { fallbackEnabledCueIds: fallbackIds });
      const evaluation = evaluateChallenger(show, analyses, profiles.champion?.profiles ?? [], candidateProfiles);
      await localRequest("/profiles/challengers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ showId: show.id, numberId, canonicalFingerprint: canonicalFingerprint(show), championId: profiles.champion?.id ?? null, profiles: candidateProfiles, evaluation }) });
      setNotice(evaluation.recommended ? "전체 이력 회귀 검증 통과. 운영자 승인 전까지 기존 Champion을 유지합니다." : "후보를 저장했습니다. 승격 조건을 충족하지 않아 Champion을 유지합니다.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "후보 평가 실패"); }
    finally { setBusy(false); }
  }

  async function promote(candidate: ProfileCandidate) {
    if (!confirmed || !reviewer.trim()) return;
    setBusy(true);
    try {
      await localRequest(`/profiles/${candidate.id}/promote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ showId: show.id, numberId, confirmed: true, operator: reviewer.trim() }) });
      setNotice("승격 완료. 공연 운영 화면에서 승인 프로필을 불러오세요. 진행 중인 공연에는 자동 적용하지 않습니다.");
      setConfirmed(false); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "승격이 차단되었습니다."); }
    finally { setBusy(false); }
  }

  async function review(analysis: RehearsalAnalysis, observation: CueObservation, startMs: number, endMs: number) {
    try {
      const revised = confirmObservation(analysis, observation.id, { startMs, endMs, reviewer: reviewer.trim() });
      await localRequest(`/rehearsals/${analysis.rehearsalId}/analysis`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(revised) });
      await refresh();
      setNotice("검토 이력을 저장했습니다. 기존 후보는 자동 승격되지 않습니다. 다시 회귀 평가하세요.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "검토 저장 실패"); }
  }

  async function exclude(analysis: RehearsalAnalysis, itemId: string, reason: string) {
    try {
      const revised = dismissReviewItem(analysis, itemId, { reviewer: reviewer.trim(), reason });
      await localRequest(`/rehearsals/${analysis.rehearsalId}/analysis`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(revised) });
      await refresh();
      setNotice("이 구간은 평가 제외로 기록했습니다. 정답이나 human-confirmed로 간주하지 않습니다.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "검토 저장 실패"); }
  }

  const analysis = analyses.find((item) => item.rehearsalId === selected);
  const candidate = profiles.challengers[0];
  const cues = flattenShow(show).segments;

  return (
    <main className="rehearsal-page">
      <header className="workspace-header"><div><span className="eyebrow">CUEFLOW / REHEARSAL CALIBRATION</span><h1>리허설에서 배우는 타이밍</h1></div><nav aria-label="Workspace"><a href="/operator">공연 운영</a><a href="/demo">데모</a></nav></header>
      <p className="rehearsal-intro">{show.title} <span>확정 대본은 그대로. 발화 위치·앵커·상대 타이밍만 보정합니다.</span></p>
      <ProductionSelector catalog={catalog} show={show} disabled={busy || pending} onSelect={onShow} />
      {show.acts.flatMap((act) => act.numbers).length > 1 ? <label>분석할 넘버 <select aria-label="Analysis number" value={numberId} disabled={busy || pending} onChange={(event) => onNumber(event.target.value)}>{show.acts.flatMap((act) => act.numbers).map((number) => <option key={number.id} value={number.id}>{number.id} · {number.title}</option>)}</select></label> : null}
      <section className="upload-panel" aria-label="Rehearsal audio upload">
        <span className="eyebrow">01 / ORIGINAL AUDIO · {numberId}</span><h2>이 넘버의 실제 리허설</h2>
        <p>WAV · FLAC · M4A · MP3 / 선택한 넘버 내부에서만 정렬합니다.</p>
        <label className="reviewer-label">음성 인식 모델 <select aria-label="Rehearsal ASR provider" value={asrProvider} disabled={busy || pending} onChange={(event) => { setASRProvider(event.target.value); setAllowCloudUpload(false); }}>{asrCatalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.kind === "external" ? "외부 API" : "설치된 모델만"}</option>)}</select></label>
        {providerMetadata.requiresCloudConsent ? <><p className="operation-note">백엔드 {providerMetadata.credentialEnvironment} 필요 · {providerMetadata.consentDescription} {providerMetadata.privacyUrl ? <a href={providerMetadata.privacyUrl} target="_blank" rel="noopener noreferrer">공급자 개인정보 정책 ↗</a> : null}</p><label className="promotion-confirm"><input type="checkbox" aria-label="Allow external audio upload" checked={allowCloudUpload} disabled={busy || pending} onChange={(event) => setAllowCloudUpload(event.target.checked)} />선택한 녹음의 {providerMetadata.displayName} 외부 전송에 동의합니다.</label></> : null}
        <input type="file" aria-label="Upload rehearsal audio" accept=".wav,.flac,.m4a,.mp3,audio/*" disabled={busy || pending || (providerMetadata.requiresCloudConsent && !allowCloudUpload)} onChange={(event) => void upload(event.target.files?.[0])} />
        <button onClick={() => void refresh()} disabled={busy}>새로고침</button>
        <p className="operation-note">원본은 로컬 .stage-data에 저장되며 Git에 포함하지 않습니다. 실공연 중에는 분석 작업을 실행하지 마세요.</p>
        {dataset?.defaultAudioPath ? <details className="registered-audio"><summary>등록 원본 · 재현 가능한 분석 명령</summary><code>{dataset.defaultAudioPath}</code><pre><code>{`npm run rehearsal:analyze -- --number ${numberId} --provider ${asrProvider}${providerMetadata.requiresCloudConsent ? " --allow-cloud-upload" : ""}`}</code></pre><p>CLI 결과는 .stage-data/number-analysis에 별도 보관됩니다. 이 업로드 이력에 자동 합쳐지지 않습니다. 키·모델·동의가 없으면 WAV 검사 후 명시적으로 종료하며 보정 수치를 만들지 않습니다.</p></details> : null}
      </section>
      <p className="operation-note" role="status">{notice}</p>
      {error ? <p className="operation-alert" role="alert">{error}</p> : null}

      <div className="rehearsal-columns">
        <section className="analysis-panel"><span className="eyebrow">02 / ALIGN & REVIEW</span><h2>리허설 이력</h2>
          {manifests.length ? <ul className="rehearsal-list">{manifests.map((record) => <li key={record.id}><button onClick={() => setSelected(record.id)} aria-pressed={selected === record.id}>{record.filename}<span>{record.status}</span></button><p className="operation-note">{record.provider ?? record.providerDisplayName ?? record.asrProvider ?? "legacy provider"} / {record.model ?? "model unrecorded"}</p>{record.error ? <p className="operation-note">{record.error}</p> : null}{record.warning ? <p className="operation-alert" role="alert">{record.warning}</p> : null}</li>)}</ul> : <p className="empty-state">오디오를 추가하면 정렬과 검토 목록이 여기에 표시됩니다.</p>}
          {analysis ? <>
            <div className="analysis-summary"><strong>{analysis.observations.length} cues</strong><span>{analysis.numberId} · LOCAL ALIGNMENT</span><span>{analysis.reviewQueue.length} review required</span><span>{analysis.skippedCueIds.length} 미관측 / 생략 후보</span></div>
            <audio ref={audioRef} controls src={localBackendUrl(`/rehearsals/${analysis.rehearsalId}/audio`)} aria-label="Rehearsal review audio" />
            <p className="operation-note">ASR: {analysis.asrProvider ?? manifests.find((record) => record.id === selected)?.asrProvider ?? "legacy provider"} / {analysis.model ?? manifests.find((record) => record.id === selected)?.model ?? "model unrecorded"}. 자동 정렬 시각은 추정값입니다. 직접 들어 확인한 구간만 human-confirmed로 표시합니다.</p>
            <label className="reviewer-label">검토자 / 승인자 <input aria-label="Reviewer name" value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="이름" /></label>
            <div className="observation-list">{analysis.observations.map((observation) => <ObservationRow key={`${analysis.rehearsalId}-${observation.id}-${observation.groundTruth}`} observation={observation} canonical={cues.find((cue) => cue.id === observation.cueId)?.captions.map((line) => line.text).join(" / ") ?? observation.cueId} canReview={!!reviewer.trim()} onListen={() => { if (audioRef.current) { audioRef.current.currentTime = Math.max(0, observation.startMs / 1000 - 0.7); void audioRef.current.play().catch(() => {}); } }} onReview={(start, end) => void review(analysis, observation, start, end)} />)}</div>
            {analysis.reviewQueue.length ? <details><summary>검토 필요 구간 ({analysis.reviewQueue.length})</summary><p className="operation-note">잡음·생략 등 평가할 수 없는 구간만 사유를 남겨 제외하세요. 제외 수는 별도 집계합니다.</p>{analysis.reviewQueue.map((item) => <ReviewQueueRow key={item.id} reason={item.reason} at={item.startMs} enabled={!!reviewer.trim()} onExclude={(reason) => void exclude(analysis, item.id, reason)} />)}</details> : null}
            <button onClick={() => downloadJSON(`${analysis.rehearsalId}-alignment.json`, analysis)}>정렬 JSON 내보내기</button>
          </> : null}
        </section>

        <section className="analysis-panel"><span className="eyebrow">03 / REPLAY & PROMOTE</span><h2>Champion / Challenger</h2>
          <div className="champion-card"><span>현재 운영 프로필</span><strong>{profiles.champion ? profiles.champion.id.slice(0, 12) : "기본 안전 기준"}</strong><small>새 분석이 기존 프로필을 자동으로 덮어쓰지 않습니다.</small></div>
          <details className="fallback-options"><summary>Fallback 허용 큐 선택 · 기본 모두 꺼짐</summary><p className="operation-note">선택해도 3회 이상의 안정된 리허설·상대 타이밍·신뢰도 조건을 통과한 큐만 활성화됩니다.</p>{cues.filter((cue) => cue.type !== "IMAGE").map((cue) => <label key={cue.id}><input type="checkbox" checked={fallbackIds.includes(cue.id)} onChange={(event) => setFallbackIds((ids) => event.target.checked ? [...ids, cue.id] : ids.filter((id) => id !== cue.id))} />{cue.id} · {cue.captions[0]?.text}</label>)}</details>
          <button className="calibrate-button" onClick={() => void calibrate()} disabled={busy || !analyses.length}>전체 이력 재생 → 후보 프로필 생성</button>
          {candidate ? <div className="candidate-card" aria-label="Challenger evaluation">
            <h3>{candidate.evaluation.recommended ? "승격 권장 · 승인 대기" : "승격 보류"}</h3><p className="operation-note">{candidate.evaluation.evidence.toUpperCase()} evidence · {candidate.evaluation.replays.length} historical rehearsals</p>
            {candidate.evaluation.reasons.length ? <ul>{candidate.evaluation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
            <div className="metrics-table"><table><thead><tr><th>리허설 / 기준</th><th>정확도</th><th>Miss / Wrong</th><th>Early / Late</th><th>P50 / P95</th></tr></thead><tbody>{candidate.evaluation.replays.flatMap((row) => (["champion", "challenger"] as const).map((kind) => { const metrics = row[kind]; return <tr key={`${row.rehearsalId}-${kind}`}><td>{row.rehearsalId.slice(0, 6)} · {kind === "champion" ? "CURRENT BASELINE" : "CANDIDATE"}</td><td>{Math.round(metrics.cueAccuracy * 100)}%</td><td>{metrics.missedCues} / {metrics.wrongTriggers}</td><td>{metrics.earlyTriggers} / {metrics.lateTriggers}</td><td>{metrics.latencyP50Ms === null ? "—" : Math.round(metrics.latencyP50Ms)} / {metrics.latencyP95Ms === null ? "—" : Math.round(metrics.latencyP95Ms)} ms</td></tr>; }))}</tbody></table></div>
            <p className="operation-note">ASR 재생 시뮬레이션 지표이며 실제 음향 인식 속도나 공연 승인 결과가 아닙니다.</p>
            <details><summary>앵커·타이밍·표본 수 ({candidate.profiles.length} cues)</summary>{candidate.profiles.map((profile) => <p className="profile-row" key={profile.cueId}>{profile.cueId} · CANDIDATE · {profile.sampleCount} rehearsals · {Math.round(profile.confidence * 100)}%<br />상대 시각 {profile.timing.sampleCount ? `+${(profile.timing.medianAfterPreviousMs / 1000).toFixed(1)}s` : "미확인"} · {profile.timing.distributionReady ? "복수 녹음 분포" : "분포 검증 전"}<br />{profile.anchors.map((anchor) => `${anchor.text} (${Math.round(anchor.reliability * 100)}%${anchor.repetitionRisk ? " · 반복 가사 / 순서 문맥 필요" : ""})`).join(" · ")}<br />Fallback {profile.fallback.enabled ? "ON" : "OFF"}</p>)}</details>
            <label className="reviewer-label">승인자 <input aria-label="Promotion operator" value={reviewer} onChange={(event) => setReviewer(event.target.value)} /></label>
            <label className="promotion-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />전체 이력과 검토 결과를 확인했으며 이 후보의 승격을 승인합니다.</label>
            <button onClick={() => void promote(candidate)} disabled={busy || !candidate.evaluation.recommended || !confirmed || !reviewer.trim() || candidate.promoted}>승인 후 Champion으로 승격</button>
            <button onClick={() => downloadJSON(`${candidate.id}-candidate.json`, candidate)}>평가·프로필 JSON</button>
          </div> : <p className="empty-state">최소 3회 이력, 미해결 검토 없음, 모든 지표 무회귀와 개선을 확인한 뒤에만 승격을 권장합니다.</p>}
        </section>
      </div>
      <RecordingReplay show={show} numberId={numberId} onStart={() => audioRef.current?.pause()} />
    </main>
  );
}

function ReviewQueueRow({ reason, at, enabled, onExclude }: { reason: string; at: number | null; enabled: boolean; onExclude: (reason: string) => void }) {
  const [note, setNote] = useState("");
  return <div className="review-queue-row"><p>{at === null ? "—" : `${(at / 1000).toFixed(1)}s`} · {reason}</p><input aria-label="평가 제외 사유" value={note} onChange={(event) => setNote(event.target.value)} placeholder="직접 확인한 제외 사유" /><button disabled={!enabled || !note.trim()} onClick={() => onExclude(note.trim())}>사유를 남기고 평가 제외</button></div>;
}

function ObservationRow({ observation, canonical, canReview, onListen, onReview }: { observation: CueObservation; canonical: string; canReview: boolean; onListen: () => void; onReview: (startMs: number, endMs: number) => void }) {
  const [start, setStart] = useState(Number((observation.startMs / 1000).toFixed(observation.timingReliable ? 2 : 1)));
  const [end, setEnd] = useState(Number((observation.endMs / 1000).toFixed(observation.timingReliable ? 2 : 1)));
  return <details className={`observation ${observation.reviewStatus}`}><summary><span>{observation.cueId} · {Math.round(observation.alignmentConfidence * 100)}%</span><b>{observation.groundTruth === "human" ? "HUMAN CONFIRMED" : observation.reviewStatus.toUpperCase()}</b></summary><p>{canonical}</p><p className="observed-speech">ASR: {observation.asrText}</p><button onClick={onListen}>이 구간 듣기</button><label>시작(초)<input type="number" min={0} step={0.01} value={start} onChange={(event) => setStart(Number(event.target.value))} /></label><label>종료(초)<input type="number" min={start} step={0.01} value={end} onChange={(event) => setEnd(Number(event.target.value))} /></label><button onClick={() => onReview(start * 1000, end * 1000)} disabled={!canReview || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start}>직접 확인한 시각 저장</button></details>;
}
