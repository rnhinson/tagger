from __future__ import annotations

import asyncio
import dataclasses
import shutil
import urllib.error
import urllib.request

from fastapi import APIRouter, HTTPException

from core.config import settings
from core.database import db
from core.inference import infer_tags_from_path
from core.providers.musicbrainz import MusicBrainzProvider
from core.tagger import write_cover
from api.config import _load as load_app_settings, get_music_dirs


def _acoustid_key() -> str:
    """AppSettings key takes precedence over env var."""
    app_key = load_app_settings().acoustid_api_key
    return app_key or settings.acoustid_api_key

router = APIRouter()
_mb = MusicBrainzProvider()


@router.get("/status")
def lookup_status():
    """Report which lookup methods are available."""
    acoustid_key = _acoustid_key()
    fpcalc_available = bool(acoustid_key) and shutil.which("fpcalc") is not None
    return {
        "acoustid_configured": bool(acoustid_key),
        "fpcalc_available": fpcalc_available,
        "method": "acoustid" if (acoustid_key and fpcalc_available) else "text",
    }


@router.post("/search/{track_id}")
async def search_track(track_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")

    acoustid_key = _acoustid_key()
    if acoustid_key:
        if not shutil.which("fpcalc"):
            raise HTTPException(400, "fpcalc not found — install libchromaprint-tools to use AcoustID")
        try:
            from core.providers.acoustid_provider import AcoustIDProvider
            results = await AcoustIDProvider(acoustid_key).lookup(row["path"])
            if results:
                return [
                    {k: v for k, v in dataclasses.asdict(r).items() if k != "raw"}
                    for r in results
                ]
        except RuntimeError as e:
            if "fpcalc" in str(e):
                raise HTTPException(400, str(e))
            # Fingerprint failed for this file — fall back to text search

    # Text search with duration for better accuracy
    results = await _mb.search(
        title=row["title"],
        artist=row["artist"],
        album=row["album"],
        duration=row["duration"],
    )

    # Supplement with Discogs when a token is configured
    discogs_token = load_app_settings().discogs_token
    if discogs_token:
        try:
            from core.providers.discogs import DiscogsProvider
            results += await DiscogsProvider(discogs_token).search(
                title=row["title"], artist=row["artist"], album=row["album"]
            )
        except Exception:
            pass  # Discogs is best-effort; never fail the whole lookup

    results.sort(key=lambda r: r.score, reverse=True)
    return [
        {k: v for k, v in dataclasses.asdict(r).items() if k != "raw"}
        for r in results
    ]


@router.post("/infer/{track_id}")
def infer_from_path(track_id: int):
    """Propose tags parsed from the file's path/name (source='filename')."""
    with db() as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    inferred = infer_tags_from_path(row["path"], get_music_dirs())
    if not inferred:
        return None
    return {
        "title":        inferred.get("title"),
        "artist":       inferred.get("artist"),
        "album":        inferred.get("album"),
        "album_artist": inferred.get("album_artist"),
        "year":         inferred.get("year"),
        "track_number": inferred.get("track_number"),
        "disc_number":  inferred.get("disc_number"),
        "mb_track_id":  None,
        "mb_artist_id": None,
        "mb_album_id":  None,
        "mb_album_artist_id": None,
        "score":        0.5,
        "source":       "filename",
    }


def _fetch_caa(mb_album_id: str) -> tuple[str, bytes]:
    """Fetch the front cover from the Cover Art Archive. Raises on failure."""
    url = f"https://coverartarchive.org/release/{mb_album_id}/front"
    req = urllib.request.Request(url, headers={"User-Agent": "tagger/0.1"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        mime = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        return mime, resp.read()


@router.post("/cover/{track_id}")
async def apply_cover_from_mb(track_id: int, mb_album_id: str):
    """Fetch cover art from Cover Art Archive and write it to the audio file."""
    with db() as conn:
        row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    try:
        mime, data = await asyncio.to_thread(_fetch_caa, mb_album_id)
    except urllib.error.HTTPError as e:
        raise HTTPException(e.code, f"Cover Art Archive returned {e.code}")
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch cover art: {e}")
    try:
        write_cover(row["path"], mime, data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}
