"""One small selection boundary shared by the rehearsal HTTP API and CLI.

Public metadata is shared JSON with the web selector; credentials stay here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Protocol

from .adapters.local import LocalASRUnavailable, get_local_provider
from .adapters.soniox import ExternalASRUnavailable, SonioxProvider
from .adapters.groq import GroqProvider

CATALOG = json.loads((Path(__file__).resolve().parents[3] / "data/asr-providers.json").read_text())
DEFAULT_PROVIDER = CATALOG["defaultProviderId"]
PROVIDERS = {item["id"]: item for item in CATALOG["providers"]}
UNAVAILABLE_ERRORS = (LocalASRUnavailable, ExternalASRUnavailable)


class RehearsalProvider(Protocol):
    name: str

    def transcribe(self, audio: str, *, words: bool = True) -> list[dict[str, Any]]: ...


class CloudConsentRequired(ExternalASRUnavailable):
    pass


def provider_metadata(identifier: str) -> dict[str, Any]:
    if identifier not in PROVIDERS:
        raise ValueError("Unknown rehearsal ASR provider; choose local, groq or soniox")
    return dict(PROVIDERS[identifier])


def unavailable_status(identifier: str) -> str:
    return f"{identifier.upper()} ASR UNAVAILABLE"


def get_rehearsal_provider(identifier: str, allow_cloud_upload: bool = False) -> RehearsalProvider:
    metadata = provider_metadata(identifier)
    if metadata["requiresCloudConsent"] and not allow_cloud_upload:
        raise CloudConsentRequired(f"CLOUD UPLOAD NOT AUTHORIZED — explicit consent for {metadata['displayName']} is required")
    env_key = metadata["credentialEnvironment"]
    if env_key and not os.environ.get(env_key, "").strip():
        raise ExternalASRUnavailable(f"{unavailable_status(identifier)} — configure {env_key} on the audio backend")
    factories = {"local": lambda: get_local_provider(),
                 "groq": lambda: GroqProvider(allow_cloud_upload=allow_cloud_upload),
                 "soniox": lambda: SonioxProvider(allow_cloud_upload=allow_cloud_upload)}
    return factories[identifier]()


def provider_audit(provider: RehearsalProvider | None) -> dict[str, Any] | None:
    audit = getattr(provider, "audit", None)
    return {**audit, "rawResult": getattr(provider, "raw_result", None)} if audit is not None else None


def cleanup_warning(audit: dict[str, Any] | None) -> str | None:
    if audit and any(not item["deleted"] for item in audit.get("cleanup", [])):
        return "Remote cleanup incomplete. Inspect external-asr.json for this run's remote objects."
    return None
