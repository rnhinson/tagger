"""
Library layouts: the folder/file template each library root is expected to
follow, and the path a track would have under it. One standard layout (the
rename template) applies to every library checked in Settings → Libraries;
a library can override it with its own.

The Quality panel's "Not in layout" view lists tracks whose path differs from
their library's layout. Fixing them is always deliberate -- a staged re-file
of chosen tracks, reviewed and undoable -- never automatic.

An unchecked library isn't compared. Rename-on-save and re-file use the
library's override, else the standard layout.
"""
from __future__ import annotations

import os
from pathlib import Path

from core.fileops import root_for
from core.naming import render_template

# Columns the SQL function takes, in order (see sql_function).
COLUMNS = ("path", "title", "artist", "album", "album_artist", "year", "genre",
           "track_number", "disc_number")


def layouts() -> dict[str, str]:
    """{library root: template} for the libraries checked against a layout."""
    from api.config import _load
    s = _load()
    overrides = {os.path.normpath(k): v.strip() for k, v in s.library_templates.items() if v.strip()}
    out = {}
    for root in map(os.path.normpath, s.layout_libraries):
        template = overrides.get(root) or s.rename_template.strip()
        if template:
            out[root] = template
    return out


def expected_path(row, roots: list[Path], templates: dict[str, str]) -> str | None:
    """Where row's layout puts it, or None (no layout, or it can't render)."""
    root = root_for(row["path"], roots)
    template = templates.get(str(root)) if root else None
    if not template:
        return None
    try:
        return str(root / render_template(template, dict(row), Path(row["path"]).suffix))
    except (KeyError, ValueError, IndexError):
        return None


def template_for(path: str, roots: list[Path], fallback: str) -> str:
    """The layout of path's library: its override, else fallback (the standard layout)."""
    from api.config import _load
    root = root_for(path, roots)
    if root is None:
        return fallback
    overrides = {os.path.normpath(k): v.strip() for k, v in _load().library_templates.items()}
    return overrides.get(str(root)) or fallback


def sql_function():
    """
    layout_path(path, title, ...) for SQL (columns as in COLUMNS): the path
    the layout gives, or NULL. Settings are read on first use, once per
    connection.
    """
    cache: dict = {}

    def layout_path(*values):
        if not cache:
            from api.config import get_library_roots
            cache["templates"] = layouts()
            cache["roots"] = get_library_roots() if cache["templates"] else []
        if not cache["templates"]:
            return None
        return expected_path(dict(zip(COLUMNS, values)), cache["roots"], cache["templates"])

    return layout_path
