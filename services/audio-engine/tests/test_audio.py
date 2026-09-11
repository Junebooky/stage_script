import asyncio
from array import array

from app.adapters import MockStreamingASR, StreamingHypothesis
from app.audio import pcm_rms


def test_silence_rms_is_zero() -> None:
    assert pcm_rms(array("h", [0] * 320).tobytes()) == 0


def test_signal_rms_is_normalized() -> None:
    value = pcm_rms(array("h", [16384] * 320).tobytes())
    assert 0.49 < value < 0.51


def test_mock_adapter_only_emits_injected_hypotheses() -> None:
    async def scenario() -> None:
        adapter = MockStreamingASR()
        assert await adapter.accept_pcm(b"\x00\x00", 1) == []
        expected = StreamingHypothesis("테스트", 0.9, False, 2)
        adapter.inject(expected)
        assert await adapter.accept_pcm(b"\x00\x00", 3) == [expected]

    asyncio.run(scenario())
