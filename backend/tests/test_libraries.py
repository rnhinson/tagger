"""Library roots: full scans walk only active roots; switch a library off/on; read-only flag."""
import os
import stat

from core.database import db
from tests.test_staging import _insert, lib  # noqa: F401  (fixture)


def _count():
    with db() as conn:
        return conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]


def test_scan_dirs_are_the_active_roots(client, lib):
    from api.config import get_scan_dirs
    (lib / "Original (read-only)").mkdir()
    dirs = get_scan_dirs()
    assert str(lib / "Shared") in dirs and str(lib / "Libraries" / "Music - Christmas") in dirs
    assert not any("Original" in d for d in dirs) and str(lib) not in dirs


def test_switch_a_library_off_and_on(client, lib):
    xmas = lib / "Libraries" / "Music - Christmas"
    _insert(xmas / "A" / "1.mp3")
    _insert(lib / "Shared" / "B" / "1.mp3")
    libs = {l["name"]: l for l in client.get("/api/config/libraries").json()}
    assert libs["Music - Christmas"]["tracks"] == 1 and libs["Music - Christmas"]["active"]

    r = client.post("/api/config/libraries", json={"path": str(xmas), "active": False}).json()
    assert r == {"active": False, "removed": 1} and _count() == 1
    from api.config import get_scan_dirs
    assert str(xmas) not in get_scan_dirs()
    assert not {l["name"]: l for l in client.get("/api/config/libraries").json()}["Music - Christmas"]["active"]

    r = client.post("/api/config/libraries", json={"path": str(xmas), "active": True}).json()
    assert r["active"] is True and str(xmas) in get_scan_dirs()
    assert client.post("/api/config/libraries", json={"path": str(lib), "active": False}).status_code == 400


def test_read_only_tracks_are_flagged(client, lib):
    ro = lib / "Shared" / "RO"
    ro.mkdir()
    t = _insert(ro / "1.mp3")
    os.chmod(ro, stat.S_IRUSR | stat.S_IXUSR)
    try:
        if os.access(ro, os.W_OK):      # running as root: chmod doesn't bite
            return
        assert client.get(f"/api/library/track/{t}").json()["read_only"] is True
        assert client.post("/api/library/summary", json={"track_ids": [t]}).json()["read_only"] == 1
        other = _insert(lib / "Shared" / "RW" / "1.mp3")
        (lib / "Shared" / "RW").mkdir()
        assert client.get("/api/library/track-ids").json()["ids"] == [other]   # select-all skips read-only
    finally:
        os.chmod(ro, stat.S_IRWXU)
