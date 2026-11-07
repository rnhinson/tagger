"""Folder moves/renames, server-side sort/filter, select-all and summaries."""
import pytest

from core.config import settings
from tests.test_staging import _insert, _mp3, lib, needs_ffmpeg  # noqa: F401  (fixture)


def _album(lib, *parts, n=2, **tags):
    d = lib.joinpath(*parts)
    ids = [_insert(_mp3(d / f"0{i} t.mp3"), title=f"T{i}", track_number=str(i), **tags) for i in range(1, n + 1)]
    (d / "cover.jpg").write_bytes(b"jpg")
    return d, ids


# ── folder moves ─────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_move_folder_to_another_library_with_its_cover(client, lib):
    (lib / "Libraries" / "Music - Cast").mkdir()
    src, ids = _album(lib, "Shared", "Lloyd Webber", "Phantom (1986)")
    dst = lib / "Libraries" / "Music - Cast" / "Lloyd Webber" / "Phantom (1986)"

    r = client.post("/api/fs/move", json={"src": str(src), "dst": str(dst)})
    assert r.json() == {"staged": True}
    assert src.is_dir()                                       # nothing moved yet
    t = client.get(f"/api/library/track/{ids[0]}").json()
    assert t["staged"]["new_path"] == str(dst / "01 t.mp3") and t["staged"]["via_folder"]
    staged = client.get("/api/staged").json()
    assert staged["count"] == 1 and staged["dirs"] == [{"src": str(src), "dst": str(dst), "tracks": 2}]

    res = client.post("/api/staged/apply", json={}).json()
    assert res["folders"] == 1 and res["applied"] == 2 and res["errors"] == []
    assert (dst / "cover.jpg").exists() and (dst / "02 t.mp3").exists()
    assert not src.exists() and not (lib / "Shared" / "Lloyd Webber").exists()   # pruned
    assert client.get(f"/api/library/track/{ids[1]}").json()["path"] == str(dst / "02 t.mp3")

    client.post(f"/api/library/history/{res['change_id']}/undo")
    assert (src / "cover.jpg").exists() and (src / "01 t.mp3").exists()
    assert not (lib / "Libraries" / "Music - Cast" / "Lloyd Webber").exists()
    assert client.get(f"/api/library/track/{ids[0]}").json()["path"] == str(src / "01 t.mp3")


@needs_ffmpeg
def test_rename_folder(client, lib):
    src, ids = _album(lib, "Libraries", "Music - Christmas", "almostchristmas", n=1)
    r = client.post("/api/fs/rename", json={"path": str(src), "name": "Almost Christmas (2001)"})
    assert r.status_code == 200
    client.post("/api/staged/apply", json={})
    assert (src.parent / "Almost Christmas (2001)" / "cover.jpg").exists()


def test_folder_move_validation(client, lib):
    a = lib / "Shared" / "A"
    (a / "inner").mkdir(parents=True)
    (lib / "Shared" / "B").mkdir()
    bad = [
        ({"src": str(lib / "Shared"), "dst": str(lib / "Libraries" / "Music - Christmas" / "S")}, "library root"),
        ({"src": str(a), "dst": str(a / "inner" / "A")}, "inside itself"),
        ({"src": str(a), "dst": str(lib / "Shared" / "B")}, "already exists"),
        ({"src": str(a), "dst": str(lib / "Elsewhere" / "A")}, "inside a library root"),
        ({"src": str(a), "dst": str(lib / "Libraries")}, "inside a library root"),
        ({"src": str(lib / "Libraries"), "dst": str(lib / "Shared" / "L")}, "holds library roots"),
    ]
    for body, msg in bad:
        r = client.post("/api/fs/move", json=body)
        assert r.status_code == 400 and msg in r.json()["detail"], (body, r.json())
    assert client.post("/api/fs/move", json={"src": "/etc", "dst": str(lib / "Shared" / "x")}).status_code == 403


