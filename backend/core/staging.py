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

Folder moves/renames are staged separately (`staged_dirs`, src -> dst) and
written as one directory move, so cover art and other non-audio files come
along. Tracks under a staged folder show its destination as their new path.
"""
from __future__ import annotations

import json
import os
import time
from collections import Counter
from pathlib import Path

from core.config import settings
from core.fileops import (
    MoveError, move_dir, move_file, prune_empty_dirs, root_for, same_filesystem,
)
from core.history import STAGEABLE, log_change, repoint_tracks, snapshot
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
    """Staged changes: tracks plus folder moves."""
    return (conn.execute("SELECT COUNT(*) FROM staged").fetchone()[0]
            + conn.execute("SELECT COUNT(*) FROM staged_dirs").fetchone()[0])


# ── Folder moves ──────────────────────────────────────────────────────────────

def load_dirs(conn) -> dict[str, str]:
    return {r["src"]: r["dst"] for r in conn.execute("SELECT src, dst FROM staged_dirs ORDER BY src")}


def moved_path(path: str, dirs: dict[str, str]) -> str | None:
    """Where path ends up when the staged folder containing it moves."""
    for src in sorted(dirs, key=len, reverse=True):
        if path.startswith(src + "/"):
            return dirs[src] + path[len(src):]
    return None


def _save_dir(conn, src: str, dst: str | None) -> None:
    if dst is None:
        conn.execute("DELETE FROM staged_dirs WHERE src = ?", (src,))
        return
    conn.execute(
        "INSERT INTO staged_dirs (src, dst, staged_at) VALUES (?, ?, ?) "
        "ON CONFLICT(src) DO UPDATE SET dst = excluded.dst, staged_at = excluded.staged_at",
        (src, dst, time.time()),
    )


def _under(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder + "/")


def stage_dir(conn, src: str, dst: str, step: "Step | None" = None) -> None:
    """Stage moving folder src to dst. Raises PlanError when it can't be done."""
    from api.config import get_library_roots, get_music_dirs

    src, dst = os.path.normpath(src), os.path.normpath(dst)
    roots = get_library_roots()
    if not Path(src).is_dir():
        raise PlanError("folder not found")
    if src == dst:
        raise PlanError("that is where it already is")
    if src in {str(r) for r in roots} or src in {os.path.normpath(d) for d in get_music_dirs()}:
        raise PlanError("a library root can't be moved or renamed")
    if _under(dst, src):
        raise PlanError("can't move a folder inside itself")
    root = root_for(dst, roots)
    if root is None or str(root) == dst:
        raise PlanError("destination must be inside a library root")
    if Path(dst).exists() and not _same(src, dst):
        raise PlanError("destination already exists")
    dirs = load_dirs(conn)
    for other in dirs:
        if other != src and (_under(other, src) or _under(src, other)):
            raise PlanError("a folder above or inside this one is already staged to move")
        if other != src and dirs[other] == dst:
            raise PlanError("another staged folder has the same destination")
    n = len(src) + 1
    busy = conn.execute(
        "SELECT COUNT(*) FROM staged s JOIN tracks t ON t.id = s.track_id "
        "WHERE s.new_path IS NOT NULL AND (t.directory = ? OR substr(t.directory, 1, ?) = ?)",
        (src, n, src + "/"),
    ).fetchone()[0]
    if busy:
        raise PlanError(f"{busy} track(s) in this folder already have staged moves -- write or discard them first")
    if step:
        step.touch_dir(src)
    _save_dir(conn, src, dst)


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
        self.prev_dirs: dict[str, str | None] = {}

    def touch(self, track_id: int) -> None:
        if track_id not in self.prev:
            self.prev[track_id] = load(self.conn, [track_id]).get(track_id)

    def touch_dir(self, src: str) -> None:
        if src not in self.prev_dirs:
            self.prev_dirs[src] = load_dirs(self.conn).get(src)

    def save(self) -> int | None:
        now = load(self.conn, list(self.prev))
        changed: dict = {str(t): p for t, p in self.prev.items() if p != now.get(t)}
        dirs_now = load_dirs(self.conn)
        changed.update({DIR_KEY + s: d for s, d in self.prev_dirs.items() if d != dirs_now.get(s)})
        if not changed:
            return None
        if "{fields}" in self.summary:
            self.summary = self.summary.replace("{fields}", _changed_fields(self.prev, now))
        return self.conn.execute(
            "INSERT INTO staged_steps (ts, summary, data) VALUES (?, ?, ?)",
            (time.time(), self.summary, json.dumps(changed)),
        ).lastrowid


