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


def _finish(conn, step: staging.Step, ids: list[int]) -> dict:
    """Record the staging step; with staging off, write it straight away."""
    step.save()
    summary = step.summary
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
        title = row["title"] or row["filename"]
        step = staging.Step(conn, f"Edited {{fields}} — {title}")
        staging.stage_edit(conn, row, updates, step)
        return {"ok": True, **_finish(conn, step, [track_id])}


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
        step = staging.Step(conn, f"Auto-numbered {len(rows)} tracks")
        for i, row in enumerate(rows, start=1):
            staging.stage_edit(conn, row, {"track_number": str(i)}, step)
        res = _finish(conn, step, [r["id"] for r in rows])
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
        step = staging.Step(conn, f"Find/replace “{req.find}” in {req.field}")
        for row in rows:
            # Work on the value as staged, so edits build on each other.
            val = staging.effective(row, pending.get(row["id"]))[req.field]
            if not val or req.find not in val:
                continue
            new_val = val.replace(req.find, req.replace)
            if new_val == val:
                continue
            staging.stage_edit(conn, row, {req.field: new_val}, step)
            changed.append(row["id"])
        res = _finish(conn, step, changed)
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
        staged_dirs = staging.load_dirs(conn)
        step = staging.Step(conn, f"Organize {len(rows)} files")
        for row in rows:
            if staged_dirs and staging.moved_path(row["path"], staged_dirs):
                errors.append({"id": row["id"], "error": "its folder is staged to move -- write that first"})
                continue
            try:
                dest = staging.plan_path(
                    row, staging.effective(row, pending.get(row["id"])), app.rename_template, roots,
                )
            except staging.PlanError as exc:
                errors.append({"id": row["id"], "error": str(exc)})
                continue
            if dest == row["path"]:
                staging.stage(conn, row, new_path=None, step=step)
                continue
            staging.stage(conn, row, new_path=dest, step=step)
            planned.append(row["id"])
        res = _finish(conn, step, planned)
    moved = 0 if res["staged"] else res["applied"]
    return {"planned": len(planned), "moved": moved, "errors": errors + res.get("errors", []),
            "staged": res["staged"]}


class MoveTo(BaseModel):
    track_ids: list[int]
    folder: str


@router.post("/move-to")
def move_to_folder(req: MoveTo):
    """Stage moving the selected files into a folder (drag and drop), names kept."""
    import os
    from core.fileops import root_for

    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    folder = os.path.normpath(req.folder)
    roots = get_library_roots()
    root = root_for(folder, roots)
    if root is None:
        raise HTTPException(400, "destination must be inside a library root")
    if not os.path.isdir(folder):
        raise HTTPException(400, "folder not found")
    planned: list[int] = []
    errors = []
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        staged_dirs = staging.load_dirs(conn)
        step = staging.Step(conn, f"Move {len(rows)} file{'s' if len(rows) != 1 else ''} → {os.path.basename(folder)}")
        for row in rows:
            if staged_dirs and staging.moved_path(row["path"], staged_dirs):
                errors.append({"id": row["id"], "error": "its folder is staged to move -- write that first"})
                continue
            dest = os.path.join(folder, row["filename"])
            if dest == row["path"]:
                continue
            staging.stage(conn, row, new_path=dest, step=step)
            planned.append(row["id"])
        res = _finish(conn, step, planned)
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
        step = staging.Step(conn, f"Set {{fields}} on {len(rows)} tracks")
        for row in rows:
            staging.stage_edit(conn, row, updates, step)
        res = _finish(conn, step, list(found))
    return {"ok": True, **res, "errors": errors + res.get("errors", [])}
