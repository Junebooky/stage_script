from __future__ import annotations

from collections import deque

from .base import StreamingASRAdapter, StreamingHypothesis


class MockStreamingASR(StreamingASRAdapter):
    """Deterministic CI/demo adapter. It never invents text from incoming PCM."""

    name = "mock-streaming-asr"

    def __init__(self) -> None:
        self._queued: deque[StreamingHypothesis] = deque()

    def inject(self, hypothesis: StreamingHypothesis) -> None:
        self._queued.append(hypothesis)

    async def accept_pcm(self, pcm_s16le: bytes, timestamp_ms: float) -> list[StreamingHypothesis]:
        if not pcm_s16le or not self._queued:
            return []
        return [self._queued.popleft()]

    async def reset(self) -> None:
        self._queued.clear()

