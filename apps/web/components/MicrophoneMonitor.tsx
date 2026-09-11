"use client";

import { AudioWaveform } from "./AudioWaveform";

export function MicrophoneMonitor({ live, requesting, level, heardText, error, hasAudio, onToggle }: {
  live: boolean;
  requesting: boolean;
  level: number;
  heardText: string;
  error: string | null;
  hasAudio: boolean;
  onToggle: () => void;
}) {
  const hint = requesting ? "마이크 권한을 허용해주세요."
    : live ? (hasAudio ? "입력된 음성의 인식 결과를 기다립니다…" : "대기 중인 다음 대사를 읽어주세요.")
    : "마이크를 켜고 대기 중인 대사를 읽어주세요.";

  return (
    <section className={`input-monitor ${live ? "is-listening" : ""}`} aria-label="Microphone recognition monitor">
      <header className="panel-heading">
        <div><span className="eyebrow">MIC INPUT</span><h2>마이크 인식</h2></div>
        <span className={`input-state ${live ? "is-live" : ""}`}><i />{error ? "CHECK INPUT" : live ? "LISTENING" : "OFFLINE"}</span>
      </header>
      <p className={`heard-text ${heardText ? "has-text" : ""}`} aria-label="Recognized speech" aria-live="polite" aria-atomic="true">
        {heardText || hint}{live && !error ? <span className="input-cursor" aria-hidden="true" /> : null}
      </p>
      <div className="audio-row">
        <AudioWaveform level={level} active={live} />
        <button className={`mic-toggle ${live ? "is-live" : ""}`} onClick={onToggle} aria-label={live ? "Stop microphone" : "Start microphone"} aria-pressed={live} title={live ? "마이크 끄기" : "마이크 켜기"} disabled={requesting}><span /></button>
      </div>
      {error ? <p className="input-error" role="status">{error}</p> : <p className="input-note">인식 원문 · 관객에게 송출되지 않습니다</p>}
    </section>
  );
}
