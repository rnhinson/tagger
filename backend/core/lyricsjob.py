"""
Background lyrics lookup: every track given (or every track missing lyrics),
through its lyrics group's queries, with progress and Cancel on the Background
page. What's found is staged -- one step per batch, so a cancel or restart
keeps what was found -- and each track's outcome is recorded, so the Missing
lyrics view can show "not found" and the next run can skip it.
"""
from __future__ import annotations

import asyncio
import logging
import time

from core import lyricsgroups, staging
from core.lyrics import RateLimited
from core.database import db
from core.tasks import _CANCEL, _update_job

logger = logging.getLogger("tagger.lyrics")

BATCH = 100        # tracks per staging step
PARALLEL = 4       # tracks at once; core/lyrics.py spaces out the requests

MISSING = ("(lyrics IS NULL OR trim(lyrics) = '') AND NOT lyrics_skip(path, "
           "(SELECT group_id FROM lyrics_members WHERE track_id = tracks.id))")


def targets(conn, ids: list[int] | None, retry: bool) -> list[int]:
    """The tracks a run looks up: missing lyrics (written or staged), not skipped,
    and -- unless retry -- not already looked up without success."""
    if ids is None:
        ids = [r[0] for r in conn.execute(f"SELECT id FROM tracks WHERE {MISSING} ORDER BY directory, filename")]
    from api.tags import _rows
    rows = {r["id"]: r for r in _rows(conn, ids)}
    entries = staging.load(conn, list(rows))
    assigned = lyricsgroups.assigned(conn, list(rows))
    done = {} if retry else lyricsgroups.lookups(conn, list(rows))
    group_for = lyricsgroups.resolver()
    out = []
    for i in ids:
        r = rows.get(i)
        if r is None or group_for(r["path"], assigned.get(i))["skip"]:
            continue
        if (staging.effective(r, entries.get(i)).get("lyrics") or "").strip():
            continue
        if done.get(i, {}).get("status") in ("missing", "instrumental", "untagged"):
            continue
        out.append(i)
    return out


async def run(job_id: str, ids: list[int], prefer: str = "synced", instrumental_to_none: bool = True) -> None:
    from api.tags import _finish, _rows
    _update_job(job_id, status="running", phase="looking up", total=len(ids), scanned=0, changed=0)
    sem = asyncio.Semaphore(PARALLEL)
    group_for = lyricsgroups.resolver()
    found = done = 0
    logger.info("lyrics lookup %s started: %d tracks", job_id, len(ids))

    async def one(row, group):
        async with sem:
            try:
                return await asyncio.to_thread(lyricsgroups.look_up, row, group, prefer)
            except RateLimited as e:
                return {"status": "later", "lyrics": None, "query": None, "error": str(e)}
            except Exception as e:  # noqa: BLE001 -- one track's failure isn't the run's
                return {"status": "error", "lyrics": None, "query": None, "error": str(e)}

    try:
        for start in range(0, len(ids), BATCH):
            if job_id in _CANCEL:
                _update_job(job_id, status="cancelled", phase=None, finished_at=time.time())
                logger.info("lyrics lookup %s cancelled after %d", job_id, done)
                return
            chunk = ids[start:start + BATCH]
            with db() as conn:
                rows = _rows(conn, chunk)
                assigned = lyricsgroups.assigned(conn, chunk)
            results = await asyncio.gather(*(one(r, group_for(r["path"], assigned.get(r["id"]))) for r in rows))
            now = time.time()
            with db() as conn:
                hits = [(r, res) for r, res in zip(rows, results) if res["lyrics"]]
                for r, res in zip(rows, results):
                    if res["status"] == "later":
                        continue          # not looked up: next run tries it
                    lyricsgroups.record(conn, r["id"], res["status"], now)
                    if res["status"] == "instrumental" and instrumental_to_none:
                        lyricsgroups.assign(conn, [r["id"]], lyricsgroups.NONE)
                if hits:
                    step = staging.Step(conn, f"Lyrics lookup: {len(hits)} track{'s' if len(hits) != 1 else ''}")
                    for r, res in hits:
                        staging.stage_edit(conn, r, {"lyrics": res["lyrics"]}, step)
                    _finish(conn, step, [r["id"] for r, _ in hits])
            found += len(hits)
            done += len(chunk)
            _update_job(job_id, scanned=done, changed=found)
            if any(res["status"] == "later" for res in results):
                # LRCLIB still refusing after waiting as asked: stop rather than
                # risk a ban. What was found is staged; a new run picks up the rest.
                _update_job(job_id, status="error", phase=None, finished_at=time.time(),
                            error=f"LRCLIB rate limit: stopped after {done} tracks ({found} found). Try again later, "
                                  "or add an LRCLIB API key in Settings → Sources.")
                logger.warning("lyrics lookup %s stopped by the rate limit after %d", job_id, done)
                return
        _update_job(job_id, status="done", phase=None, finished_at=time.time(), scanned=done, changed=found)
        logger.info("lyrics lookup %s done: %d of %d found", job_id, found, done)
    except Exception as exc:
        _update_job(job_id, status="error", phase=None, finished_at=time.time(), error=str(exc))
        logger.exception("lyrics lookup %s failed: %s", job_id, exc)
    finally:
        _CANCEL.discard(job_id)
