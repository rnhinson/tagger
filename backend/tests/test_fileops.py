import subprocess

import pytest

from core.config import settings
from core.database import db
from tests.conftest import FFMPEG


def _make_mp3(path):
    subprocess.run(
        [FFMPEG, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.3",
         "-c:a", "libmp3lame", "-y", str(path)],
        check=True, capture_output=True,
    )


def _insert(path, **extra):
    cols = {"path": str(path), "filename": path.name, "directory": str(path.parent),
            "format": "mp3", "scanned_at": 1.0, **extra}
    with db() as conn:
        names = ", ".join(cols)
        ph = ", ".join("?" * len(cols))
        cur = conn.execute(f"INSERT INTO tracks ({names}) VALUES ({ph})", list(cols.values()))
        return cur.lastrowid


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")
def test_delete_to_trash_and_undo(client, tmp_path):
    music = tmp_path / "music"
    music.mkdir()
    f = music / "song.mp3"
    _make_mp3(f)
    tid = _insert(f)

    assert client.post("/api/library/delete-files", json=[tid]).json()["deleted"] == 1
    assert not f.exists()
    trash = settings.config_dir / "trash"
    assert list(trash.iterdir())  # file preserved in trash
    assert client.get("/api/library/tracks").json()["total"] == 0

    cid = client.get("/api/library/history").json()[0]["id"]
    client.post(f"/api/library/history/{cid}/undo")
    assert f.exists()  # restored to original path
    assert client.get("/api/library/tracks").json()["total"] == 1


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")
def test_reorganize_and_undo(client, tmp_path):
    music = tmp_path / "music"
    music.mkdir()
    settings.music_dir = music
    f = music / "raw.mp3"
    _make_mp3(f)
    tid = _insert(f, title="Song", artist="Artist", album="Album", track_number="1")

    client.patch("/api/config", json={"rename_template": "{artist}/{album}/{track_number:02d} {title}"})
    assert client.post("/api/tags/reorganize", json={"track_ids": [tid]}).json()["moved"] == 1

    new = music / "Artist" / "Album" / "01 Song.mp3"
    assert new.exists() and not f.exists()
    assert client.get(f"/api/library/track/{tid}").json()["path"] == str(new)

    cid = client.get("/api/library/history").json()[0]["id"]
    client.post(f"/api/library/history/{cid}/undo")
    assert f.exists()  # moved back


def test_delete_files_requires_ids(client):
    assert client.post("/api/library/delete-files", json=[]).status_code == 400


def test_trash_info_and_empty(client):
    trash = settings.config_dir / "trash"
    trash.mkdir(parents=True, exist_ok=True)
    (trash / "old.mp3").write_bytes(b"x" * 10)

    info = client.get("/api/library/trash").json()
    assert info["count"] == 1 and info["bytes"] == 10

    assert client.post("/api/library/trash/empty").json()["removed"] == 1
    assert client.get("/api/library/trash").json()["count"] == 0
