import subprocess

import pytest

from core.database import db
from core.scanner import _under, _excluded, scan_library
from tests.conftest import FFMPEG


def test_under_matching():
    assert _under("/music/a/b.mp3", ["/music"]) is True
    assert _under("/music/a/b.mp3", ["/music/a"]) is True
    assert _under("/music/a/b.mp3", ["/other"]) is False
    # prefix that isn't a path boundary must not match
    assert _under("/music-extra/x.mp3", ["/music"]) is False


def _count(where="", params=()):
    with db() as conn:
        return conn.execute(f"SELECT COUNT(*) FROM tracks {where}", params).fetchone()[0]


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")
def test_targeted_rescan_prunes_only_its_subtree(temp_db, tmp_path):
    root = tmp_path / "music"
    (root / "A").mkdir(parents=True)
    (root / "B").mkdir(parents=True)
    files = {
        "A/1.mp3": root / "A" / "1.mp3",
        "A/2.mp3": root / "A" / "2.mp3",
        "B/3.mp3": root / "B" / "3.mp3",
    }
    for f in files.values():
        subprocess.run(
            [FFMPEG, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.3",
             "-c:a", "libmp3lame", "-y", str(f)],
            check=True, capture_output=True,
        )

    total, upserted = scan_library(music_dirs=[str(root)])
    assert total == 3 and upserted == 3
    assert _count() == 3

    # Delete one file in A, then rescan ONLY A.
    files["A/1.mp3"].unlink()
    scan_library(music_dirs=[str(root / "A")], prune_under=[str(root / "A")])

    with db() as conn:
        paths = {r["path"] for r in conn.execute("SELECT path FROM tracks")}
    assert str(files["A/1.mp3"]) not in paths     # pruned (missing, in scope)
    assert str(files["A/2.mp3"]) in paths         # kept
    assert str(files["B/3.mp3"]) in paths         # untouched (out of scope)


def test_concurrent_scan_blocked(client):
    with db() as conn:
        conn.execute(
            "INSERT INTO scan_jobs (id, status, started_at) VALUES ('running-job', 'running', 1.0)"
        )
    r = client.post("/api/jobs/scan")
    assert r.status_code == 409


def test_targeted_scan_rejects_outside_dir(client):
    r = client.post("/api/jobs/scan", params={"directory": "/etc"})
    assert r.status_code == 403


def test_excluded_matching():
    assert _excluded("/m/a/song.mp3", ["*.mp3"]) is True
    assert _excluded("/m/a/song.flac", ["*.mp3"]) is False
    assert _excluded("/m/Podcasts/x.mp3", ["*Podcasts*"]) is True
    assert _excluded("/m/a/._hidden.mp3", ["._*"]) is True     # basename match
    assert _excluded("/m/a/song.mp3", []) is False


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")
def test_scan_respects_exclude(temp_db, tmp_path):
    root = tmp_path / "music"
    (root / "keep").mkdir(parents=True)
    (root / "skip").mkdir()
    for f in (root / "keep" / "a.mp3", root / "skip" / "b.mp3"):
        subprocess.run(
            [FFMPEG, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.3",
             "-c:a", "libmp3lame", "-y", str(f)],
            check=True, capture_output=True,
        )
    total, upserted = scan_library(music_dirs=[str(root)], exclude=["*skip*"])
    assert total == 1  # the excluded directory is pruned
