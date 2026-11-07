"""API keys in settings.json: encrypted with TAGGER_SECRET_KEY, never returned by the API."""
import json

from cryptography.fernet import Fernet

from api.config import _load
from core import secrets
from core.config import settings


def test_keys_are_encrypted_and_never_returned(client, monkeypatch):
    monkeypatch.setenv("TAGGER_SECRET_KEY", Fernet.generate_key().decode())
    r = client.patch("/api/config", json={"lrclib_api_key": "k-123", "discogs_token": "d-456"}).json()
    assert r["lrclib_api_key"] == "" and r["secrets_set"]["lrclib_api_key"] and r["secrets_encrypted"]
    raw = settings.settings_file.read_text()
    assert "k-123" not in raw and "d-456" not in raw and secrets.PREFIX in raw
    assert _load().lrclib_api_key == "k-123"
    client.patch("/api/config", json={"rename_on_save": True})            # other saves keep it
    assert _load().lrclib_api_key == "k-123"
    client.patch("/api/config", json={"lrclib_api_key": ""})               # Remove
    assert client.get("/api/config").json()["secrets_set"]["lrclib_api_key"] is False


def test_plain_values_are_sealed_at_startup_and_a_wrong_key_reads_as_unset(client, monkeypatch):
    monkeypatch.delenv("TAGGER_SECRET_KEY", raising=False)
    client.patch("/api/config", json={"acoustid_api_key": "a-789"})
    assert json.loads(settings.settings_file.read_text())["acoustid_api_key"] == "a-789"   # no key: plain
    monkeypatch.setenv("TAGGER_SECRET_KEY", Fernet.generate_key().decode())
    assert secrets.seal_existing() == 1
    assert "a-789" not in settings.settings_file.read_text() and _load().acoustid_api_key == "a-789"
    monkeypatch.setenv("TAGGER_SECRET_KEY", Fernet.generate_key().decode())
    assert _load().acoustid_api_key == ""
