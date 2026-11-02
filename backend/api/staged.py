"""Review, write or discard staged changes (core/staging.py)."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import staging
from core.database import db

router = APIRouter()


class Selection(BaseModel):
    # None = every staged track
    track_ids: Optional[list[int]] = None


@router.get("")
def list_staged():
    """Every staged track with a field-by-field diff (current -> staged)."""
    with db() as conn:
        entries = staging.load(conn)
        if not entries:
            return {"count": 0, "tracks": []}
        ph = ",".join("?" * len(entries))
        rows = conn.execute(
            f"SELECT * FROM tracks WHERE id IN ({ph}) ORDER BY directory, disc_number, track_number, filename",
            list(entries),
        ).fetchall()
    tracks = []
    for r in rows:
        e = entries[r["id"]]
        tracks.append({
            "id": r["id"],
            "title": r["title"],
            "filename": r["filename"],
            "path": r["path"],
            "new_path": e["new_path"],
            "changes": [{"field": k, "old": r[k], "new": v} for k, v in e["tags"].items()],
        })
    return {"count": len(tracks), "tracks": tracks}


@router.get("/count")
def staged_count():
    """Staged tracks, plus the staging undo stack (newest step first)."""
    with db() as conn:
        return {
            "count": staging.count(conn),
            "steps": staging.step_count(conn),
            "last_step": staging.last_step(conn),
        }


@router.post("/undo")
def undo_staged_step():
    """Undo the newest staging action (nothing on disk changes)."""
    with db() as conn:
        try:
            return staging.undo_step(conn)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.post("/apply")
def apply_staged(sel: Selection):
    with db() as conn:
        return staging.apply(conn, sel.track_ids)


@router.post("/discard")
def discard_staged(sel: Selection):
    with db() as conn:
        return {"discarded": staging.discard(conn, sel.track_ids)}
