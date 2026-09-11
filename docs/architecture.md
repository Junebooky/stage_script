# Realtime Performance Caption Engine — Architecture

## Product boundary

This system follows a known script. Live audio decides **when** a prepared segment begins; it never generates the caption content. No LLM exists on the realtime path.

```text
Prepared script ───────────────┐
                              ├─ local-window matcher → script pointer → prepared captions
Laptop microphone → partial ASR┘
          └─────── PCM → VAD / visual response / backend ASR adapter
```

The MVP has one ordered script pointer. Actor identity is display metadata, not tracking state. This lets a single actor continue for many segments and lets actors alternate without introducing diarization.

## Audio pipeline

`BrowserMicAdapter` uses `getUserMedia()` and an `AudioWorklet`. The worklet down-samples mono browser audio to 16 kHz, batches 320 samples (20 ms), calculates audio energy, and emits speech-start/speech-end VAD events. PCM frames are converted to signed 16-bit and sent to `ws://localhost:8000/ws/audio` when the optional Python service is available.

The Web Audio graph terminates in a zero-gain node so processing remains alive without playing the microphone through the speakers. VAD silence changes the listening state but never advances the script pointer.

Browser interim speech recognition is a demo ASR adapter. It makes the microphone scenario usable without checking a large acoustic model into the repository. It is not the production ASR choice and may use the browser vendor's speech service. The deterministic Simulation Mode and all CI tests have no network or microphone dependency.

## Script state machine

```text
IDLE → ARMED → LISTENING → MATCHING → TRIGGERED → DISPLAYING
                          └─ low confidence → RESYNC ─┘
```

- `speechStart` records the latency origin and moves to `LISTENING`.
- A partial hypothesis moves through `MATCHING` and can trigger a prepared segment.
- `TRIGGERED` persists the cue event until React confirms the rendered caption was painted.
- `speechEnd` returns to `DISPLAYING` or `ARMED`; it does not move the pointer.
- `HOLD` blocks automatic matches while manual controls remain available.

The state machine lives in `packages/script-engine`, independent from React and audio hardware.

## Matching strategy

The default `PrefixFuzzyMatcher` normalizes Unicode to NFC, lowercases Latin text, removes spacing and punctuation, and filters standalone Korean filler tokens. It scores:

| Evidence | Default weight |
| --- | ---: |
| Script order prior | 0.40 |
| Partial prefix/fuzzy match | 0.35 |
| ASR confidence | 0.15 |
| Active speech/VAD | 0.10 |

At least three normalized characters are required, independent of the aggregate score. Prefix coverage raises confidence gradually so one shared syllable cannot trigger a caption.

Normal mode searches only the next three positions. Four low-confidence attempts expand the window to five behind and ten ahead. Nine attempts permit full resync. Full resync is therefore unavailable during healthy tracking. Thresholds and window sizes are explicit configuration.

## Overlap and chorus

`OVERLAP` is one segment with at least two prepared caption lines. Once its start is matched, the renderer displays every line simultaneously. The engine does not separate voices or create parallel pointers. The next matched segment removes the entire overlap block.

`CHORUS` is one segment with exactly one prepared display caption. Multiple voices are treated as one acoustic event.

## ASR adapter

The Python `StreamingASRAdapter` accepts mono 16 kHz signed 16-bit PCM and returns zero or more partial hypotheses. `MockStreamingASR` completes the protocol and supports deterministic tests without inventing text from audio. A local implementation should replace only this class, preserving the WebSocket message contract.

Recommended production order:

1. Integrate and benchmark a Korean sherpa-onnx streaming CTC/transducer model.
2. Add model-specific resampling only if its input rate differs.
3. Send partial hypothesis, decoder confidence, and monotonic timestamp over the existing socket.
4. Run the matcher on the backend or forward the same event to the shared client engine; do not introduce an LLM.

## Latency measurement

The browser records `performance.now()` at the AudioWorklet speech-start notification. A trigger carries this origin through the engine. After the caption changes, two `requestAnimationFrame` callbacks measure through the next browser paint. `LatencyTracker` records a bounded 500-sample window and reports last, P50, P95, and P99. Development logs emit a `caption_latency` record for each cue.

Simulation uses its injected speech-start as the origin. Manual cues use the manual trigger timestamp, so the displayed value measures trigger-to-paint rather than speech-to-paint.

## 3D rendering

The center stage uses React Three Fiber. `AvatarAdapter` defines the model boundary. The included generic adapter maps live amplitude and three coarse energy bands to scale, mouth aperture, ring speed, glow, and particles. A viseme-capable GLB/VRM adapter can implement the same interface, discover morph targets, and map phoneme/viseme events without changing the page or engine.

## Production audio expansion

The browser microphone is an `AudioInputAdapter` in practice: its stable output is `(PCM frames, channel id, timestamp)`. Future USB, CoreAudio, ASIO, and Dante inputs should normalize to the same transport contract. The script engine consumes hypotheses and VAD state, never hardware objects, so production input routing remains outside cue logic.

## Repository map

```text
apps/web                 Next.js demo, mic capture, UI, 3D avatar
services/audio-engine    FastAPI WebSocket and ASR adapter boundary
packages/script-schema   validated script types and demo loader
packages/alignment       normalization and prefix/fuzzy matcher
packages/script-engine   state machine and local pointer tracking
packages/shared          latency statistics
data                     original two-person demo script
```

