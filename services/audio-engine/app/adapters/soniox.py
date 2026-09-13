"""Opt-in external batch ASR. No canonical lyrics, fallback, or API keys in artifacts.

The browser never receives a provider credential. Only this run's remote objects
are deleted; the original local recording is never changed.
"""
from __future__ import annotations

import math
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

MODEL = "stt-async-v5"
BASE_URL = "https://api.soniox.com/v1"


class ExternalASRUnavailable(RuntimeError):
    pass


def require_soniox_config(allow_cloud_upload: bool) -> str:
    if not allow_cloud_upload:
        raise ExternalASRUnavailable("CLOUD UPLOAD NOT AUTHORIZED — explicitly allow audio transfer to Soniox (US).")
    key = os.environ.get("SONIOX_API_KEY", "").strip()
    if not key:
        raise ExternalASRUnavailable("SONIOX_API_KEY is not configured on the audio backend. Do not paste it in the browser or chat.")
    return key


def token_segments(tokens: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join subwords before normalization: Korean morphemes aren't filler words.

    Pauses/speakers/sentence endings split spans without consulting the script.
    Overlapping word timestamps remain span-only estimates, never fabricated
    non-overlapping word times. Alignment will require review for those spans.
    """
    segments: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []
    word: dict[str, Any] | None = None
    speaker: Any = None

    def flush_word() -> None:
        nonlocal word
        if word:
            words.append(word)
            word = None

    def flush_span() -> None:
        flush_word()
        if not words:
            return
        segment = {"id": f"soniox-{len(segments)}", "text": " ".join(item["text"] for item in words),
                   "startMs": min(item["startMs"] for item in words), "endMs": max(item["endMs"] for item in words),
                   "confidence": min(item["confidence"] for item in words)}
        if all(left["endMs"] <= right["startMs"] for left, right in zip(words, words[1:])):
            segment["words"] = list(words)
        segments.append(segment)
        words.clear()

    for token in tokens:
        text = token.get("text")
        if not isinstance(text, str):
            raise ValueError("Invalid Soniox token text")
        if re.fullmatch(r"<[^>]+>", text):
            continue  # Protocol markers are not recognized speech.
        if not text.strip():
            flush_word()
            continue
        start, end, confidence = token.get("start_ms"), token.get("end_ms"), token.get("confidence")
        if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in (start, end, confidence)):
            raise ValueError("Invalid Soniox token timestamps/confidence")
        if start < 0 or end < start or not 0 <= confidence <= 1:
            raise ValueError("Invalid Soniox token range")
        previous = word or (words[-1] if words else None)
        span_start = words[0]["startMs"] if words else (word["startMs"] if word else start)
        if previous and (start - previous["endMs"] > 700 or token.get("speaker") != speaker
                         or start - span_start > 12_000 or previous["text"].endswith((".", "!", "?", "。"))):
            flush_span()
        speaker = token.get("speaker")
        pieces = re.split(r"(\s+)", text)
        for piece in pieces:
            if not piece:
                continue
            if piece.isspace():
                flush_word()
            elif word:
                word.update(text=word["text"] + piece, startMs=min(word["startMs"], start),
                            endMs=max(word["endMs"], end), confidence=min(word["confidence"], confidence))
            else:
                word = {"text": piece, "startMs": start, "endMs": end, "confidence": confidence}
    flush_span()
    return sorted(segments, key=lambda segment: segment["startMs"])


class SonioxProvider:
    name = f"soniox/{MODEL}"
    timestamp_basis = "cloud-asr-pseudo"

    def __init__(self, *, allow_cloud_upload: bool, transport: httpx.BaseTransport | None = None,
                 timeout_seconds: float = 600, poll_seconds: float = 1):
        self._key = require_soniox_config(allow_cloud_upload)
        self._transport = transport
        self.timeout_seconds = timeout_seconds
        self.poll_seconds = poll_seconds
        self.audit: dict[str, Any] = {"provider": self.name, "region": "US", "endpoint": BASE_URL,
                                      "canonicalContextSent": False, "cleanup": [], "uploadStarted": False}
        self.raw_result: dict[str, Any] | None = None

    def transcribe(self, audio: str, *, words: bool = True) -> list[dict[str, Any]]:
        del words  # The service always supplies token-level estimates.
        file_id = transcription_id = None
        def identifier(value: Any) -> str:
            return str(uuid.UUID(value))  # Never interpolate unchecked provider paths.
        with httpx.Client(base_url=BASE_URL + "/", headers={"Authorization": f"Bearer {self._key}"},
                          timeout=60, follow_redirects=False, trust_env=False, transport=self._transport) as client:
            def request(method: str, path: str, **kwargs: Any) -> Any:
                try:
                    response = client.request(method, path, **kwargs)
                except httpx.HTTPError:
                    raise RuntimeError("Soniox network request failed; check connectivity and the remote-object audit.") from None
                if not 200 <= response.status_code < 300:
                    # Do not log raw responses, headers, or request bodies containing private data.
                    raise RuntimeError(f"Soniox HTTP {response.status_code}; check credentials, balance/rate limits, and service availability.")
                return response.json() if response.content else None
            try:
                self.audit["uploadStarted"] = True
                with Path(audio).open("rb") as recording:
                    uploaded = request("POST", "files", files={"file": (f"recording{Path(audio).suffix.lower()}", recording, "application/octet-stream")})
                file_id = identifier(uploaded["id"])
                self.audit["fileId"] = file_id
                job = request("POST", "transcriptions", json={"model": MODEL, "file_id": file_id,
                              "language_hints": ["ko"], "enable_language_identification": True})
                transcription_id = identifier(job["id"])
                self.audit["transcriptionId"] = transcription_id
                deadline = time.monotonic() + self.timeout_seconds
                while job.get("status") in {"queued", "processing"}:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Soniox transcription timed out; inspect external-asr.json for remote cleanup status.")
                    time.sleep(self.poll_seconds)
                    job = request("GET", f"transcriptions/{transcription_id}")
                if job.get("status") != "completed":
                    raise RuntimeError("Soniox transcription did not complete successfully.")
                self.raw_result = request("GET", f"transcriptions/{transcription_id}/transcript")
                return token_segments(self.raw_result["tokens"])
            finally:
                # Only objects created by this invocation. Failed deletion is an explicit
                # warning, never a claim of zero retention. Soniox otherwise retains async
                # files/transcripts for up to 30 days under its documented policy.
                for kind, object_id in (("transcriptions", transcription_id), ("files", file_id)):
                    if not object_id:
                        continue
                    try:
                        request("DELETE", f"{kind}/{object_id}")
                        self.audit["cleanup"].append({"kind": kind, "id": object_id, "deleted": True})
                    except Exception:
                        self.audit["cleanup"].append({"kind": kind, "id": object_id, "deleted": False,
                                                      "warning": "Remote object may remain; delete this ID in the Soniox project."})
