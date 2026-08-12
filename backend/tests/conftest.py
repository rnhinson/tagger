import shutil
import subprocess

import pytest

from core.config import settings
from core.database import init_db

FFMPEG = shutil.which("ffmpeg")

_CODECS = {
    ".mp3":  ["-c:a", "libmp3lame"],
    ".flac": ["-c:a", "flac"],
    ".ogg":  ["-c:a", "libvorbis"],
    ".m4a":  ["-c:a", "aac"],
}


@pytest.fixture()
def temp_db(tmp_path):
    """Point the app's SQLite DB at a fresh temp dir and initialise the schema."""
    prev = settings.config_dir
    settings.config_dir = tmp_path
    init_db()
    try:
        yield tmp_path
    finally:
        settings.config_dir = prev


@pytest.fixture()
def client(tmp_path):
    """A FastAPI TestClient backed by a fresh temp DB."""
    from fastapi.testclient import TestClient
    import main

    prev = settings.config_dir
    settings.config_dir = tmp_path
    try:
        with TestClient(main.app) as c:
            yield c
    finally:
        settings.config_dir = prev


@pytest.fixture()
def make_audio(tmp_path):
    """Generate a short silent audio file in the given format via ffmpeg."""
    if not FFMPEG:
        pytest.skip("ffmpeg not available")

    def _make(ext: str):
        out = tmp_path / f"sample{ext}"
        subprocess.run(
            [FFMPEG, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.5",
             *_CODECS[ext], "-y", str(out)],
            check=True, capture_output=True,
        )
        return out

    return _make
