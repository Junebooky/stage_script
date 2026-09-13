"""Load ignored backend-local configuration at process entry, never in tests/CI."""
import os
from pathlib import Path

from dotenv import load_dotenv


def load_backend_environment() -> None:
    if os.environ.get("CI") or os.environ.get("PYTEST_CURRENT_TEST"):
        return
    load_dotenv(Path(__file__).resolve().parents[1] / ".env.local", override=False)
