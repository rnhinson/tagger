"""
Multi-value tags: one tag string holding several values separated by ';'
("Folk; Celtic"). Players differ in what they split on; ';' is the one most
of them (Navidrome, Music Assistant, Jellyfin, Plex) read as a list.

Values compare exactly for browsing (the Tags panel lists what is in the
files), but case-insensitively when editing, so adding "rock" to a track that
has "Rock" doesn't create a duplicate.
"""
from __future__ import annotations

from typing import Iterable

SEP = ";"
JOIN = "; "

# Tags edited as a set of values (add/remove) rather than as one string.
MULTI_FIELDS = ("genre", "composer", "artist", "album_artist")


def split_values(s: str | None) -> list[str]:
    """'Folk ; Celtic;; folk' -> ['Folk', 'Celtic'] (trimmed, blanks and case-duplicates dropped)."""
    out, seen = [], set()
    for part in (s or "").split(SEP):
        part = part.strip()
        if part and part.casefold() not in seen:
            seen.add(part.casefold())
            out.append(part)
    return out


def join_values(values: Iterable[str]) -> str:
    return JOIN.join(values)


def has_value(s: str | None, value: str) -> bool:
    """True when `value` is one of the values in `s` (exact match)."""
    return value in split_values(s)


def has_value_sql(s, value) -> int:
    """SQLite function has_value(column, value) -- registered on every connection."""
    return 1 if value is not None and has_value(s, value) else 0


def edit_values(s: str | None, add: Iterable[str] = (), remove: Iterable[str] = ()) -> str:
    """Remove then add values (case-insensitive), keeping the existing order."""
    gone = {r.strip().casefold() for r in remove}
    values = [v for v in split_values(s) if v.casefold() not in gone]
    have = {v.casefold() for v in values}
    for a in add:
        a = a.strip()
        if a and a.casefold() not in have:
            have.add(a.casefold())
            values.append(a)
    return join_values(values)
