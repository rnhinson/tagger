"""
Spectrogram rendering via ffmpeg's showspectrumpic filter.

A spectrogram reveals the actual audio content — e.g. a frequency cutoff that
betrays a lossy transcode dressed up as a lossless file — which the codec/
bitrate columns can't. Gated on ffmpeg being available; rendered images are
cached under the config dir, keyed by track id + mtime.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from core.config import settings
from core.database import db

router = APIRouter()

_FILTER = "showspectrumpic=s=900x400:legend=1:fscale=lin"


def ffmpeg_bin() -> str | None:
    return shutil.which("ffmpeg")


@router.get("/status")
def status():
    return {"available": ffmpeg_bin() is not None}


@router.get("/{track_id}")
def spectrogram(track_id: int):
    ff = ffmpeg_bin()
    if not ff:
        raise HTTPException(503, "ffmpeg not available")

    with db() as conn:
        row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    path = row["path"]
    if not os.path.exists(path):
        raise HTTPException(404, "Audio file not found on disk")

    mtime = int(os.path.getmtime(path))
    cache_dir = settings.config_dir / "spectrograms"
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{track_id}_{mtime}.png"

    if not out.exists():
        for stale in cache_dir.glob(f"{track_id}_*.png"):
            stale.unlink(missing_ok=True)
        try:
            proc = subprocess.run(
                [ff, "-hide_banner", "-v", "error", "-i", path,
                 "-lavfi", _FILTER, "-frames:v", "1", "-y", str(out)],
                capture_output=True, timeout=120,
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(504, "Spectrogram render timed out")
        if proc.returncode != 0 or not out.exists():
            raise HTTPException(500, "Failed to render spectrogram")

    return Response(
        content=Path(out).read_bytes(),
        media_type="image/png",
        headers={"Cache-Control": "max-age=3600"},
    )