@needs_ffmpeg
def test_folder_move_refuses_tracks_with_staged_moves_and_vice_versa(client, lib):
    src, ids = _album(lib, "Shared", "X", "Al", n=1, album="Al", album_artist="X")
    client.post("/api/tags/reorganize", json={"track_ids": ids})
    r = client.post("/api/fs/move", json={"src": str(src), "dst": str(lib / "Shared" / "Y")})
    assert r.status_code == 400 and "staged moves" in r.json()["detail"]
    client.post("/api/staged/discard", json={})
    client.post("/api/fs/move", json={"src": str(src), "dst": str(lib / "Shared" / "Y")})
    res = client.post("/api/tags/reorganize", json={"track_ids": ids}).json()
    assert "folder is staged" in res["errors"][0]["error"]


@needs_ffmpeg
def test_folder_move_staged_step_undo_and_discard(client, lib):
    src, _ = _album(lib, "Shared", "A", n=1)
    client.post("/api/fs/move", json={"src": str(src), "dst": str(lib / "Shared" / "B")})
    c = client.get("/api/staged/count").json()
    assert c["count"] == 1 and c["last_step"]["summary"].startswith("Move folder A")
    client.post("/api/staged/undo")
    assert client.get("/api/staged/count").json()["count"] == 0
    client.post("/api/fs/move", json={"src": str(src), "dst": str(lib / "Shared" / "B")})
    assert client.post("/api/staged/discard", json={"dirs": [str(src)]}).json()["discarded"] == 1
    assert client.get("/api/staged/count").json() == {"count": 0, "steps": 0, "last_step": None}


@needs_ffmpeg
def test_tags_and_folder_move_in_one_write_undo_together(client, lib):
    src, ids = _album(lib, "Shared", "A", n=1, genre="Rock")
    client.patch(f"/api/tags/{ids[0]}", json={"genre": "Soundtrack"})
    client.post("/api/fs/move", json={"src": str(src), "dst": str(lib / "Shared" / "B")})
    res = client.post("/api/staged/apply", json={}).json()
    from core.tagger import read_tags
    moved = lib / "Shared" / "B" / "01 t.mp3"
    assert read_tags(str(moved))["genre"] == "Soundtrack"
    client.post(f"/api/library/history/{res['change_id']}/undo")
    assert read_tags(str(src / "01 t.mp3"))["genre"] == "Rock"


# ── views: sort, filter, select-all, summary ─────────────────────────────────

def _rows(lib):
    s = lib / "Shared"
    return [
        _insert(s / "a.flac", title="b", artist="X", album="A", year="2001", track_number="10", format="flac"),
        _insert(s / "b.mp3", title="a", artist="X", album="A", year="2001", track_number="2"),
        _insert(s / "c.mp3", title="c", artist="", album="", track_number="1"),   # poor
        _insert(s / "d.mp3", title="d", artist="Y", album="", track_number="3"),  # fair
    ]


def test_sort_is_server_side_and_numeric(client, lib):
    a, b, c, d = _rows(lib)
    t = client.get("/api/library/tracks?sort=track_number").json()["tracks"]
    assert [x["id"] for x in t] == [c, b, d, a]          # 1, 2, 3, 10 -- not "10" < "2"
    t = client.get("/api/library/tracks?sort=title&sort_dir=desc&limit=2").json()
    assert [x["id"] for x in t["tracks"]] == [d, c] and t["total"] == 4
    t = client.get("/api/library/tracks?sort=artist").json()["tracks"]
    assert t[-1]["id"] == c                               # blanks last


def test_filters_are_server_side(client, lib):
    a, b, c, d = _rows(lib)
    ids = lambda q: [x["id"] for x in client.get(f"/api/library/tracks?{q}").json()["tracks"]]
    assert ids("format=flac") == [a]
    assert set(ids("quality=poor")) == {c}
    assert set(ids("quality=fair")) == {d}
    assert set(ids("quality=good")) == {a, b}
    assert ids("q=X&format=flac") == [a]                  # search combines with filters
    assert client.get("/api/library/formats").json() == ["flac", "mp3"]


def test_track_ids_cover_every_page_in_view_order(client, lib):
    a, b, c, d = _rows(lib)
    r = client.get("/api/library/track-ids?sort=track_number").json()
    assert r["ids"] == [c, b, d, a]
    assert client.get("/api/library/track-ids?quality=good").json()["ids"] == [b, a]   # track 2, 10


