from __future__ import annotations

import json
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .adapters import MockStreamingASR, StreamingHypothesis
from .audio import pcm_rms

app = FastAPI(title="Stage Audio Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "adapter": MockStreamingASR.name}


@app.websocket("/ws/audio")
async def audio_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    adapter = MockStreamingASR()
    frame_count = 0
    await websocket.send_json(
        {
            "type": "ready",
            "adapter": adapter.name,
            "audio_format": "mono/16000/s16le",
        }
    )
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                pcm = message["bytes"]
                now_ms = time.monotonic() * 1000
                frame_count += 1
                hypotheses = await adapter.accept_pcm(pcm, now_ms)
                for hypothesis in hypotheses:
                    await websocket.send_json(hypothesis.as_message())
                if frame_count % 5 == 0:
                    await websocket.send_json(
                        {"type": "audio_metrics", "rms": pcm_rms(pcm), "received_at_ms": now_ms}
                    )
                continue

            raw_text = message.get("text")
            if raw_text is None:
                continue
            payload = json.loads(raw_text)
            message_type = payload.get("type")
            if message_type == "ping":
                await websocket.send_json({"type": "pong", "at": time.monotonic() * 1000})
            elif message_type == "reset":
                await adapter.reset()
            elif message_type == "mock_hypothesis":
                adapter.inject(
                    StreamingHypothesis(
                        text=str(payload.get("text", "")),
                        confidence=float(payload.get("confidence", 0.9)),
                        is_final=bool(payload.get("is_final", False)),
                        timestamp_ms=time.monotonic() * 1000,
                    )
                )
    except WebSocketDisconnect:
        await adapter.reset()
