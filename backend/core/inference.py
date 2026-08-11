"""
Infer tags from a file's path and name when metadata is missing.

Heuristics only — results are proposals a user reviews before saving. The parser
recognises the common `Artist/Album/NN Title` layout plus a handful of filename
conventions, and never guesses a field it cannot support from the path.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

# "01 - Title", "01. Title", "01 Title", "1-01 Title" (disc-track)
_LEADING_NUM = re.compile(
    r"^\s*(?:(?P<disc>\d{1,2})[-\.])?(?P<track>\d{1,3})\s*[-.\)]?\s+(?P<rest>.+)$"
)
# "Artist - Title"
_ARTIST_TITLE = re.compile(r"^(?P<artist>.+?)\s+-\s+(?P<title>.+)$")
# A 4-digit year anywhere in a folder name, e.g. "1997 - OK Computer" or "(1997)"
_YEAR = re.compile(r"(?:^|[^\d])(19\d{2}|20\d{2})(?:[^\d]|$)")


def _relative_parts(path: str, music_dirs: list[str]) -> list[str]:
    """Path components below the deepest matching music dir (excluding the file)."""
    norm = os.path.normpath(path)
    best: str | None = None
    for d in music_dirs:
        d = os.path.normpath(d)
        if (norm == d or norm.startswith(d + os.sep)) and (best is None or len(d) > len(best)):
            best = d
    parent = os.path.dirname(norm)
    if best and (parent == best or parent.startswith(best + os.sep)):
        rel = os.path.relpath(parent, best)
        parts = [] if rel == "." else rel.split(os.sep)
    else:
        parts = []
    return parts


def _strip_year(name: str) -> tuple[str, str | None]:
    """Return (name_without_year, year) — pulls a leading/parenthesised year out."""
    m = _YEAR.search(name)
    if not m:
        return name.strip(), None
    year = m.group(1)
    cleaned = (name[: m.start(1)] + name[m.end(1) :]).strip(" -–—()[]._")
    return cleaned or name.strip(), year


def infer_tags_from_path(path: str, music_dirs: list[str]) -> dict:
    """
    Return a dict of inferred tag fields (any of title/artist/album/year/
    track_number/disc_number). Only fields confidently derivable are included.
    """
    result: dict[str, str] = {}
    stem = Path(path).stem.strip()
    parts = _relative_parts(path, music_dirs)

    # Directory layout: .../Artist/Album (last two components below the root)
    if len(parts) >= 2:
        album_raw, year = _strip_year(parts[-1])
        result["album"] = album_raw
        if year:
            result["year"] = year
        result["artist"] = parts[-2].strip()
    elif len(parts) == 1:
        album_raw, year = _strip_year(parts[-1])
        # A single folder is more likely the album than the artist
        result["album"] = album_raw
        if year:
            result["year"] = year

    # Filename: leading track/disc number
    title_src = stem
    m = _LEADING_NUM.match(stem)
    if m:
        result["track_number"] = str(int(m.group("track")))
        if m.group("disc"):
            result["disc_number"] = str(int(m.group("disc")))
        title_src = m.group("rest").strip()

    # Filename: "Artist - Title". Only split when the folder didn't already give
    # an artist — otherwise the dash is likely part of the title, not a separator.
    at = _ARTIST_TITLE.match(title_src)
    if at and not result.get("artist"):
        result["artist"] = at.group("artist").strip()
        result["title"] = at.group("title").strip()
    else:
        result["title"] = title_src

    # Normalise separators and drop empties
    return {k: v for k, v in result.items() if v}
