"""Read-only PCM WAV inspection, independent of optional ASR/model packages."""
from __future__ import annotations

import hashlib
import wave
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def inspect_wav(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"AUDIO FILE NOT FOUND: {path}")
    before = sha256_file(path)
    size = path.stat().st_size
    # wave supports integer PCM (including this 48 kHz stereo 24-bit original).
    # Unsupported float/compressed encodings fail explicitly, not 'decoded OK'.
    with wave.open(str(path), "rb") as source:
        channels, width, rate, expected = source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getnframes()
        if source.getcomptype() != "NONE" or width not in (1, 2, 3, 4) or not rate or not channels or not expected:
            raise ValueError("Unsupported or empty PCM WAV")
        frames, peak = 0, 0
        while block := source.readframes(16_384):
            if len(block) % (channels * width):
                raise ValueError("Truncated WAV sample frame")
            frames += len(block) // (channels * width)
            for offset in range(0, len(block), width):
                sample = int.from_bytes(block[offset:offset + width], "little", signed=width != 1)
                peak = max(peak, abs(sample - 128 if width == 1 else sample))
        if frames != expected:
            raise ValueError(f"Truncated WAV data: decoded {frames} of {expected} frames")
    after = sha256_file(path)
    if before != after:
        raise ValueError("Original recording changed during read-only inspection")
    return {"path": str(path.resolve()), "exists": True, "bytes": size,
            "durationMs": frames / rate * 1000, "sampleRate": rate, "channels": channels,
            "channelLayout": "mono" if channels == 1 else "stereo" if channels == 2 else "multichannel",
            "bitsPerSample": width * 8, "codec": f"pcm_{'u' if width == 1 else 's'}{width * 8}{'le' if width > 1 else ''}",
            "frames": frames, "decodeSuccess": True, "decodedFrames": frames,
            "peakAbsoluteNormalized": peak / (2 ** (width * 8 - 1)),
            "sha256Before": before, "sha256After": after, "originalUnchanged": True,
            "decoder": "python-stdlib-wave / full integer PCM decode"}
