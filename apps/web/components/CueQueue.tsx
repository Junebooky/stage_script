"use client";

import type { ScriptEngineSnapshot } from "@stage/script-engine";
import type { PerformanceScript } from "@stage/script-schema";
import { memo } from "react";

export const CueQueue = memo(function CueQueue({ script, snapshot }: { script: PerformanceScript; snapshot: ScriptEngineSnapshot }) {
  const completed = new Set(snapshot.completedIndexes);
  const previous = snapshot.completedIndexes.filter((index) => index !== snapshot.currentIndex).at(-1);
  const start = Math.max(0, snapshot.currentIndex);
  const indexes = [
    ...(previous === undefined ? [] : [previous]),
    ...Array.from({ length: Math.min(4, script.segments.length - start) }, (_, offset) => start + offset)
  ].slice(0, 4);

  return (
    <section className="cue-queue" aria-label="Caption cue queue">
      <header className="panel-heading">
        <div><span className="eyebrow">CUE STACK</span><h2>다음 자막</h2></div>
        <span className="completion-count"><strong>{String(completed.size).padStart(2, "0")}</strong> / {String(script.segments.length).padStart(2, "0")} <span>Complete</span></span>
      </header>
      <div className="cue-progress" role="progressbar" aria-label="Completed captions" aria-valuemin={0} aria-valuemax={script.segments.length} aria-valuenow={completed.size}>
        {script.segments.map((segment, index) => <i key={segment.id} className={completed.has(index) ? "is-complete" : index === snapshot.currentIndex ? "is-on-air" : ""} />)}
      </div>
      <ol className="cue-list">
        {indexes.map((index) => {
          const segment = script.segments[index]!;
          const state = completed.has(index) ? "complete" : index === snapshot.currentIndex ? "on-air" : "waiting";
          const isNext = index === snapshot.currentIndex + 1;
          return (
            <li key={`${segment.id}-${state}`} className={`cue-item is-${state} ${isNext ? "is-next" : ""}`} data-cue={segment.id} data-state={state} aria-current={state === "on-air" ? "step" : undefined}>
              <span className="cue-marker" aria-hidden="true">{state === "complete" ? "✓" : String(index + 1).padStart(2, "0")}</span>
              <div className="cue-content">
                <div className="cue-meta"><span>{segment.captions.map((caption) => caption.actor).join(" · ")}{segment.type === "SOLO" ? "" : ` / ${segment.type}`}</span><span className="cue-status">{state === "complete" ? "Complete" : state === "on-air" ? "ON AIR" : isNext ? "자막 대기중" : "대기"}</span></div>
                <p title={segment.captions.map((caption) => caption.text).join(" / ")}>{segment.captions.map((caption) => caption.text).join(" / ")}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {snapshot.finished ? <p className="queue-end" aria-live="polite">✓ 마지막 큐 송출 완료</p> : !snapshot.nextSegment ? <p className="queue-end">마지막 자막이 송출 중입니다.</p> : null}
    </section>
  );
});
