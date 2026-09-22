import pytest

from app.streaming_measurement import block_external_sockets


def test_measurement_network_guard_allows_only_loopback():
    for host in ("127.0.0.1", "::1"):
        block_external_sockets("socket.connect", (None, (host, 1234)))
    for host in ("api.groq.com", "api.soniox.com", "huggingface.co", "8.8.8.8"):
        with pytest.raises(RuntimeError, match="non-loopback"):
            block_external_sockets("socket.connect", (None, (host, 443)))


def test_measurement_guard_ignores_non_socket_events():
    block_external_sockets("open", ("local.wav", "r", 0))
