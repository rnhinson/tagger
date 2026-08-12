from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.database import db
from core.history import log_change, snapshot
from core.tagger import write_tags
from core.replaygain import rg_tool, scan as rg_scan
from api.config import _load as load_settings
from core.config import settings as core_settings

router = APIRouter()

_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe(part: str) -> str:
    """Sanitize a single path component."""
    part = _UNSAFE.sub('_', part).strip('. ')
    return part or '_'


def render_template(template: str, tags: dict, ext: str) -> str:
    """
    Render a rename template into a sanitized path relative to the music root,
    with the given extension. Raises ValueError/KeyError on a bad template.
    """
    fields = {
        'title':        tags.get('title') or '',
        'artist':       tags.get('artist') or '',
        'album':        tags.get('album') or '',
        'album_artist': tags.get('album_artist') or tags.get('artist') or '',
        'year':         tags.get('year') or '',
        'genre':        tags.get('genre') or '',
        'track_number': tags.get('track_number') or '0',
        'disc_number':  tags.get('disc_number') or '0',
    }
    track_num = int(re.sub(r'\D.*', '', fields['track_number']) or '0')
    disc_num  = int(re.sub(r'\D.*', '', fields['disc_number'])  or '0')
    rel = template.format(
        track_number=track_num,
        disc_number=disc_num,
        **{k: fields[k] for k in ('title', 'artist', 'album', 'album_artist', 'year', 'genre')},
    )
    parts = [_safe(p) for p in rel.replace('\\', '/').split('/') if p]
    if not parts:
        raise ValueError("template produced an empty path")
    return str(Path(*parts).with_suffix(ext))


def _rename_path(old_path: str, merged: dict) -> str | None:
    """
    Return the new absolute path for the file after applying the rename template,
    or None if renaming is not needed / not possible.
    """
    app = load_settings()
    if not app.rename_on_save:
        return None

    try:
        rel = render_template(app.rename_template, merged, Path(old_path).suffix)
    except (KeyError, ValueError, IndexError):
        return None  # bad template — skip rename

    new_path = str(core_settings.music_dir / rel)
    if new_path == old_path:
        return None
    return new_path


def _apply_rename(conn, track_id: int, old_path: str, merged: dict) -> None:
    """Move the file and update the DB row if rename is needed."""
    new_path = _rename_path(old_path, merged)
    if not new_path:
        return
    dest = Path(new_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    Path(old_path).rename(dest)
    conn.execute(
        "UPDATE tracks SET path = ?, filename = ?, directory = ? WHERE id = ?",
        (new_path, dest.name, str(dest.parent), track_id),
    )


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

        snap = snapshot(row)
        write_tags(row["path"], updates)

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(
            f"UPDATE tracks SET {set_clause}, tagged_at = ? WHERE id = ?",
            [*updates.values(), time.time(), track_id],
        )

        merged = {**dict(row), **updates}
        _apply_rename(conn, track_id, row["path"], merged)

        title = row["title"] or row["filename"]
        log_change(conn, "tag_edit", f"Edited tags — {title}", [snap])

    return {"ok": True}


class Reorganize(BaseModel):
    track_ids: list[int]


@router.post("/reorganize")
def reorganize(req: Reorganize):
    """
    Apply the configured rename template to the selected files, moving them on
    disk regardless of the rename-on-save setting. Undoable (moves files back).
    """
    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    template = load_settings().rename_template
    moved = 0
    errors = []
    snaps: list[dict] = []
    with db() as conn:
        for tid in req.track_ids:
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (tid,)).fetchone()
            if not row:
                errors.append({"id": tid, "error": "not found"})
                continue
            try:
                rel = render_template(template, dict(row), Path(row["path"]).suffix)
            except (KeyError, ValueError, IndexError) as exc:
                errors.append({"id": tid, "error": f"bad template: {exc}"})
                continue
            new_path = str(core_settings.music_dir / rel)
            if new_path == row["path"]:
                continue
            dest = Path(new_path)
            if dest.exists():
                errors.append({"id": tid, "error": "destination already exists"})
                continue
            try:
                snap = snapshot(row)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(row["path"], str(dest))
                conn.execute(
                    "UPDATE tracks SET path = ?, filename = ?, directory = ? WHERE id = ?",
                    (new_path, dest.name, str(dest.parent), tid),
                )
                snaps.append(snap)
                moved += 1
            except Exception as exc:
                errors.append({"id": tid, "error": str(exc)})
        log_change(conn, "tag_edit", f"Reorganized {moved} files", snaps)
    return {"moved": moved, "errors": errors}


@router.post("/bulk")
def bulk_update_tags(update: BulkTagUpdate):
    updates = update.tags.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "No fields provided")

    errors = []
    snaps: list[dict] = []
    with db() as conn:
        for track_id in update.track_ids:
            row = conn.execute(
                "SELECT * FROM tracks WHERE id = ?", (track_id,)
            ).fetchone()
            if not row:
                errors.append({"id": track_id, "error": "not found"})
                continue
            try:
                snap = snapshot(row)
                write_tags(row["path"], updates)
                set_clause = ", ".join(f"{k} = ?" for k in updates)
                conn.execute(
                    f"UPDATE tracks SET {set_clause}, tagged_at = ? WHERE id = ?",
                    [*updates.values(), time.time(), track_id],
                )
                merged = {**dict(row), **updates}
                _apply_rename(conn, track_id, row["path"], merged)
                snaps.append(snap)
            except Exception as exc:
                errors.append({"id": track_id, "error": str(exc)})

        log_change(conn, "tag_edit", f"Bulk edit — {len(snaps)} tracks", snaps)

    return {"ok": True, "errors": errors}
