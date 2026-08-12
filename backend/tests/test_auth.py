import pytest
from fastapi.testclient import TestClient

from core.config import settings


@pytest.fixture()
def auth_client(tmp_path, monkeypatch):
    """TestClient with a password configured."""
    import main
    monkeypatch.setenv("TAGGER_PASSWORD", "hunter2")
    prev = settings.config_dir
    settings.config_dir = tmp_path
    try:
        with TestClient(main.app) as c:
            yield c
    finally:
        settings.config_dir = prev


def test_disabled_when_no_password(client):
    assert client.get("/api/auth/status").json()["required"] is False
    assert client.get("/api/library/tracks").status_code == 200


def test_blocks_api_without_login(auth_client):
    assert auth_client.get("/api/library/tracks").status_code == 401


def test_status_reports_required(auth_client):
    body = auth_client.get("/api/auth/status").json()
    assert body["required"] is True
    assert body["authed"] is False


def test_wrong_password_rejected(auth_client):
    assert auth_client.post("/api/auth/login", json={"password": "nope"}).status_code == 401


def test_login_grants_access_then_logout(auth_client):
    assert auth_client.post("/api/auth/login", json={"password": "hunter2"}).status_code == 200
    assert auth_client.get("/api/auth/status").json()["authed"] is True
    assert auth_client.get("/api/library/tracks").status_code == 200

    auth_client.post("/api/auth/logout")
    assert auth_client.get("/api/library/tracks").status_code == 401


def test_auth_endpoints_reachable_without_cookie(auth_client):
    # The login/status endpoints must not be gated, or you could never log in.
    assert auth_client.get("/api/auth/status").status_code == 200
