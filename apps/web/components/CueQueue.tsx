"use client";

import type { ScriptEngineSnapshot } from "@stage/script-engine";
import type { PerformanceScript } from "@stage/script-schema";
import { memo } from "react";

export const CueQueue = memo(function CueQueue({
  script,
  snapshot,
  skippedIndexes
}: {
  script: PerformanceScript;
  snapshot: ScriptEngineSnapshot;
  skippedIndexes?: number[];
}) {
  const completed = new Set(snapshot.completedIndexes);
  const skipped = new Set(skippedIndexes ?? snapshot.skippedIndexes ?? []);
  const previous = snapshot.completedIndexes.filter((index) => index !== snapshot.currentIndex).at(-1);
  const start = Math.max(0, snapshot.currentIndex);

  // Identify skipped cues prior to the current on-air cue
  const skippedPrior = Array.from(skipped)
    .filter((idx) => (previous !== undefined ? idx > previous : true) && idx < start)
    .sort((a, b) => a - b);

  const priorIndexes = [
    ...(previous === undefined ? [] : [previous]),
    ...skippedPrior
  ];

  // Up to 4 cues in visible stack: prior (completed + skipped), on-air, and upcoming
  const slotsRemaining = Math.max(1, 4 - priorIndexes.length - (start < script.segments.length ? 1 : 0));
  const upcomingIndexes = Array.from(
    { length: Math.min(slotsRemaining, script.segments.length - (start + 1)) },
    (_, offset) => start + 1 + offset
  );

  const indexes = [
    ...priorIndexes,
    ...(start < script.segments.length ? [start] : []),
    ...upcomingIndexes
  ].slice(0, 4);

  return (
    <section className="cue-queue" aria-label="Caption cue queue">
      <header className="panel-heading">
        <div><span className="eyebrow">CUE STACK</span><h2>다음 자막</h2></div>
        <span className="completion-count">
          <strong>{String(completed.size).padStart(2, "0")}</strong> / {String(script.segments.length).padStart(2, "0")}{" "}
          <span>Complete</span>
          {skipped.size > 0 ? (
            <span className="skipped-badge" title="미송출 스킵 큐 수">
              {" "}· {skipped.size} Skipped
            </span>
          ) : null}
        </span>
      </header>
      <div className="cue-progress" role="progressbar" aria-label="Completed captions" aria-valuemin={0} aria-valuemax={script.segments.length} aria-valuenow={completed.size}>
        {script.segments.map((segment, index) => {
          const isComplete = completed.has(index);
          const isOnAir = index === snapshot.currentIndex;
          const isSkipped = skipped.has(index);
          const progressClass = isComplete
            ? "is-complete"
            : isOnAir
            ? "is-on-air"
            : isSkipped
            ? "is-skipped"
            : "";
          return <i key={segment.id} className={progressClass} />;
        })}
      </div>
      <ol className="cue-list">
        {indexes.map((index) => {
          const segment = script.segments[index]!;
          const isComplete = completed.has(index);
          const isOnAir = index === snapshot.currentIndex;
          const isSkipped = skipped.has(index);
          const isNext = !isComplete && !isOnAir && !isSkipped && index === snapshot.currentIndex + 1;

          const state = isComplete
            ? "complete"
            : isOnAir
            ? "on-air"
            : isSkipped
            ? "skipped"
            : "waiting";

          const statusLabel = isComplete
            ? "Complete"
            : isOnAir
            ? "ON AIR"
            : isSkipped
            ? "[SKIPPED]"
            : isNext
            ? "자막 대기중"
            : "대기";

          const marker = isComplete
            ? "✓"
            : isSkipped
            ? "↷"
            : String(index + 1).padStart(2, "0");

          return (
            <li
              key={`${segment.id}-${state}`}
              className={`cue-item is-${state} ${isNext ? "is-next" : ""}`}
              data-cue={segment.id}
              data-state={state}
              aria-current={isOnAir ? "step" : undefined}
            >
              <span className="cue-marker" aria-hidden="true">{marker}</span>
              <div className="cue-content">
                <div className="cue-meta">
                  <span>
                    {segment.captions.map((caption) => caption.actor).join(" · ")}
                    {segment.type === "SOLO" ? "" : ` / ${segment.type}`}
                  </span>
                  <span className="cue-status">{statusLabel}</span>
                </div>
                <p title={segment.captions.map((caption) => caption.text).join(" / ")}>
                  {segment.captions.map((caption) => caption.text).join(" / ")}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {snapshot.finished ? <p className="queue-end" aria-live="polite">✓ 마지막 큐 송출 완료</p> : !snapshot.nextSegment ? <p className="queue-end">마지막 자막이 송출 중입니다.</p> : null}
    </section>
  );
});
