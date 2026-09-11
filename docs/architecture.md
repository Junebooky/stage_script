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

The context resumes inside the microphone-button gesture, before waiting for permission. Browser recognition starts in that same gesture alongside capture initialization, without waiting for the AudioWorklet to load. Resampling keeps its phase across worklet blocks, producing exactly 16,000 output samples per second from either 44.1 or 48 kHz input. Stopping or failing an input session closes its stream, context, and socket; late callbacks from that session are ignored.

Browser interim speech recognition is a demo ASR adapter. It makes the microphone scenario usable without checking a large acoustic model into the repository. It is not the production ASR choice and may use the browser vendor's speech service. The deterministic Simulation Mode and tests do not require an external speech service or physical microphone. Browser tests use synthesized Web Audio and injected recognition events; acoustic quality and production latency require separate real-device tests.

The waveform shows captured amplitude even if recognition fails. Recognized text is separate from the prepared caption and remains visible during silence or a failed script match. Microphone and ASR errors are surfaced beside it. The optional WebSocket receives backend hypotheses, mapping them onto the browser clock before matching. A non-mock `ready.adapter` selects backend ASR; the included mock does not disable browser recognition.

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

Presentation lifecycle uses `completedIndexes` and `finished` from that same engine, not animation timers. Advancing completes only the previously displayed index; skipped positions are never marked Complete. Rewinding removes later completions, and reset clears them. Advancing past the final cue explicitly finishes the performance while retaining the final caption and blocking further automatic matches. HOLD and silence do not complete cues.

## Matching strategy

The default `PrefixFuzzyMatcher` normalizes Unicode to NFC, lowercases Latin text, removes spacing and punctuation, and filters standalone Korean filler tokens. It scores:

| Evidence | Default weight |
| --- | ---: |
| Script order prior | 0.40 |
| Partial prefix/fuzzy match | 0.35 |
| ASR confidence | 0.15 |
| Active speech/VAD | 0.10 |

The very next ordered cue has a fast path: an exact two-normalized-character prefix with active speech triggers immediately, even with a low ASR confidence. It does not wait for sentence coverage, `isFinal`, silence, or a subsequent recognition update. One character alone cannot trigger. The displayed score is a script-alignment heuristic, not a calibrated probability of correct recognition. Two-syllable matching deliberately trades accuracy for early response and can still miscue on shared words or recognition revisions.

Wider-window matching requires at least four characters, edit similarity of at least 0.75, and the weighted threshold of 0.78. An eligible next cue takes precedence over speculative skips. Normal mode searches only the next three positions. Four unmatched completed attempts expand the window to five behind and ten ahead; nine permit full resync. Interim revisions and continuing evidence from an already-cued line do not increase this counter. Thresholds and window sizes are explicit configuration.

Browser results carry both a per-result utterance ID and a session stream ID. The adapter emits every changed interim immediately and attaches cumulative recognition context across result boundaries; raw `text` stays separate for the microphone monitor. Finalized results are emitted once. Normal end-of-recognition restarts use a 40 ms scheduling delay; permission and network errors remain visible and are not retried indefinitely.

`HypothesisCursor` consumes the actual matched prefix, never a required verbatim full script sentence. It remaps that evidence across interim corrections, deduplicates unchanged text, and accepts new next-cue evidence without waiting for previous-sentence completion. An exact continuation of the current script line cannot reuse an internal next-cue prefix. A second occurrence can cue a repeated line. Candidate matching is bounded to the latest 512 unconsumed characters. The default inter-cue cooldown is zero: a single valid update must not be dropped during a 420 ms lockout. Reset retains a checkpoint of the active recognition stream so delayed old text does not restart the performance.

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

The browser records `performance.now()` at the AudioWorklet speech-start notification. The first subsequent cue consumes that onset; later cues in an uninterrupted monologue must not reuse it and appear to have waited since the beginning of the monologue. Without a fresh onset, instrumentation measures recognition-receipt-to-paint and labels it `인식→표시`, explicitly excluding ASR delay. Available onset measurements are labeled `음성→표시`.

Captions change immediately. Two `requestAnimationFrame` callbacks after commit only measure through the following paint; they do not gate rendering. `LatencyTracker` records a bounded 500-sample window and reports last, P50, P95, and P99, resetting when the measurement basis changes so unlike clocks are not mixed. Logs include `asr_state`, `caption_match` (decision duration, final/interim, and whether a cue advanced), and `caption_latency` with its basis. They do not log raw speech.

Simulation uses its injected speech-start as the origin. Manual cues use the manual trigger timestamp, labeled `수동→표시`. Synthetic interim-to-paint tests verify application response, not human Korean recognition latency.

## 3D rendering

The center stage uses the exact vertex and fragment shader strings supplied in `ref.tsx`, extracted into `apps/web/lib/gyroid-shaders.ts`. A Three.js fullscreen plane ray-marches the original gyroid surface with its blue exterior and amber interior; it is not a torus-knot approximation. The desktop canvas is capped at 760 CSS pixels with a 1.35 presentation zoom (about a 440-pixel visible orb at 1440×900). Mobile uses a smaller 1.05 zoom, preserving room for captions and audio. The shader strings remain unchanged. Audio adds only a subtle scale/speed response. Reduced-motion preference freezes procedural motion, and a CSS fallback keeps the layout intact without WebGL. `AvatarAdapter` remains the replaceable model boundary.

## Presentation surfaces

`Stage caption output` renders prepared script content and identifies standby preview, ON AIR, HOLD, or completion. `Microphone recognition monitor` renders raw ASR text and actual audio amplitude independently. `Caption cue queue` shows the latest completed cue, the active cue, and upcoming lines with actor metadata. These are separate accessible regions. The initial preview is explicitly not on air. Cue transitions animate borders and row movement, never delay caption legibility. Reduced-motion preference disables those decorative animations. Manual presentation controls use the same engine and visibly identify their source; they do not simulate microphone recognition.

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
