"""Cover art in the album folder and in tracks: scan flags, quality groups, move/copy/delete."""
import subprocess

import pytest

from core import covers
from core.config import settings
from core.database import db
from core.scanner import scan_library
from core.tagger import read_cover, write_cover
from tests.conftest import FFMPEG
from tests.test_staging import lib  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")
JPG = b"\xff\xd8\xff\xe0fake-jpeg"


def _mp3(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([FFMPEG, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.3",
                    "-c:a", "libmp3lame", "-y", str(path)], check=True, capture_output=True)
    return path


def _album(lib, name, embedded=False, folder=False):
    d = lib / "Shared" / "A" / name
    for i in (1, 2):
        f = _mp3(d / f"0{i} t.mp3")
        if embedded:
            write_cover(f, "image/jpeg", JPG)
    if folder:
        (d / "Folder.JPG").write_bytes(JPG)
    return d


def _ids(d):
    with db() as conn:
        return [r[0] for r in conn.execute("SELECT id FROM tracks WHERE directory = ? ORDER BY path", (str(d),))]


def test_folder_image_names():
    assert covers.folder_image(["01.mp3", "back.jpg", "Folder.JPG", "cover.png"]) == "cover.png"
    assert covers.folder_image(["01.mp3", "scan1.jpg"]) is None


def test_scan_flags_and_quality_groups(client, lib):
    none = _album(lib, "None")
    _album(lib, "Folder", folder=True)
    _album(lib, "Tracks", embedded=True)
    both = _album(lib, "Both", embedded=True, folder=True)
    scan_library(music_dirs=[str(lib / "Shared")])
    issues = client.get("/api/library/issues").json()
    assert (issues["covers_none"], issues["covers_no_folder"], issues["covers_no_tracks"], issues["covers_both"]) == (2, 4, 4, 2)
    listed = client.get("/api/library/tracks", params={"issue": "covers_none"}).json()
    assert {t["directory"] for t in listed["tracks"]} == {str(none)}
    assert {t["has_cover"] for t in client.get("/api/library/tracks", params={"issue": "covers_both"}).json()["tracks"]} == {1}
    assert str(both) in {t["directory"] for t in client.get("/api/library/tracks", params={"issue": "covers_both"}).json()["tracks"]}


def test_move_copy_delete(client, lib):
    tracks = _album(lib, "Tracks", embedded=True)
    folder = _album(lib, "Folder", folder=True)
    scan_library(music_dirs=[str(lib / "Shared")])
    post = lambda ids, action: client.post("/api/covers/albums", json={"track_ids": ids, "action": action}).json()

    plan = client.post("/api/covers/albums", json={"track_ids": _ids(tracks) + _ids(folder), "dry_run": True}).json()
    assert [(a["embedded"], a["folder"], len(a["track_ids"])) for a in plan["albums"]] == [(0, True, 2), (2, False, 2)]
    r = post(_ids(tracks), "move_to_folder")["albums"][0]
    assert (r["folder"], r["tracks"]) == (1, 2) and (tracks / "cover.jpg").read_bytes() == JPG
    assert all(read_cover(p) is None for p in tracks.glob("*.mp3"))

    r = post(_ids(folder), "copy_to_tracks")["albums"][0]
    assert r["tracks"] == 2 and (folder / "Folder.JPG").exists()
    assert all(read_cover(p) == ("image/jpeg", JPG) for p in folder.glob("*.mp3"))

    r = post(_ids(folder), "delete_folder")["albums"][0]
    assert r["folder"] == 1 and not (folder / "Folder.JPG").exists()
    assert post(_ids(folder), "delete_folder")["albums"][0]["note"] == "no folder cover"

    r = post(_ids(folder), "delete_tracks")["albums"][0]
    assert r["tracks"] == 2 and all(read_cover(p) is None for p in folder.glob("*.mp3"))
    assert len(list((settings.config_dir / "trash").glob("cover_*"))) == 2     # the folder file + one track copy

    issues = client.get("/api/library/issues").json()
    assert issues["covers_none"] == 2 and issues["covers_no_tracks"] == 4
    assert client.post("/api/covers/albums", json={"track_ids": [], "action": "nope"}).status_code == 400


def test_fit_shrinks_only_big_images():
    from io import BytesIO
    from PIL import Image
    def img(w, h, fmt="PNG", mode="RGB"):
        b = BytesIO(); Image.new(mode, (w, h)).save(b, fmt); return b.getvalue()
    big = img(3000, 2000)
    mime, data = covers.fit("image/png", big, 1200)
    assert mime == "image/jpeg" and Image.open(BytesIO(data)).size == (1200, 800) and len(data) < len(big)
    small = img(400, 400)
    assert covers.fit("image/png", small, 1200) == ("image/png", small)
    assert covers.fit("image/png", big, 0) == ("image/png", big)
    mime, _ = covers.fit("image/png", img(2000, 2000, mode="RGBA"), 500)
    assert mime == "image/png"                                   # transparency kept
    assert covers.fit("image/jpeg", JPG, 500) == ("image/jpeg", JPG)    # unreadable: unchanged


def test_upload_is_shrunk_and_flagged(client, lib):
    from io import BytesIO
    from PIL import Image
    d = _album(lib, "Up")
    scan_library(music_dirs=[str(lib / "Shared")])
    tid = _ids(d)[0]
    b = BytesIO(); Image.new("RGB", (2000, 2000)).save(b, "PNG")
    r = client.post(f"/api/covers/{tid}", files={"file": ("big.png", b.getvalue(), "image/png")})
    assert r.status_code == 200
    mime, data = read_cover(next(iter(sorted(d.glob("*.mp3")))))
    assert mime == "image/jpeg" and Image.open(BytesIO(data)).size == (500, 500)
    assert client.get("/api/library/issues").json()["covers_no_tracks"] == 1


def test_sizes_tracked_oversized_and_shrink(client, lib):
    from io import BytesIO
    from PIL import Image
    b = BytesIO(); Image.new("RGB", (1600, 1600)).save(b, "JPEG"); big = b.getvalue()
    d = lib / "Shared" / "A" / "Big"
    for i in (1, 2):
        write_cover(_mp3(d / f"0{i} t.mp3"), "image/jpeg", big)
    (d / "cover.jpg").write_bytes(big)
    scan_library(music_dirs=[str(lib / "Shared")])
    t = client.get("/api/library/tracks", params={"directory": str(d)}).json()["tracks"][0]
    assert (t["cover_width"], t["cover_height"], t["cover_bytes"]) == (1600, 1600, len(big))
    with db() as conn:
        assert conn.execute("SELECT width, bytes FROM folder_covers WHERE directory = ?", (str(d),)).fetchone()[:] == (1600, len(big))
    assert client.get("/api/library/issues").json()["covers_oversized"] == 2
    client.get("/api/library/tracks", params={"sort": "cover"}).raise_for_status()

    r = client.post("/api/covers/albums", json={"track_ids": _ids(d), "action": "shrink"}).json()["albums"][0]
    assert (r["folder"], r["tracks"]) == (1, 2)
    assert Image.open(d / "cover.jpg").size == (1200, 1200)
    t = client.get("/api/library/tracks", params={"directory": str(d)}).json()["tracks"][0]
    assert (t["cover_width"], t["has_cover"]) == (500, 1)
    assert client.get("/api/library/issues").json()["covers_oversized"] == 0
    r = client.post("/api/covers/albums", json={"track_ids": _ids(d), "action": "shrink"}).json()["albums"][0]
    assert r["note"] == "nothing larger than the size settings"
