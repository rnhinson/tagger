"""Scan cancel / interrupted jobs, and the About endpoint."""
import time

from core import tasks
from core.database import db
from core.scanner import ScanCancelled, scan_library


def test_interrupted_jobs_dont_block_new_scans(temp_db):
    stuck = tasks.create_scan_job()
    tasks._update_job(stuck, status="running")
    assert tasks.active_scan()["id"] == stuck
    assert tasks.mark_interrupted() == 1
    assert tasks.active_scan() is None and tasks.get_job(stuck)["status"] == "interrupted"


def test_cancel_stops_before_pruning(temp_db, tmp_path):
    root = tmp_path / "music"
    (root / "A").mkdir(parents=True)
    with db() as conn:   # a row whose file is gone: a completed scan would prune it
        conn.execute("INSERT INTO tracks (path, filename, directory, format, scanned_at) "
                     "VALUES (?, 'x.mp3', ?, 'mp3', 1)", (str(root / "A" / "x.mp3"), str(root / "A")))
    phases = []
    try:
        scan_library(music_dirs=[str(root)], should_stop=lambda: True, phase_cb=phases.append)
        raise AssertionError("expected ScanCancelled")
    except ScanCancelled:
        pass
    with db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0] == 1   # not pruned
    assert phases == ["listing"]


def test_cancel_endpoint_and_job_scope(client):
    job = tasks.create_scan_job("/music/Shared")
    tasks._update_job(job, status="running")
    assert tasks.get_job(job)["directory"] == "/music/Shared"
    assert client.post(f"/api/jobs/{job}/cancel").json() == {"cancelling": True}
    assert job in tasks._CANCEL
    tasks._update_job(job, status="done")
    assert client.post(f"/api/jobs/{job}/cancel").status_code == 409
    tasks._CANCEL.discard(job)


def test_about(client):
    a = client.get("/api/about").json()
    assert a["version"] and a["started"] <= time.time() and "ffmpeg" in a["tools"] and a["tracks"] == 0
