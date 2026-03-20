"""
Background job management — scan jobs persisted to SQLite.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from core.database import db


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


async def run_scan_job(job_id: str) -> None:
    """Run a full library scan as a background task, updating job status in DB."""
    from core.scanner import scan_library
    from api.config import _load as load_app_settings, get_music_dirs

    _update_job(job_id, status="running")

    app_settings = load_app_settings()
    music_dirs = get_music_dirs()

    def progress(scanned: int, total: int) -> None:
        _update_job(job_id, scanned=scanned, total=total)

    try:
        total, upserted = await asyncio.to_thread(scan_library, progress, app_settings.scan_tags, music_dirs)
        _update_job(
            job_id,
            status="done",
            finished_at=time.time(),
            total=total,
            scanned=upserted,
        )
    except Exception as exc:
        _update_job(
            job_id,
            status="error",
            finished_at=time.time(),
            error=str(exc),
        )
