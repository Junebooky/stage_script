"""Optional, genuinely offline faster-whisper provider; never downloads a model.

This is bounded rolling chunk inference, not a phoneme streaming recognizer.
Its measured latency/accuracy on singing must be validated on the show machine.
"""
from __future__ import annotations

import asyncio
import importlib.util
import math
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from .base import StreamingASRAdapter, StreamingHypothesis
from ..audio import pcm_rms


class LocalASRUnavailable(RuntimeError):
    pass


class FasterWhisperProvider:
    name = "faster-whisper-local"

    def __init__(self, model_dir: Path) -> None:
        # tokenizer.json is mandatory: faster-whisper otherwise calls from_pretrained
        # even when model weights were supplied as a local directory.
        for filename in ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json"):
            if not (model_dir / filename).is_file():
                raise LocalASRUnavailable(f"Local model is missing {filename}")
        from faster_whisper import WhisperModel

        self.model = WhisperModel(
            str(model_dir.resolve()), local_files_only=True,
            device=os.environ.get("STAGE_ASR_DEVICE", "cpu"),
            compute_type=os.environ.get("STAGE_ASR_COMPUTE_TYPE", "int8"),
        )
        if "ko" not in self.model.supported_languages:
            raise LocalASRUnavailable("The configured model does not support Korean")
        self.lock = threading.Lock()

    def transcribe(self, audio: Any, *, words: bool = False) -> list[dict[str, Any]]:
        with self.lock:
            segments, _ = self.model.transcribe(
                audio, language="ko", task="transcribe", beam_size=1,
                word_timestamps=words, vad_filter=False,
                condition_on_previous_text=False, temperature=0,
            )
            results = []
            for segment in segments:
                if segment.no_speech_prob > 0.8 or not segment.text.strip():
                    continue
                item = {
                    "id": str(segment.id), "text": segment.text.strip(),
                    "startMs": segment.start * 1000, "endMs": segment.end * 1000,
                    "confidence": min(1.0, max(0.0, math.exp(segment.avg_logprob))),
                    "confidenceBasis": "segment-logprob-derived",
                    "providerMetadata": {"avg_logprob": segment.avg_logprob, "no_speech_prob": segment.no_speech_prob},
                }
                if words:
                    item["words"] = [
                        {"text": word.word, "startMs": word.start * 1000,
                         "endMs": word.end * 1000, "confidence": word.probability, "confidenceBasis": "provider-native"}
                        for word in (segment.words or [])
                    ]
                results.append(item)
            return results


_provider: FasterWhisperProvider | None = None
_provider_path: str | None = None
_provider_lock = threading.Lock()
_usage_lock = threading.Lock()
_rehearsal_jobs = 0
_performance_sessions = 0


def claim_local_runtime(kind: str) -> None:
    """Do not hide a whole-show transcription queue behind live 'ready' status."""
    global _rehearsal_jobs, _performance_sessions
    with _usage_lock:
        if kind == "performance":
            if _rehearsal_jobs:
                raise LocalASRUnavailable("Rehearsal transcription is running; wait before arming live ASR")
            if _performance_sessions:
                raise LocalASRUnavailable("Another performance microphone session owns local ASR")
            _performance_sessions += 1
        else:
            if _performance_sessions:
                raise LocalASRUnavailable("Live performance owns local ASR; analyze recordings after the show")
            _rehearsal_jobs += 1


def release_local_runtime(kind: str) -> None:
    global _rehearsal_jobs, _performance_sessions
    with _usage_lock:
        if kind == "performance":
            _performance_sessions = max(0, _performance_sessions - 1)
        else:
            _rehearsal_jobs = max(0, _rehearsal_jobs - 1)


def get_local_provider() -> FasterWhisperProvider:
    global _provider, _provider_path
    model_dir = os.environ.get("STAGE_LOCAL_MODEL_DIR", "")
    if not model_dir or not Path(model_dir).is_dir():
        raise LocalASRUnavailable("Set STAGE_LOCAL_MODEL_DIR to an existing, complete local model directory")
    if importlib.util.find_spec("faster_whisper") is None:
        raise LocalASRUnavailable("Install the optional audio-engine[local-asr] dependency before the show")
    with _provider_lock:
        if _provider is None or _provider_path != model_dir:
            try:
                _provider = FasterWhisperProvider(Path(model_dir))
                _provider_path = model_dir
            except Exception as error:
                _provider = None
                raise LocalASRUnavailable(f"Local model load failed: {error}") from error
        return _provider


