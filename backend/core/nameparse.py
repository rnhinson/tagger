"""
Tags from file names, in the style of Mp3tag's "Filename - Tag": a pattern of
%field% placeholders and literal text, matched against the END of the path
(extension dropped). Each '/' in the pattern is one folder level, so
"%artist%/%album%/%track% - %title%" reads the last two folders and the name.

  %title% %artist% %album% %album_artist% %year% %genre% %composer%
  %track% %disc%   numbers (leading zeros dropped)
  %dummy%          matches anything, sets nothing (repeatable)
"""
from __future__ import annotations

import re
from pathlib import PurePosixPath

FIELDS = {
    "title": "title", "artist": "artist", "album": "album", "album_artist": "album_artist",
    "albumartist": "album_artist", "year": "year", "genre": "genre", "composer": "composer",
    "track": "track_number", "disc": "disc_number", "dummy": None,
}
_TOKEN = re.compile(r"%(\w+)%")
_NUMERIC = {"track_number", "disc_number"}


class PatternError(ValueError):
    pass


def compile_pattern(pattern: str) -> tuple[re.Pattern, list[str], dict[str, str]]:
    """The regex for a pattern, the tag fields it sets (in order), their group names."""
    pattern = pattern.strip().strip("/")
    if not pattern:
        raise PatternError("empty pattern")
    out, fields, groups, pos = [], [], {}, 0
    for m in _TOKEN.finditer(pattern):
        out.append(re.escape(pattern[pos:m.start()]))
        name = m.group(1).lower()
        if name not in FIELDS:
            raise PatternError(f"unknown field %{m.group(1)}%")
        field = FIELDS[name]
        if field is None:
            out.append(r"[^/]*?")
        elif field in groups:
            out.append(f"(?P={groups[field]})")      # same field twice: must match the same text
        else:
            groups[field] = f"f{len(groups)}"
            fields.append(field)
            out.append(rf"(?P<{groups[field]}>\d+)" if field in _NUMERIC else rf"(?P<{groups[field]}>[^/]+?)")
        pos = m.end()
    out.append(re.escape(pattern[pos:]))
    if not fields:
        raise PatternError("the pattern sets no fields -- use %title%, %artist%, …")
    rx = re.compile(r"(?:^|/)" + "".join(out) + r"$")
    return rx, fields, groups


def parse_path(path: str, compiled) -> dict | None:
    """Tag values for one path, or None when the pattern doesn't match."""
    rx, fields, groups = compiled
    p = PurePosixPath(path)
    m = rx.search(str(p.with_suffix("")) if p.suffix else str(p))
    if not m:
        return None
    out = {}
    for f in fields:
        v = m.group(groups[f]).strip()
        out[f] = str(int(v)) if f in _NUMERIC else v
    return out
