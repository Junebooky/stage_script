"""Deterministic Groq contract fixtures; no external requests or real credentials."""
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters.groq import GroqASRError, GroqProvider, normalize_verbose
from app.adapters.soniox import ExternalASRUnavailable, SonioxProvider
from app.inspection import sha256_file
from app.main import app
from app.rehearsal_cli import analyze_audio
from app.rehearsal_providers import CloudConsentRequired, get_rehearsal_provider, provider_metadata
from test_inspection import make_wav

TEST_CREDENTIAL = "test-only-not-a-real-credential"


def verbose():
    return {"text": "어두운 숲이여 길을 열어 주오", "language": "korean", "duration": 3.5,
        "x_groq": {"id": "request-fixture"},
        "segments": [{"id": 0, "text": "어두운 숲이여", "start": 0.1, "end": 1.5, "avg_logprob": -0.2,
                      "no_speech_prob": 0.01, "compression_ratio": 1.2},
                     {"id": 1, "text": "길을 열어 주오", "start": 2, "end": 3.5}],
        "words": [{"word": "어두운", "start": 0.1, "end": 0.7}, {"word": "숲이여", "start": 0.8, "end": 1.5},
                  {"word": "길을", "start": 2, "end": 2.4}, {"word": "열어", "start": 2.5, "end": 2.8}, {"word": "주오", "start": 3, "end": 3.5}]}


@pytest.fixture
def audio(tmp_path):
    path = tmp_path / "private original.wav"
    make_wav(path)
    return path


def provider(monkeypatch, handler):
    monkeypatch.setenv("GROQ_API_KEY", TEST_CREDENTIAL)
    return GroqProvider(allow_cloud_upload=True, transport=httpx.MockTransport(handler))


