from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.rehearsal import artifact_path, read_json, strict_promotion_reasons, write_json
from test_local import wav_bytes


class FixtureProvider:
    name = "deterministic-test-provider-not-production"

    def transcribe(self, audio, *, words=False):
        assert Path(audio).is_file()
        return [{"id": "0", "text": "무대가 열린다", "startMs": 100, "endMs": 1200, "confidence": 0.95}]


@pytest.fixture
def local_client(tmp_path, monkeypatch):
    monkeypatch.setenv("STAGE_DATA_DIR", str(tmp_path / "private-recordings"))
    monkeypatch.setattr("app.rehearsal_providers.get_local_provider", lambda: FixtureProvider())
    with TestClient(app) as client:
        yield client


def upload(client):
    response = client.post("/rehearsals?provider=local&filename=original.wav&showId=fixture-show", content=wav_bytes(), headers={"Content-Type": "audio/wav"})
    assert response.status_code == 202
    return response.json()["id"]


def test_raw_audio_upload_transcribe_poll_result_and_review_audio(local_client) -> None:
    identifier = upload(local_client)
    manifest = local_client.get(f"/rehearsals/{identifier}").json()
    assert manifest["status"] == "complete"
    assert manifest["filename"] == "original.wav"
    assert len(manifest["sha256"]) == 64
    assert local_client.get("/rehearsals?showId=fixture-show").json()[0]["id"] == identifier
    assert local_client.get("/rehearsals?showId=other-show").json() == []
    result = local_client.get(f"/rehearsals/{identifier}/result").json()
    assert result["transcript"][0]["text"] == "무대가 열린다"
    assert result["timestampBasis"] == "local-asr-pseudo"
    audio = local_client.get(f"/rehearsals/{identifier}/audio")
    assert audio.content == wav_bytes()
    assert audio.headers["content-type"] == "audio/wav"
    ranged = local_client.get(f"/rehearsals/{identifier}/audio", headers={"Range": "bytes=0-43"})
    assert ranged.status_code == 206
    assert len(ranged.content) == 44


def test_known_number_history_analysis_and_profiles_never_mix(local_client):
    ids = []
    for number in ("test-one", "test-two"):
        response = local_client.post(f"/rehearsals?provider=local&filename=original.wav&showId=fixture-show&numberId={number}", content=wav_bytes())
        assert response.status_code == 202
        identifier = response.json()["id"]
        ids.append(identifier)
        analysis = {"rehearsalId": identifier, "showId": "fixture-show", "numberId": number,
                    "alignmentMode": "known-number-local", "canonicalFingerprint": "fixture", "observations": []}
        assert local_client.put(f"/rehearsals/{identifier}/analysis", json={**analysis, "numberId": "wrong"}).status_code == 400
        assert local_client.put(f"/rehearsals/{identifier}/analysis", json=analysis).status_code == 200
        candidate = {"showId": "fixture-show", "numberId": number, "canonicalFingerprint": "fixture", "profiles": [], "evaluation": {"recommended": False}}
        assert local_client.post("/profiles/challengers", json=candidate).status_code == 201
    for number, identifier in zip(("test-one", "test-two"), ids):
        history = local_client.get(f"/rehearsals?showId=fixture-show&numberId={number}").json()
        assert [item["id"] for item in history] == [identifier]
        store = local_client.get(f"/profiles?showId=fixture-show&numberId={number}").json()
        assert len(store["challengers"]) == 1
        assert store["challengers"][0]["numberId"] == number
        assert set(store["challengers"][0]["analysisHashes"]) == {identifier}
        assert store["champion"] is None
    assert local_client.get("/profiles?showId=fixture-show").json()["challengers"] == []


def test_external_upload_rejects_missing_consent_and_key_before_storing_audio(local_client, monkeypatch):
    monkeypatch.delenv("SONIOX_API_KEY", raising=False)
    endpoint = "/rehearsals?filename=private.wav&showId=fixture-show&provider=soniox"
    assert local_client.post(endpoint, content=wav_bytes()).status_code == 403
    response = local_client.post(endpoint + "&allowCloudUpload=true", content=wav_bytes())
    assert response.status_code == 503 and "SONIOX_API_KEY" in response.json()["detail"]
    assert local_client.get("/rehearsals").json() == []


def test_analysis_is_separate_and_revisions_persist_without_touching_raw_audio(local_client) -> None:
    identifier = upload(local_client)
    path = artifact_path("rehearsals", identifier, "recording.wav")
    before = path.read_bytes()
    analysis = {"rehearsalId": identifier, "showId": "fixture-show", "observations": [], "canonicalFingerprint": "fixture"}
    assert local_client.put(f"/rehearsals/{identifier}/analysis", json=analysis).status_code == 200
    assert local_client.put(f"/rehearsals/{identifier}/analysis", json=analysis).status_code == 200
    assert len(list(path.parent.glob("analysis-*.json"))) == 2
    assert local_client.get(f"/rehearsals/{identifier}/analysis").json() == analysis
    assert path.read_bytes() == before
    assert local_client.put(f"/rehearsals/{identifier}/analysis", json={**analysis, "showId": "wrong"}).status_code == 400


