from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .adapters import MockStreamingASR, StreamingHypothesis
from .audio import pcm_rms
from .adapters.local import LocalStreamingASR, claim_local_runtime, get_local_provider, local_readiness, release_local_runtime
from .rehearsal import recover_interrupted_jobs, router as rehearsal_router
from .environment import load_backend_environment


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_backend_environment()
    recover_interrupted_jobs()
    yield


app = FastAPI(title="Stage Audio Engine", version="0.2.0", lifespan=lifespan)
LOCAL_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(LOCAL_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(rehearsal_router)


@app.middleware("http")
async def local_origin_only(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in LOCAL_ORIGINS:
        return JSONResponse({"detail": "Only the local operator origin is allowed"}, status_code=403)
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "adapter": MockStreamingASR.name}


@app.get("/readiness")
async def readiness() -> dict[str, object]:
    return await asyncio.to_thread(local_readiness)


@app.websocket("/ws/audio")
async def audio_socket(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if origin and origin not in LOCAL_ORIGINS:
        await websocket.close(code=1008, reason="Local operator origin required")
        return
    await websocket.accept()
    performance = websocket.query_params.get("mode") == "performance"
    if performance:
        try:
            provider = await asyncio.to_thread(get_local_provider)
            claim_local_runtime("performance")
            adapter = LocalStreamingASR(provider)
        except Exception as error:
            await websocket.send_json({"type": "error", "detail": f"LOCAL ASR UNAVAILABLE: {error}"})
            await websocket.close(code=1013)
            return
    else:
        adapter = MockStreamingASR()
    frame_count = 0
    audio_generation = 0
    await websocket.send_json(
        {
            "type": "ready",
            "adapter": adapter.name,
            "audio_format": "mono/16000/s16le",
            "local_ready": performance,
            "mode": "performance" if performance else "demo",
            "reset_generation": True,
            "generation": audio_generation,
        }
    )
    receive_task = asyncio.create_task(websocket.receive())
    try:
        while True:
            # Poll inference independently of incoming frames, including after silence.
            done, _ = await asyncio.wait({receive_task}, timeout=0.04)
            for hypothesis in await adapter.poll():
                await websocket.send_json({**hypothesis.as_message(), "generation": audio_generation})
            if not done:
                continue
            message = receive_task.result()
            if message.get("type") == "websocket.disconnect":
                break
            receive_task = asyncio.create_task(websocket.receive())
            if message.get("bytes") is not None:
                pcm = message["bytes"]
                if len(pcm) % 2 or len(pcm) > 32000:
                    await websocket.send_json({"type": "error", "detail": "Expected at most one second of mono/16000/s16le PCM"})
                    continue
                now_ms = time.monotonic() * 1000
                frame_count += 1
                hypotheses = await adapter.accept_pcm(pcm, now_ms)
                for hypothesis in hypotheses:
                    await websocket.send_json({**hypothesis.as_message(), "generation": audio_generation})
                if frame_count % 5 == 0:
                    await websocket.send_json(
                        {"type": "audio_metrics", "rms": pcm_rms(pcm), "received_at_ms": now_ms}
                    )
                continue

            raw_text = message.get("text")
            if raw_text is None:
                continue
            try:
                payload = json.loads(raw_text)
            except ValueError:
                await websocket.send_json({"type": "error", "detail": "Invalid JSON control message"})
                continue
            if not isinstance(payload, dict):
                continue
            message_type = payload.get("type")
            if message_type == "ping":
                await websocket.send_json({"type": "pong", "at": time.monotonic() * 1000})
            elif message_type == "reset":
                generation = payload.get("generation", audio_generation + 1)
                if not isinstance(generation, int) or isinstance(generation, bool) or generation <= audio_generation:
                    await websocket.send_json({"type": "error", "detail": "Reset requires a newer audio generation"})
                    continue
                await adapter.reset()
                audio_generation = generation
                await websocket.send_json({"type": "reset_ack", "generation": audio_generation})
            elif message_type == "mock_hypothesis":
                if performance:
                    await websocket.send_json({"type": "error", "detail": "Mock hypotheses are forbidden in performance mode"})
                    continue
                adapter.inject(
                    StreamingHypothesis(
                        text=str(payload.get("text", "")),
                        confidence=float(payload.get("confidence", 0.9)),
                        is_final=bool(payload.get("is_final", False)),
                        timestamp_ms=time.monotonic() * 1000,
                    )
                )
    except WebSocketDisconnect:
        pass
    except Exception as error:
        await websocket.send_json({"type": "error", "detail": f"Audio processing failed: {error}"})
        await websocket.close(code=1011)
    finally:
        receive_task.cancel()
        await adapter.reset()
        if performance:
            release_local_runtime("performance")
