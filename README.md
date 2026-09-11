# Cueflow — Realtime Performance Caption MVP

Cueflow follows a prepared performance script and displays complete captions as soon as live partial speech provides enough evidence. Audio controls timing; the stored script controls content.

## Run the web demo

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:3000/demo`. The simulation controls work without a microphone or backend. Use `?debug=true` to open developer telemetry.

`START MIC` enables AudioWorklet capture, VAD, audio-reactive 3D motion, and browser interim Korean speech recognition where supported. Chrome-based browsers provide the broadest demo support. The browser recognizer is a replaceable demo adapter, not the production/offline ASR.

## Run the optional audio backend

```bash
python3 -m venv services/audio-engine/.venv
services/audio-engine/.venv/bin/pip install -e 'services/audio-engine[test]'
npm run dev:backend
```

The web app automatically connects to `ws://localhost:8000/ws/audio`. Override it with `NEXT_PUBLIC_AUDIO_WS_URL`.

## Verify

```bash
npm test
npm run typecheck
npm run build
npm run test:backend
```

Keyboard safety controls:

- `Space` or `Right`: next caption
- `Left`: previous caption
- `H`: hold/resume automatic advance
- `R`: force resync mode

See [architecture](docs/architecture.md) and [latency instrumentation](docs/latency.md) for design decisions and extension points.

