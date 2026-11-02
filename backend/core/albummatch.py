"""
Pair a folder's tracks with a MusicBrainz release's tracks (album-level match).

Each (local, release) pair is scored on disc + track number, title similarity
and duration; pairs are taken greedily, best first, so every track and every
release track is used at most once. The user can reassign any pair before
anything is staged -- this only proposes.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

MIN_SCORE = 0.35
_BRACKETS = re.compile(r"[\(\[][^)\]]*(remaster|version|edit|mix|live|mono|stereo|bonus)[^)\]]*[\)\]]", re.I)
_NONWORD = re.compile(r"[^\w]+")


def _norm(s: str | None) -> str:
    s = _BRACKETS.sub("", (s or "").lower())
    return _NONWORD.sub(" ", s).strip()


def _int(v) -> int:
    try:
        return int(str(v or "").split("/")[0])
    except ValueError:
        return 0


def score(local: dict, mb: dict) -> float:
    """0..1: how likely `local` (a track row) is release track `mb`."""
    s = 0.0
    disc = _int(local.get("disc_number")) or 1
    num = _int(local.get("track_number"))
    if num and num == mb["position"] and disc == mb["disc"]:
        s += 0.4
    elif num and num == mb["position"]:
        s += 0.2
    a, b = _norm(local.get("title")), _norm(mb.get("title"))
    if a and b:
        s += 0.45 * SequenceMatcher(None, a, b).ratio()
    d1, d2 = local.get("duration"), mb.get("duration")
    if d1 and d2:
        diff = abs(d1 - d2)
        s += 0.15 if diff <= 3 else 0.07 if diff <= 10 else 0.0
    return round(s, 3)


def match(local: list[dict], release_tracks: list[dict]) -> dict[int, tuple[str | None, float]]:
    """{track id: (release track key or None, score)}."""
    pairs = sorted(((score(l, m), l["id"], m["key"]) for l in local for m in release_tracks), reverse=True)
    out: dict[int, tuple[str | None, float]] = {}
    used: set[str] = set()
    for sc, tid, key in pairs:
        if sc < MIN_SCORE:
            break
        if tid in out or key in used:
            continue
        out[tid] = (key, sc)
        used.add(key)
    for l in local:
        out.setdefault(l["id"], (None, 0.0))
    return out


FIELDS = ("title", "artist", "album", "album_artist", "year", "track_number", "disc_number",
          "mb_track_id", "mb_artist_id", "mb_album_id", "mb_album_artist_id")


def tags_for(release: dict, mb: dict, original_year: bool = True) -> dict[str, str]:
    """The tags release track `mb` gives a file."""
    year = (release.get("original_year") if original_year else None) or release.get("year")
    tags = {
        "title": mb.get("title"), "artist": mb.get("artist"),
        "album": release.get("album"), "album_artist": release.get("album_artist"),
        "year": year, "track_number": str(mb["position"]), "disc_number": str(mb["disc"]),
        "mb_track_id": mb.get("mb_track_id"), "mb_artist_id": mb.get("mb_artist_id"),
        "mb_album_id": release.get("mb_album_id"), "mb_album_artist_id": release.get("mb_album_artist_id"),
    }
    return {k: v for k, v in tags.items() if v}