def test_upload_rejects_missing_model_invalid_format_empty_and_oversize(local_client, monkeypatch) -> None:
    assert local_client.post("/rehearsals?provider=local&filename=notes.txt", content=b"text").status_code == 415
    assert local_client.post("/rehearsals?provider=local&filename=empty.wav", content=b"").status_code == 400
    monkeypatch.setenv("STAGE_MAX_AUDIO_BYTES", "10")
    assert local_client.post("/rehearsals?provider=local&filename=big.wav", content=wav_bytes()).status_code == 413
    monkeypatch.delenv("STAGE_LOCAL_MODEL_DIR", raising=False)
    from app.adapters.local import get_local_provider
    monkeypatch.setattr("app.rehearsal_providers.get_local_provider", get_local_provider)
    assert local_client.post("/rehearsals?provider=local&filename=audio.wav", content=wav_bytes()).status_code == 503


def metric(**overrides):
    return {"evaluatedCues": 10, "reviewRequired": 0, "cueAccuracy": 0.9, "missedCues": 1,
            "wrongTriggers": 0, "earlyTriggers": 0, "lateTriggers": 0, "manualInterventions": 0,
            "fallbackTriggers": 0, "latencyP50Ms": 200, "latencyP95Ms": 500, "recoveryTimeMs": None,
            "imageEntryErrorMs": None, "imageExitErrorMs": None, **overrides}


def test_strict_gate_rejects_missing_history_review_and_any_false_trigger_regression() -> None:
    report = {"recommended": True, "replays": [{"rehearsalId": "one", "champion": metric(), "challenger": metric()}]}
    assert strict_promotion_reasons(report, {"one", "two"})
    report["replays"][0]["challenger"] = metric(wrongTriggers=1)
    assert any("wrongTriggers" in reason for reason in strict_promotion_reasons(report, {"one"}))
    report["replays"][0]["challenger"] = metric(reviewRequired=1)
    assert any("review" in reason for reason in strict_promotion_reasons(report, {"one"}))


def test_challenger_does_not_replace_champion_until_operator_confirms_all_history(local_client) -> None:
    identifiers = [upload(local_client) for _ in range(3)]
    for identifier in identifiers:
        assert local_client.put(f"/rehearsals/{identifier}/analysis", json={
            "rehearsalId": identifier, "showId": "fixture-show", "observations": [],
            "canonicalFingerprint": "fixture", "createdAt": 100, "revision": 0,
        }).status_code == 200
    evaluation = {"recommended": True, "reasons": [], "evidence": "pseudo", "replays": [
        {"rehearsalId": identifier, "analysisCreatedAt": 100, "analysisRevision": 0,
         "champion": metric(), "challenger": metric(cueAccuracy=1, missedCues=0)} for identifier in identifiers]}
    candidate = local_client.post("/profiles/challengers", json={"showId": "fixture-show", "championId": None,
        "canonicalFingerprint": "fixture", "profiles": [], "evaluation": evaluation}).json()
    assert local_client.get("/profiles?showId=fixture-show").json()["champion"] is None
    url = f"/profiles/{candidate['id']}/promote"
    assert local_client.post(url, json={"showId": "fixture-show"}).status_code == 400
    approved = local_client.post(url, json={"showId": "fixture-show", "confirmed": True, "operator": "Stage manager"})
    assert approved.status_code == 200
    assert approved.json()["promoted"] is True
    assert local_client.get("/profiles?showId=fixture-show").json()["champion"]["id"] == candidate["id"]
    # A new rehearsal invalidates an old evaluation even if the UI had cached it.
    upload(local_client)
    assert local_client.post(url, json={"showId": "fixture-show", "confirmed": True, "operator": "Stage manager"}).status_code == 409


def test_local_recording_paths_cannot_be_injected_via_filenames_or_manifest(local_client) -> None:
    response = local_client.post("/rehearsals?provider=local&filename=../../private.wav&showId=fixture-show", content=wav_bytes())
    identifier = response.json()["id"]
    manifest_path = artifact_path("rehearsals", identifier, "manifest.json")
    manifest = read_json(manifest_path)
    assert manifest["storedFilename"] == "recording.wav"
    assert manifest["filename"] == "private.wav"
    manifest["storedFilename"] = "../../outside.wav"
    write_json(manifest_path, manifest)
    assert local_client.get(f"/rehearsals/{identifier}/audio").status_code == 400
