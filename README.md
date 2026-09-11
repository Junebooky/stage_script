# Cueflow — Realtime Performance Caption MVP

Cueflow follows a prepared performance script and displays complete captions as soon as live partial speech provides enough evidence. Audio controls timing; the stored script controls content.

## Run the web demo

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:3000/demo`. On desktop, a large gyroid and **STAGE OUTPUT / 무대 송출 자막** occupy the left stage; a cue stack and separate **MIC INPUT / 마이크 인식** monitor occupy the right rail. On mobile, stage output and microphone remain in the first viewport, followed by the cue stack. The first prepared line is explicitly labeled as a standby preview; the last cued caption stays visible during silence. This is an in-browser stage-output preview, not an external projector integration.

Click the microphone icon beside the waveform, allow microphone access, and read the next line marked **자막 대기중**. AudioWorklet capture drives the waveform independently of recognition. Raw recognized speech stays inside the microphone monitor, even when the words do not match the script. Matching a partial utterance displays the full prepared line in stage output, never the raw transcription.

The next ordered cue fires on its first **two matching normalized syllables**: saying `어둠` shows the entire first caption; `한 걸` cues the next one. Neither a finalized ASR sentence nor a pause is required, and there is no inter-cue cooldown. This deliberately favors early response over accuracy; wider-window skips still require stronger evidence. Ongoing and revised recognition text is tracked across result boundaries so a delayed final cannot replay the same evidence. Reset keeps a live recognition checkpoint and waits for fresh speech.

The cue stack previews upcoming actors and lines. A successful cue switches to **ON AIR** with an amber highlight; advancing completes the previously displayed cue with a green check. Skipped lines are not counted as completed. Rewinding re-arms later cues, and reset clears completion history. The final cue has an explicit **마지막 큐 완료** action and leaves the final caption visible.

For a microphone-free presentation, click **다음 큐 송출** to step through the same output/queue transitions. Manual cues are labeled `MANUAL`, have no voice-match confidence, and report trigger-to-paint latency. Previous, hold/resume, and reset are available beside it. Use `?debug=true` for additional developer telemetry and synthetic partial/overlap/skip controls.

Browser interim Korean speech recognition is a replaceable demo adapter, not production/offline ASR. Try Chrome on `localhost` or HTTPS. Support and speech-service availability vary by browser; the UI reports permission, unsupported-browser, and recognition-network errors instead of silently waiting. A moving waveform means audio capture works, not that ASR is working. [Browser recognition limitations](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

## Run the optional audio backend

```bash
python3 -m venv services/audio-engine/.venv
services/audio-engine/.venv/bin/pip install -e 'services/audio-engine[test]'
npm run dev:backend
```

On local HTTP, the web app automatically connects to `ws://localhost:8000/ws/audio`. Override it with `NEXT_PUBLIC_AUDIO_WS_URL` (use `wss://` on HTTPS). The shipped `MockStreamingASR` verifies transport only; it does **not** transcribe microphone audio. Browser recognition remains active with this mock. A non-mock backend's `ready.adapter` switches recognition to the backend, whose `hypothesis` messages feed the same caption engine.

## Verify

```bash
npm test
npm run typecheck
npm run build
npm run test:backend
npx playwright install chromium
npm run test:e2e
```

Browser tests pass synthesized audio through the actual AudioWorklet and inject ASR results to verify the input → waveform → hypothesis → caption flow. They do not measure human Korean recognition accuracy or production end-to-end latency.

The latency metric labels its origin: `음성→표시` uses an available VAD onset, `인식→표시` uses recognition receipt when a continuous monologue has no new onset, and `수동→표시` uses the manual cue. Recognition-to-paint does **not** include ASR waiting time. Tests cover all 16 cues using only two-syllable interims, full continuous transcripts, late final revisions, and reset while listening.

Keyboard safety controls:

- `Space` or `Right`: next caption
- `Left`: previous caption
- `H`: hold/resume automatic advance
- `R`: force resync mode

See [architecture](docs/architecture.md) and [latency instrumentation](docs/latency.md) for design decisions and extension points.
