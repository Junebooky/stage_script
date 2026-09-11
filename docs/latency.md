# Latency Measurement Plan

The production KPI is measured from the relevant line's first browser-detected speech onset to the prepared subtitle's browser paint. Report distributions, never only an average. The budgets below are targets, not measured guarantees of the browser demo.

| Stage | Start | End | Current instrumentation | Target budget |
| --- | --- | --- | --- | ---: |
| Audio capture | physical speech onset | AudioWorklet speech-start | worklet VAD event and main-thread receipt | 20–40 ms |
| Buffer | first sample | 320-sample PCM frame | fixed 16 kHz / 20 ms chunks | 20 ms |
| ASR | PCM accepted | partial emitted | adapter monotonic timestamps (local adapter integration point) | 40–100 ms |
| Matching | partial received | cue decision | `caption_match.decisionMs` around engine processing | < 2 ms |
| WebSocket | frame/hypothesis send | peer receipt | service `received_at_ms`; add synchronized trace IDs with real ASR | < 10 ms local |
| React render | cue state committed | caption painted | two `requestAnimationFrame` callbacks after caption commit | 8–32 ms |

## Current end-to-end clock

All browser values use `performance.now()`, avoiding wall-clock adjustments. `speechStart(at)` stores the onset. The next cue consumes it once. `TriggerEvent` carries `speechOnsetAt`, and the caption renderer reports its commit. The page samples after the following paint and records:

- Last latency
- P50
- P95
- P99
- Sample count

The rolling window is capped at 500 measurements and resets when its measurement basis changes:

| UI label | Origin | Included / excluded |
| --- | --- | --- |
| `음성→표시` | most recent unconsumed VAD onset | includes time from detected speech to recognition and paint; not physical onset before VAD |
| `인식→표시` | ASR hypothesis receipt | matching and paint only; **excludes recognition delay** |
| `수동→표시` | manual cue click | manual trigger and paint only |

Continuous speech can span multiple script lines without a new VAD onset. Reusing its initial onset would inflate every later cue's latency; inventing a new acoustic onset would hide recognition latency. The demo instead switches to the explicitly labeled recognition basis. Per-line word/audio timestamps from a real ASR adapter are needed for comparable end-to-end measurements on continuous speech.

The next cue's two-syllable fast path is synchronous: no final-result gate, sentence-completion gate, or default 420 ms inter-cue lockout. Two animation frames are measurement instrumentation, not a delay before caption display. `caption_match` logs matching duration and whether an interim or final advanced; `caption_latency` logs duration and basis without raw speech.

The browser regression suite injects two-syllable interims for all 16 cues without final events or manual advancing, asserting recognition-injection-to-paint under 200 ms in the local test environment. It also checks continuous revised sentences and delayed finals after reset. These synthetic values validate wiring and application response, not acoustic-model speed, real microphone accuracy, or the production KPI.

## Backend tracing extension

When a local ASR is connected, assign each 20 ms PCM chunk a session sequence number and carry these fields through each partial:

```json
{
  "session_id": "...",
  "first_audio_sequence": 1842,
  "audio_captured_at_ms": 92140.2,
  "asr_started_at_ms": 92161.0,
  "partial_emitted_at_ms": 92218.6,
  "matcher_finished_at_ms": 92219.1
}
```

Browser and backend monotonic clocks have different origins. Estimate their offset with repeated WebSocket ping/pong measurements and use the minimum-RTT sample. Preserve raw per-stage durations even when the cross-process offset is uncertain.

## Benchmark protocol

1. Warm the acoustic model before collecting samples.
2. Run at least 200 cues across short lines, long solos, fast turns, overlap starts, pauses, and intentional skips.
3. Report P50/P95/P99 separately for capture, ASR, match, transport, and render.
4. Mark browser interim ASR runs as demo-only; use the local model for acceptance measurements.
5. Fail the target if end-to-end P50 is 150 ms or higher, or P95 is 250 ms or higher.
