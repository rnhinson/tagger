"""
Optional single-password authentication.

Enabled only when TAGGER_PASSWORD is set; otherwise the app is fully open
(unchanged behaviour). A successful login sets an HMAC session cookie derived
from the password, so it stays valid across restarts until the password changes.
"""
from __future__ import annotations

import hashlib
import hmac
import os

COOKIE_NAME = "tagger_session"
_COOKIE_MSG = b"tagger-session-v1"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def password() -> str:
    return os.environ.get("TAGGER_PASSWORD", "")


def auth_enabled() -> bool:
    return bool(password())


def secure_cookie() -> bool:
    """Whether to mark the session cookie Secure (set behind HTTPS)."""
    return os.environ.get("TAGGER_SECURE_COOKIE", "").lower() in ("1", "true", "yes")


def _secret() -> bytes:
    return hashlib.sha256(password().encode()).digest()


def make_token() -> str:
    return hmac.new(_secret(), _COOKIE_MSG, hashlib.sha256).hexdigest()


def valid_token(token: str | None) -> bool:
    return bool(token) and hmac.compare_digest(token, make_token())


def check_password(candidate: str) -> bool:
    return bool(candidate) and hmac.compare_digest(candidate, password())
