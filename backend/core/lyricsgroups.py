"""
Lyrics groups: how a track's lyrics are looked up, or that they aren't.

A group is a list of queries, tried in order until LRCLIB has something.
Each query is a title / artist / album template over the track's tags (plus
the cleaned-up variables below). A query with no artist searches by title +
album -- what finds cast recordings, whose artist tag is rarely what LRCLIB
files them under. A "skip" group is never looked up, and its tracks don't
count as missing lyrics.

A track's group: the one it was assigned (lyrics_members), else its
library's default (Settings → Libraries), else Standard. Assignments live in
Tagger's DB, not the files.
"""
from __future__ import annotations

import os
import re
import string

from core.multivalue import split_values

STANDARD, NONE = "standard", "none"

DEFAULT_GROUPS = [
    {"id": STANDARD, "name": "Standard", "skip": False, "queries": [
        {"title": "{title}", "artist": "{artist}", "album": "{album}"},
        {"title": "{title_base}", "artist": "{artist_first}", "album": ""},
    ]},
    {"id": "cast", "name": "Cast album", "skip": False, "queries": [
        {"title": "{title_base}", "artist": "{artist_first}", "album": "{album}"},
        {"title": "{title_base}", "artist": "{album_artist_first}", "album": ""},
        {"title": "{title_base}", "artist": "", "album": "{album_base}"},
    ]},
    {"id": "soundtrack", "name": "Soundtrack", "skip": False, "queries": [
        {"title": "{title_base}", "artist": "{artist_first}", "album": ""},
        {"title": "{title_base}", "artist": "", "album": "{album_base}"},
    ]},
    {"id": NONE, "name": "No lyrics", "skip": True, "queries": []},
]

FIELDS = ("title", "artist", "album")
VARIABLES = ("title", "artist", "album", "album_artist", "year", "title_base", "album_base",
             "artist_first", "album_artist_first")

# Trailing "(Original Broadway Cast Recording)", "[Live]", ' (From "Frozen")',
# " - From the Motion Picture …": what LRCLIB's names usually lack.
_TAIL = re.compile(r'(\s*(\([^)]*\)|\[[^\]]*\]))+\s*$|\s+-\s+(from|theme from)\b.*$', re.IGNORECASE)


def _base(s: str) -> str:
    out = _TAIL.sub("", s or "").strip()
    return out or (s or "").strip()


def variables(track) -> dict:
    t = dict(track)
    v = {k: (t.get(k) or "").strip() if isinstance(t.get(k), str) else str(t.get(k) or "") for k in
         ("title", "artist", "album", "album_artist", "year")}
    v["title_base"], v["album_base"] = _base(v["title"]), _base(v["album"])
    v["artist_first"] = (split_values(v["artist"]) or [""])[0]
    v["album_artist_first"] = (split_values(v["album_artist"]) or [""])[0]
    return v


def _render(template: str, v: dict) -> str:
    return " ".join(template.format_map(v).split())


def check(template: str) -> None:
    """Raise ValueError naming the problem if template uses anything but VARIABLES."""
    for _, name, spec, conv in string.Formatter().parse(template):
        if name is None:
            continue
        if name not in VARIABLES or spec or conv:
            raise ValueError(f"unknown variable {{{name}}}" if name not in VARIABLES
                             else f"{{{name}}} takes no format")


def queries(group: dict, track) -> list[dict]:
    """The group's queries rendered for track: distinct, each with a title."""
    v, out = variables(track), []
    for q in group.get("queries", []):
        r = {f: _render(q.get(f, ""), v) for f in FIELDS}
        if r["title"] and (r["artist"] or r["album"]) and r not in out:
            out.append(r)
    return out


def groups() -> list[dict]:
    """The configured groups; Standard and No lyrics always exist."""
    from api.config import _load
    have = [g.model_dump() for g in _load().lyrics_groups] or [dict(g) for g in DEFAULT_GROUPS]
    ids = {g["id"] for g in have}
    for g in DEFAULT_GROUPS:
        if g["id"] in (STANDARD, NONE) and g["id"] not in ids:
            have.append(dict(g))
    return have


def resolver():
    """group_for(path, assigned_id) -> group, with settings read once."""
    from api.config import _load, get_library_roots
    from core.fileops import root_for
    by_id = {g["id"]: g for g in groups()}
    defaults = {os.path.normpath(k): v for k, v in _load().library_lyrics_groups.items() if v in by_id}
    roots = get_library_roots() if defaults else []

    def group_for(path: str, assigned: str | None) -> dict:
        if assigned in by_id:
            return by_id[assigned]
        root = root_for(path, roots) if roots else None
        return by_id[defaults.get(str(root), STANDARD)] if root else by_id[STANDARD]

    return group_for


def assigned(conn, ids: list[int]) -> dict[int, str]:
    out = {}
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        out.update(conn.execute(f"SELECT track_id, group_id FROM lyrics_members WHERE track_id IN "
                                f"({','.join('?' * len(chunk))})", chunk).fetchall())
    return out


def lookups(conn, ids: list[int]) -> dict[int, dict]:
    out = {}
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        for r in conn.execute(f"SELECT * FROM lyrics_lookups WHERE track_id IN "
                              f"({','.join('?' * len(chunk))})", chunk):
            out[r["track_id"]] = {"status": r["status"], "at": r["at"]}
    return out


def assign(conn, ids: list[int], group_id: str | None) -> int:
    """Put tracks in a group; None = back to their library's default."""
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        conn.execute(f"DELETE FROM lyrics_members WHERE track_id IN ({','.join('?' * len(chunk))})", chunk)
    if group_id:
        conn.executemany("INSERT INTO lyrics_members (track_id, group_id) VALUES (?, ?)",
                         [(i, group_id) for i in ids])
    return len(ids)


def record(conn, track_id: int, status: str, at: float) -> None:
    conn.execute("INSERT INTO lyrics_lookups (track_id, status, at) VALUES (?, ?, ?) "
                 "ON CONFLICT(track_id) DO UPDATE SET status = excluded.status, at = excluded.at",
                 (track_id, status, at))


def sql_function():
    """lyrics_skip(path, assigned_id) for SQL: 1 when the track's group is never looked up."""
    cache: dict = {}

    def lyrics_skip(path, group_id):
        if not cache:
            cache["for"] = resolver()
        return 1 if cache["for"](path, group_id)["skip"] else 0

    return lyrics_skip


def look_up(track, group: dict, prefer: str = "synced") -> dict:
    """
    Try the group's queries in order: {'status', 'lyrics', 'query'}. Status is
    synced | plain | instrumental | missing | untagged; 'query' is the one that
    answered (or None).
    """
    from core import lyrics as lrclib
    qs = queries(group, track)
    if not qs:
        return {"status": "untagged", "lyrics": None, "query": None}
    t = dict(track)
    for q in qs:
        hit = (lrclib.fetch(q["title"], q["artist"], q["album"] or None, t.get("duration")) if q["artist"]
               else lrclib.fetch_by_album(q["title"], q["album"], t.get("duration")))
        if not hit:
            continue
        if hit["instrumental"] and not (hit["synced"] or hit["plain"]):
            return {"status": "instrumental", "lyrics": None, "query": q}
        text = (hit["synced"] or hit["plain"]) if prefer == "synced" else (hit["plain"] or hit["synced"])
        return {"status": "synced" if text == hit["synced"] else "plain", "lyrics": text, "query": q}
    return {"status": "missing", "lyrics": None, "query": None}
