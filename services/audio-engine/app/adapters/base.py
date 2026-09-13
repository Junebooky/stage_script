from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass


@dataclass(frozen=True, slots=True)
class StreamingHypothesis:
    text: str
    confidence: float
    is_final: bool
    timestamp_ms: float
    utterance_id: str | None = None
    start_ms: float | None = None
    end_ms: float | None = None

    def as_message(self) -> dict[str, object]:
        return {"type": "hypothesis", **asdict(self)}


class StreamingASRAdapter(ABC):
    """Local mono/16 kHz PCM boundary. Mock implementations are demo-only."""

    name: str

    @abstractmethod
    async def accept_pcm(self, pcm_s16le: bytes, timestamp_ms: float) -> list[StreamingHypothesis]:
        """Accept mono 16 kHz signed 16-bit PCM and return zero or more partials."""

    @abstractmethod
    async def reset(self) -> None:
        """Reset decoder state at a session boundary, not at every silence."""

    async def poll(self) -> list[StreamingHypothesis]:
        """Drain asynchronous chunk inference without waiting for another audio frame."""
        return []
