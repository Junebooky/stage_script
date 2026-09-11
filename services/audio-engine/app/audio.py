from __future__ import annotations

import math
from array import array


def pcm_rms(pcm_s16le: bytes) -> float:
    if not pcm_s16le:
        return 0.0
    samples = array("h")
    samples.frombytes(pcm_s16le)
    if not samples:
        return 0.0
    return min(1.0, math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / 32768)

