"""Entry-point configuration must never read private local keys in CI/tests."""
from pathlib import Path

from app.environment import load_backend_environment


def test_pytest_and_ci_never_read_local_credentials(monkeypatch):
    calls = []
    monkeypatch.setattr("app.environment.load_dotenv", lambda *args, **kwargs: calls.append((args, kwargs)))
    load_backend_environment()
    assert calls == []
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("CI", "true")
    load_backend_environment()
    assert calls == []


def test_server_entry_loads_only_backend_file_without_overriding_process_environment(monkeypatch):
    calls = []
    monkeypatch.setattr("app.environment.load_dotenv", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("CI", raising=False)
    load_backend_environment()
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args == (Path(__file__).resolve().parents[1] / ".env.local",)
    assert kwargs == {"override": False}
