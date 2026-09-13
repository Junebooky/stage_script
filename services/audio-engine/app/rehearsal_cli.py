"""Inspection/transcription stage invoked by the number-scoped Node CLI.

No canonical text is passed to ASR, no raw writes. External ASR is opt-in.
The Node stage performs alignment and replay with the app's actual TS packages.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .rehearsal_providers import DEFAULT_PROVIDER, PROVIDERS, UNAVAILABLE_ERRORS, get_rehearsal_provider, provider_metadata, provider_audit, cleanup_warning, unavailable_status
from .environment import load_backend_environment
from .inspection import inspect_wav, sha256_file


def write_artifact(directory: Path, filename: str, value: dict) -> None:
    # Every CLI run owns a new directory; never overwrite a previous review/run.
    with (directory / filename).open("x", encoding="utf-8") as target:
        json.dump(value, target, ensure_ascii=False, indent=2, allow_nan=False)


def analyze_audio(audio: Path, output: Path, *, inspect_only: bool = False,
                  asr_provider: str = DEFAULT_PROVIDER, allow_cloud_upload: bool = False) -> int:
    try:
        inspection = inspect_wav(audio)
        write_artifact(output, "inspection.json", inspection)
        print(json.dumps(inspection, ensure_ascii=False), flush=True)
    except Exception as error:
        write_artifact(output, "status.json", {"status": "AUDIO INSPECTION FAILED", "reason": str(error), "realASRRan": False})
        return 1
    if inspect_only:
        write_artifact(output, "status.json", {"status": "INSPECTION ONLY", "realASRRan": False})
        return 0
    try:
        metadata = provider_metadata(asr_provider)
        provider = get_rehearsal_provider(asr_provider, allow_cloud_upload)
    except (*UNAVAILABLE_ERRORS, ValueError) as error:
        status = unavailable_status(asr_provider)
        write_artifact(output, "status.json", {"status": status, "reason": str(error),
            "realASRRan": False, "observationStatus": "NOT GENERATED", "metricsStatus": "NOT MEASURED",
            "candidateStatus": "NOT GENERATED", "productionReady": False})
        print(f"{status}: {error}", flush=True)
        return 2
    try:
        began = time.perf_counter()
        transcript = provider.transcribe(str(audio.resolve()), words=True)
        elapsed = (time.perf_counter() - began) * 1000
        if sha256_file(audio) != inspection["sha256Before"]:
            raise ValueError("Original recording changed during ASR")
        write_artifact(output, "observation.json", {"provider": provider.name, "model": metadata["model"], "asrProvider": asr_provider, "transcript": transcript,
            "timestampBasis": getattr(provider, "timestamp_basis", "local-asr-pseudo"), "transcriptionWallTimeMs": elapsed,
            "liveLatencyMeasured": False, "audioSha256": inspection["sha256Before"]})
        write_artifact(output, "status.json", {"status": "ASR COMPLETE", "realASRRan": True,
            "productionReady": False, "transcriptCount": len(transcript), "originalUnchanged": True})
        return 0
    except Exception as error:
        write_artifact(output, "status.json", {"status": "ASR FAILED", "reason": str(error), "realASRRan": False, "attempted": True, "productionReady": False})
        return 1
    finally:
        audit = provider_audit(provider)
        if audit is not None:
            write_artifact(output, "external-asr.json", audit)
        if warning := cleanup_warning(audit):
            print(warning, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--provider", choices=list(PROVIDERS), default=DEFAULT_PROVIDER)
    parser.add_argument("--allow-cloud-upload", action="store_true")
    args = parser.parse_args()
    if not args.output.is_dir() or any(args.output.iterdir()):
        parser.error("Output must be a new empty run directory")
    load_backend_environment()
    return analyze_audio(args.audio, args.output, inspect_only=args.inspect_only,
                         asr_provider=args.provider, allow_cloud_upload=args.allow_cloud_upload)


if __name__ == "__main__":
    raise SystemExit(main())
