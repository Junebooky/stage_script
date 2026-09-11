"use client";

import { useMemo } from "react";

export function AudioWaveform({ level, active }: { level: number; active: boolean }) {
  const bars = useMemo(() => Array.from({ length: 54 }, (_, index) => 0.22 + ((index * 17) % 11) / 14), []);
  return (
    <div className={`waveform ${active ? "is-active" : ""}`} aria-label={`Audio level ${Math.round(level * 100)} percent`}>
      {bars.map((base, index) => {
        const focus = 1 - Math.abs(index - bars.length / 2) / (bars.length / 2);
        const height = 5 + base * 8 + level * (16 + focus * 30);
        return <span key={index} style={{ height: `${height}px`, opacity: 0.25 + focus * 0.75 }} />;
      })}
    </div>
  );
}

