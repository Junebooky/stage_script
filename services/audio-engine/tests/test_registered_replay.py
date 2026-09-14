from __future__ import annotations

import copy
import hashlib
import io
import json
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import registered_replay as replay


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    original_root = replay.REPO_ROOT
    for relative in ("data/replay-recordings/registry.json", "data/replay-recordings/R001-M05-2.profile.json", "data/replay-recordings/R001-M05-2.reference.json", "data/productions/decadence-gyeongseong/numbers/M05-2.json"):
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((original_root / relative).read_bytes())
    profile_path = tmp_path / "data/replay-recordings/R001-M05-2.profile.json"
    profile = json.loads(profile_path.read_text())
    audio = tmp_path / profile["sourceAudioPath"]
    audio.parent.mkdir(parents=True)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as source:
        source.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        source.writeframes(b"\0\0" * 16000)
    audio.write_bytes(buffer.getvalue())
    profile["sourceAudioSha256"] = hashlib.sha256(audio.read_bytes()).hexdigest()
    audit = {"provider": "groq/whisper-large-v3", "model": "whisper-large-v3", "originalSha256": profile["sourceAudioSha256"], "timelineOffsetMs": 0, "canonicalContextSent": False,
             "rawResult": {"segments": [{"text": "안녕 세상", "start": 0.05, "end": 0.06}], "words": [{"word": "안녕", "start": 0.01, "end": 0.04}, {"word": "세상", "start": 0.035, "end": 0.09}]},
             "must_not_cross_to_browser": "private-provider-request-audit"}
    artifact = tmp_path / profile["asrEvidenceSource"]["path"]
    write(artifact, audit)
    profile["asrEvidenceSource"]["sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    write(profile_path, profile)
    monkeypatch.setattr(replay, "REPO_ROOT", tmp_path)
    monkeypatch.setenv("STAGE_DATA_DIR", str(tmp_path / ".stage-data"))
    # A new ASR request would immediately fail this suite, never make a network call.
    monkeypatch.setattr("app.rehearsal.get_rehearsal_provider", lambda *args, **kwargs: pytest.fail("Replay attempted ASR"))
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50123)) as client:
        yield client, profile, audit, audio, artifact, profile_path


def test_read_only_registered_data_and_original_range_audio(fixture):
    client, profile, _, audio, artifact, _ = fixture
    before = (audio.read_bytes(), artifact.read_bytes())
    response = client.get("/replay-recordings/R001-M05-2")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["evidence"]["sourceWordCount"] == 2
    assert data["evidence"]["sourceSegmentCount"] == 1
    assert data["evidence"]["liveLatencyMeasured"] is False
    assert data["profile"]["sourceAudioSha256"] == profile["sourceAudioSha256"]
    assert "rawResult" not in response.text and "private-provider-request-audit" not in response.text
    assert "must_not_cross_to_browser" not in response.text
    full = client.get("/replay-recordings/R001-M05-2/audio")
    assert full.status_code == 200 and full.content == before[0]
    assert full.headers["cache-control"] == "no-store"
    ranged = client.get("/replay-recordings/R001-M05-2/audio", headers={"Range": "bytes=0-43"})
    assert ranged.status_code == 206 and ranged.content == before[0][:44]
    assert (audio.read_bytes(), artifact.read_bytes()) == before
    assert not (replay.REPO_ROOT / ".stage-data/rehearsals").exists()


def test_normalization_preserves_every_original_word_even_when_bounds_overlap(fixture):
    _, profile, audit, *_ = fixture
    evidence = replay.normalize_saved_evidence(audit, profile, 1000)
    span = evidence["transcript"][0]
    assert [(word["startMs"], word["endMs"]) for word in span["words"]] == [(10, 40), (35, 90)]
    assert all(word["confidence"] is None and word["confidenceBasis"] == "unavailable" for word in span["words"])
    assert span["startMs"] == 10 and span["endMs"] == 90
    assert span["providerMetadata"] == {"originalStartMs": 50, "originalEndMs": 60}
    assert len(evidence["warnings"]) == 1


