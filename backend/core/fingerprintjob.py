"""
Background fingerprinting for duplicates by sound: fpcalc reads the first
30 seconds of each track whose fingerprint is missing or older than the file,
with progress and Cancel on the Background page. Resumable: a cancelled or
interrupted run keeps what it stored.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import time

from core.database import db
from core.tasks import _CANCEL, _update_job

logger = logging.getLogger("tagger.fingerprint")

PARALLEL = 4
BATCH = 50
SECONDS = 30


def targets(conn) -> list[int]:
    return [r[0] for r in conn.execute(
        "SELECT t.id FROM tracks t LEFT JOIN fingerprints f ON f.track_id = t.id "
        "WHERE f.track_id IS NULL OR f.mtime IS NOT t.mtime ORDER BY t.directory, t.filename")]


def fingerprint(path: str) -> list[int]:
    """fpcalc's raw fingerprint of the first SECONDS; [] when it can't read the file."""
    try:
        out = subprocess.run(["fpcalc", "-raw", "-json", "-length", str(SECONDS), path],
                             capture_output=True, text=True, timeout=60)
        return json.loads(out.stdout).get("fingerprint", []) if out.returncode == 0 else []
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return []


async def run(job_id: str, ids: list[int]) -> None:
    _update_job(job_id, status="running", phase="fingerprinting", total=len(ids), scanned=0, changed=0)
    sem = asyncio.Semaphore(PARALLEL)
    done = stored = 0

    async def one(path: str) -> list[int]:
        async with sem:
            return await asyncio.to_thread(fingerprint, path)

    try:
        for start in range(0, len(ids), BATCH):
            if job_id in _CANCEL:
                _update_job(job_id, status="cancelled", phase=None, finished_at=time.time())
                return
            chunk = ids[start:start + BATCH]
            with db() as conn:
                ph = ",".join("?" * len(chunk))
                rows = conn.execute(f"SELECT id, path, mtime FROM tracks WHERE id IN ({ph})", chunk).fetchall()
            fps = await asyncio.gather(*(one(r["path"]) for r in rows))
            with db() as conn:
                conn.executemany(
                    "INSERT INTO fingerprints (track_id, mtime, fp) VALUES (?, ?, ?) "
                    "ON CONFLICT(track_id) DO UPDATE SET mtime = excluded.mtime, fp = excluded.fp",
                    [(r["id"], r["mtime"], json.dumps(fp) if fp else "") for r, fp in zip(rows, fps)])
            done += len(chunk)
            stored += sum(1 for fp in fps if fp)
            _update_job(job_id, scanned=done, changed=stored)
        _update_job(job_id, status="done", phase=None, finished_at=time.time(), scanned=done, changed=stored)
        logger.info("fingerprints %s done: %d of %d", job_id, stored, done)
    except Exception as exc:
        _update_job(job_id, status="error", phase=None, finished_at=time.time(), error=str(exc))
        logger.exception("fingerprints %s failed: %s", job_id, exc)
    finally:
        _CANCEL.discard(job_id)


def available() -> bool:
    return shutil.which("fpcalc") is not None
