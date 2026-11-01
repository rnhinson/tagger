from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import staging
from core.database import db
from core.tagger import TAG_FIELDS
from core.replaygain import rg_tool, scan as rg_scan
from api.config import _load as load_settings, get_library_roots

router = APIRouter()


def _finish(conn, ids: list[int], summary: str) -> dict:
    """With staging off, write what was just staged for these tracks."""
    if load_settings().stage_changes:
        return {"staged": True}
    res = staging.apply(conn, ids, summary)
    return {"staged": False, "applied": res["applied"], "errors": res["errors"]}


def _rows(conn, ids: list[int]) -> list:
    if not ids:
        return []
    ph = ",".join("?" * len(ids))
    return conn.execute(f"SELECT * FROM tracks WHERE id IN ({ph})", ids).fetchall()


class TagUpdate(BaseModel):
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[str] = None
    genre: Optional[str] = None
    track_number: Optional[str] = None
    disc_number: Optional[str] = None
    comment: Optional[str] = None
    composer: Optional[str] = None
    bpm: Optional[str] = None
    lyrics: Optional[str] = None
    compilation: Optional[str] = None
    mb_track_id: Optional[str] = None
    mb_artist_id: Optional[str] = None
    mb_album_id: Optional[str] = None
    mb_album_artist_id: Optional[str] = None


class BulkTagUpdate(BaseModel):
    track_ids: list[int]
    tags: TagUpdate


class ReplayGainRequest(BaseModel):
    track_ids: list[int]
    album_mode: bool = False


@router.get("/replaygain/status")
def replaygain_status():
    tool = rg_tool()
    return {"available": tool is not None, "tool": tool}


@router.post("/replaygain")
def scan_replaygain(req: ReplayGainRequest):
    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    with db() as conn:
        placeholders = ",".join("?" * len(req.track_ids))
        rows = conn.execute(
            f"SELECT path FROM tracks WHERE id IN ({placeholders})", req.track_ids
        ).fetchall()
    paths = [r["path"] for r in rows]
    try:
        return rg_scan(paths, album_mode=req.album_mode)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@router.patch("/{track_id}")
def update_track_tags(track_id: int, update: TagUpdate):
    updates = update.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "No fields provided")

    with db() as conn:
        row = conn.execute(
            "SELECT * FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Track not found")
        staging.stage_edit(conn, row, updates)
        title = row["title"] or row["filename"]
        return {"ok": True, **_finish(conn, [track_id], f"Edited tags — {title}")}


class AutoNumber(BaseModel):
    track_ids: list[int]


class FindReplace(BaseModel):
    track_ids: list[int]
    field: str
    find: str
    replace: str = ""


@router.post("/autonumber")
def autonumber(req: AutoNumber):
    """Assign sequential track numbers to the selection, ordered by filename."""
    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    with db() as conn:
        rows = sorted(_rows(conn, req.track_ids), key=lambda r: r["filename"].lower())
        for i, row in enumerate(rows, start=1):
            staging.stage_edit(conn, row, {"track_number": str(i)})
        res = _finish(conn, [r["id"] for r in rows], f"Auto-numbered {len(rows)} tracks")
    return {"numbered": len(rows), **res}


@router.post("/find-replace")
def find_replace(req: FindReplace):
    """Replace text within one tag field across the selection (case-sensitive)."""
    if req.field not in TAG_FIELDS:
        raise HTTPException(400, "Invalid field")
    if not req.find:
        raise HTTPException(400, "Nothing to find")
    changed = []
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        pending = staging.load(conn, [r["id"] for r in rows])
        for row in rows:
            # Work on the value as staged, so edits build on each other.
            val = staging.effective(row, pending.get(row["id"]))[req.field]
            if not val or req.find not in val:
                continue
            new_val = val.replace(req.find, req.replace)
            if new_val == val:
                continue
            staging.stage_edit(conn, row, {req.field: new_val})
            changed.append(row["id"])
        res = _finish(conn, changed, f"Find/replace on {len(changed)} tracks")
    return {"changed": len(changed), **res}


class Reorganize(BaseModel):
    track_ids: list[int]


@router.post("/reorganize")
def reorganize(req: Reorganize):
    """
    Plan a move for each selected file to the rename template, relative to its
    own library root (core/fileops.py), and stage it -- nothing moves until the
    staged changes are written. Uses the tags as staged.
    """
    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    app = load_settings()
    roots = get_library_roots()
    planned: list[int] = []
    errors = []
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        found = {r["id"] for r in rows}
        errors += [{"id": t, "error": "not found"} for t in req.track_ids if t not in found]
        pending = staging.load(conn, list(found))
        for row in rows:
            try:
                dest = staging.plan_path(
                    row, staging.effective(row, pending.get(row["id"])), app.rename_template, roots,
                )
            except staging.PlanError as exc:
                errors.append({"id": row["id"], "error": str(exc)})
                continue
            if dest == row["path"]:
                staging.stage(conn, row, new_path=None)
                continue
            staging.stage(conn, row, new_path=dest)
            planned.append(row["id"])
        res = _finish(conn, planned, f"Reorganized {len(planned)} files")
    moved = 0 if res["staged"] else res["applied"]
    return {"planned": len(planned), "moved": moved, "errors": errors + res.get("errors", []),
            "staged": res["staged"]}


@router.post("/bulk")
def bulk_update_tags(update: BulkTagUpdate):
    updates = update.tags.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "No fields provided")

    with db() as conn:
        rows = _rows(conn, update.track_ids)
        found = {r["id"] for r in rows}
        errors = [{"id": t, "error": "not found"} for t in update.track_ids if t not in found]
        for row in rows:
            staging.stage_edit(conn, row, updates)
        res = _finish(conn, list(found), f"Bulk edit — {len(rows)} tracks")
    return {"ok": True, **res, "errors": errors + res.get("errors", [])}
