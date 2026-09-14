"""Read-only, registered-ID replay. No ASR provider imports, uploads, or writes.

CLI number-analysis evidence is intentionally separate from uploaded rehearsals.
Only normalized words/text and explicit provenance cross to the local browser.
"""
from __future__ import annotations

import ipaddress
import json
import math
import re
import unicodedata
import wave
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from .inspection import sha256_file

REPO_ROOT = Path(__file__).resolve().parents[3]


def local_replay_request(request: Request) -> None:
    try:
        local_client = bool(request.client and ipaddress.ip_address(request.client.host).is_loopback)
    except ValueError:
        local_client = False
    if not local_client or request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise HTTPException(403, "Registered replay is available only on loopback")
    if request.query_params:
        raise HTTPException(400, "Replay accepts only a registered recording ID, not paths or query parameters")


router = APIRouter(prefix="/replay-recordings", dependencies=[Depends(local_replay_request)])


def trusted_path(relative: str, approved: str) -> Path:
    if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts or "\\" in relative:
        raise ValueError("Invalid registered replay path")
    path = (REPO_ROOT / relative).resolve()
    # Validate both the nominal namespace and the resolved target, including symlinks.
    root = REPO_ROOT.resolve() / approved
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Registered local replay file missing or outside its approved root; restore the registered local files. No ASR request was made.")
    return path


def read_registered(relative: str, approved: str) -> Any:
    return json.loads(trusted_path(relative, approved).read_text(encoding="utf-8"))


def registration(recording_id: str) -> tuple[dict, dict, Path]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", recording_id):
        raise HTTPException(404, "Unknown registered replay recording")
    registry = read_registered("data/replay-recordings/registry.json", "data/replay-recordings")
    item = next((entry for entry in registry["recordings"] if entry["id"] == recording_id), None)
    if item is None:
        raise HTTPException(404, "Unknown registered replay recording")
    profile = read_registered(item["profilePath"], "data/replay-recordings")
    if profile["recordingId"] != recording_id or profile["version"] != 1:
        raise ValueError("Registered recording identity mismatch")
    canonical_path = trusted_path(item["canonicalPath"], "data/productions")
    if sha256_file(canonical_path) != item["canonicalSha256"]:
        raise ValueError("Registered canonical SHA-256 mismatch; replay refused")
    canonical = json.loads(canonical_path.read_text(encoding="utf-8"))
    compact = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
    fingerprint = 2166136261
    for char in compact:
        # Mirror canonicalFingerprint's for-of + charCodeAt(0), including astral characters.
        unit = int.from_bytes(char.encode("utf-16-le")[:2], "little")
        fingerprint = ((fingerprint ^ unit) * 16777619) & 0xFFFFFFFF
    if canonical["id"] != profile["showId"] or f"{fingerprint:08x}" != profile["canonicalFingerprint"]:
        raise ValueError("Registered canonical fingerprint mismatch")
    numbers = [number for act in canonical["acts"] for number in act["numbers"] if number["id"] == profile["numberId"]]
    if len(numbers) != 1:
        raise ValueError("Registered number mismatch")
    ids = [cue["id"] for cue in numbers[0]["cues"]]
    partition = profile["performedCueIds"] + profile["absentCueIds"]
    if not profile["performedCueIds"] or len(set(partition)) != len(partition) or set(partition) != set(ids):
        raise ValueError("Invalid recording cue partition")
    audio = trusted_path(profile["sourceAudioPath"], "recordings")
    if audio.suffix.lower() != ".wav" or sha256_file(audio) != profile["sourceAudioSha256"]:
        raise ValueError("Registered original WAV SHA-256 mismatch; replay refused")
    return item, profile, audio


