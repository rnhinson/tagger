"""
Background job management — scan jobs persisted to SQLite.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from core.database import db

logger = logging.getLogger("tagger.scan")


def create_scan_job() -> str:
    job_id = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO scan_jobs (id, status, started_at) VALUES (?, 'pending', ?)",
            (job_id, time.time()),
        )
    return job_id


def get_job(job_id: str) -> dict | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM scan_jobs WHERE id = ?", (job_id,)
        ).fetchone()
    return dict(row) if row else None


def active_scan() -> dict | None:
    """Return the currently running/pending scan job, if any."""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM scan_jobs WHERE status IN ('pending', 'running') "
            "ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
    return dict(row) if row else None


def list_jobs(limit: int = 20) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM scan_jobs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def _update_job(job_id: str, **kwargs: Any) -> None:
    if not kwargs:
        return
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    with db() as conn:
        conn.execute(
            f"UPDATE scan_jobs SET {sets} WHERE id = ?",
            (*kwargs.values(), job_id),
        )


async def auto_scan_loop() -> None:
    """
    Background freshness loop. When auto_scan_minutes > 0, runs a full scan on
    that interval (skipping if one is already running). Re-reads settings each
    cycle, so it can be toggled without a restart. Off by default.
    """
    from api.config import _load as load_app_settings

    while True:
        mins = 0
        try:
            mins = load_app_settings().auto_scan_minutes
        except Exception:
            pass
        # When disabled, idle in short hops so re-enabling takes effect quickly.
        await asyncio.sleep(max(1, mins) * 60 if mins else 60)
        if mins and not active_scan():
            try:
                await run_scan_job(create_scan_job())
            except Exception:
                pass


async def run_scan_job(job_id: str, directory: str | None = None) -> None:
    """
    Run a library scan as a background task, updating job status in DB.

    With `directory`, only that subtree is scanned and pruned; otherwise the
    full set of configured music directories is scanned.
    """
    from core.scanner import scan_library
    from api.config import _load as load_app_settings, get_music_dirs

    _update_job(job_id, status="running")

    app_settings = load_app_settings()
    if directory:
        music_dirs = [directory]
        prune_under: list[str] | None = [directory]
    else:
        music_dirs = get_music_dirs()
        prune_under = None

    def progress(scanned: int, total: int) -> None:
        _update_job(job_id, scanned=scanned, total=total)

    logger.info("scan %s started (%s)", job_id, directory or "full library")
    started = time.time()
    try:
        total, upserted = await asyncio.to_thread(
            scan_library, progress, app_settings.scan_tags, music_dirs,
            prune_under, app_settings.scan_exclude,
        )
        _update_job(
            job_id,
            status="done",
            finished_at=time.time(),
            total=total,
            scanned=upserted,
        )
        logger.info("scan %s done: %d found, %d upserted in %.1fs",
                    job_id, total, upserted, time.time() - started)
    except Exception as exc:
        _update_job(
            job_id,
            status="error",
            finished_at=time.time(),
            error=str(exc),
        )
        logger.exception("scan %s failed: %s", job_id, exc)
