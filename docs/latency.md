# Latency Measurement Plan

The KPI is measured from first browser-detected speech onset to the prepared subtitle's browser paint. Report distributions, never only an average.

| Stage | Start | End | Current instrumentation | Target budget |
| --- | --- | --- | --- | ---: |
| Audio capture | physical speech onset | AudioWorklet speech-start | worklet VAD event and main-thread receipt | 20–40 ms |
| Buffer | first sample | 320-sample PCM frame | fixed 16 kHz / 20 ms chunks | 20 ms |
| ASR | PCM accepted | partial emitted | adapter monotonic timestamps (local adapter integration point) | 40–100 ms |
| Matching | partial received | cue decision | `StreamingHypothesis.receivedAt` and trigger timestamp | < 2 ms |
| WebSocket | frame/hypothesis send | peer receipt | service `received_at_ms`; add synchronized trace IDs with real ASR | < 10 ms local |
| React render | cue state committed | caption painted | two `requestAnimationFrame` callbacks after caption commit | 8–32 ms |

## Current end-to-end clock

All browser end-to-end values use `performance.now()`, avoiding wall-clock adjustments. `speechStart(at)` stores the onset. `TriggerEvent` carries `speechOnsetAt`, and the caption renderer reports its commit. The page samples after the following paint and records:

- Last latency
- P50
- P95
- P99
- Sample count

The rolling window is capped at 500 measurements. Simulation values validate instrumentation but are not acoustic-model benchmarks.

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

