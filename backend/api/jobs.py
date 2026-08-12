from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from api.config import get_music_dirs
from core.tasks import active_scan, create_scan_job, get_job, list_jobs, run_scan_job

router = APIRouter()


def _under_music_dir(directory: str) -> bool:
    target = os.path.normpath(directory)
    for d in get_music_dirs():
        d = os.path.normpath(d)
        if target == d or target.startswith(d + os.sep):
            return True
    return False


@router.post("/scan")
async def start_scan(background_tasks: BackgroundTasks, directory: Optional[str] = Query(None)):
    """Start a full scan, or a targeted rescan of `directory` (must be under a music dir)."""
    running = active_scan()
    if running:
        raise HTTPException(409, {"detail": "A scan is already running", "job_id": running["id"]})

    if directory is not None:
        directory = os.path.normpath(directory)
        if not _under_music_dir(directory):
            raise HTTPException(403, "Directory is outside the configured music directories")
        if not os.path.isdir(directory):
            raise HTTPException(404, "Directory not found")

    job_id = create_scan_job()
    background_tasks.add_task(run_scan_job, job_id, directory)
    return {"job_id": job_id, "directory": directory}


@router.get("")
def get_jobs():
    return list_jobs()


@router.get("/{job_id}")
def get_job_status(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job
