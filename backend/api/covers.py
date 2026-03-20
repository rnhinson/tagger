from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response

from core.database import db
from core.tagger import read_cover, write_cover

router = APIRouter()


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
        row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")
    data = await file.read()
    try:
        write_cover(row["path"], file.content_type, data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}