@pytest.mark.parametrize("change", ["text", "word-count", "negative", "order", "offset", "context", "audio-hash"])
def test_invalid_evidence_fails_without_fabrication_or_fallback(fixture, change):
    _, profile, source, *_ = fixture
    audit = copy.deepcopy(source)
    if change == "text": audit["rawResult"]["segments"][0]["text"] = "다른 텍스트"
    elif change == "word-count": audit["rawResult"]["words"].append({"word": "extra", "start": 0.1, "end": 0.2})
    elif change == "negative": audit["rawResult"]["words"][0]["start"] = -1
    elif change == "order": audit["rawResult"]["words"][1]["end"] = 0.039
    elif change == "offset": audit["timelineOffsetMs"] = 100
    elif change == "context": audit["canonicalContextSent"] = True
    else: audit["originalSha256"] = "wrong"
    with pytest.raises(ValueError): replay.normalize_saved_evidence(audit, profile, 1000)


def test_unknown_id_paths_query_and_external_origin_are_rejected(fixture):
    client, *_ = fixture
    assert client.get("/replay-recordings/unknown").status_code == 404
    assert client.get("/replay-recordings/R001-M05-2?path=/etc/passwd").status_code == 400
    assert client.get("/replay-recordings/R001-M05-2", headers={"origin": "https://untrusted.example"}).status_code == 403
    assert client.get("/replay-recordings/R001-M05-2", headers={"host": "evil.example"}).status_code == 403
    assert client.post("/replay-recordings/R001-M05-2").status_code == 405
    assert client.put("/replay-recordings/R001-M05-2/audio").status_code == 405


def test_non_loopback_client_is_rejected(fixture):
    with TestClient(app, base_url="http://localhost", client=("192.0.2.9", 5000)) as client:
        assert client.get("/replay-recordings/R001-M05-2").status_code == 403


@pytest.mark.parametrize("target", ["audio", "asr", "canonical"])
def test_checksum_change_is_refused(fixture, target):
    client, _, _, audio, artifact, _ = fixture
    path = audio if target == "audio" else artifact if target == "asr" else replay.REPO_ROOT / "data/productions/decadence-gyeongseong/numbers/M05-2.json"
    path.write_bytes(path.read_bytes() + b" ")
    response = client.get("/replay-recordings/R001-M05-2")
    assert response.status_code == 409 and "SHA-256 mismatch" in response.text


def test_missing_artifact_is_actionable_and_no_reupload_or_asr(fixture):
    client, _, _, _, artifact, _ = fixture
    artifact.unlink()
    response = client.get("/replay-recordings/R001-M05-2")
    assert response.status_code == 409 and "No ASR request" in response.text


@pytest.mark.parametrize("path", ["/etc/passwd", "recordings/../../etc/passwd", "data/replay-recordings/registry.json"])
def test_trusted_registry_still_cannot_escape_recording_root(fixture, path):
    client, profile, _, _, _, profile_path = fixture
    profile["sourceAudioPath"] = path
    write(profile_path, profile)
    assert client.get("/replay-recordings/R001-M05-2/audio").status_code == 409


def test_symlink_outside_approved_root_is_rejected(fixture, tmp_path):
    client, _, _, audio, *_ = fixture
    payload = audio.read_bytes()
    audio.unlink()
    outside = tmp_path / "not-a-recording.wav"
    outside.write_bytes(payload)
    audio.symlink_to(outside)
    assert client.get("/replay-recordings/R001-M05-2/audio").status_code == 409


def test_bad_partition_and_fingerprint_are_rejected(fixture):
    client, profile, _, _, _, profile_path = fixture
    profile["absentCueIds"].append(profile["performedCueIds"][0])
    write(profile_path, profile)
    assert client.get("/replay-recordings/R001-M05-2").status_code == 409
    profile["absentCueIds"].pop()
    profile["canonicalFingerprint"] = "bad"
    write(profile_path, profile)
    assert client.get("/replay-recordings/R001-M05-2").status_code == 409
