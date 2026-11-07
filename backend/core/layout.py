"""
Layouts: the folder/file template a track is expected to follow, and the
path it would have under it. A track uses the first layout set of: its
group's (one it was put in -- core/lyricsgroups.py), its library's, the
standard one (the rename template). Only libraries checked in Settings →
Libraries are compared.

The Quality panel's "Not in layout" view lists tracks whose path differs from
their library's layout. Fixing them is always deliberate -- a staged re-file
of chosen tracks, reviewed and undoable -- never automatic.

Rename-on-save and re-file use the same order, checked library or not.
"""
from __future__ import annotations

import os
from pathlib import Path

from core.fileops import root_for
from core.naming import render_template

# Columns the SQL function takes, in order (see sql_function); the last is
# the track's assigned group.
COLUMNS = ("path", "title", "artist", "album", "album_artist", "year", "genre",
           "track_number", "disc_number", "group_id")
SQL_ARGS = ", ".join(COLUMNS[:-1]) + ", (SELECT group_id FROM lyrics_members WHERE track_id = tracks.id)"


class Layouts:
    """Settings read once: which layout a track uses, and whether it's compared."""

    def __init__(self):
        from api.config import _load, get_library_roots
        from core import lyricsgroups
        s = _load()
        self.standard = s.rename_template.strip()
        self.libraries = {os.path.normpath(k): v.strip() for k, v in s.library_templates.items() if v.strip()}
        self.groups = {g["id"]: g.get("layout", "").strip() for g in lyricsgroups.groups() if g.get("layout", "").strip()}
        self.checked = {os.path.normpath(p) for p in s.layout_libraries}
        self.roots = get_library_roots()

    def template(self, path: str, group_id: str | None = None) -> str:
        """Its group's layout, else its library's, else the standard one."""
        if group_id in self.groups:
            return self.groups[group_id]
        root = root_for(path, self.roots)
        return (self.libraries.get(str(root)) if root else None) or self.standard

    def expected(self, row, group_id: str | None = None) -> str | None:
        """Where row belongs, if its library is checked; None otherwise or when it can't render."""
        root = root_for(row["path"], self.roots) if self.checked else None
        if root is None or str(root) not in self.checked:
            return None
        template = self.template(row["path"], group_id)
        if not template:
            return None
        try:
            return str(root / render_template(template, dict(row), Path(row["path"]).suffix))
        except (KeyError, ValueError, IndexError):
            return None


def template_for(conn, row) -> str:
    """The layout row's track uses (see Layouts.template)."""
    from core import lyricsgroups
    return Layouts().template(row["path"], lyricsgroups.assigned(conn, [row["id"]]).get(row["id"]))


def sql_function():
    """
    layout_path(path, title, ..., group_id) for SQL (columns as in COLUMNS):
    the path the layout gives, or NULL. Settings are read on first use, once
    per connection.
    """
    cache: dict = {}

    def layout_path(*values):
        if not cache:
            cache["layouts"] = Layouts()
        row = dict(zip(COLUMNS, values))
        return cache["layouts"].expected(row, row.pop("group_id"))

    return layout_path
