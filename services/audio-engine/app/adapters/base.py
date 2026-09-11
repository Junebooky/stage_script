from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass


@dataclass(frozen=True, slots=True)
class StreamingHypothesis:
    text: str
    confidence: float
    is_final: bool
    timestamp_ms: float

    def as_message(self) -> dict[str, object]:
        return {"type": "hypothesis", **asdict(self)}


class StreamingASRAdapter(ABC):
    """Replace this boundary with sherpa-onnx, NeMo, or another local engine."""

    name: str

    @abstractmethod
    async def accept_pcm(self, pcm_s16le: bytes, timestamp_ms: float) -> list[StreamingHypothesis]:
        """Accept mono 16 kHz signed 16-bit PCM and return zero or more partials."""

    @abstractmethod
    async def reset(self) -> None:
        """Reset decoder state at a session boundary, not at every silence."""