def test_summary_reports_shared_and_mixed_values_as_staged(client, lib):
    a, b, c, d = _rows(lib)
    client.patch(f"/api/tags/{a}", json={"genre": "G"})
    client.patch(f"/api/tags/{b}", json={"genre": "G"})
    s = client.post("/api/library/summary", json={"track_ids": [a, b]}).json()
    assert s["count"] == 2
    assert s["values"]["genre"] == "G" and s["values"]["album"] == "A"
    assert "title" in s["mixed"] and "genre" not in s["mixed"]


# ── drag and drop: files into a folder ───────────────────────────────────────

@needs_ffmpeg
def test_move_files_into_a_folder(client, lib):
    src, ids = _album(lib, "Shared", "Loose", n=2)
    target = lib / "Libraries" / "Music - Christmas" / "Carols"
    target.mkdir()
    r = client.post("/api/tags/move-to", json={"track_ids": ids, "folder": str(target)}).json()
    assert r["planned"] == 2 and r["staged"] is True
    assert client.get("/api/staged/count").json()["last_step"]["summary"] == "Move 2 files → Carols"
    client.post("/api/staged/apply", json={})
    assert (target / "01 t.mp3").exists() and (target / "02 t.mp3").exists()
    assert not (target / "cover.jpg").exists()   # another album's folder: its cover isn't ours
    assert not src.exists() and [p.name.endswith("_cover.jpg") for p in (settings.config_dir / "trash").iterdir()] == [True]


def test_move_files_into_a_folder_validation(client, lib):
    tid = _insert(lib / "Shared" / "a.mp3", title="A")
    assert client.post("/api/tags/move-to", json={"track_ids": [tid], "folder": "/etc"}).status_code == 400
    r = client.post("/api/tags/move-to", json={"track_ids": [tid], "folder": str(lib / "Shared" / "nope")})
    assert r.status_code == 400 and "not found" in r.json()["detail"]
    r = client.post("/api/tags/move-to", json={"track_ids": [tid], "folder": str(lib / "Shared")}).json()
    assert r["planned"] == 0   # already there


def test_default_order_is_numeric_by_track(client, lib):
    ids = {n: _insert(lib / "Shared" / "Al" / f"{n}.mp3", track_number=str(n)) for n in (10, 2, 1)}
    got = [t["id"] for t in client.get("/api/library/tracks").json()["tracks"]]
    assert got == [ids[1], ids[2], ids[10]]


def test_album_list_groups_by_folder_with_shared_tags_and_expected(client, lib):
    d1, d2 = lib / "Shared" / "VA" / "Hits", lib / "Shared" / "Ann" / "Solo"
    _insert(d1 / "01.mp3", album="Hits", artist="Ann", album_artist="Various", year="2001", track_number="1/3", genre="Pop")
    _insert(d1 / "02.mp3", album="Hits", artist="Bob", album_artist="Various", year="2001", track_number="2/3", genre="Rock")
    _insert(d2 / "01.mp3", album="Solo", artist="Ann", track_number="1")
    albums = client.get("/api/library/album-list").json()
    hits = next(a for a in albums if a["album"] == "Hits")
    assert (hits["tracks"], hits["expected"], hits["discs"]) == (2, 3, 1)          # one row, not one per artist
    assert hits["album_artist"] == "Various" and hits["year"] == "2001"
    assert hits["genre"] is None and set(hits["mixed"]) == {"artist", "genre"}
    assert sorted(hits["values"]["genre"]) == ["Pop", "Rock"]
    solo = next(a for a in albums if a["album"] == "Solo")
    assert solo["expected"] is None and solo["artist"] == "Ann"
    only = client.get("/api/library/album-list", params={"tag": "genre", "value": "Rock"}).json()
    assert [a["album"] for a in only] == ["Hits"] and only[0]["tracks"] == 1           # follows the view's filters


def test_tracks_flag_missing_files(client, lib):
    d = lib / "Shared" / "M"
    d.mkdir(parents=True)
    (d / "here.mp3").write_bytes(b"x")
    here = _insert(d / "here.mp3")
    gone = _insert(d / "gone.mp3")
    by = {t["id"]: t["missing"] for t in client.get("/api/library/tracks").json()["tracks"]}
    assert by[here] is False and by[gone] is True
