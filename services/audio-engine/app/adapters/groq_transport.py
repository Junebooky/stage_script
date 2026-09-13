"""Free-tier transport preparation. Never upload, trim, chunk, or edit input."""
import json
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

MAX_UPLOAD_BYTES = 25_000_000  # Conservative decimal MB, not 25 MiB.
TARGET_RATE = 16_000


class TransportError(RuntimeError):
    pass


def probe(path: Path) -> dict:
    try:
        process = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,sample_rate,channels,duration_ts,time_base,start_time,bits_per_raw_sample",
            "-of", "json", str(path)], check=True, capture_output=True, timeout=30)
        stream = json.loads(process.stdout)["streams"][0]
        duration = Fraction(stream["duration_ts"]) * Fraction(stream["time_base"])
        rate, channels = int(stream["sample_rate"]), int(stream["channels"])
        offset = float(stream.get("start_time", 0))
        if duration <= 0 or rate <= 0 or channels <= 0 or offset != 0:
            raise ValueError()
        return {"codec": stream["codec_name"], "sampleRate": rate, "channels": channels,
            "durationMs": float(duration * 1000), "durationTicks": int(stream["duration_ts"]),
            "timeBase": stream["time_base"], "timelineOffsetMs": offset * 1000,
            "bitsPerRawSample": stream.get("bits_per_raw_sample")}
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, IndexError, TypeError):
        raise TransportError("Cannot verify complete zero-offset audio timeline; no upload performed.") from None


def prepare_transport(original: Path, derived: Path) -> dict:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise TransportError("ffmpeg and ffprobe are required before Groq upload.")
    source = probe(original)
    try:
        # FLAC is lossless for the derived PCM. Resampling/downmixing are explicitly
        # authorized, but are NOT bit-identical preservation of the original audio.
        subprocess.run(["ffmpeg", "-nostdin", "-n", "-v", "error", "-xerror", "-i", str(original),
            "-map", "0:a:0", "-map_metadata", "-1", "-ar", str(TARGET_RATE), "-ac", "1",
            "-sample_fmt", "s32", "-c:a", "flac", "-compression_level", "8", str(derived)],
            check=True, capture_output=True, timeout=180)
        target = probe(derived)
        # Decode the entire derived file, not merely its container header.
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(derived),
            "-map", "0:a:0", "-f", "null", "-"], check=True, capture_output=True, timeout=180)
    except (subprocess.SubprocessError, OSError):
        raise TransportError("FLAC conversion/full decode failed; original retained, no upload performed.") from None
    delta = target["durationMs"] - source["durationMs"]
    tolerance = 1000 / TARGET_RATE
    audit = {"original": source, "derived": target, "bytes": derived.stat().st_size,
        "maxUploadBytes": MAX_UPLOAD_BYTES, "durationDeltaMs": delta, "durationToleranceMs": tolerance,
        "durationVerified": abs(delta) <= tolerance + 1e-9,
        "timelineOffsetMs": 0, "timelineOffsetVerified": True, "fullDecodeSuccess": True,
        "resampling": "16000 Hz", "downmix": "mono", "codecCompression": "lossless FLAC",
        "trimmed": False, "tempoChanged": False, "silenceRemoved": False, "chunked": False}
    if target["codec"] != "flac" or target["sampleRate"] != TARGET_RATE or target["channels"] != 1 or not audit["durationVerified"]:
        raise TransportError("FLAC format/duration verification failed; no upload performed.")
    return audit
