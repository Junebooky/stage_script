"""Provider contract tests only. No recording is sent outside the process."""
import json

import httpx
import pytest

from app.adapters.soniox import ExternalASRUnavailable, SonioxProvider, token_segments
from app.rehearsal_cli import analyze_audio
from test_inspection import make_wav

FILE_ID = "00000000-0000-4000-8000-000000000001"
JOB_ID = "00000000-0000-4000-8000-000000000002"


def token(text, start, end, confidence=0.95):
    return {"text": text, "start_ms": start, "end_ms": end, "confidence": confidence}


def test_credentials_and_consent_are_required_before_any_network(monkeypatch):
    monkeypatch.delenv("SONIOX_API_KEY", raising=False)
    with pytest.raises(ExternalASRUnavailable, match="NOT AUTHORIZED"):
        SonioxProvider(allow_cloud_upload=False)
    with pytest.raises(ExternalASRUnavailable, match="SONIOX_API_KEY"):
        SonioxProvider(allow_cloud_upload=True)


def test_korean_subwords_join_before_matching_and_confidence_is_preserved():
    result = token_segments([token("어", 0, 90), token("두운", 90, 250), token(" 숲이여", 300, 500, 0.7),
                             token(" 길을", 1500, 1700), token(" 열어", 1800, 1900), token(" 주오!", 2000, 2200)])
    assert [span["text"] for span in result] == ["어두운 숲이여", "길을 열어 주오!"]
    assert result[0]["words"][0]["text"] == "어두운"
    assert result[0]["confidence"] == 0.7
    assert result[1]["startMs"] == 1500


def test_overlap_is_span_only_not_fabricated_word_timing():
    result = token_segments([token("둘이", 10, 300), token(" 함께", 200, 500)])
    assert "words" not in result[0]
    assert result[0]["startMs"] == 10 and result[0]["endMs"] == 500
    with pytest.raises(ValueError, match="range"):
        token_segments([token("잘못된 시각", 500, 10)])


@pytest.mark.parametrize("fail_job,cleanup_fails", [(False, False), (True, False), (False, True)])
def test_real_api_contract_poll_cleanup_and_no_canonical_context(tmp_path, monkeypatch, fail_job, cleanup_fails):
    monkeypatch.setenv("SONIOX_API_KEY", "fixture-secret")
    audio = tmp_path / "private-title.wav"
    make_wav(audio)
    before = audio.read_bytes()
    requests = []
    def handler(request):
        requests.append((request.method, request.url.path))
        assert request.headers["authorization"] == "Bearer fixture-secret"
        assert request.url.host == "api.soniox.com"
        if request.method == "DELETE":
            return httpx.Response(409 if cleanup_fails else 204)
        if request.url.path == "/v1/files":
            assert b"private-title" not in request.read()
            return httpx.Response(201, json={"id": FILE_ID})
        if request.url.path == "/v1/transcriptions":
            body = json.loads(request.read())
            assert body["model"] == "stt-async-v5" and body["language_hints"] == ["ko"]
            assert "context" not in body and "translation" not in body
            return httpx.Response(201, json={"id": JOB_ID, "status": "queued"})
        if request.url.path.endswith("/transcript"):
            return httpx.Response(200, json={"tokens": [token("실제", 0, 100), token(" 발화", 120, 300)]})
        return httpx.Response(200, json={"status": "error" if fail_job else "completed"})
    provider = SonioxProvider(allow_cloud_upload=True, transport=httpx.MockTransport(handler), poll_seconds=0)
    if fail_job:
        with pytest.raises(RuntimeError, match="did not complete"):
            provider.transcribe(str(audio))
    else:
        assert provider.transcribe(str(audio))[0]["text"] == "실제 발화"
    assert requests[-2:] == [("DELETE", f"/v1/transcriptions/{JOB_ID}"), ("DELETE", f"/v1/files/{FILE_ID}")]
    assert all(item["deleted"] is not cleanup_fails for item in provider.audit["cleanup"])
    assert "fixture-secret" not in json.dumps(provider.audit)
    assert audio.read_bytes() == before


def test_timeout_records_cleanup_and_never_silently_falls_back(tmp_path, monkeypatch):
    monkeypatch.setenv("SONIOX_API_KEY", "fixture")
    audio = tmp_path / "recording.wav"
    make_wav(audio)
    def handler(request):
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(201, json={"id": FILE_ID if request.url.path.endswith("/files") else JOB_ID, "status": "queued"})
    provider = SonioxProvider(allow_cloud_upload=True, transport=httpx.MockTransport(handler), timeout_seconds=0)
    with pytest.raises(TimeoutError):
        provider.transcribe(str(audio))
    assert len(provider.audit["cleanup"]) == 2 and provider.raw_result is None


def test_cli_external_missing_key_writes_inspection_not_fake_asr(tmp_path, monkeypatch):
    monkeypatch.delenv("SONIOX_API_KEY", raising=False)
    audio, output = tmp_path / "recording.wav", tmp_path / "run"
    make_wav(audio)
    output.mkdir()
    assert analyze_audio(audio, output, asr_provider="soniox", allow_cloud_upload=True) == 2
    assert {path.name for path in output.iterdir()} == {"inspection.json", "status.json"}
    status = json.loads((output / "status.json").read_text())
    assert status["status"] == "EXTERNAL ASR UNAVAILABLE" and not status["realASRRan"]