def local_readiness() -> dict[str, Any]:
    try:
        provider = get_local_provider()
        if _rehearsal_jobs:
            raise LocalASRUnavailable("Rehearsal transcription is running; live ASR is reserved until it completes")
        return {"status": "LOCAL ASR READY", "adapter": provider.name,
                "local_ready": True, "reason": None, "offline": True,
                "language": "ko", "inference": "rolling-chunk", "chunk_min_ms": 400}
    except LocalASRUnavailable as error:
        return {"status": "LOCAL ASR UNAVAILABLE", "adapter": "unavailable",
                "local_ready": False, "reason": str(error), "offline": True}


class LocalStreamingASR(StreamingASRAdapter):
    """Inference is asynchronous; incoming PCM never queues behind slow inference.

    At most one inference and a twelve-second rolling buffer are retained. This
    bounds backpressure, but a slow CPU still increases recognition latency.
    """
    name = FasterWhisperProvider.name

    def __init__(self, provider: FasterWhisperProvider) -> None:
        self.provider = provider
        self.pcm = bytearray()
        self.total_samples = 0
        self.window_start_samples = 0
        self.last_inference_samples = 0
        self.silent_samples = 0
        self.speech_seen = False
        self.utterance = 0
        self.generation = 0
        self.pending: asyncio.Task[None] | None = None
        self.results: deque[StreamingHypothesis] = deque()
        self.last_text = ""

    async def accept_pcm(self, pcm_s16le: bytes, timestamp_ms: float) -> list[StreamingHypothesis]:
        if len(pcm_s16le) % 2:
            raise ValueError("PCM frame must contain complete signed 16-bit samples")
        count = len(pcm_s16le) // 2
        self.total_samples += count
        if pcm_rms(pcm_s16le) > 0.006:
            self.silent_samples = 0
            self.speech_seen = True
        else:
            self.silent_samples += count
        if self.speech_seen:
            self.pcm.extend(pcm_s16le)
            excess = max(0, len(self.pcm) - 16000 * 2 * 12)
            if excess:
                del self.pcm[:excess]
                self.window_start_samples += excess // 2
        else:
            self.window_start_samples = self.total_samples
        self._schedule()
        return await self.poll()

    def _schedule(self) -> None:
        if self.pending is not None and not self.pending.done():
            return
        if not self.speech_seen or len(self.pcm) < 16000 * 2 * 0.4:
            return
        if self.total_samples - self.last_inference_samples < 16000 * 0.32:
            return
        self.last_inference_samples = self.total_samples
        pcm, start = bytes(self.pcm), self.window_start_samples / 16
        final = self.silent_samples >= 16000 * 0.6
        self.pending = asyncio.create_task(self._infer(pcm, start, final, self.generation, self.utterance))
        if final:
            self.pcm.clear()
            self.speech_seen = False
            self.window_start_samples = self.total_samples
            self.utterance += 1

    async def _infer(self, pcm: bytes, start: float, final: bool, generation: int, utterance: int) -> None:
        try:
            import numpy as np

            samples = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768
            segments = await asyncio.to_thread(self.provider.transcribe, samples)
            if generation != self.generation or not segments:
                return
            text = " ".join(segment["text"] for segment in segments)
            if text == self.last_text and not final:
                return
            self.last_text = text if not final else ""
            self.results.append(StreamingHypothesis(
                text=text, confidence=sum(item["confidence"] for item in segments) / len(segments),
                is_final=final, timestamp_ms=time.monotonic() * 1000,
                utterance_id=f"local-{generation}-{utterance}",
                start_ms=start + segments[0]["startMs"], end_ms=start + segments[-1]["endMs"],
            ))
        except asyncio.CancelledError:
            raise
        except Exception:
            # Surface a failed worker on the next poll; never silently switch to mock.
            raise

    async def poll(self) -> list[StreamingHypothesis]:
        if self.pending is not None and self.pending.done():
            self.pending.result()
            self.pending = None
        result = list(self.results)
        self.results.clear()
        self._schedule()
        return result

    async def reset(self) -> None:
        self.generation += 1
        if self.pending is not None:
            self.pending.cancel()
            self.pending = None
        self.pcm.clear()
        self.results.clear()
        self.speech_seen = False
        self.silent_samples = 0
        self.last_text = ""
        self.window_start_samples = self.total_samples
        self.last_inference_samples = self.total_samples
