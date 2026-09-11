from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_reports_active_adapter() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "adapter": "mock-streaming-asr"}


def test_websocket_accepts_pcm_and_streams_adapter_partials() -> None:
    with client.websocket_connect("/ws/audio") as socket:
        ready = socket.receive_json()
        assert ready["type"] == "ready"
        assert ready["audio_format"] == "mono/16000/s16le"

        socket.send_json({"type": "mock_hypothesis", "text": "오늘 여기서", "confidence": 0.91})
        socket.send_bytes(b"\x00\x00" * 320)
        partial = socket.receive_json()
        assert partial["type"] == "hypothesis"
        assert partial["text"] == "오늘 여기서"
        assert partial["is_final"] is False

