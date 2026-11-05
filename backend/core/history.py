"""
Change history + undo for destructive actions (tag edits, renames, removals).

Each undoable action records a JSON snapshot of the affected rows *before* the
change. Undo replays that snapshot: rewriting tags to disk, moving renamed files
back, and re-inserting removed rows. Cover-art and ReplayGain writes are not
tracked.

Undo checks the files, not just the rows: a track whose file is gone (or whose
tags can't be written back) is reported as missing and its row is left alone,
so the DB never claims a restore that didn't happen on disk.

Undo goes newest-first per track: a change can't be undone while a later,
still-applied change touched the same tracks (its snapshot would be stale).
Each track is committed on its own; a change is only marked undone when every
track was restored, so re-running an undo after fixing the cause is safe.
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from core.config import settings
from core.fileops import MoveError, move_file, prune_empty_dirs, root_for
from core.tagger import TAG_FIELDS, write_tags

# Columns restored when undoing a tag edit (writable to file + DB).
_MB_FIELDS = ["mb_track_id", "mb_artist_id", "mb_album_id", "mb_album_artist_id"]
_WRITABLE = TAG_FIELDS + _MB_FIELDS
# Fields a staged edit may change (core/staging.py).
STAGEABLE = _WRITABLE

# Full column set, used to re-insert a removed row verbatim.
_ALL_COLUMNS = [
    "id", "path", "filename", "directory", "format", "size", "mtime", "duration",
    "bitrate", "sample_rate", "channels",
    *TAG_FIELDS, *_MB_FIELDS, "scanned_at", "tagged_at",
]


def snapshot(row) -> dict:
    """Full dict snapshot of a track row (sqlite3.Row or dict)."""
    return {k: row[k] for k in _ALL_COLUMNS}


def log_change(conn, kind: str, summary: str, snapshots: list[dict],
               dirs: list[dict] | None = None) -> int | None:
    """
    Record an undoable change within the caller's transaction. Returns its id.
    `dirs` are whole-folder moves ({src, dst}) made by the change; undo moves
    each folder back in one piece before restoring the tracks.
    """
    if not snapshots and not dirs:
        return None
    data = {"tracks": snapshots, **({"dirs": dirs} if dirs else {})}
    cur = conn.execute(
        "INSERT INTO change_log (ts, kind, summary, data, undone) VALUES (?, ?, ?, ?, 0)",
        (time.time(), kind, summary, json.dumps(data)),
    )
    return cur.lastrowid


def list_changes(conn, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        "SELECT id, ts, kind, summary, undone, "
        "json_array_length(data, '$.tracks') AS count FROM change_log "
        "ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def undo_change(conn, change_id: int) -> dict:
    """Reverse a logged change. Returns {restored, kind}. Raises ValueError if invalid."""
    row = conn.execute(
        "SELECT * FROM change_log WHERE id = ?", (change_id,)
    ).fetchone()
    if not row:
        raise ValueError("Change not found")
    if row["undone"]:
        raise ValueError("Change already undone")

    payload = json.loads(row["data"])
    tracks = payload.get("tracks", [])
    _check_newest(conn, change_id, {t["id"] for t in tracks})
    errors: list[dict] = []
    if row["kind"] == "tag_edit":
        _undo_dir_moves(conn, payload.get("dirs", []), errors)
        restored = _undo_tag_edits(conn, tracks, errors)
    elif row["kind"] == "remove":
        restored = _undo_removes(conn, tracks)
    elif row["kind"] == "delete_files":
        restored = _undo_deletes(conn, tracks, errors)
    else:
        raise ValueError(f"Cannot undo change of kind {row['kind']!r}")

    if not errors:
        conn.execute("UPDATE change_log SET undone = 1 WHERE id = ?", (change_id,))
    return {"restored": restored, "kind": row["kind"], "errors": errors}


def _check_newest(conn, change_id: int, ids: set[int]) -> None:
    later = conn.execute(
        "SELECT id, summary, data FROM change_log WHERE id > ? AND undone = 0 ORDER BY id DESC",
        (change_id,),
    ).fetchall()
    for c in later:
        if ids & {t["id"] for t in json.loads(c["data"]).get("tracks", [])}:
            raise ValueError(f"Undo the later change first: {c['summary']}")


def repoint_tracks(conn, src: str, dst: str) -> None:
    """Rewrite the paths of every track under folder src to sit under dst."""
    n = len(src) + 1
    conn.execute(
        "UPDATE tracks SET path = ? || substr(path, ?), directory = ? || substr(directory, ?) "
        "WHERE directory = ? OR substr(directory, 1, ?) = ?",
        (dst, n, dst, n, src, n, src + "/"),
    )


def _undo_dir_moves(conn, dirs: list[dict], errors: list[dict]) -> None:
    """Move folders back whole (newest first), so cover art etc. comes along."""
    from api.config import get_library_roots
    from core.fileops import move_dir

    roots = None
    for d in reversed(dirs):
        src, dst = d["src"], d["dst"]
        if Path(src).exists() and not Path(dst).exists():
            continue  # already back
        try:
            move_dir(dst, src)
        except (MoveError, OSError) as exc:
            errors.append({"dir": src, "name": Path(src).name, "error": f"move back failed: {exc}"})
            continue
        repoint_tracks(conn, dst, src)
        conn.commit()
        roots = roots or get_library_roots()
        prune_empty_dirs(Path(dst).parent, root_for(dst, roots) or settings.music_dir)


def _undo_tag_edits(conn, snapshots: list[dict], errors: list[dict]) -> int:
    from api.config import get_library_roots

    restored = 0
    vacated: set[Path] = set()
    for snap in snapshots:
        cur = conn.execute(
            "SELECT path FROM tracks WHERE id = ?", (snap["id"],)
        ).fetchone()
        if not cur:
            continue  # row gone; nothing to restore onto
        old_path = snap["path"]
        cur_path = cur["path"]

        # Move the file back if it was renamed during the change.
        if cur_path != old_path and Path(cur_path).exists():
            try:
                move_file(cur_path, old_path)
            except (MoveError, OSError) as exc:
                errors.append({"id": snap["id"], "name": snap.get("title") or snap["filename"],
                               "error": f"move back failed: {exc}"})
                continue
            vacated.add(Path(cur_path).parent)

        name = snap.get("title") or snap["filename"]
        if not Path(old_path).exists():
            errors.append({"id": snap["id"], "name": name, "error": f"file missing: {cur_path}"})
            continue
        try:
            write_tags(old_path, {k: snap.get(k) for k in _WRITABLE})
        except Exception as exc:
            # The file may have moved back already: record where it is, so a
            # retry starts from there. The tags stay as they were.
            dest = Path(old_path)
            conn.execute("UPDATE tracks SET path = ?, filename = ?, directory = ? WHERE id = ?",
                         (old_path, dest.name, str(dest.parent), snap["id"]))
            conn.commit()
            errors.append({"id": snap["id"], "name": name, "error": f"tag write failed: {exc}"})
            continue

        set_cols = ["path", "filename", "directory", *_WRITABLE, "tagged_at"]
        conn.execute(
            f"UPDATE tracks SET {', '.join(f'{c} = ?' for c in set_cols)} WHERE id = ?",
            [*(snap.get(c) for c in set_cols), snap["id"]],
        )
        conn.commit()
        restored += 1

    if vacated:
        roots = get_library_roots()
        for d in vacated:
            prune_empty_dirs(d, root_for(d, roots) or settings.music_dir)
    return restored


def _reinsert(conn, snap: dict) -> None:
    cols = ", ".join(_ALL_COLUMNS)
    placeholders = ", ".join("?" * len(_ALL_COLUMNS))
    conn.execute(
        f"INSERT OR REPLACE INTO tracks ({cols}) VALUES ({placeholders})",
        [snap.get(c) for c in _ALL_COLUMNS],
    )


def _undo_removes(conn, snapshots: list[dict]) -> int:
    for snap in snapshots:
        _reinsert(conn, snap)
    return len(snapshots)


def _undo_deletes(conn, snapshots: list[dict], errors: list[dict]) -> int:
    """Restore files moved to trash, then re-insert their rows."""
    restored = 0
    for snap in snapshots:
        trash = snap.get("_trash")
        dest = Path(snap["path"])
        if trash and Path(trash).exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(trash, str(dest))
        elif not dest.exists():   # trash emptied, and nobody put it back
            errors.append({"id": snap["id"], "name": snap.get("title") or snap["filename"],
                           "error": "file missing: no copy left in the trash"})
            continue
        _reinsert(conn, snap)
        conn.commit()
        restored += 1
    return restored
