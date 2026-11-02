"""
Staged changes: edits are held in the `staged` table and only reach the files
when they are written (apply). Every editing endpoint stages; with the
`stage_changes` setting off, the endpoint applies its own tracks right away,
so there is one write path either way.

A staged entry per track holds tag values that differ from the DB row and an
optional new path (organize / rename-on-save). Writing is one undoable change.

Each staging action is a Step: it records the entries it replaced, so staged
work can be undone one action at a time (newest first) before it is written.
Writing or discarding a track drops it from every step.
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


class Step:
    """One staging action; call save() when done to make it undoable."""

    def __init__(self, conn, summary: str):
        self.conn, self.summary = conn, summary
        self.prev: dict[int, dict | None] = {}

    def touch(self, track_id: int) -> None:
        if track_id not in self.prev:
            self.prev[track_id] = load(self.conn, [track_id]).get(track_id)

    def save(self) -> int | None:
        now = load(self.conn, list(self.prev))
        changed = {str(t): p for t, p in self.prev.items() if p != now.get(t)}
        if not changed:
            return None
        if "{fields}" in self.summary:
            self.summary = self.summary.replace("{fields}", _changed_fields(self.prev, now))
        return self.conn.execute(
            "INSERT INTO staged_steps (ts, summary, data) VALUES (?, ?, ?)",
            (time.time(), self.summary, json.dumps(changed)),
        ).lastrowid


def _changed_fields(prev: dict, now: dict) -> str:
    """'genre, year' -- what a step changed, for its label."""
    fields: list[str] = []
    for t, p in prev.items():
        a, b = p or {"tags": {}, "new_path": None}, now.get(t) or {"tags": {}, "new_path": None}
        for k in sorted(set(a["tags"]) | set(b["tags"])):
            if a["tags"].get(k) != b["tags"].get(k) and k not in fields:
                fields.append(k)
        if a["new_path"] != b["new_path"] and "location" not in fields:
            fields.append("location")
    names = [f.replace("_", " ") for f in fields]
    return ", ".join(names[:3]) + (f" +{len(names) - 3}" if len(names) > 3 else "") or "tags"


def last_step(conn) -> dict | None:
    r = conn.execute(
        "SELECT id, ts, summary, data FROM staged_steps ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not r:
        return None
    return {"id": r["id"], "ts": r["ts"], "summary": r["summary"], "count": len(json.loads(r["data"]))}


def step_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM staged_steps").fetchone()[0]


def undo_step(conn) -> dict:
    """Put back what the newest staging action replaced. Raises ValueError if none."""
    r = conn.execute("SELECT * FROM staged_steps ORDER BY id DESC LIMIT 1").fetchone()
    if not r:
        raise ValueError("Nothing staged to undo")
    restored = 0
    for tid, prev in json.loads(r["data"]).items():
        tid = int(tid)
        if not conn.execute("SELECT 1 FROM tracks WHERE id = ?", (tid,)).fetchone():
            continue
        if prev is None:
            _save(conn, tid, {}, None)
        else:
            _save(conn, tid, prev["tags"], prev["new_path"])
        restored += 1
    conn.execute("DELETE FROM staged_steps WHERE id = ?", (r["id"],))
    return {"summary": r["summary"], "restored": restored}


def _forget(conn, ids: list[int] | None) -> None:
    """Drop tracks from every step (they were written or discarded)."""
    if ids is None:
        conn.execute("DELETE FROM staged_steps")
        return
    gone = {str(i) for i in ids}
    for r in conn.execute("SELECT id, data FROM staged_steps").fetchall():
        data = json.loads(r["data"])
        kept = {k: v for k, v in data.items() if k not in gone}
        if len(kept) == len(data):
            continue
        if kept:
            conn.execute("UPDATE staged_steps SET data = ? WHERE id = ?", (json.dumps(kept), r["id"]))
        else:
            conn.execute("DELETE FROM staged_steps WHERE id = ?", (r["id"],))


def stage(conn, row, tags: dict | None = None, new_path=_UNSET, step: Step | None = None) -> None:
    """Merge tags (and/or a new path) into row's staged entry."""
    if step:
        step.touch(row["id"])
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


def stage_edit(conn, row, tags: dict, step: Step | None = None) -> None:
    """Stage a tag edit; with rename-on-save, also stage the matching path."""
    from api.config import _load as load_settings, get_library_roots

    stage(conn, row, tags, step=step)
    app = load_settings()
    if app.rename_on_save:
        entry = load(conn, [row["id"]]).get(row["id"])
        try:
            dest = plan_path(row, effective(row, entry), app.rename_template, get_library_roots())
        except PlanError:
            return  # leave the file where it is
        stage(conn, row, new_path=dest, step=step)


def discard(conn, ids: list[int] | None = None) -> int:
    _forget(conn, ids)
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
        _forget(conn, [tid])
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
