from __future__ import annotations

import asyncio
import io
import os
import sys
import types
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.adapters.local import (
    FasterWhisperProvider, LocalASRUnavailable, claim_local_runtime,
    local_readiness, release_local_runtime,
)
from app.main import app
from app.sources import AudioFrame, FileReplaySource, LiveMicSource


def wav_bytes() -> bytes:
    result = io.BytesIO()
    with wave.open(result, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 640)
    return result.getvalue()


def test_unavailable_model_is_explicit_and_performance_never_falls_back_to_mock(monkeypatch) -> None:
    monkeypatch.delenv("STAGE_LOCAL_MODEL_DIR", raising=False)
    state = local_readiness()
    assert state["status"] == "LOCAL ASR UNAVAILABLE"
    assert state["local_ready"] is False
    with TestClient(app) as client:
        assert client.get("/readiness").json()["local_ready"] is False
        with client.websocket_connect("/ws/audio?mode=performance") as socket:
            error = socket.receive_json()
            assert error["type"] == "error"
            assert "LOCAL ASR UNAVAILABLE" in error["detail"]


def test_complete_local_model_and_tokenizer_are_required_before_import(tmp_path: Path) -> None:
    with pytest.raises(LocalASRUnavailable, match="model.bin"):
        FasterWhisperProvider(tmp_path)
    (tmp_path / "model.bin").touch()
    (tmp_path / "config.json").write_text("{}")
    with pytest.raises(LocalASRUnavailable, match="tokenizer.json"):
        FasterWhisperProvider(tmp_path)


def test_provider_uses_only_local_files_and_korean_timestamp_api(tmp_path: Path, monkeypatch) -> None:
    for name in ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json"):
        (tmp_path / name).write_text("{}")
    calls = {}

    class Model:
        supported_languages = ["ko", "en"]

        def __init__(self, path, **kwargs):
            calls["path"], calls["constructor"] = path, kwargs

        def transcribe(self, audio, **kwargs):
            calls["transcribe"] = kwargs
            return iter([types.SimpleNamespace(id=0, text=" 무대가 열린다 ", start=1.2, end=2.3,
                avg_logprob=-0.1, no_speech_prob=0.01,
                words=[types.SimpleNamespace(word="무대가", start=1.2, end=1.6, probability=0.95)])]), None

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=Model))
    provider = FasterWhisperProvider(tmp_path)
    result = provider.transcribe("local-fixture.wav", words=True)
    assert calls["path"] == str(tmp_path.resolve())
    assert calls["constructor"]["local_files_only"] is True
    assert calls["transcribe"]["language"] == "ko"
    assert calls["transcribe"]["word_timestamps"] is True
    assert result[0]["startMs"] == 1200
    assert result[0]["words"][0]["endMs"] == 1600


def test_runtime_does_not_queue_live_inference_behind_whole_show_rehearsal() -> None:
    claim_local_runtime("rehearsal")
    try:
        with pytest.raises(LocalASRUnavailable, match="Rehearsal transcription"):
            claim_local_runtime("performance")
    finally:
        release_local_runtime("rehearsal")
    claim_local_runtime("performance")
    try:
        with pytest.raises(LocalASRUnavailable, match="Live performance"):
            claim_local_runtime("rehearsal")
        with pytest.raises(LocalASRUnavailable, match="Another performance"):
            claim_local_runtime("performance")
    finally:
        release_local_runtime("performance")


def test_live_and_accelerated_file_replay_produce_same_pcm_boundary(tmp_path: Path) -> None:
    recording = tmp_path / "fixture.wav"
    recording.write_bytes(wav_bytes())

    async def scenario():
        replay = FileReplaySource(recording, speed=4)
        frames = [frame async for frame in replay.frames()]
        assert [frame.start_ms for frame in frames] == [0, 20]
        assert all(frame.sample_rate == 16000 and len(frame.pcm) == 640 for frame in frames)
        live = LiveMicSource()
        for frame in frames:
            await live.feed(frame)
        await live.close()
        assert [frame async for frame in live.frames()] == frames
        with pytest.raises(ValueError):
            await live.feed(AudioFrame(b"x", 0))

    asyncio.run(scenario())


def test_foreign_origins_cannot_write_local_rehearsal_data() -> None:
    with TestClient(app) as client:
        response = client.post("/rehearsals?filename=audio.wav", content=wav_bytes(), headers={"Origin": "https://untrusted.example"})
        assert response.status_code == 403
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/audio", headers={"Origin": "https://untrusted.example"}):
                pass


@pytest.mark.local_asr
def test_opt_in_actual_local_korean_model() -> None:
    """No model or private audio is bundled/downloaded by CI."""
    model = os.environ.get("STAGE_TEST_LOCAL_MODEL_DIR")
    recording = os.environ.get("STAGE_TEST_KOREAN_AUDIO")
    if not model or not recording:
        pytest.skip("Set STAGE_TEST_LOCAL_MODEL_DIR and STAGE_TEST_KOREAN_AUDIO for real local-ASR integration")
    provider = FasterWhisperProvider(Path(model))
    results = provider.transcribe(recording, words=True)
    assert results and any(any("가" <= char <= "힣" for char in item["text"]) for item in results)
    assert all(item["endMs"] >= item["startMs"] >= 0 for item in results)
