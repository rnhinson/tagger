from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from core.database import db

router = APIRouter()

_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/mp4",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
}
_CHUNK = 64 * 1024


def _iter_file(path: str, start: int, length: int) -> Iterator[bytes]:
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            chunk = f.read(min(_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    """Parse a single 'bytes=start-end' range; return (start, end) or None if unsatisfiable."""
    try:
        unit, _, rng = header.partition("=")
        if unit.strip() != "bytes":
            return None
        start_s, _, end_s = rng.partition("-")
        if start_s == "":  # suffix range: bytes=-N (last N bytes)
            length = int(end_s)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    end = min(end, size - 1)
    if start > end or start < 0:
        return None
    return start, end


@router.get("/{track_id}")
def stream_track(track_id: int, request: Request):
    """Stream a track's audio file inline, honouring HTTP Range for seeking."""
    with db() as conn:
        row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    path = row["path"]
    if not os.path.exists(path):
        raise HTTPException(404, "Audio file not found on disk")

    size = os.path.getsize(path)
    media_type = _MEDIA_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")
    range_header = request.headers.get("range")

    if range_header:
        parsed = _parse_range(range_header, size)
        if parsed is None:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        start, end = parsed
        length = end - start + 1
        return StreamingResponse(
            _iter_file(path, start, length),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
            },
        )

    return StreamingResponse(
        _iter_file(path, 0, size),
        media_type=media_type,
        headers={"Accept-Ranges": "bytes", "Content-Length": str(size)},
    )
