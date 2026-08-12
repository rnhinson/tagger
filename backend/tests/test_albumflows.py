import subprocess

import pytest

from core.database import db
from core.tagger import read_tags, write_tags
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
def test_autonumber_orders_by_filename(client, tmp_path):
    music = tmp_path / "m"
    music.mkdir()
    ids = {}
    for name in ["03 c.mp3", "01 a.mp3", "02 b.mp3"]:
        f = music / name
        _make_mp3(f)
        ids[name] = _insert(f)

    assert client.post("/api/tags/autonumber", json={"track_ids": list(ids.values())}).json()["numbered"] == 3

    by_name = {t["filename"]: t["track_number"] for t in client.get("/api/library/tracks").json()["tracks"]}
    assert by_name["01 a.mp3"] == "1"
    assert by_name["02 b.mp3"] == "2"
    assert by_name["03 c.mp3"] == "3"


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")
def test_find_replace_writes_db_and_file(client, tmp_path):
    music = tmp_path / "m"
    music.mkdir()
    f = music / "x.mp3"
    _make_mp3(f)
    write_tags(f, {"artist": "The Beatles"})
    tid = _insert(f, artist="The Beatles")

    res = client.post("/api/tags/find-replace",
                      json={"track_ids": [tid], "field": "artist", "find": "The ", "replace": ""}).json()
    assert res["changed"] == 1
    assert client.get(f"/api/library/track/{tid}").json()["artist"] == "Beatles"
    assert read_tags(str(f))["artist"] == "Beatles"  # written to disk too


def test_find_replace_rejects_unknown_field(client):
    r = client.post("/api/tags/find-replace",
                    json={"track_ids": [1], "field": "path", "find": "x", "replace": "y"})
    assert r.status_code == 400
