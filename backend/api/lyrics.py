"""
Lyrics from LRCLIB: fetch for a selection and stage the chosen ones; search
by hand for one track; look up in the background; lyrics groups (how a track
is looked up, or that it isn't: core/lyricsgroups.py).
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from core import lyrics as lrclib
from core import lyricsgroups, lyricsjob
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
    with db() as conn:
        assigned = lyricsgroups.assigned(conn, [t["id"] for t in tracks])
    group_for = lyricsgroups.resolver()
    sem = asyncio.Semaphore(4)

    async def one(t: dict) -> dict:
        group = group_for(t["path"], assigned.get(t["id"]))
        base = {"id": t["id"], "title": t.get("title") or t["filename"], "artist": t.get("artist"),
                "group": group["name"]}
        if t.get("lyrics") and not req.overwrite:
            return {**base, "status": "has", "lyrics": None}
        if group["skip"]:
            return {**base, "status": "skipped", "lyrics": None}
        async with sem:
            try:
                res = await asyncio.to_thread(lyricsgroups.look_up, t, group, req.prefer)
            except Exception as e:  # noqa: BLE001 -- one track's failure isn't the batch's
                return {**base, "status": "error", "error": str(e), "lyrics": None}
        return {**base, **res}

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


class Assign(BaseModel):
    track_ids: list[int]
    group_id: str | None = None     # None: back to the library's default


@router.get("/groups")
def list_groups():
    """The lyrics groups, with how many tracks were put in each."""
    with db() as conn:
        counts = dict(conn.execute("SELECT group_id, COUNT(*) FROM lyrics_members GROUP BY group_id").fetchall())
    return [{**g, "assigned": counts.get(g["id"], 0)} for g in lyricsgroups.groups()]


@router.post("/assign")
def assign(req: Assign):
    """Put tracks in a lyrics group (Tagger's DB only; no file changes)."""
    if req.group_id and req.group_id not in {g["id"] for g in lyricsgroups.groups()}:
        raise HTTPException(400, "No such lyrics group")
    with db() as conn:
        n = lyricsgroups.assign(conn, req.track_ids, req.group_id)
    return {"assigned": n}


@router.get("/plan/{track_id}")
def plan(track_id: int):
    """A track's group, its queries rendered, and its last lookup -- for Search."""
    with db() as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Track not found")
        t = staging.effective(row, staging.load(conn, [track_id]).get(track_id))
        group = lyricsgroups.resolver()(row["path"], lyricsgroups.assigned(conn, [track_id]).get(track_id))
        last = lyricsgroups.lookups(conn, [track_id]).get(track_id)
    return {"track": {k: t.get(k) for k in ("id", "title", "artist", "album", "album_artist", "duration", "lyrics")},
            "group": {"id": group["id"], "name": group["name"], "skip": group["skip"]},
            "queries": lyricsgroups.queries(group, t), "last": last}


class Search(BaseModel):
    title: str = ""
    artist: str = ""
    album: str = ""
    q: str = ""                     # free text, instead of / with the fields


@router.post("/search")
async def search(req: Search):
    """Every LRCLIB hit for a hand-made query."""
    if not (req.q.strip() or req.title.strip()):
        raise HTTPException(400, "A title or free text is required")
    try:
        hits = await asyncio.to_thread(lrclib.search, req.title.strip(), req.artist.strip(),
                                       req.album.strip(), req.q.strip())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LRCLIB: {e}")
    return {"hits": hits}


class Lookup(BaseModel):
    track_ids: list[int] | None = None   # None: every track missing lyrics
    prefer: str = "synced"
    retry: bool = False                   # also tracks already looked up without success
    instrumental_to_none: bool = True     # LRCLIB says instrumental -> the No lyrics group


@router.post("/lookup")
def start_lookup(req: Lookup, background_tasks: BackgroundTasks):
    """Look up lyrics in the background (Settings → Background); finds are staged."""
    from core.tasks import active_scan, create_scan_job
    running = active_scan("lyrics")
    if running:
        raise HTTPException(409, {"detail": "A lyrics lookup is already running", "job_id": running["id"]})
    with db() as conn:
        ids = lyricsjob.targets(conn, req.track_ids, req.retry)
    if not ids:
        return {"job_id": None, "tracks": 0}
    job_id = create_scan_job(kind="lyrics")
    background_tasks.add_task(lyricsjob.run, job_id, ids, req.prefer, req.instrumental_to_none)
    return {"job_id": job_id, "tracks": len(ids)}
