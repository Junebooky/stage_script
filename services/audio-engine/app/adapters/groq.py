"""Prerecorded rehearsal ASR only. No canonical prompt or live microphone path."""
from __future__ import annotations

import math
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx

from .soniox import ExternalASRUnavailable
from .groq_transport import MAX_UPLOAD_BYTES, TransportError, prepare_transport
from ..inspection import sha256_file

MODEL = "whisper-large-v3"
ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions"


class GroqASRError(RuntimeError):
    pass


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(item: dict[str, Any], field: str) -> float:
    value = item.get(field)
    if not finite(value) or value < 0:
        raise GroqASRError("Groq returned invalid acoustic timestamps")
    return value * 1000


def normalize_verbose(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Retain segment text/times; attach only correctly contained ordered words.

    Inconsistent word alignment is retained in rawResult and marked for review,
    not fixed by inventing boundaries. No per-word probability is manufactured.
    """
    raw_segments = result.get("segments")
    if not isinstance(raw_segments, list):
        raise GroqASRError("Groq verbose_json must contain segment timestamps")
    raw_words = result.get("words", [])
    if not isinstance(raw_words, list):
        raise GroqASRError("Groq returned invalid word data")
    normalized_words = []
    for raw in raw_words:
        if not isinstance(raw, dict) or not isinstance(raw.get("word"), str):
            raise GroqASRError("Groq returned invalid word text")
        start, end = timestamp(raw, "start"), timestamp(raw, "end")
        if end < start:
            raise GroqASRError("Groq returned reversed word timestamps")
        native = raw.get("confidence")
        if native is not None and (not finite(native) or not 0 <= native <= 1):
            raise GroqASRError("Groq returned invalid native word confidence")
        normalized_words.append({"text": raw["word"], "startMs": start, "endMs": end,
                                 "confidence": native, "confidenceBasis": "provider-native" if native is not None else "unavailable"})
    spans = []
    assigned = set()
    for index, raw in enumerate(raw_segments):
        if not isinstance(raw, dict) or not isinstance(raw.get("text"), str):
            raise GroqASRError("Groq returned invalid segment text")
        start, end = timestamp(raw, "start"), timestamp(raw, "end")
        if end < start:
            raise GroqASRError("Groq returned reversed segment timestamps")
        logprob = raw.get("avg_logprob")
        derived = math.exp(logprob) if finite(logprob) and logprob <= 0 else None
        metadata = {key: raw[key] for key in ("id", "seek", "avg_logprob", "no_speech_prob", "compression_ratio", "temperature", "tokens") if key in raw}
        contained = [(i, word) for i, word in enumerate(normalized_words)
                     if i not in assigned and start <= word["startMs"] and word["endMs"] <= end]
        words = [word for _, word in contained]
        ordered = all(left["endMs"] <= right["startMs"] for left, right in zip(words, words[1:]))
        normalize = lambda text: re.sub(r"[\W_]", "", text, flags=re.UNICODE)
        text_agrees = normalize("".join(word["text"] for word in words)) == normalize(raw["text"])
        span = {"id": f"groq-{index}", "text": raw["text"], "startMs": start, "endMs": end,
                "confidence": derived, "confidenceBasis": "segment-logprob-derived" if derived is not None else "unavailable",
                "providerMetadata": metadata}
        if words and ordered and text_agrees:
            span["words"] = words
            assigned.update(i for i, _ in contained)
        else:
            metadata["wordTimingWarning"] = "Words missing, crossing segment boundaries, overlapping, or text mismatch; review raw provider timestamps."
        spans.append(span)
    return sorted(spans, key=lambda span: span["startMs"])


def redact(value: Any, secret: str) -> Any:
    """Defensive response sanitization, including unexpected echoed credentials."""
    if isinstance(value, str):
        return value.replace(secret, "[REDACTED]")
    if isinstance(value, list):
        return [redact(item, secret) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, secret) for key, item in value.items()
                if key.lower() not in {"authorization", "api_key", "headers", "request_headers", "environment"}}
    return value


class GroqProvider:
    name = f"groq/{MODEL}"
    timestamp_basis = "cloud-asr-pseudo"

    def __init__(self, *, allow_cloud_upload: bool, transport: httpx.BaseTransport | None = None):
        if not allow_cloud_upload:
            raise ExternalASRUnavailable("CLOUD UPLOAD NOT AUTHORIZED — explicitly allow audio transfer to Groq.")
        self._key = os.environ.get("GROQ_API_KEY", "").strip()
        if not self._key:
            raise ExternalASRUnavailable("GROQ ASR UNAVAILABLE — configure GROQ_API_KEY in the backend environment.")
        self._transport = transport
        self.raw_result: dict[str, Any] | None = None
        self.audit: dict[str, Any] = {"provider": self.name, "model": MODEL, "endpoint": ENDPOINT,
            "cloudUploadAuthorized": True, "canonicalContextSent": False, "derivedFileUsed": False,
            "attempts": [], "cleanup": [], "remoteDeletion": "not-exposed-by-transcription-endpoint",
            "privacyPolicy": "https://console.groq.com/docs/your-data", "liveLatencyMeasured": False}

    def _request(self, client: httpx.Client, path: Path, *, derived: bool = False) -> httpx.Response:
        attempt = {"transportFormat": path.suffix.lower().lstrip("."), "bytes": path.stat().st_size,
                   "derived": derived, "timelineOffsetMs": 0}
        self.audit["attempts"].append(attempt)
        began = time.perf_counter()
        try:
            with path.open("rb") as audio:
                response = client.post(ENDPOINT, data={"model": MODEL, "language": "ko", "temperature": "0",
                    "response_format": "verbose_json", "timestamp_granularities[]": ["word", "segment"]},
                    files={"file": (f"recording{path.suffix.lower()}", audio, "application/octet-stream")})
            attempt.update(statusCode=response.status_code)
            request_id = response.headers.get("x-request-id")
            if request_id:
                attempt["requestId"] = redact(request_id, self._key)
            return response
        except httpx.TimeoutException:
            raise GroqASRError("Groq transcription timed out; no automatic retry or provider fallback.") from None
        except httpx.HTTPError:
            raise GroqASRError("Groq network request failed; no automatic retry or provider fallback.") from None
        finally:
            attempt["wallTimeMs"] = (time.perf_counter() - began) * 1000

    def transcribe(self, audio: str, *, words: bool = True) -> list[dict[str, Any]]:
        del words  # Always request BOTH word and segment timestamp granularities.
        original = Path(audio).resolve()
        before = sha256_file(original)
        self.audit["originalSha256"] = before
        began = time.perf_counter()
        derived: Path | None = None
        try:
            with tempfile.TemporaryDirectory(prefix="cueflow-groq-transport-") as directory:
                derived = Path(directory) / "transport.flac"
                try:
                    transport_audit = prepare_transport(original, derived)
                except TransportError as error:
                    raise GroqASRError(str(error)) from None
                self.audit.update(derivedFileUsed=True, transport=transport_audit,
                    derivation="16000 Hz mono PCM encoded as lossless FLAC; no trim or time shift", timelineOffsetMs=0)
                if transport_audit["bytes"] > MAX_UPLOAD_BYTES:
                    raise GroqASRError(f"Prepared FLAC exceeds 25 MB ({transport_audit['bytes']} bytes); no upload, chunking or fallback performed.")
                if sha256_file(original) != before:
                    raise GroqASRError("Original changed during preparation; no upload performed.")
                with httpx.Client(headers={"Authorization": f"Bearer {self._key}"},
                              timeout=httpx.Timeout(300, connect=20), follow_redirects=False,
                              trust_env=False, transport=self._transport) as client:
                    response = self._request(client, derived, derived=True)
                if not 200 <= response.status_code < 300:
                    raise GroqASRError(f"Groq HTTP {response.status_code}; check credentials, permissions, rate limits or provider availability.")
                try:
                    result = response.json()
                    if not isinstance(result, dict):
                        raise ValueError()
                    self.raw_result = redact(result, self._key)
                    transcript = normalize_verbose(self.raw_result)
                except (ValueError, TypeError, KeyError):
                    raise GroqASRError("Groq returned invalid verbose_json; no transcript fabricated.") from None
                self.audit["xGroq"] = self.raw_result.get("x_groq")
                return transcript
        finally:
            if derived is not None:
                self.audit["temporaryTransportRemoved"] = not derived.exists()
            self.audit["pipelineWallTimeMs"] = (time.perf_counter() - began) * 1000
            self.audit["transcriptionWallTimeMs"] = sum(attempt["wallTimeMs"] for attempt in self.audit["attempts"])
            self.audit["originalUnchanged"] = sha256_file(original) == before
            if not self.audit["originalUnchanged"]:
                raise GroqASRError("Original recording changed during Groq transcription")
