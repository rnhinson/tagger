"""
Staged changes: edits are held in the `staged` table and only reach the files
when they are written (apply). Every editing endpoint stages; with the
`stage_changes` setting off, the endpoint applies its own tracks right away,
so there is one write path either way.

A staged entry per track holds tag values that differ from the DB row and an
optional new path (organize / rename-on-save). Writing is one undoable change.
"""
from __future__ import annotations

import json
import os
import time
from collections import Counter
from pathlib import Path

from core.config import settings
from core.fileops import (
    MoveError, move_file, prune_empty_dirs, root_for, same_filesystem,
)
from core.history import STAGEABLE, log_change, snapshot
from core.naming import render_template
from core.tagger import write_tags

_UNSET = object()


class PlanError(Exception):
    pass


def _norm(v) -> str:
    return "" if v is None else str(v)


def load(conn, ids: list[int] | None = None) -> dict[int, dict]:
    """{track_id: {"tags": {...}, "new_path": str|None}} for staged tracks."""
    if ids is None:
        rows = conn.execute("SELECT * FROM staged").fetchall()
    else:
        if not ids:
            return {}
        ph = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT * FROM staged WHERE track_id IN ({ph})", ids).fetchall()
    return {
        r["track_id"]: {"tags": json.loads(r["tags"]), "new_path": r["new_path"]}
        for r in rows
    }


def count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM staged").fetchone()[0]


def effective(row, entry: dict | None) -> dict:
    """The row as it will be once its staged tags are written."""
    d = dict(row)
    if entry:
        d.update(entry["tags"])
    return d


def _save(conn, track_id: int, tags: dict, new_path: str | None) -> None:
    if not tags and not new_path:
        conn.execute("DELETE FROM staged WHERE track_id = ?", (track_id,))
        return
    conn.execute(
        "INSERT INTO staged (track_id, tags, new_path, staged_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(track_id) DO UPDATE SET tags = excluded.tags, "
        "new_path = excluded.new_path, staged_at = excluded.staged_at",
        (track_id, json.dumps(tags), new_path, time.time()),
    )


def stage(conn, row, tags: dict | None = None, new_path=_UNSET) -> None:
    """Merge tags (and/or a new path) into row's staged entry."""
    cur = load(conn, [row["id"]]).get(row["id"], {"tags": {}, "new_path": None})
    merged = {**cur["tags"], **{k: v for k, v in (tags or {}).items() if k in STAGEABLE}}
    # A value equal to what is on file is not a change.
    merged = {k: v for k, v in merged.items() if _norm(v) != _norm(row[k])}
    path = cur["new_path"] if new_path is _UNSET else new_path
    if path == row["path"]:
        path = None
    _save(conn, row["id"], merged, path)


def plan_path(row, tags: dict, template: str, roots: list[Path]) -> str:
    """Absolute destination for row under its library root. Raises PlanError."""
    root = root_for(row["path"], roots)
    if root is None:
        raise PlanError("not inside a library root (see Settings → Library roots)")
    try:
        rel = render_template(template, tags, Path(row["path"]).suffix)
    except (KeyError, ValueError, IndexError) as exc:
        raise PlanError(f"bad template: {exc}")
    return str(root / rel)


def stage_edit(conn, row, tags: dict) -> None:
    """Stage a tag edit; with rename-on-save, also stage the matching path."""
    from api.config import _load as load_settings, get_library_roots

    stage(conn, row, tags)
    app = load_settings()
    if app.rename_on_save:
        entry = load(conn, [row["id"]]).get(row["id"])
        try:
            dest = plan_path(row, effective(row, entry), app.rename_template, get_library_roots())
        except PlanError:
            return  # leave the file where it is
        stage(conn, row, new_path=dest)


def discard(conn, ids: list[int] | None = None) -> int:
    if ids is None:
        return conn.execute("DELETE FROM staged").rowcount
    if not ids:
        return 0
    ph = ",".join("?" * len(ids))
    return conn.execute(f"DELETE FROM staged WHERE track_id IN ({ph})", ids).rowcount


def apply(conn, ids: list[int] | None = None, summary: str | None = None) -> dict:
    """
    Write staged changes to the files. Per track: tags first, then the move.
    Each track is committed on its own, so a failure part-way leaves every
    written track recorded and every unwritten one still staged.
    """
    from api.config import get_library_roots

    entries = load(conn, ids)
    if not entries:
        return {"applied": 0, "errors": [], "change_id": None}

    ph = ",".join("?" * len(entries))
    rows = {
        r["id"]: r
        for r in conn.execute(f"SELECT * FROM tracks WHERE id IN ({ph})", list(entries)).fetchall()
    }
    # Two tracks headed for the same file: refuse both.
    dests = Counter(e["new_path"] for e in entries.values() if e["new_path"])
    roots = get_library_roots()

    errors: list[dict] = []
    snaps: list[dict] = []
    vacated: list[Path] = []
    for tid, entry in entries.items():
        row = rows.get(tid)
        if row is None:
            discard(conn, [tid])
            continue
        tags, new = entry["tags"], entry["new_path"]
        name = row["title"] or row["filename"]
        if new:
            problem = None
            if dests[new] > 1:
                problem = "another staged track has the same destination"
            elif not same_filesystem(row["path"], new):
                problem = (
                    "destination is on a different filesystem -- outside the "
                    "mounted library? Check Settings → Library roots"
                )
            elif Path(new).exists() and not _same(row["path"], new):
                problem = "destination already exists"
            if problem:
                errors.append({"id": tid, "name": name, "error": problem})
                continue

        snap = snapshot(row)
        if tags:
            try:
                write_tags(row["path"], tags)
            except Exception as exc:
                errors.append({"id": tid, "name": name, "error": f"tag write failed: {exc}"})
                continue

        moved_to = None
        if new:
            try:
                move_file(row["path"], new)
                moved_to = new
            except (MoveError, OSError) as exc:
                errors.append({"id": tid, "name": name, "error": f"move failed: {exc}"})

        sets = dict(tags)
        if moved_to:
            dest = Path(moved_to)
            sets.update(path=moved_to, filename=dest.name, directory=str(dest.parent))
            vacated.append(Path(row["path"]).parent)
        if sets:
            sets["tagged_at"] = time.time()
            conn.execute(
                f"UPDATE tracks SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                [*sets.values(), tid],
            )
        # Keep a failed move staged so it can be retried; the tags are done.
        _save(conn, tid, {}, None if (moved_to or not new) else new)
        conn.commit()
        if sets:
            snaps.append(snap)

    for d in set(vacated):
        stop = root_for(d, roots) or settings.music_dir
        prune_empty_dirs(d, stop)

    n = len(snaps)
    change_id = log_change(
        conn, "tag_edit", summary or f"Wrote changes to {n} track{'s' if n != 1 else ''}", snaps,
    )
    return {"applied": n, "errors": errors, "change_id": change_id}


def _same(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False