def test_missing_credentials_and_consent_make_no_request(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(ExternalASRUnavailable, match="NOT AUTHORIZED"):
        GroqProvider(allow_cloud_upload=False)
    with pytest.raises(ExternalASRUnavailable, match="GROQ ASR UNAVAILABLE"):
        GroqProvider(allow_cloud_upload=True)


def test_verbose_korean_times_metadata_and_missing_confidence():
    spans = normalize_verbose(verbose())
    assert spans[0]["text"] == "어두운 숲이여"
    assert spans[0]["startMs"] == 100 and spans[0]["endMs"] == 1500
    assert spans[0]["confidence"] == math.exp(-0.2)
    assert spans[0]["confidenceBasis"] == "segment-logprob-derived"
    assert spans[0]["providerMetadata"]["no_speech_prob"] == 0.01
    assert spans[0]["providerMetadata"]["avg_logprob"] == -0.2
    assert spans[0]["words"][0]["text"] == "어두운"
    assert all(word["confidence"] is None and word["confidenceBasis"] == "unavailable" for span in spans for word in span["words"])
    assert spans[1]["confidence"] is None and spans[1]["confidenceBasis"] == "unavailable"


def test_crossing_word_times_are_not_changed_to_fit_the_segment():
    result = verbose()
    result["words"][0]["end"] = 1.6
    span = normalize_verbose(result)[0]
    assert "words" not in span and "wordTimingWarning" in span["providerMetadata"]
    assert span["startMs"] == 100 and span["endMs"] == 1500


def test_actual_multipart_contract_and_immutable_original(audio, monkeypatch):
    before = sha256_file(audio)
    requests = []
    def handler(request):
        requests.append(request)
        assert request.url == "https://api.groq.com/openai/v1/audio/transcriptions"
        assert request.method == "POST"
        assert request.headers["authorization"] == f"Bearer {TEST_CREDENTIAL}"
        body = request.read()
        for value in (b"whisper-large-v3", b"verbose_json", b'name="language"\r\n\r\nko', b'name="temperature"\r\n\r\n0'):
            assert value in body
        assert body.count(b'name="timestamp_granularities[]"') == 2
        assert b"word" in body and b"segment" in body
        assert b'name="prompt"' not in body and b"M05-2" not in body
        assert b"private original" not in body and b'filename="recording.wav"' in body
        assert audio.read_bytes() in body
        return httpx.Response(200, json=verbose(), headers={"x-request-id": "fixture-id"})
    instance = provider(monkeypatch, handler)
    assert instance.transcribe(str(audio))[1]["text"] == "길을 열어 주오"
    assert len(requests) == 1 and sha256_file(audio) == before
    assert instance.audit["attempts"][0]["requestId"] == "fixture-id"
    assert instance.audit["xGroq"] == {"id": "request-fixture"}
    assert instance.audit["remoteDeletion"] == "not-exposed-by-transcription-endpoint"
    assert TEST_CREDENTIAL not in json.dumps(instance.audit)


@pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
def test_error_responses_never_echo_secrets_or_retry(audio, monkeypatch, status):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": f"Authorization: Bearer {TEST_CREDENTIAL}"}})
    instance = provider(monkeypatch, handler)
    with pytest.raises(GroqASRError, match=f"HTTP {status}") as error:
        instance.transcribe(str(audio))
    assert TEST_CREDENTIAL not in str(error.value)
    assert TEST_CREDENTIAL not in json.dumps(instance.audit)
    assert len(calls) == 1 and instance.raw_result is None


@pytest.mark.parametrize("exception", [httpx.ReadTimeout, httpx.ConnectError])
def test_network_failures_never_echo_secret(audio, monkeypatch, exception):
    def handler(request):
        raise exception(TEST_CREDENTIAL, request=request)
    instance = provider(monkeypatch, handler)
    with pytest.raises(GroqASRError) as error:
        instance.transcribe(str(audio))
    assert TEST_CREDENTIAL not in str(error.value) and instance.audit["originalUnchanged"]


def test_unexpected_success_metadata_is_redacted(audio, monkeypatch):
    result = verbose()
    result["x_groq"] = {"id": TEST_CREDENTIAL, "authorization": TEST_CREDENTIAL}
    instance = provider(monkeypatch, lambda _: httpx.Response(200, json=result))
    instance.transcribe(str(audio))
    assert TEST_CREDENTIAL not in json.dumps({"audit": instance.audit, "raw": instance.raw_result})


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="lossless transport verification requires ffmpeg")
def test_size_rejection_retries_lossless_flac_only_then_removes_temporary_file(audio, monkeypatch):
    attempts = []
    def handler(request):
        body = request.read()
        attempts.append(body)
        if len(attempts) == 1:
            return httpx.Response(413)
        assert b'filename="recording.flac"' in body and b"fLaC" in body
        return httpx.Response(200, json=verbose())
    instance = provider(monkeypatch, handler)
    instance.transcribe(str(audio))
    assert len(attempts) == 2 and instance.audit["derivedFileUsed"]
    assert instance.audit["temporaryTransportRemoved"] and instance.audit["originalUnchanged"]
    assert all(attempt["timelineOffsetMs"] == 0 for attempt in instance.audit["attempts"])


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="lossless transport verification requires ffmpeg")
def test_failed_flac_retry_still_removes_temporary_transport(audio, monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(413)
        raise httpx.ReadTimeout(TEST_CREDENTIAL, request=request)
    instance = provider(monkeypatch, handler)
    with pytest.raises(GroqASRError, match="timed out"):
        instance.transcribe(str(audio))
    assert len(calls) == 2
    assert instance.audit["temporaryTransportRemoved"] and instance.audit["originalUnchanged"]
    assert TEST_CREDENTIAL not in json.dumps(instance.audit)


def test_provider_selection_is_centralized_and_no_silent_fallback(monkeypatch):
    assert provider_metadata("groq")["model"] == "whisper-large-v3"
    assert provider_metadata("soniox")["requiresCloudConsent"]
    assert not provider_metadata("local")["requiresCloudConsent"]
    monkeypatch.setenv("GROQ_API_KEY", TEST_CREDENTIAL)
    monkeypatch.setenv("SONIOX_API_KEY", TEST_CREDENTIAL)
    assert isinstance(get_rehearsal_provider("groq", True), GroqProvider)
    assert isinstance(get_rehearsal_provider("soniox", True), SonioxProvider)
    sentinel = object()
    monkeypatch.setattr("app.rehearsal_providers.get_local_provider", lambda: sentinel)
    assert get_rehearsal_provider("local") is sentinel
    with pytest.raises(CloudConsentRequired):
        get_rehearsal_provider("groq")
    with pytest.raises(ValueError, match="Unknown"):
        get_rehearsal_provider("wrong", True)


def test_cli_missing_key_and_invalid_provider_are_explicit(audio, tmp_path, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    output = tmp_path / "run"
    output.mkdir()
    assert analyze_audio(audio, output, asr_provider="groq", allow_cloud_upload=True) == 2
    assert json.loads((output / "status.json").read_text())["status"] == "GROQ ASR UNAVAILABLE"
    assert not (output / "observation.json").exists()
    process = subprocess.run([sys.executable, "-m", "app.rehearsal_cli", "--audio", str(audio), "--output", str(output), "--provider", "invalid"],
                             cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert process.returncode == 2 and "invalid choice" in process.stderr


def test_upload_manifest_result_and_audit_use_selected_groq_provider(audio, tmp_path, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", TEST_CREDENTIAL)
    monkeypatch.setenv("STAGE_DATA_DIR", str(tmp_path / "data"))
    class MockGroq(GroqProvider):
        def __init__(self, *, allow_cloud_upload):
            super().__init__(allow_cloud_upload=allow_cloud_upload, transport=httpx.MockTransport(lambda _: httpx.Response(200, json=verbose())))
    monkeypatch.setattr("app.rehearsal_providers.GroqProvider", MockGroq)
    with TestClient(app) as client:
        endpoint = "/rehearsals?filename=original.wav&showId=fixture&numberId=test-number&provider=groq"
        assert client.post(endpoint, content=audio.read_bytes()).status_code == 403
        response = client.post(endpoint + "&allowCloudUpload=true", content=audio.read_bytes())
        assert response.status_code == 202
        result = client.get(f"/rehearsals/{response.json()['id']}/result").json()
        assert result["provider"] == "groq/whisper-large-v3" and result["model"] == "whisper-large-v3"
        assert result["manifest"]["asrProvider"] == "groq" and result["manifest"]["cloudUploadAuthorized"]
        assert result["transcript"][0]["words"][0]["confidence"] is None
        assert TEST_CREDENTIAL not in json.dumps(result)
    for path in (tmp_path / "data").rglob("*.json"):
        assert TEST_CREDENTIAL not in path.read_text()
