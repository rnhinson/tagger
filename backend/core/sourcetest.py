"""
"Test" for each key/token in Settings → Sources: one cheap request that the
service answers differently for a bad credential (checked 2026-11-07):
AcoustID error code 4 "invalid API key"; Discogs and LRCLIB HTTP 401.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

_UA = "tagger/0.2.0 (https://github.com/beartums/tagger)"


def _fetch(url: str, headers: dict) -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, **headers})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read() or b"{}")
        except ValueError:
            body = {}
        return e.code, body


def acoustid(key: str) -> dict:
    # A dummy fingerprint: the key is checked first, so code 4 means the key.
    _, body = _fetch("https://api.acoustid.org/v2/lookup?" + urllib.parse.urlencode(
        {"client": key, "duration": 100, "fingerprint": "AQAA"}), {})
    if (body.get("error") or {}).get("code") == 4:
        return {"ok": False, "message": "AcoustID: invalid API key"}
    return {"ok": True, "message": "AcoustID accepted the key"}


def discogs(token: str) -> dict:
    status, body = _fetch("https://api.discogs.com/oauth/identity", {"Authorization": f"Discogs token={token}"})
    if status == 200:
        return {"ok": True, "message": f"Discogs: signed in as {body.get('username', '?')}"}
    return {"ok": False, "message": f"Discogs: {body.get('message') or f'HTTP {status}'}"}


def lrclib(key: str, app_id: str) -> dict:
    h = {k: v for k, v in {"Lrclib-Api-Key": key, "Lrclib-App-Id": app_id}.items() if v}
    status, body = _fetch("https://lrclib.net/api/search?q=hello", h)
    if status == 200:
        return {"ok": True, "message": "LRCLIB accepted the " + " and ".join(
            n for n, k in (("app ID", "Lrclib-App-Id"), ("key", "Lrclib-Api-Key")) if k in h)}
    if status == 429:
        return {"ok": False, "message": "LRCLIB: rate limited right now — try again in a minute"}
    return {"ok": False, "message": f"LRCLIB: {body.get('message') or f'HTTP {status}'}"}
