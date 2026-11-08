"""
Pair a folder's tracks with a MusicBrainz release's tracks (album-level match).

Each (local, release) pair is scored on disc + track number, title similarity
and duration; pairs are taken greedily, best first, so every track and every
release track is used at most once. A pair is only proposed when the TITLES
agree (similarity >= TITLE_MIN): a matching number or length alone says
nothing about which song it is. A track without a title tag is compared by
its file name (leading number dropped). The user can reassign any pair
before anything is staged -- this only proposes.
"""
from __future__ import annotations

import re
from pathlib import Path
from difflib import SequenceMatcher

MIN_SCORE = 0.35
TITLE_MIN = 0.6
_LEADING_NUM = re.compile(r"^\s*(\d+[\s.\-_]*)+")
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


_PLACEHOLDER = re.compile(r"^(unknown( (artist|album|title|track))?|untitled|(audio ?)?track ?\d+)$", re.I)
_DISC_DIR = re.compile(r"^(cd|dis[ck])\s*\d+$", re.I)
_DIR_SUFFIX = re.compile(r"\s*[\(\[](\d{4}|flac|mp3|ogg|m4a|\d+\s*kbps|web|cd|lossless)[\)\]]\s*$", re.I)


def is_placeholder(s: str | None) -> bool:
    """Empty, or a ripper's stand-in ("Unknown Album", "Track 3")."""
    s = _spaces(s)
    return not s or bool(_PLACEHOLDER.match(s))


def _spaces(s: str | None) -> str:
    """Underscores (older rips) as spaces."""
    return re.sub(r"[\s_]+", " ", s or "").strip()


def name_title(local: dict) -> str:
    """The file name without its extension and leading number."""
    stem = (local.get("filename") or "").rsplit(".", 1)[0]
    return _spaces(_LEADING_NUM.sub("", stem))


def local_title(local: dict) -> str:
    """The title to compare: the tag, else (missing or a placeholder) the file name."""
    return name_title(local) if is_placeholder(local.get("title")) else local["title"]


def names_from_path(path: str, root: Path | None) -> tuple[str | None, str | None]:
    """(album, artist) from .../Artist/Album[/Disc 1]/file, never above the library root."""
    d = Path(path).parent
    if _DISC_DIR.match(d.name):
        d = d.parent
    if d == root or not d.name:
        return None, None
    album = _spaces(d.name)
    while _DIR_SUFFIX.search(album):
        album = _DIR_SUFFIX.sub("", album)
    artist = _spaces(d.parent.name) if d.parent != root and d.parent.name else None
    if " - " in album:
        head, rest = album.split(" - ", 1)
        if not artist or _norm(head) == _norm(artist):
            artist, album = artist or head, rest
    return album.strip() or None, artist


def title_similarity(local: dict, mb: dict) -> float:
    a, b = _norm(local_title(local)), _norm(mb.get("title"))
    return SequenceMatcher(None, a, b).ratio() if a and b else 0.0


def score(local: dict, mb: dict) -> float:
    """0..1: how likely `local` (a track row) is release track `mb`."""
    s = 0.0
    disc = _int(local.get("disc_number")) or 1
    num = local_number(local)
    if unnamed(local):
        return _score_by_position(local, mb, disc, num)
    if num and num == mb["position"] and disc == mb["disc"]:
        s += 0.4
    elif num and num == mb["position"]:
        s += 0.2
    s += 0.45 * title_similarity(local, mb)
    d1, d2 = local.get("duration"), mb.get("duration")
    if d1 and d2:
        diff = abs(d1 - d2)
        s += 0.15 if diff <= 3 else 0.07 if diff <= 10 else 0.0
    return round(s, 3)


def local_number(local: dict) -> int:
    """Track number: the tag, else the file name's leading number."""
    n = _int(local.get("track_number"))
    if n:
        return n
    m = re.match(r"\s*(\d+)", local.get("filename") or "")
    return int(m.group(1)) if m else 0


def unnamed(local: dict) -> bool:
    """No usable title in the tag or the file name (an unidentified rip)."""
    return is_placeholder(local_title(local)) or not _norm(local_title(local))


def _score_by_position(local: dict, mb: dict, disc: int, num: int) -> float:
    """An unnamed track pairs by number and length alone: both must agree."""
    if not num or num != mb["position"]:
        return 0.0
    s = 0.6 if disc == mb["disc"] else 0.45
    d1, d2 = local.get("duration"), mb.get("duration")
    if not (d1 and d2):
        return round(s + 0.2, 3)
    diff = abs(d1 - d2)
    return round(s + 0.4, 3) if diff <= 3 else round(s + 0.2, 3) if diff <= 10 else 0.0


def match(local: list[dict], release_tracks: list[dict]) -> dict[int, tuple[str | None, float]]:
    """{track id: (release track key or None, score)}."""
    pairs = sorted(((score(l, m), l["id"], m["key"]) for l in local for m in release_tracks
                    if unnamed(l) or title_similarity(l, m) >= TITLE_MIN), reverse=True)
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


def quality(local: list[dict], release_tracks: list[dict]) -> dict:
    """
    How well a release fits the selection: the mean best-pair score over YOUR
    tracks (an unmatched track counts 0), so a release missing half the
    album ranks low even if the half it has fits perfectly.
    """
    pairs = match(local, release_tracks)
    matched = sum(1 for k, _ in pairs.values() if k)
    q = sum(sc for _, sc in pairs.values()) / len(local) if local else 0.0
    return {"quality": round(q, 3), "matched": matched, "local": len(local),
            "release_tracks": len(release_tracks), "pairs": pairs}


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
