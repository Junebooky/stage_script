"use client";

import type { ScriptSegment } from "@stage/script-schema";
import { useEffect, useRef } from "react";

export function CaptionDisplay({ segment, triggerKey, onPaint }: {
  segment: ScriptSegment | null;
  triggerKey: number | null;
  onPaint: () => void;
}) {
  const lastPaintedRef = useRef<number | null>(null);

  useEffect(() => {
    if (triggerKey === null || triggerKey === lastPaintedRef.current) return;
    lastPaintedRef.current = triggerKey;
    onPaint();
  }, [onPaint, triggerKey]);

  if (!segment) {
    return (
      <div className="caption-empty">
        <span>READY FOR CUE</span>
        <p>마이크를 켜거나 시뮬레이션을 시작하세요</p>
      </div>
    );
  }

  return (
    <div className={`caption-card type-${segment.type.toLowerCase()}`} data-segment={segment.id}>
      <div className="caption-kicker">
        <span>{segment.type}</span>
        <span>{segment.metadata?.scene}</span>
      </div>
      <div className="caption-lines">
        {segment.captions.map((caption) => (
          <div className="caption-line" key={`${segment.id}-${caption.actor}`}>
            <span className="actor-name">{caption.actor}</span>
            <p>{caption.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