DIR_KEY = "dir:"  # step keys for folder moves; track keys are the id


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
        if tid.startswith(DIR_KEY):
            continue
        tid = int(tid)
        if not conn.execute("SELECT 1 FROM tracks WHERE id = ?", (tid,)).fetchone():
            continue
        if prev is None:
            _save(conn, tid, {}, None)
        else:
            _save(conn, tid, prev["tags"], prev["new_path"])
        restored += 1
    for key, prev in json.loads(r["data"]).items():
        if key.startswith(DIR_KEY):
            _save_dir(conn, key[len(DIR_KEY):], prev)
            restored += 1
    conn.execute("DELETE FROM staged_steps WHERE id = ?", (r["id"],))
    return {"summary": r["summary"], "restored": restored}


def _forget(conn, ids: list[int] | None, dirs: list[str] = ()) -> None:
    """Drop tracks/folders from every step (they were written or discarded)."""
    if ids is None:
        conn.execute("DELETE FROM staged_steps")
        return
    gone = {str(i) for i in ids} | {DIR_KEY + d for d in dirs}
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
    if app.rename_on_save and not moved_path(row["path"], load_dirs(conn)):
        entry = load(conn, [row["id"]]).get(row["id"])
        try:
            dest = plan_path(row, effective(row, entry), app.rename_template, get_library_roots())
        except PlanError:
            return  # leave the file where it is
        stage(conn, row, new_path=dest, step=step)


def discard(conn, ids: list[int] | None = None, dirs: list[str] | None = None) -> int:
    """Drop staged changes: everything when both are None, else just these."""
    if ids is None and dirs is None:
        _forget(conn, None)
        return (conn.execute("DELETE FROM staged").rowcount
                + conn.execute("DELETE FROM staged_dirs").rowcount)
    ids, dirs = ids or [], dirs or []
    _forget(conn, ids, dirs)
    n = 0
    if ids:
        ph = ",".join("?" * len(ids))
        n += conn.execute(f"DELETE FROM staged WHERE track_id IN ({ph})", ids).rowcount
    for d in dirs:
        n += conn.execute("DELETE FROM staged_dirs WHERE src = ?", (d,)).rowcount
    return n


def apply(conn, ids: list[int] | None = None, summary: str | None = None,
          dirs: list[str] | None = None) -> dict:
    """
    Write staged changes to the files. Per track: tags first, then the move;
    then folder moves (whole folders). Everything when ids and dirs are None.
    Each track/folder is committed on its own, so a failure part-way leaves
    everything written recorded and everything unwritten still staged.
    """
    from api.config import get_library_roots

    entries = load(conn, ids)
    staged_dirs = load_dirs(conn)
    if ids is not None or dirs is not None:
        staged_dirs = {s: d for s, d in staged_dirs.items() if s in (dirs or [])}
    if not entries and not staged_dirs:
        return {"applied": 0, "errors": [], "change_id": None}

    ph = ",".join("?" * len(entries))
    rows = {
        r["id"]: r
        for r in conn.execute(f"SELECT * FROM tracks WHERE id IN ({ph})", list(entries)).fetchall()
    } if entries else {}
    # Two tracks headed for the same file: refuse both.
    dests = Counter(e["new_path"] for e in entries.values() if e["new_path"])
    roots = get_library_roots()

    errors: list[dict] = []
    snaps: dict[int, dict] = {}   # first (pre-change) snapshot per track
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
            snaps.setdefault(tid, snap)

    moved_dirs: list[dict] = []
    for src, dst in staged_dirs.items():
        problem = None
        if not Path(src).is_dir():
            problem = "folder no longer exists"
        elif Path(dst).exists() and not _same(src, dst):
            problem = "destination already exists"
        elif not same_filesystem(src, dst):
            problem = "destination is on a different filesystem -- outside the mounted library?"
        if problem:
            errors.append({"dir": src, "name": Path(src).name, "error": problem})
            continue
        n = len(src) + 1
        under = conn.execute(
            "SELECT * FROM tracks WHERE directory = ? OR substr(directory, 1, ?) = ?",
            (src, n, src + "/"),
        ).fetchall()
        try:
            move_dir(src, dst)
        except (MoveError, OSError) as exc:
            errors.append({"dir": src, "name": Path(src).name, "error": f"move failed: {exc}"})
            continue
        for r in under:
            snaps.setdefault(r["id"], snapshot(r))
        repoint_tracks(conn, src, dst)
        _save_dir(conn, src, None)
        _forget(conn, [], [src])
        conn.commit()
        moved_dirs.append({"src": src, "dst": dst})
        vacated.append(Path(src).parent)

    for d in set(vacated):
        stop = root_for(d, roots) or settings.music_dir
        prune_empty_dirs(d, stop)

    n = len(snaps)
    if not summary:
        summary = f"Wrote changes to {n} track{'s' if n != 1 else ''}"
        if moved_dirs:
            summary += f" ({len(moved_dirs)} folder{'s' if len(moved_dirs) != 1 else ''} moved)"
    change_id = log_change(conn, "tag_edit", summary, list(snaps.values()), moved_dirs)
    return {"applied": n, "folders": len(moved_dirs), "errors": errors, "change_id": change_id}


def _same(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False
