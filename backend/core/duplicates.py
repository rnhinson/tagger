"""
Duplicate tracks and albums.

Tracks are duplicates when they are the same recording more than once:
- by tags: the same cleaned-up title and first artist ("The", "feat. X",
  "(Remastered)" and the like ignored) AND lengths within TOLERANCE seconds,
  so a live take or a remix of the same song isn't one;
- by sound: chromaprint fingerprints (fpcalc, stored by the fingerprint job)
  that match, which catches copies whose tags disagree.
Both kinds merge into one set of groups, each ranked keeper-first (lossless,
then bitrate, sample rate, size).

Albums are duplicates when the same cleaned-up album + album artist sits in
more than one folder.

refresh(conn) recomputes the groups; the dup_rank(id) / dup_album(directory)
SQL functions read the last result, so the Quality views and their counts
call refresh first.
"""
from __future__ import annotations

import json
import re

from core.lyricsgroups import _base
from core.multivalue import split_values

TOLERANCE = 2.0          # seconds two copies' lengths may differ
LOSSLESS = {"flac", "alac", "wav", "aiff", "aif", "ape", "wv"}

# Fingerprints: compare this many values (~0.12 s each) at offsets up to
# SHIFT, and call it the same recording when SIMILAR of the bits agree.
COMPARE, SHIFT, SIMILAR = 120, 3, 0.85

_FEAT = re.compile(r"\s*[(\[]?\b(feat\.?|ft\.?|featuring)\s.*$", re.IGNORECASE)
_EDITION = re.compile(r"\s+-\s+[^-]*\b(remaster(ed)?|version|edit|mono|stereo|mix)\b.*$", re.IGNORECASE)
_PUNCT = re.compile(r"[^\w]+")


def norm_title(s: str | None) -> str:
    s = _EDITION.sub("", _FEAT.sub("", s or ""))
    return _PUNCT.sub(" ", _base(s).casefold()).strip()


def norm_artist(s: str | None) -> str:
    first = _FEAT.sub("", (split_values(s or "") or [""])[0]).casefold()
    first = re.sub(r"^the\s+", "", first.strip())
    return _PUNCT.sub(" ", first).strip()


def rank_key(r) -> tuple:
    """Bigger is better: lossless, then bitrate, sample rate, size."""
    return ((r["format"] or "").lower() in LOSSLESS, r["bitrate"] or 0, r["sample_rate"] or 0, r["size"] or 0)


def _by_tags(rows) -> list[list[int]]:
    buckets: dict[tuple, list] = {}
    for r in rows:
        k = (norm_title(r["title"]), norm_artist(r["artist"]))
        if all(k):
            buckets.setdefault(k, []).append(r)
    out = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        # Clusters of lengths no more than TOLERANCE apart; no length fits anywhere.
        members.sort(key=lambda r: r["duration"] or 0)
        cluster, last = [members[0]], members[0]["duration"]
        for r in members[1:]:
            d = r["duration"]
            if d is None or last is None or d - last <= TOLERANCE:
                cluster.append(r)
            else:
                out.append(cluster)
                cluster = [r]
            last = d if d is not None else last
        out.append(cluster)
    return [[r["id"] for r in c] for c in out if len(c) > 1]


def _similar(a: list[int], b: list[int]) -> float:
    best = 0.0
    for off in range(-SHIFT, SHIFT + 1):
        x, y = (a[off:], b) if off >= 0 else (a, b[-off:])
        n = min(len(x), len(y), COMPARE)
        if n < 30:
            continue
        diff = sum(((x[i] ^ y[i]) & 0xFFFFFFFF).bit_count() for i in range(n))
        best = max(best, 1 - diff / (32 * n))
    return best


def _by_sound(conn) -> list[list[int]]:
    rows = conn.execute(
        "SELECT f.track_id, f.fp, t.duration FROM fingerprints f JOIN tracks t ON t.id = f.track_id "
        "WHERE f.fp != '' AND f.mtime = t.mtime").fetchall()
    fps = {r["track_id"]: (json.loads(r["fp"]), r["duration"] or 0) for r in rows}
    # Candidates share several exact values (their top 20 bits) early on.
    index: dict[int, list[int]] = {}
    for tid, (fp, _) in fps.items():
        for v in set(x >> 12 for x in fp[8:72]):
            index.setdefault(v, []).append(tid)
    shared: dict[tuple[int, int], int] = {}
    for ids in index.values():
        if len(ids) > 200:          # silence and the like: matches everything
            continue
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                k = (a, b) if a < b else (b, a)
                shared[k] = shared.get(k, 0) + 1
    pairs = [(a, b) for (a, b), n in shared.items()
             if n >= 4 and abs(fps[a][1] - fps[b][1]) <= TOLERANCE + 1
             and _similar(fps[a][0], fps[b][0]) >= SIMILAR]
    return [list(p) for p in pairs]


def compute(conn) -> list[list[int]]:
    """Duplicate groups (track ids), each keeper-first, largest groups first."""
    rows = {r["id"]: r for r in conn.execute(
        "SELECT id, title, artist, duration, format, bitrate, sample_rate, size FROM tracks")}
    parent: dict[int, int] = {}

    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    for group in _by_tags(rows.values()) + _by_sound(conn):
        for g in group:
            parent.setdefault(g, g)
        root = find(group[0])
        for g in group[1:]:
            parent[find(g)] = root
    groups: dict[int, list[int]] = {}
    for x in parent:
        groups.setdefault(find(x), []).append(x)
    out = [sorted(g, key=lambda i: rank_key(rows[i]), reverse=True) for g in groups.values() if len(g) > 1]
    out.sort(key=lambda g: (norm_artist(rows[g[0]]["artist"]), norm_title(rows[g[0]]["title"])))
    return out


def albums(conn) -> list[list[str]]:
    """Folders holding the same album (cleaned-up album + album artist), two or more each."""
    seen: dict[tuple, set] = {}
    for r in conn.execute("SELECT DISTINCT directory, album, COALESCE(NULLIF(album_artist, ''), artist) AS aa "
                          "FROM tracks WHERE album IS NOT NULL AND album != ''"):
        k = (norm_title(r["album"]), norm_artist(r["aa"]))
        if k[0]:
            seen.setdefault(k, set()).add(r["directory"])
    return [sorted(d) for d in seen.values() if len(d) > 1]


# Last computed: track id -> its group's position; folder -> its album group's.
_rank: dict[int, int] = {}
_folders: dict[str, int] = {}


_state: tuple | None = None


def refresh(conn) -> None:
    """Recompute, unless nothing that matters changed since the last time."""
    global _rank, _folders, _state
    from core.config import settings
    state = (str(settings.config_dir), *conn.execute(
        "SELECT (SELECT COUNT(*) FROM tracks), (SELECT MAX(COALESCE(tagged_at, 0)) FROM tracks), "
        "(SELECT MAX(scanned_at) FROM tracks), (SELECT COUNT(*) FROM fingerprints), (SELECT TOTAL(mtime) FROM fingerprints), "
        "(SELECT COALESCE(SUM(id), 0) FROM tracks)").fetchone())
    if state == _state:
        return
    _rank = {tid: i for i, g in enumerate(compute(conn)) for tid in g}
    _folders = {d: i for i, g in enumerate(albums(conn)) for d in g}
    _state = state


def dup_rank(track_id):
    return _rank.get(track_id)


def dup_album(directory):
    return _folders.get(directory)
