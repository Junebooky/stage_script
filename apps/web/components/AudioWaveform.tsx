"use client";

import type { CSSProperties } from "react";

const SHAPE = Array.from({ length: 56 }, (_, index) => (
  (0.2 + 0.8 * Math.sin(Math.PI * (index + 1) / 57)) * (0.4 + ((index * 13) % 17) / 24)
));

export function AudioWaveform({ level, active }: { level: number; active: boolean }) {
  const energy = Math.max(0, Math.min(1, level));
  return (
    <div className={`audio-waveform ${active ? "is-active" : ""}`} role="img" aria-label="Microphone audio waveform" data-level={energy.toFixed(3)}>
      {SHAPE.map((shape, index) => (
        <i key={index} style={{ "--bar-height": `${3 + energy * shape * 48}px` } as CSSProperties} />
      ))}
    </div>
  );
}
