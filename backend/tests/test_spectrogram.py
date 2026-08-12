import subprocess

import pytest

from core.database import db
from tests.conftest import FFMPEG


def _insert(path):
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO tracks (path, filename, directory, format, scanned_at) VALUES (?,?,?,?,?)",
            (str(path), path.name, str(path.parent), "flac", 1.0),
        )
        return cur.lastrowid


def test_status(client):
    assert "available" in client.get("/api/spectrogram/status").json()


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")
def test_renders_png_and_caches(client, tmp_path):
    audio = tmp_path / "s.flac"
    subprocess.run(
        [FFMPEG, "-f", "lavfi", "-i", "anoisesrc=d=1:c=pink", "-c:a", "flac", "-y", str(audio)],
        check=True, capture_output=True,
    )
    tid = _insert(audio)

    r = client.get(f"/api/spectrogram/{tid}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"

    # A second request is served from the on-disk cache.
    from core.config import settings
    cached = list((settings.config_dir / "spectrograms").glob(f"{tid}_*.png"))
    assert len(cached) == 1
    assert client.get(f"/api/spectrogram/{tid}").status_code == 200


def test_missing_track(client):
    assert client.get("/api/spectrogram/999").status_code in (404, 503)