def normalize_saved_evidence(audit: dict, profile: dict, duration_ms: float) -> dict:
    """Group consecutive raw words by raw SEGMENT TEXT, never canonical/alignment.

    Some provider segment bounds overlap or exclude their own words. Keep every
    original word timestamp, use word envelopes for speech onsets, and report
    original provider bounds as provenance. No time interpolation or correction.
    """
    source = profile["asrEvidenceSource"]
    if (audit.get("provider") not in {source["provider"], f"{source['provider']}/{source['model']}"} or audit.get("model") != source["model"]
            or audit.get("originalSha256") != profile["sourceAudioSha256"]
            or audit.get("timelineOffsetMs") != 0 or audit.get("canonicalContextSent") is not False):
        raise ValueError("Saved ASR provenance or zero-offset mismatch")
    raw = audit["rawResult"]
    raw_words, raw_segments = raw["words"], raw["segments"]
    if not raw_words or not raw_segments:
        raise ValueError("Saved word and segment evidence is required; no automatic fallback")
    normalize = lambda text: "".join(char for char in unicodedata.normalize("NFC", text) if char.isalnum())
    words = []
    previous_end = 0.0
    for raw_word in raw_words:
        start, end = raw_word["start"] * 1000, raw_word["end"] * 1000
        text = raw_word["word"].strip()
        if not text or not all(math.isfinite(time) for time in (start, end)) or not 0 <= start <= end <= duration_ms + 1 or end < previous_end:
            raise ValueError("Invalid or non-monotonic saved word timestamps; no inferred replacements")
        previous_end = end
        words.append({"text": text, "startMs": start, "endMs": end, "confidence": None, "confidenceBasis": "unavailable"})
    cursor = 0
    transcript, warnings = [], []
    for index, segment in enumerate(raw_segments):
        expected = normalize(segment["text"])
        collected, observed = [], ""
        while len(observed) < len(expected) and cursor < len(words):
            word = words[cursor]
            collected.append(word)
            observed += normalize(word["text"])
            cursor += 1
        if not expected or expected != observed or not collected:
            raise ValueError("Saved segment/word text partition mismatch; replay refused rather than inventing evidence")
        start, end = min(word["startMs"] for word in collected), max(word["endMs"] for word in collected)
        provider_start, provider_end = segment["start"] * 1000, segment["end"] * 1000
        if start < provider_start - 1 or end > provider_end + 1:
            warnings.append(f"segment-{index}: original provider bounds do not contain its text-matched words; word timestamps unchanged")
        transcript.append({"id": f"saved-segment-{index}", "text": segment["text"].strip(),
                           "startMs": start, "endMs": end, "confidence": None, "confidenceBasis": "unavailable", "words": collected,
                           "providerMetadata": {"originalStartMs": provider_start, "originalEndMs": provider_end}})
    if cursor != len(words):
        raise ValueError("Unassigned saved words; replay refused")
    return {"version": 1, "recordingId": profile["recordingId"], "sourceAudioSha256": profile["sourceAudioSha256"],
            "sourceArtifactSha256": source["sha256"], "runId": source["runId"], "provider": source["provider"], "model": source["model"],
            "deliveryBasis": "saved-word-end-simulation", "liveLatencyMeasured": False, "wordConfidence": "unavailable",
            "sourceSegmentCount": len(raw_segments), "sourceWordCount": len(words),
            "derivation": "Consecutive raw words partitioned by exact normalized raw segment text (no canonical/reference input); original word timestamps unchanged, speech envelopes from those words. Delivery at word end is simulated, not measured ASR latency.",
            "warnings": warnings, "transcript": transcript}


def load_registered_replay(recording_id: str) -> dict:
    item, profile, audio = registration(recording_id)
    with wave.open(str(audio), "rb") as source_audio:
        duration_ms = source_audio.getnframes() / source_audio.getframerate() * 1000
    source = profile["asrEvidenceSource"]
    artifact = trusted_path(source["path"], ".stage-data/number-analysis")
    if sha256_file(artifact) != source["sha256"]:
        raise ValueError("Saved ASR SHA-256 mismatch; replay refused")
    evidence = normalize_saved_evidence(json.loads(artifact.read_text(encoding="utf-8")), profile, duration_ms)
    reference = read_registered(item["referencePath"], "data/replay-recordings")
    # Public, version-controlled metadata is explicitly whitelisted. The raw audit
    # (tokens, request metadata, x_groq, transport, etc.) is never returned.
    safe_profile = {key: profile[key] for key in ("version", "recordingId", "showId", "numberId", "canonicalFingerprint", "sourceAudioPath", "sourceAudioSha256", "performedCueIds", "absentCueIds", "omissionBasis")}
    safe_profile["asrEvidenceSource"] = {key: source[key] for key in ("kind", "runId", "provider", "model", "path", "sha256", "wordConfidence", "liveLatencyMeasured")}
    safe_profile["nonCanonicalEvents"] = [{key: event[key] for key in ("type", "startMs", "endMs", "text", "note")} for event in profile["nonCanonicalEvents"]]
    safe_reference = {key: reference[key] for key in ("version", "recordingId", "canonicalFingerprint", "quality", "basis", "provenance", "absentCueIds")}
    safe_reference["cues"] = [{key: cue[key] for key in ("cueId", "referenceStartMs", "warnings", "repeatGroup", "occurrence") if key in cue} for cue in reference["cues"]]
    return {"profile": safe_profile, "reference": safe_reference, "evidence": evidence, "durationMs": duration_ms, "audioBytes": audio.stat().st_size}


@router.get("/{recording_id}")
def replay_data(recording_id: str) -> dict:
    try:
        return load_registered_replay(recording_id)
    except (ValueError, KeyError, TypeError, OSError, wave.Error) as error:
        # Never expose arbitrary exception contents / private paths / raw audit.
        detail = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else "Registered replay data unavailable or invalid; restore the registered local files. No ASR request was made."
        raise HTTPException(409, detail) from None


@router.get("/{recording_id}/audio")
def replay_audio(recording_id: str) -> FileResponse:
    try:
        _, _, audio = registration(recording_id)
        return FileResponse(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})
    except (ValueError, KeyError, TypeError, OSError) as error:
        detail = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else "Registered original WAV unavailable or invalid"
        raise HTTPException(409, detail) from None


if __name__ == "__main__":
    # Read-only offline evaluator bridge. Takes an ID, never an arbitrary path.
    import argparse
    parser = argparse.ArgumentParser(description="Load registered saved replay evidence; no ASR calls")
    parser.add_argument("recording_id")
    args = parser.parse_args()
    print(json.dumps(load_registered_replay(args.recording_id), ensure_ascii=False, allow_nan=False))
