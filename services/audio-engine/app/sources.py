"""Live and replay audio share the same timestamped PCM stream boundary."""
from __future__ import annotations

import asyncio
import sys
import wave
from abc import ABC, abstractmethod
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator


@dataclass(frozen=True, slots=True)
class AudioFrame:
    pcm: bytes
    start_ms: float
    sample_rate: int = 16000


class AudioSource(ABC):
    @abstractmethod
    def frames(self) -> AsyncIterator[AudioFrame]:
        """Normalized mono, 16 kHz signed little-endian PCM."""


class LiveMicSource(AudioSource):
    """A producer feeds worklet/audio-interface frames; bounded queue fails loudly."""
    def __init__(self, max_frames: int = 500) -> None:
        self.queue: asyncio.Queue[AudioFrame | None] = asyncio.Queue(maxsize=max_frames)

    async def feed(self, frame: AudioFrame) -> None:
        if frame.sample_rate != 16000 or len(frame.pcm) % 2:
            raise ValueError("Expected mono/16000/s16le audio")
        self.queue.put_nowait(frame)

    async def close(self) -> None:
        await self.queue.put(None)

    async def frames(self) -> AsyncIterator[AudioFrame]:
        while (frame := await self.queue.get()) is not None:
            yield frame


def decode_audio_pcm(path: Path) -> bytes:
    """16 kHz mono PCM WAV works without optional packages.

    Other WAV encodings and FLAC/M4A/MP3 use the optional faster-whisper/PyAV
    decoder. It operates on a local path and does not invoke a network process.
    """
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as source:
                if (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, 16000):
                    return source.readframes(source.getnframes())
        except (wave.Error, EOFError):
            pass
    try:
        from faster_whisper.audio import decode_audio
    except ImportError as error:
        raise ValueError("This format needs the optional local-asr/PyAV decoder; basic support is mono 16 kHz PCM WAV") from error
    samples = decode_audio(str(path), sampling_rate=16000)
    pcm = array("h", (max(-32768, min(32767, round(float(sample) * 32768))) for sample in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


class FileReplaySource(AudioSource):
    def __init__(self, path: Path, *, speed: float = 1, frame_ms: int = 20) -> None:
        if speed <= 0 or frame_ms <= 0:
            raise ValueError("Replay speed and frame size must be positive")
        self.path, self.speed, self.frame_ms = path, speed, frame_ms

    async def frames(self) -> AsyncIterator[AudioFrame]:
        pcm = await asyncio.to_thread(decode_audio_pcm, self.path)
        frame_bytes = self.frame_ms * 16 * 2
        loop = asyncio.get_running_loop()
        began = loop.time()
        for offset in range(0, len(pcm), frame_bytes):
            start_ms = offset / 32
            delay = began + start_ms / 1000 / self.speed - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            yield AudioFrame(pcm[offset:offset + frame_bytes], start_ms)
