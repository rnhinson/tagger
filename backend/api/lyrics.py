"""Fetch lyrics from LRCLIB for a selection, then stage the chosen ones (core/lyrics.py)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import lyrics as lrclib
from core.albummatch import _int
from core import staging
from core.database import db

router = APIRouter()


class LyricsFetch(BaseModel):
    track_ids: list[int]
    prefer: str = "synced"          # synced | plain
    overwrite: bool = False         # also fetch for tracks that already have lyrics


@router.post("/fetch")
async def fetch_lyrics(req: LyricsFetch):
    """What LRCLIB has for each track: the text to write, and its kind."""
    from api.tags import _rows
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        entries = staging.load(conn, [r["id"] for r in rows])
    tracks = sorted((staging.effective(r, entries.get(r["id"])) for r in rows),
                    key=lambda t: (t["directory"], _int(t.get("disc_number")), _int(t.get("track_number")), t["filename"]))
    sem = asyncio.Semaphore(4)

    async def one(t: dict) -> dict:
        base = {"id": t["id"], "title": t.get("title") or t["filename"], "artist": t.get("artist")}
        if t.get("lyrics") and not req.overwrite:
            return {**base, "status": "has", "lyrics": None}
        if not t.get("title") or not t.get("artist"):
            return {**base, "status": "untagged", "lyrics": None}
        async with sem:
            try:
                hit = await asyncio.to_thread(lrclib.fetch, t["title"], t["artist"], t.get("album"), t.get("duration"))
            except Exception as e:  # noqa: BLE001 -- one track's failure isn't the batch's
                return {**base, "status": "error", "error": str(e), "lyrics": None}
        if not hit:
            return {**base, "status": "missing", "lyrics": None}
        if hit["instrumental"] and not (hit["synced"] or hit["plain"]):
            return {**base, "status": "instrumental", "lyrics": None}
        text = (hit["synced"] or hit["plain"]) if req.prefer == "synced" else (hit["plain"] or hit["synced"])
        kind = "synced" if text and text == hit["synced"] else "plain"
        return {**base, "status": kind, "lyrics": text}

    return {"items": await asyncio.gather(*(one(t) for t in tracks))}


class LyricsStage(BaseModel):
    items: dict[int, str]           # track id -> lyrics text


@router.post("/stage")
def stage_lyrics(req: LyricsStage):
    """Stage the chosen lyrics into each track's lyrics tag, as one step."""
    from api.tags import _finish, _rows
    items = {k: v for k, v in req.items.items() if v and v.strip()}
    if not items:
        raise HTTPException(400, "No lyrics to write")
    with db() as conn:
        rows = _rows(conn, list(items))
        step = staging.Step(conn, f"Lyrics on {len(rows)} track{'s' if len(rows) != 1 else ''}")
        for row in rows:
            staging.stage_edit(conn, row, {"lyrics": items[row["id"]]}, step)
        res = _finish(conn, step, [r["id"] for r in rows])
    return {"changed": len(rows), **res, "errors": res.get("errors", [])}
