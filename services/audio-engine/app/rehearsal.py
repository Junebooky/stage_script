"""Local raw-audio jobs and immutable analysis/calibration artifacts.

Raw recordings are deliberately not part of the canonical show. Each upload has
its own generated directory; user filenames are metadata, never filesystem paths.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import FileResponse

from .adapters.local import claim_local_runtime, release_local_runtime
from .rehearsal_providers import DEFAULT_PROVIDER, UNAVAILABLE_ERRORS, CloudConsentRequired, get_rehearsal_provider, provider_metadata, provider_audit, cleanup_warning
from .inspection import inspect_wav, sha256_file

router = APIRouter()
ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")
SUPPORTED_EXTENSIONS = {".wav", ".flac", ".m4a", ".mp3"}


def storage_root() -> Path:
    root = Path(os.environ.get("STAGE_DATA_DIR", str(Path(__file__).resolve().parents[3] / ".stage-data")))
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def artifact_path(kind: str, identifier: str, filename: str) -> Path:
    if kind == "profiles":
        if not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 200:
            raise HTTPException(400, "Invalid show identifier")
        # Authored show IDs may be Korean or contain punctuation. They are never paths.
        identifier = hashlib.sha256(identifier.encode("utf-8")).hexdigest()
    elif not ID_PATTERN.fullmatch(identifier):
        raise HTTPException(400, "Invalid artifact identifier")
    return storage_root() / kind / identifier / filename


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path) -> Any:
    if not path.is_file():
        raise HTTPException(404, "Artifact not found")
    return json.loads(path.read_text(encoding="utf-8"))


async def bounded_json(request: Request) -> dict[str, Any]:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 20 * 1024 * 1024:
            raise HTTPException(413, "Analysis JSON must be at most 20 MiB")
    try:
        result = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise HTTPException(400, "Invalid JSON") from error
    if not isinstance(result, dict):
        raise HTTPException(400, "Expected a JSON object")
    return result


async def transcribe_rehearsal(identifier: str) -> None:
    manifest_path = artifact_path("rehearsals", identifier, "manifest.json")
    manifest = read_json(manifest_path)
    manifest.update(status="transcribing", startedAt=time.time() * 1000)
    write_json(manifest_path, manifest)
    claimed = False
    provider = None
    try:
        selected = manifest.get("asrProvider", "local")  # Legacy jobs were local.
        metadata = provider_metadata(selected)
        if metadata["kind"] == "local":
            claim_local_runtime("rehearsal")
            claimed = True
        audio = manifest_path.parent / manifest["storedFilename"]
        before = await asyncio.to_thread(sha256_file, audio)
        if audio.suffix.lower() == ".wav":
            inspection = await asyncio.to_thread(inspect_wav, audio)
            write_json(manifest_path.parent / "inspection.json", inspection)
            manifest["durationMs"] = inspection["durationMs"]
        provider = await asyncio.to_thread(get_rehearsal_provider, selected, manifest.get("cloudUploadAuthorized") is True)
        began = time.perf_counter()
        transcript = await asyncio.to_thread(
            provider.transcribe, str(audio), words=True,
        )
        if await asyncio.to_thread(sha256_file, audio) != before:
            raise ValueError("Original audio changed during transcription")
        # Acoustic timestamps originate in ASR, not in canonical show text.
        elapsed = (time.perf_counter() - began) * 1000
        result = {"rehearsalId": identifier, "provider": provider.name, "model": metadata["model"], "asrProvider": selected,
                  "transcriptionWallTimeMs": elapsed, "audioSha256": before, "liveLatencyMeasured": False,
                  "timestampBasis": getattr(provider, "timestamp_basis", "local-asr-pseudo"), "transcript": transcript}
        write_json(manifest_path.parent / "transcript.json", result)
        manifest.update(status="complete", provider=provider.name, model=metadata["model"], transcriptionWallTimeMs=elapsed, completedAt=time.time() * 1000,
                        transcriptCount=len(transcript), lastSpeechEndMs=max((item["endMs"] for item in transcript), default=0))
    except Exception as error:
        manifest.update(status="failed", error=str(error), completedAt=time.time() * 1000)
    finally:
        audit = provider_audit(provider)
        if audit is not None:
            write_json(manifest_path.parent / "external-asr.json", audit)
            manifest["externalCleanup"] = audit.get("cleanup", [])
        if warning := cleanup_warning(audit):
            manifest["warning"] = warning
        if claimed:
            release_local_runtime("rehearsal")
    write_json(manifest_path, manifest)


def recover_interrupted_jobs() -> None:
    """A process restart must not leave the operator polling a dead job forever."""
    for path in (storage_root() / "rehearsals").glob("*/manifest.json"):
        manifest = read_json(path)
        if manifest.get("status") in {"queued", "transcribing", "uploading"}:
            manifest.update(status="failed", error="Audio backend restarted during this job; original audio was retained. Retry analysis.")
            write_json(path, manifest)


@router.post("/rehearsals", status_code=202)
async def upload_rehearsal(request: Request, background: BackgroundTasks,
                           filename: str, showId: str = "", numberId: str | None = None,
                           provider: str = DEFAULT_PROVIDER, allowCloudUpload: bool = False) -> dict[str, Any]:
    # Fail before accepting private audio if the chosen provider isn't ready.
    await check_rehearsal_provider(provider, allowCloudUpload)
    metadata = provider_metadata(provider)
    if numberId is not None:
        profile_namespace(showId, numberId)
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(415, "Supported rehearsal audio: WAV, FLAC, M4A, MP3")
    identifier = uuid.uuid4().hex
    target = artifact_path("rehearsals", identifier, f"recording{extension}")
    target.parent.mkdir(parents=True, exist_ok=True)
    maximum = int(os.environ.get("STAGE_MAX_AUDIO_BYTES", str(2 * 1024**3)))
    size, checksum = 0, hashlib.sha256()
    manifest = {"id": identifier, "filename": Path(filename).name, "showId": showId, "numberId": numberId,
                "asrProvider": provider, "model": metadata["model"], "providerDisplayName": metadata["displayName"],
                "cloudUploadAuthorized": metadata["requiresCloudConsent"] and allowCloudUpload,
                "storedFilename": target.name, "status": "uploading", "createdAt": time.time() * 1000}
    manifest_path = target.parent / "manifest.json"
    write_json(manifest_path, manifest)
    try:
        with target.open("xb") as recording:
            async for chunk in request.stream():
                size += len(chunk)
                if size > maximum:
                    raise HTTPException(413, "Recording exceeds configured local upload limit")
                recording.write(chunk)
                checksum.update(chunk)
        if size == 0:
            raise HTTPException(400, "Recording is empty")
    except Exception as error:
        # Keep a recoverable failed-upload manifest, not an invisible orphan.
        manifest.update(status="failed", error=str(error), bytes=size)
        write_json(manifest_path, manifest)
        raise
    manifest.update(status="queued", bytes=size, sha256=checksum.hexdigest())
    write_json(manifest_path, manifest)
    background.add_task(transcribe_rehearsal, identifier)
    return manifest


@router.get("/rehearsals")
async def list_rehearsals(showId: str | None = None, numberId: str | None = None) -> list[dict[str, Any]]:
    manifests = [read_json(path) for path in (storage_root() / "rehearsals").glob("*/manifest.json")]
    return sorted((item for item in manifests if (showId is None or item.get("showId") == showId)
                   and (numberId is None or item.get("numberId") == numberId)),
                  key=lambda item: item["createdAt"], reverse=True)


@router.get("/rehearsals/{identifier}")
async def get_rehearsal(identifier: str) -> dict[str, Any]:
    return read_json(artifact_path("rehearsals", identifier, "manifest.json"))


@router.post("/rehearsals/{identifier}/retry", status_code=202)
async def retry_rehearsal(identifier: str, background: BackgroundTasks) -> dict[str, Any]:
    path = artifact_path("rehearsals", identifier, "manifest.json")
    manifest = read_json(path)
    if manifest["status"] != "failed":
        raise HTTPException(409, "Only failed jobs can be retried")
    filename = manifest.get("storedFilename", "")
    if filename not in {f"recording{extension}" for extension in SUPPORTED_EXTENSIONS} or not (path.parent / filename).is_file():
        raise HTTPException(409, "Original recording is unavailable; upload again")
    await check_rehearsal_provider(manifest.get("asrProvider", "local"), manifest.get("cloudUploadAuthorized") is True)
    manifest.update(status="queued", error=None)
    write_json(path, manifest)
    background.add_task(transcribe_rehearsal, identifier)
    return manifest


async def check_rehearsal_provider(provider: str, allow_cloud_upload: bool) -> None:
    try:
        await asyncio.to_thread(get_rehearsal_provider, provider, allow_cloud_upload)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except CloudConsentRequired as error:
        raise HTTPException(403, str(error)) from error
    except UNAVAILABLE_ERRORS as error:
        raise HTTPException(503, str(error)) from error


@router.get("/rehearsals/{identifier}/result")
async def rehearsal_result(identifier: str) -> dict[str, Any]:
    manifest = read_json(artifact_path("rehearsals", identifier, "manifest.json"))
    if manifest["status"] != "complete":
        raise HTTPException(409, "Transcription has not completed")
    return {"manifest": manifest, **read_json(artifact_path("rehearsals", identifier, "transcript.json"))}


@router.get("/rehearsals/{identifier}/audio")
async def rehearsal_audio(identifier: str) -> FileResponse:
    manifest_path = artifact_path("rehearsals", identifier, "manifest.json")
    manifest = read_json(manifest_path)
    filename = manifest.get("storedFilename", "")
    if filename not in {f"recording{extension}" for extension in SUPPORTED_EXTENSIONS}:
        raise HTTPException(400, "Invalid stored recording")
    path = manifest_path.parent / filename
    if not path.is_file():
        raise HTTPException(404, "Recording not found")
    mime = {".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp3": "audio/mpeg"}
    return FileResponse(path, media_type=mime[path.suffix], filename=manifest.get("filename", filename), content_disposition_type="inline")


@router.put("/rehearsals/{identifier}/analysis")
async def save_analysis(identifier: str, request: Request) -> dict[str, Any]:
    manifest = read_json(artifact_path("rehearsals", identifier, "manifest.json"))
    if manifest["status"] != "complete":
        raise HTTPException(409, "Transcription must complete before analysis")
    analysis = await bounded_json(request)
    if analysis.get("rehearsalId") != identifier or not isinstance(analysis.get("observations"), list):
        raise HTTPException(400, "Analysis needs matching rehearsalId and observations")
    if manifest.get("showId") and analysis.get("showId") != manifest["showId"]:
        raise HTTPException(400, "Analysis belongs to a different show")
    if manifest.get("numberId") and (analysis.get("numberId") != manifest["numberId"] or analysis.get("alignmentMode") != "known-number-local"):
        raise HTTPException(400, "Known-number audio requires matching number-local analysis")
    # Historical revisions remain available for audit/review; current points to the latest.
    revision = uuid.uuid4().hex
    write_json(artifact_path("rehearsals", identifier, f"analysis-{revision}.json"), analysis)
    write_json(artifact_path("rehearsals", identifier, "analysis.json"), analysis)
    return {"saved": True, "revision": revision}


@router.get("/rehearsals/{identifier}/analysis")
async def get_analysis(identifier: str) -> dict[str, Any]:
    return read_json(artifact_path("rehearsals", identifier, "analysis.json"))


def profile_namespace(show_id: str, number_id: str | None = None) -> str:
    if number_id is None:
        return show_id  # Backward-compatible whole-show profile namespace.
    if not isinstance(show_id, str) or not show_id.strip() or len(show_id) > 200 or not isinstance(number_id, str) or not ID_PATTERN.fullmatch(number_id):
        raise HTTPException(400, "Invalid number profile scope")
    return "number-" + hashlib.sha256((show_id + "\0" + number_id).encode("utf-8")).hexdigest()


@router.get("/profiles")
async def get_profiles(showId: str, numberId: str | None = None) -> dict[str, Any]:
    root = artifact_path("profiles", profile_namespace(showId, numberId), "champion.json").parent
    champion = read_json(root / "champion.json") if (root / "champion.json").is_file() else None
    challengers = [read_json(path) for path in root.glob("challenger-*.json")]
    return {"champion": champion, "challengers": sorted(challengers, key=lambda item: item["createdAt"], reverse=True)}


@router.post("/profiles/challengers", status_code=201)
async def save_challenger(request: Request) -> dict[str, Any]:
    candidate = await bounded_json(request)
    show_id = candidate.get("showId")
    if not isinstance(show_id, str) or not isinstance(candidate.get("profiles"), list) or not isinstance(candidate.get("evaluation"), dict) or not isinstance(candidate.get("canonicalFingerprint"), str):
        raise HTTPException(400, "Challenger needs showId, canonicalFingerprint, profiles and evaluation")
    validate_profiles(candidate["profiles"])
    number_id = candidate.get("numberId")
    scope = profile_namespace(show_id, number_id)
    identifier = uuid.uuid4().hex
    analysis_hashes = {}
    for manifest in await list_rehearsals(show_id, number_id):
        path = artifact_path("rehearsals", manifest["id"], "analysis.json")
        if path.is_file():
            analysis_hashes[manifest["id"]] = hashlib.sha256(path.read_bytes()).hexdigest()
    candidate["analysisHashes"] = analysis_hashes
    candidate.update(id=identifier, createdAt=time.time() * 1000, promoted=False)
    write_json(artifact_path("profiles", scope, f"challenger-{identifier}.json"), candidate)
    return candidate


def validate_profiles(profiles: list[Any]) -> None:
    ids = set()

    def numeric(value, maximum=float("inf")):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= maximum

    for profile in profiles:
        if not isinstance(profile, dict) or not isinstance(profile.get("cueId"), str) or not profile["cueId"].strip() or profile["cueId"] in ids:
            raise HTTPException(400, "Invalid or duplicate profile cueId")
        ids.add(profile["cueId"])
        anchors, timing, thresholds, fallback = (profile.get(field) for field in ("anchors", "timing", "thresholds", "fallback"))
        if not isinstance(anchors, list) or any(not isinstance(anchor, dict) or not isinstance(anchor.get("text"), str) or not anchor["text"].strip() or not numeric(anchor.get("reliability"), 1) for anchor in anchors):
            raise HTTPException(400, "Invalid profile anchors")
        if not isinstance(timing, dict) or any(not numeric(timing.get(field)) for field in ("medianAfterPreviousMs", "earlyToleranceMs", "lateToleranceMs", "varianceMs2")):
            raise HTTPException(400, "Invalid profile relative timing")
        if not isinstance(thresholds, dict) or any(not numeric(thresholds.get(field), 1) for field in ("text", "fallback")):
            raise HTTPException(400, "Invalid profile thresholds")
        if not isinstance(fallback, dict) or not isinstance(fallback.get("enabled"), bool) or not numeric(profile.get("sampleCount")) or int(profile["sampleCount"]) != profile["sampleCount"] or not numeric(profile.get("confidence"), 1):
            raise HTTPException(400, "Invalid profile fallback, sample count or confidence")


def strict_promotion_reasons(evaluation: dict[str, Any], historical_ids: set[str]) -> list[str]:
    """Defense in depth; a UI recommendation alone cannot overwrite champion."""
    reasons = []
    rows = evaluation.get("replays", [])
    if not isinstance(rows, list):
        return ["Invalid replay report"]
    replay_ids = {row.get("rehearsalId") for row in rows if isinstance(row, dict)}
    if not historical_ids or replay_ids != historical_ids or len(rows) != len(historical_ids):
        reasons.append("Every historical rehearsal for this show must be replayed exactly once")
    if evaluation.get("recommended") is not True:
        reasons.append("Challenger is not recommended by the regression gate")
    if len(historical_ids) < 3:
        reasons.append("At least three historical rehearsals are required")
    improved = False
    for row in rows:
        if not isinstance(row, dict):
            reasons.append("Invalid replay report")
            continue
        champion, challenger = row.get("champion", {}), row.get("challenger", {})
        if not isinstance(champion, dict) or not isinstance(challenger, dict):
            reasons.append("Invalid metrics")
            continue
        if challenger.get("reviewRequired", 1) != 0:
            reasons.append("Unresolved review-required observations")
        if challenger.get("evaluatedCues", 0) <= 0:
            reasons.append("No evaluable cues")
        for field in ("wrongTriggers", "earlyTriggers", "missedCues", "lateTriggers", "manualInterventions", "fallbackTriggers"):
            before, after = champion.get(field), challenger.get(field)
            if not isinstance(before, (int, float)) or not isinstance(after, (int, float)) or not math.isfinite(before) or not math.isfinite(after) or after > before:
                reasons.append(f"Regression or missing metric: {field}")
            elif after < before:
                improved = True
        for field in ("latencyP50Ms", "latencyP95Ms", "recoveryTimeMs", "imageEntryErrorMs", "imageExitErrorMs"):
            before, after = champion.get(field), challenger.get(field)
            if before is None and after is None:
                continue
            if not isinstance(before, (int, float)) or not isinstance(after, (int, float)) or not math.isfinite(before) or not math.isfinite(after) or after > before:
                reasons.append(f"Regression or missing metric: {field}")
            elif after < before:
                improved = True
        before, after = champion.get("cueAccuracy"), challenger.get("cueAccuracy")
        if not isinstance(before, (int, float)) or not isinstance(after, (int, float)) or not 0 <= before <= 1 or not 0 <= after <= 1 or after < before:
            reasons.append("Cue accuracy regressed")
        elif after > before:
            improved = True
    if not improved:
        reasons.append("No measurable improvement over the current champion")
    return list(dict.fromkeys(reasons))


@router.post("/profiles/{identifier}/promote")
async def promote_profile(identifier: str, request: Request) -> dict[str, Any]:
    body = await bounded_json(request)
    if body.get("confirmed") is not True or not isinstance(body.get("operator"), str) or not body["operator"].strip():
        raise HTTPException(400, "Explicit operator confirmation and name are required")
    show_id = body.get("showId", "")
    scope = profile_namespace(show_id, body.get("numberId"))
    candidate_path = artifact_path("profiles", scope, f"challenger-{identifier}.json")
    if not ID_PATTERN.fullmatch(identifier):
        raise HTTPException(400, "Invalid challenger identifier")
    candidate = read_json(candidate_path)
    historical = await list_rehearsals(show_id, candidate.get("numberId"))
    historical_ids = {item["id"] for item in historical if item["status"] == "complete"}
    reasons = strict_promotion_reasons(candidate["evaluation"], historical_ids)
    replay_rows = candidate["evaluation"].get("replays", [])
    for rehearsal_id in historical_ids:
        path = artifact_path("rehearsals", rehearsal_id, "analysis.json")
        if not path.is_file():
            reasons.append("All historical recordings need completed analysis")
            continue
        analysis = read_json(path)
        if analysis.get("canonicalFingerprint") != candidate["canonicalFingerprint"]:
            reasons.append("Canonical show revision changed; reanalyze and replay")
        if candidate.get("analysisHashes", {}).get(rehearsal_id) != hashlib.sha256(path.read_bytes()).hexdigest():
            reasons.append("A rehearsal analysis/review changed after evaluation; replay the challenger")
        row = next((row for row in replay_rows if isinstance(row, dict) and row.get("rehearsalId") == rehearsal_id), {})
        if row.get("analysisCreatedAt") != analysis.get("createdAt") or row.get("analysisRevision") != analysis.get("revision", 0):
            reasons.append("Replay used a stale analysis revision; replay the challenger")
    if reasons:
        raise HTTPException(409, {"status": "PROMOTION BLOCKED", "reasons": reasons})
    champion_path = artifact_path("profiles", scope, "champion.json")
    current = read_json(champion_path) if champion_path.is_file() else None
    if candidate.get("championId") != (current.get("id") if current else None):
        raise HTTPException(409, "Champion changed; replay the challenger against the current champion")
    if current:
        write_json(champion_path.parent / f"archived-{current['id']}.json", current)
    candidate.update(promoted=True, promotedAt=time.time() * 1000, operator=body["operator"].strip())
    write_json(champion_path, candidate)
    write_json(candidate_path, candidate)
    return candidate
