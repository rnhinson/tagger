from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response

from pydantic import BaseModel

from core import covers
from core.database import db
from core.tagger import read_cover, write_cover

router = APIRouter()

_MAX_COVER_BYTES = 20 * 1024 * 1024  # 20 MB


class CoverAction(BaseModel):
    track_ids: list[int]
    action: str = ""
    dry_run: bool = False            # just the selection's album folders and what they hold


@router.post("/albums")
def album_covers(req: CoverAction):
    """Move, copy or delete cover art for the selection's album folders (core/covers.py)."""
    if not req.dry_run and req.action not in covers.ACTIONS:
        raise HTTPException(400, f"Unknown action {req.action}")
    from api.config import _load as load_settings
    from api.tags import _rows
    cfg = load_settings()
    with db() as conn:
        by_dir: dict[str, list] = {}
        for r in _rows(conn, req.track_ids):
            by_dir.setdefault(r["directory"], []).append(r)
        if req.dry_run:
            folders = {r[0] for r in conn.execute("SELECT directory FROM folder_covers")}
            return {"albums": [{"directory": d, "track_ids": [r["id"] for r in rows],
                                "embedded": sum(1 for r in rows if r["has_cover"]), "folder": d in folders}
                               for d, rows in sorted(by_dir.items())]}
        results = []
        for d, rows in by_dir.items():
            try:
                results.append(covers.act(conn, d, rows, req.action, cfg.cover_folder_size, cfg.cover_embed_size))
            except Exception as e:  # noqa: BLE001 -- one album failing doesn't stop the rest
                results.append({"directory": d, "folder": 0, "tracks": 0, "errors": [], "note": str(e)})
    return {"albums": results}


@router.get("/{track_id}")
def get_cover(track_id: int):
    with db() as conn:
        row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    result = read_cover(row["path"])
    if not result:
        raise HTTPException(404, "No cover art")
    mime, data = result
    return Response(content=data, media_type=mime, headers={"Cache-Control": "max-age=3600"})


@router.post("/{track_id}")
async def set_cover(track_id: int, file: UploadFile = File(...)):
    with db() as conn:
        row = conn.execute("SELECT id, path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")
    data = await file.read(_MAX_COVER_BYTES + 1)
    if len(data) > _MAX_COVER_BYTES:
        raise HTTPException(413, "Cover image too large (max 20 MB)")
    from api.config import _load as load_settings
    try:
        with db() as conn:
            covers.set_track(conn, row, file.content_type, data, load_settings().cover_embed_size)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}
