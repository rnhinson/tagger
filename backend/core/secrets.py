"""
API keys and tokens in settings.json, encrypted at rest.

The encryption key is TAGGER_SECRET_KEY (a Fernet key, from a Kubernetes
Secret) -- never the settings file, so the file and its backups alone don't
reveal them. Stored values look like "enc:v1:<token>". Without the env var
they're stored as plain text, as before. Plain values already in the file
are encrypted at startup once a key is set (seal_existing).

The API never returns them: GET /api/config says only which are set.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger("tagger.secrets")

FIELDS = ("acoustid_api_key", "discogs_token", "lrclib_api_key")
PREFIX = "enc:v1:"


def _fernet():
    key = os.environ.get("TAGGER_SECRET_KEY", "").strip()
    if not key:
        return None
    from cryptography.fernet import Fernet
    return Fernet(key.encode())


def enabled() -> bool:
    return _fernet() is not None


def seal(value: str) -> str:
    f = _fernet()
    if not value or f is None or value.startswith(PREFIX):
        return value
    return PREFIX + f.encrypt(value.encode()).decode()


def unseal(value: str, field: str = "") -> str:
    if not value.startswith(PREFIX):
        return value
    f = _fernet()
    if f is None:
        logger.warning("%s is encrypted but TAGGER_SECRET_KEY isn't set: ignoring it", field)
        return ""
    from cryptography.fernet import InvalidToken
    try:
        return f.decrypt(value[len(PREFIX):].encode()).decode()
    except InvalidToken:
        logger.warning("%s can't be decrypted with this TAGGER_SECRET_KEY: ignoring it", field)
        return ""


def seal_existing() -> int:
    """Encrypt plain-text values left in settings.json; returns how many."""
    import json
    from core.config import settings
    f = settings.settings_file
    if not enabled() or not f.exists():
        return 0
    data = json.loads(f.read_text())
    plain = [k for k in FIELDS if data.get(k) and not str(data[k]).startswith(PREFIX)]
    if plain:
        for k in plain:
            data[k] = seal(data[k])
        f.write_text(json.dumps(data, indent=2))
        logger.info("encrypted %s in settings.json", ", ".join(plain))
    return len(plain)
