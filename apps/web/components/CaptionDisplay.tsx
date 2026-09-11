"use client";

import type { ScriptSegment } from "@stage/script-schema";
import { memo, useEffect, useRef } from "react";

export const CaptionDisplay = memo(function CaptionDisplay({ segment, previewSegment, triggerKey, onPaint }: {
  segment: ScriptSegment | null;
  previewSegment?: ScriptSegment;
  triggerKey: number | null;
  onPaint: () => void;
}) {
  const lastPaintedRef = useRef<number | null>(null);

  useEffect(() => {
    if (triggerKey === null || triggerKey === lastPaintedRef.current) return;
    lastPaintedRef.current = triggerKey;
    onPaint();
  }, [onPaint, triggerKey]);

  const visibleSegment = segment ?? previewSegment;
  if (!visibleSegment) return <div className="caption-card is-preview">대사를 기다리고 있습니다</div>;

  return (
    <div className={`caption-card type-${visibleSegment.type.toLowerCase()} ${segment ? "" : "is-preview"}`} data-segment={segment?.id} data-preview={!segment} aria-label={segment ? "Prepared caption" : "Prepared caption preview"} aria-live="polite" aria-atomic="true">
      <div className="caption-lines" key={visibleSegment.id}>
        {visibleSegment.captions.map((caption) => (
          <div className="caption-line" key={`${visibleSegment.id}-${caption.actor}`}>
            <p>{caption.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
});
