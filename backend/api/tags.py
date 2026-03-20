from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.database import db
from core.tagger import write_tags
from api.config import _load as load_settings
from core.config import settings as core_settings

router = APIRouter()

_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe(part: str) -> str:
    """Sanitize a single path component."""
    part = _UNSAFE.sub('_', part).strip('. ')
    return part or '_'


def _rename_path(old_path: str, merged: dict) -> str | None:
    """
    Return the new absolute path for the file after applying the rename template,
    or None if renaming is not needed / not possible.
    """
    app = load_settings()
    if not app.rename_on_save:
        return None

    fields = {
        'title':        merged.get('title') or '',
        'artist':       merged.get('artist') or '',
        'album':        merged.get('album') or '',
        'album_artist': merged.get('album_artist') or merged.get('artist') or '',
        'year':         merged.get('year') or '',
        'genre':        merged.get('genre') or '',
        'track_number': merged.get('track_number') or '0',
        'disc_number':  merged.get('disc_number') or '0',
    }
    try:
        track_num = int(re.sub(r'\D.*', '', fields['track_number']) or '0')
        disc_num  = int(re.sub(r'\D.*', '', fields['disc_number'])  or '0')
        rel = app.rename_template.format(
            track_number=track_num,
            disc_number=disc_num,
            **{k: fields[k] for k in ('title', 'artist', 'album', 'album_artist', 'year', 'genre')},
        )
    except (KeyError, ValueError):
        return None  # bad template — skip rename

    ext = Path(old_path).suffix
    # Sanitize each path component individually
    parts = [_safe(p) for p in rel.replace('\\', '/').split('/') if p]
    if not parts:
        return None

    new_path = core_settings.music_dir / Path(*parts).with_suffix(ext)
    if str(new_path) == old_path:
        return None
    return str(new_path)


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

        write_tags(row["path"], updates)

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(
            f"UPDATE tracks SET {set_clause}, tagged_at = ? WHERE id = ?",
            [*updates.values(), time.time(), track_id],
        )

        merged = {**dict(row), **updates}
        _apply_rename(conn, track_id, row["path"], merged)

    return {"ok": True}


@router.post("/bulk")
def bulk_update_tags(update: BulkTagUpdate):
    updates = update.tags.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "No fields provided")

    errors = []
    with db() as conn:
        for track_id in update.track_ids:
            row = conn.execute(
                "SELECT * FROM tracks WHERE id = ?", (track_id,)
            ).fetchone()
            if not row:
                errors.append({"id": track_id, "error": "not found"})
                continue
            try:
                write_tags(row["path"], updates)
                set_clause = ", ".join(f"{k} = ?" for k in updates)
                conn.execute(
                    f"UPDATE tracks SET {set_clause}, tagged_at = ? WHERE id = ?",
                    [*updates.values(), time.time(), track_id],
                )
                merged = {**dict(row), **updates}
                _apply_rename(conn, track_id, row["path"], merged)
            except Exception as exc:
                errors.append({"id": track_id, "error": str(exc)})

    return {"ok": True, "errors": errors}
