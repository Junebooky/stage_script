"""Opt-in local-only WAV -> real /ws/audio -> immutable event capture.

No microphone, speaker, saved transcript, cue reference, or audience publisher.
Run after explicitly provisioning a local model. All outbound sockets are blocked
except loopback. The normal app/adapter is reused without changing its policy.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import socket
import sys
import time
import uuid
import wave
from pathlib import Path

import httpx
import uvicorn
from websockets.asyncio.client import connect

from .environment import load_backend_environment
from .sources import decode_audio_pcm

ROOT = Path(__file__).resolve().parents[3]


def block_external_sockets(event, args):
    if event == "socket.connect":
        address = args[1]
        if isinstance(address, tuple) and address[0] not in {"127.0.0.1", "::1"}:
            raise RuntimeError("Measurement forbids non-loopback network connections")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value):
    with path.open("x", encoding="utf8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


async def measure(audio_path: Path, output: Path, drain_seconds: float = 10):
    # Load only the established ignored backend configuration. Never log env.
    load_backend_environment()
    sys.addaudithook(block_external_sockets)
    from .adapters.local import get_local_provider
    from .main import app

    before = sha(audio_path)
    with wave.open(str(audio_path), "rb") as wav:
        original = {"frames": wav.getnframes(), "sampleRate": wav.getframerate(),
                    "channels": wav.getnchannels(), "sampleWidth": wav.getsampwidth()}
        original_ms = wav.getnframes() / wav.getframerate() * 1000
    pcm = await asyncio.to_thread(decode_audio_pcm, audio_path)
    duration_ms = len(pcm) / 32
    if abs(duration_ms - original_ms) > 1:
        raise ValueError("PCM conversion changed duration by more than 1 ms")
    provider = await asyncio.to_thread(get_local_provider)
    original_transcribe = provider.transcribe
    calls = []

    def instrumented_transcribe(samples, *, words=False):
        started = time.monotonic_ns()
        item = {"startedNs": started, "inputSamples": len(samples), "inputAudioMs": len(samples) / 16}
        try:
            result = original_transcribe(samples, words=words)
            item["segments"] = len(result)
            return result
        except Exception:
            item["failed"] = True
            raise
        finally:
            item["endedNs"] = time.monotonic_ns()
            item["wallMs"] = (item["endedNs"] - started) / 1e6
            calls.append(item)

    provider.transcribe = instrumented_transcribe
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off", access_log=False))
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    output.mkdir(parents=True, exist_ok=False)
    events, frames = [], []
    origin_ns = None
    error = None
    ready = None
    sent_bytes = 0
    try:
        while not server.started:
            if server_task.done():
                await server_task
                raise RuntimeError("Local server did not start")
            await asyncio.sleep(.02)
        async with httpx.AsyncClient(trust_env=False) as http:
            response = await http.get(f"http://127.0.0.1:{port}/readiness", timeout=60)
            ready = response.json()
        if not ready.get("local_ready"):
            raise RuntimeError("Local ASR is not ready; no fallback")
        async with connect(f"ws://127.0.0.1:{port}/ws/audio?mode=performance", proxy=None, max_size=2**20) as ws:
            handshake = json.loads(await ws.recv())
            if handshake.get("adapter") != "faster-whisper-local" or not handshake.get("local_ready"):
                raise RuntimeError("Refusing a non-local/mock adapter")
            print(json.dumps({"readiness": ready, "websocket": handshake, "durationMs": duration_ms}), flush=True)
            origin_ns = time.monotonic_ns()

            async def receive():
                async for raw in ws:
                    arrival = time.monotonic_ns()
                    message = json.loads(raw)
                    events.append({"sequence": len(events), "receivedNs": arrival,
                        "receivedAtMs": (arrival - origin_ns) / 1e6,
                        "sentAudioThroughMs": sent_bytes / 32, "message": message})
                    if message.get("type") == "error":
                        raise RuntimeError("Local ASR websocket reported an error; see local event trace")

            receiving = asyncio.create_task(receive())
            try:
                for offset in range(0, len(pcm), 640):
                    chunk = pcm[offset:offset + 640]
                    end_ms = (offset + len(chunk)) / 32
                    # Supply each 20 ms frame ONLY once its end is in the past.
                    # No accelerated replay or future-audio lookahead.
                    wait = origin_ns / 1e9 + end_ms / 1000 - time.monotonic()
                    if wait > 0:
                        await asyncio.sleep(wait)
                    if receiving.done():
                        await receiving
                        raise RuntimeError("Receiver ended before the audio")
                    await ws.send(chunk)
                    sent_bytes += len(chunk)
                    at = (time.monotonic_ns() - origin_ns) / 1e6
                    frames.append({"startSample": offset // 2, "endSample": (offset + len(chunk)) // 2,
                                  "sentAtMs": at, "sourceEndMs": end_ms, "lagMs": at - end_ms})
                    if len(frames) % 1000 == 0:
                        print(f"PCM 1.0x: {end_ms/1000:.1f}/{duration_ms/1000:.3f}s; hypotheses={sum(e['message'].get('type') == 'hypothesis' for e in events)}", flush=True)
                # Do not append invented silence to force a final. Drain only.
                await asyncio.sleep(drain_seconds)
                if receiving.done():
                    await receiving
            finally:
                receiving.cancel()
                await asyncio.gather(receiving, return_exceptions=True)
    except Exception as cause:
        error = type(cause).__name__ + ": " + str(cause)
        raise
    finally:
        server.should_exit = True
        await server_task
        provider.transcribe = original_transcribe
        after = sha(audio_path)
        total_work = sum(c["wallMs"] for c in calls)
        total_audio = sum(c["inputAudioMs"] for c in calls)
        capture = {"version": 1, "mode": "actual-local-streaming-paced-file-not-microphone",
            "audioPath": str(audio_path), "sourceSha256": before, "sourceUnchanged": before == after,
            "original": original, "originalDurationMs": original_ms, "pcmDurationMs": duration_ms,
            "pcmFormat": "16000/mono/s16le", "timelineOffsetMs": 0, "pcmSha256": hashlib.sha256(pcm).hexdigest(),
            "clock": "single-process monotonic_ns; frame end paced; provider timestamp is same host monotonic clock",
            "originNs": origin_ns, "readiness": ready, "versions": {name: importlib.metadata.version(name) for name in ["faster-whisper", "ctranslate2", "av", "numpy"]},
            "framesSent": len(frames), "sentAudioMs": sent_bytes / 32, "drainSeconds": drain_seconds,
            "complete": sent_bytes == len(pcm) and error is None, "error": error,
            "rtf": {"inferenceWorkOverAnalyzedAudio": total_work / total_audio if total_audio else None,
                    "rollingComputeLoadOverSourceDuration": total_work / duration_ms,
                    "pacedSupplyOverSourceDuration": frames[-1]["sentAtMs"] / duration_ms if frames else None,
                    "totalInferenceWallMs": total_work, "totalRepeatedWindowAudioMs": total_audio,
                    "callCount": len(calls)},
            "events": events, "inferences": calls, "frames": frames}
        write_json(output / "capture.json", capture)
        print(json.dumps({"output": str(output), "complete": capture["complete"], "rtf": capture["rtf"],
                          "hypotheses": sum(e["message"].get("type") == "hypothesis" for e in events), "originalUnchanged": before == after}), flush=True)
        if before != after:
            raise RuntimeError("Original audio hash changed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or ROOT / ".stage-data" / "streaming-measurements" / ("run-" + str(uuid.uuid4()))
    asyncio.run(measure(args.audio.resolve(), output.resolve()))
