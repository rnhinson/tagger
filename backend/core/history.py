"""
Change history + undo for destructive actions (tag edits, renames, removals).

Each undoable action records a JSON snapshot of the affected rows *before* the
change. Undo replays that snapshot: rewriting tags to disk, moving renamed files
back, and re-inserting removed rows. Cover-art and ReplayGain writes are not
tracked.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from core.tagger import TAG_FIELDS, write_tags

# Columns restored when undoing a tag edit (writable to file + DB).
_MB_FIELDS = ["mb_track_id", "mb_artist_id", "mb_album_id", "mb_album_artist_id"]
_WRITABLE = TAG_FIELDS + _MB_FIELDS

# Full column set, used to re-insert a removed row verbatim.
_ALL_COLUMNS = [
    "id", "path", "filename", "directory", "format", "size", "mtime", "duration",
    *TAG_FIELDS, *_MB_FIELDS, "scanned_at", "tagged_at",
]


def snapshot(row) -> dict:
    """Full dict snapshot of a track row (sqlite3.Row or dict)."""
    return {k: row[k] for k in _ALL_COLUMNS}


def log_change(conn, kind: str, summary: str, snapshots: list[dict]) -> None:
    """Record an undoable change within the caller's transaction."""
    if not snapshots:
        return
    conn.execute(
        "INSERT INTO change_log (ts, kind, summary, data, undone) VALUES (?, ?, ?, ?, 0)",
        (time.time(), kind, summary, json.dumps({"tracks": snapshots})),
    )


def list_changes(conn, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        "SELECT id, ts, kind, summary, undone FROM change_log "
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
    if row["kind"] == "tag_edit":
        restored = _undo_tag_edits(conn, tracks)
    elif row["kind"] == "remove":
        restored = _undo_removes(conn, tracks)
    else:
        raise ValueError(f"Cannot undo change of kind {row['kind']!r}")

    conn.execute("UPDATE change_log SET undone = 1 WHERE id = ?", (change_id,))
    return {"restored": restored, "kind": row["kind"]}


def _undo_tag_edits(conn, snapshots: list[dict]) -> int:
    restored = 0
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
            dest = Path(old_path)
            dest.parent.mkdir(parents=True, exist_ok=True)
            Path(cur_path).rename(dest)

        try:
            write_tags(old_path, {k: snap.get(k) for k in _WRITABLE})
        except Exception:
            pass  # file may be unreadable; still restore the DB row

        set_cols = ["path", "filename", "directory", *_WRITABLE, "tagged_at"]
        conn.execute(
            f"UPDATE tracks SET {', '.join(f'{c} = ?' for c in set_cols)} WHERE id = ?",
            [*(snap.get(c) for c in set_cols), snap["id"]],
        )
        restored += 1
    return restored


def _undo_removes(conn, snapshots: list[dict]) -> int:
    restored = 0
    cols = ", ".join(_ALL_COLUMNS)
    placeholders = ", ".join("?" * len(_ALL_COLUMNS))
    for snap in snapshots:
        conn.execute(
            f"INSERT OR REPLACE INTO tracks ({cols}) VALUES ({placeholders})",
            [snap.get(c) for c in _ALL_COLUMNS],
        )
        restored += 1
    return restored
