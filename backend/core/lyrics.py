"""
Lyrics from LRCLIB (lrclib.net): free, no key, synced (LRC, timestamped)
and plain lyrics. /api/get wants an exact artist + title (+ album, duration
within ~2 s); when that misses, /api/search is tried and the best hit whose
duration is close enough is taken.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

API = "https://lrclib.net/api"
_UA = "tagger (https://github.com/beartums/tagger)"


def _get(path: str, params: dict) -> object | None:
    url = f"{API}/{path}?" + urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # /get tries outside sources on a miss and can answer 5xx when they
        # fail: for a lookup that is "not found", not an error.
        if e.code == 404 or e.code >= 500:
            return None
        raise


def fetch(title: str, artist: str, album: str | None = None, duration: float | None = None) -> dict | None:
    """{'synced', 'plain', 'instrumental'} for a track, or None when LRCLIB has nothing."""
    if not title or not artist:
        return None
    hit = _get("get", {"track_name": title, "artist_name": artist, "album_name": album,
                       "duration": round(duration) if duration else None})
    if not hit:
        found = _get("search", {"track_name": title, "artist_name": artist}) or []
        close = [h for h in found if not duration or not h.get("duration") or abs(h["duration"] - duration) <= 3]
        hit = next((h for h in close if h.get("syncedLyrics")), None) or (close[0] if close else None)
    if not hit:
        return None
    return {"synced": hit.get("syncedLyrics") or None, "plain": hit.get("plainLyrics") or None,
            "instrumental": bool(hit.get("instrumental"))}
