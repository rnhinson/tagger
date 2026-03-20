from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException

from core.tasks import create_scan_job, get_job, list_jobs, run_scan_job

router = APIRouter()


@router.post("/scan")
async def start_scan(background_tasks: BackgroundTasks):
    job_id = create_scan_job()
    background_tasks.add_task(run_scan_job, job_id)
    return {"job_id": job_id}


@router.get("")
def get_jobs():
    return list_jobs()


@router.get("/{job_id}")
def get_job_status(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job
