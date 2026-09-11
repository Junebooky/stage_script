"use client";

import type { ScriptEngineSnapshot } from "@stage/script-engine";

export function DebugPanel({ snapshot, vad, level }: { snapshot: ScriptEngineSnapshot; vad: boolean; level: number }) {
  return (
    <aside className="debug-panel" aria-label="Developer telemetry">
      <div><span>PARTIAL</span><code>{snapshot.partial || "—"}</code></div>
      <div><span>EXPECTED</span><code>{snapshot.expected || "—"}</code></div>
      <div><span>CURRENT</span><code>{snapshot.currentSegment?.id ?? "—"}</code></div>
      <div><span>NEXT</span><code>{snapshot.nextSegment?.id ?? "—"}</code></div>
      <div><span>SEARCH</span><code>{snapshot.searchMode}</code></div>
      <div><span>VAD</span><code>{vad ? "SPEECH" : "QUIET"} / {level.toFixed(3)}</code></div>
    </aside>
  );
}

