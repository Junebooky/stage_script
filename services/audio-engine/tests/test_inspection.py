from __future__ import annotations

import json
import wave
from pathlib import Path

import pytest

from app.adapters.local import LocalASRUnavailable
from app.inspection import inspect_wav, sha256_file
from app.rehearsal_cli import analyze_audio


def make_wav(path: Path, width: int = 3, channels: int = 2) -> None:
    with wave.open(str(path), "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(width)
        target.setframerate(48000)
        target.writeframes(bytes(480 * channels * width))


@pytest.mark.parametrize("width", [1, 2, 3, 4])
def test_full_pcm_decode_is_model_independent_and_immutable(tmp_path, width):
    audio = tmp_path / "original with spaces.wav"
    make_wav(audio, width)
    before = sha256_file(audio)
    metadata = inspect_wav(audio)
    assert metadata["durationMs"] == 10
    assert metadata["sampleRate"] == 48000
    assert metadata["channels"] == 2
    assert metadata["bitsPerSample"] == width * 8
    assert metadata["decodedFrames"] == metadata["frames"] == 480
    assert metadata["sha256Before"] == metadata["sha256After"] == before
    assert metadata["decodeSuccess"] and metadata["originalUnchanged"]


def test_missing_and_truncated_audio_fail_explicitly(tmp_path):
    with pytest.raises(FileNotFoundError, match="AUDIO FILE NOT FOUND"):
        inspect_wav(tmp_path / "missing.wav")
    audio = tmp_path / "truncated.wav"
    make_wav(audio)
    audio.write_bytes(audio.read_bytes()[:-7])
    with pytest.raises(ValueError, match="Truncated"):
        inspect_wav(audio)


def test_cli_stops_at_unavailable_boundary_without_fabricated_observations(tmp_path, monkeypatch):
    audio, output = tmp_path / "original.wav", tmp_path / "run"
    make_wav(audio)
    output.mkdir()
    def unavailable():
        raise LocalASRUnavailable("fixture: no model; never download")
    monkeypatch.setattr("app.rehearsal_cli.get_local_provider", unavailable)
    assert analyze_audio(audio, output) == 2
    assert {path.name for path in output.iterdir()} == {"inspection.json", "status.json"}
    assert json.loads((output / "status.json").read_text())["realASRRan"] is False


def test_cli_local_provider_contract_keeps_asr_separate_from_canonical(tmp_path, monkeypatch):
    audio, output = tmp_path / "original.wav", tmp_path / "run"
    make_wav(audio)
    output.mkdir()
    class FixtureProvider:
        name = "SYNTHETIC TEST ONLY"
        def transcribe(self, path, *, words):
            assert Path(path) == audio and words is True
            return [{"id": "0", "text": "배우가 실제로 말한 문장", "startMs": 0, "endMs": 5, "confidence": 0.9}]
    monkeypatch.setattr("app.rehearsal_cli.get_local_provider", lambda: FixtureProvider())
    before = sha256_file(audio)
    assert analyze_audio(audio, output) == 0
    assert json.loads((output / "observation.json").read_text())["transcript"][0]["text"] == "배우가 실제로 말한 문장"
    assert sha256_file(audio) == before
