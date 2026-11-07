"""Staged changes, library-root organize, and safe moves + undo."""
import errno
import os
import shutil
import subprocess

import pytest

from core import fileops, staging
from core.config import settings
from core.database import db
from core.tagger import read_tags
from tests.conftest import FFMPEG

needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")


def _mp3(path, **tags):
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = [a for k, v in tags.items() for a in ("-metadata", f"{k}={v}")]
    subprocess.run(
        [FFMPEG, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.3",
         "-c:a", "libmp3lame", *meta, "-y", str(path)],
        check=True, capture_output=True,
    )
    return path


def _insert(path, **extra):
    cols = {"path": str(path), "filename": path.name, "directory": str(path.parent),
            "format": "mp3", "scanned_at": 1.0, **extra}
    with db() as conn:
        names = ", ".join(cols)
        ph = ", ".join("?" * len(cols))
        return conn.execute(f"INSERT INTO tracks ({names}) VALUES ({ph})", list(cols.values())).lastrowid


@pytest.fixture()
def lib(client, tmp_path, monkeypatch):
    """/music with a Shared root and per-library roots under Libraries/."""
    music = tmp_path / "music"
    (music / "Shared").mkdir(parents=True)
    (music / "Libraries" / "Music - Christmas").mkdir(parents=True)
    monkeypatch.setattr(settings, "music_dir", music)
    client.patch("/api/config", json={
        "library_roots": [str(music / "Shared"), str(music / "Libraries" / "*")],
        "rename_template": "{album_artist}/{album}/{track_number:02d} {title}",
    })
    return music


# ── staging ──────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_edit_is_staged_until_applied(client, lib):
    f = _mp3(lib / "Shared" / "a.mp3", title="Old")
    tid = _insert(f, title="Old")

    assert client.patch(f"/api/tags/{tid}", json={"title": "New"}).json()["staged"] is True
    assert read_tags(str(f))["title"] == "Old"          # file untouched
    t = client.get(f"/api/library/track/{tid}").json()
    assert t["title"] == "Old"                          # DB untouched
    assert t["staged"]["tags"] == {"title": "New"}      # overlay for the UI

    diff = client.get("/api/staged").json()
    assert diff["count"] == 1
    assert diff["tracks"][0]["changes"] == [{"field": "title", "old": "Old", "new": "New"}]

    res = client.post("/api/staged/apply", json={}).json()
    assert res["applied"] == 1 and res["errors"] == [] and res["change_id"]
    assert read_tags(str(f))["title"] == "New"
    assert client.get(f"/api/library/track/{tid}").json()["staged"] is None
    assert client.get("/api/staged/count").json()["count"] == 0

    client.post(f"/api/library/history/{res['change_id']}/undo")
    assert read_tags(str(f))["title"] == "Old"


def test_staging_the_current_value_is_not_a_change(client, lib):
    tid = _insert(lib / "Shared" / "a.mp3", title="Same", genre="")
    client.patch(f"/api/tags/{tid}", json={"title": "Same", "genre": ""})
    assert client.get("/api/staged/count").json()["count"] == 0

    client.patch(f"/api/tags/{tid}", json={"title": "Other"})
    client.patch(f"/api/tags/{tid}", json={"title": "Same"})  # edited back
    assert client.get("/api/staged/count").json()["count"] == 0


def test_discard_selected_and_all(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A")
    b = _insert(lib / "Shared" / "b.mp3", title="B")
    client.post("/api/tags/bulk", json={"track_ids": [a, b], "tags": {"genre": "Soundtrack"}})
    assert client.get("/api/staged/count").json()["count"] == 2
    assert client.post("/api/staged/discard", json={"track_ids": [a]}).json()["discarded"] == 1
    assert client.post("/api/staged/discard", json={}).json()["discarded"] == 1


@needs_ffmpeg
def test_staging_off_writes_immediately(client, lib):
    f = _mp3(lib / "Shared" / "a.mp3", title="Old")
    tid = _insert(f, title="Old")
    client.patch("/api/config", json={"stage_changes": False})
    res = client.patch(f"/api/tags/{tid}", json={"title": "New"}).json()
    assert res["staged"] is False and res["applied"] == 1
    assert read_tags(str(f))["title"] == "New"


def test_find_replace_builds_on_staged_value(client, lib):
    tid = _insert(lib / "Shared" / "a.mp3", artist="The Beatles")
    client.patch(f"/api/tags/{tid}", json={"artist": "The Beatles (UK)"})
    client.post("/api/tags/find-replace",
                json={"track_ids": [tid], "field": "artist", "find": "The ", "replace": ""})
    assert client.get(f"/api/library/track/{tid}").json()["staged"]["tags"]["artist"] == "Beatles (UK)"


def test_settings_patch_keeps_unsent_fields(client):
    client.patch("/api/config", json={"rename_on_save": True})
    client.patch("/api/config", json={"discogs_token": "x"})
    assert client.get("/api/config").json()["rename_on_save"] is True


# ── organize ─────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_organize_stays_inside_the_tracks_library(client, lib):
    src = _mp3(lib / "Libraries" / "Music - Christmas" / "loose" / "x.mp3")
    tid = _insert(src, title="Silent Night", album="Carols", album_artist="Choir", track_number="3")

    res = client.post("/api/tags/reorganize", json={"track_ids": [tid]}).json()
    assert res["planned"] == 1 and res["staged"] is True
    dest = lib / "Libraries" / "Music - Christmas" / "Choir" / "Carols" / "03 Silent Night.mp3"
    assert client.get("/api/staged").json()["tracks"][0]["new_path"] == str(dest)
    assert src.exists() and not dest.exists()  # nothing moved yet

    assert client.post("/api/staged/apply", json={}).json()["applied"] == 1
    assert dest.exists() and not src.exists()
    assert not (lib / "Libraries" / "Music - Christmas" / "loose").exists()  # emptied folder pruned
    assert (lib / "Libraries" / "Music - Christmas").is_dir()                # root kept
    assert not (lib / "Choir").exists()  # never the music dir itself


def test_organize_refuses_tracks_outside_every_root(client, lib):
    tid = _insert(lib / "Elsewhere" / "x.mp3", title="T")
    res = client.post("/api/tags/reorganize", json={"track_ids": [tid]}).json()
    assert res["planned"] == 0
    assert "library root" in res["errors"][0]["error"]
    assert client.get("/api/staged/count").json()["count"] == 0


@needs_ffmpeg
def test_organize_uses_staged_tags(client, lib):
    src = _mp3(lib / "Shared" / "x.mp3")
    tid = _insert(src, title="T", album="Old", album_artist="A", track_number="1")
    client.patch(f"/api/tags/{tid}", json={"album": "New"})
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    client.post("/api/staged/apply", json={})
    moved = lib / "Shared" / "A" / "New" / "01 T.mp3"
    assert moved.exists() and read_tags(str(moved))["album"] == "New"


@needs_ffmpeg
def test_rename_on_save_stages_the_move(client, lib):
    src = _mp3(lib / "Shared" / "x.mp3")
    tid = _insert(src, title="T", album="Alb", album_artist="A", track_number="2")
    client.patch("/api/config", json={"rename_on_save": True})
    client.patch(f"/api/tags/{tid}", json={"title": "U"})
    staged = client.get(f"/api/library/track/{tid}").json()["staged"]
    assert staged["new_path"] == str(lib / "Shared" / "A" / "Alb" / "02 U.mp3")


@needs_ffmpeg
def test_apply_refuses_colliding_or_existing_destinations(client, lib):
    a = _insert(_mp3(lib / "Shared" / "a.mp3"), title="Same", album="Al", album_artist="X", track_number="1")
    b = _insert(_mp3(lib / "Shared" / "b.mp3"), title="Same", album="Al", album_artist="X", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [a, b]})
    res = client.post("/api/staged/apply", json={}).json()
    assert res["applied"] == 0 and len(res["errors"]) == 2
    assert client.get("/api/staged/count").json()["count"] == 2  # still staged

    client.post("/api/staged/discard", json={"track_ids": [b]})
    _mp3(lib / "Shared" / "X" / "Al" / "01 Same.mp3")  # occupied
    res = client.post("/api/staged/apply", json={}).json()
    assert "already exists" in res["errors"][0]["error"]
    assert (lib / "Shared" / "a.mp3").exists()


@needs_ffmpeg
def test_apply_refuses_a_move_off_the_filesystem(client, lib, monkeypatch):
    src = _mp3(lib / "Shared" / "x.mp3")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    monkeypatch.setattr(staging, "same_filesystem", lambda a, b: False)
    res = client.post("/api/staged/apply", json={}).json()
    assert res["applied"] == 0 and "different filesystem" in res["errors"][0]["error"]
    assert src.exists()


# ── moves + undo ─────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_undo_moves_back_across_filesystems(client, lib, monkeypatch):
    """The 2026-11-01 bug: undo used Path.rename, which fails with EXDEV."""
    src = _mp3(lib / "Shared" / "orig" / "x.mp3")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    cid = client.post("/api/staged/apply", json={}).json()["change_id"]

    real_rename = os.rename

    def cross_device(a, b, *args, **kw):
        if os.path.dirname(a) != os.path.dirname(b):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return real_rename(a, b, *args, **kw)

    monkeypatch.setattr(os, "rename", cross_device)
    res = client.post(f"/api/library/history/{cid}/undo").json()
    assert res["errors"] == [] and res["restored"] == 1
    assert src.exists()
    assert not (lib / "Shared" / "A").exists()


@needs_ffmpeg
def test_failed_undo_is_retryable(client, lib):
    src = _mp3(lib / "Shared" / "x.mp3")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    cid = client.post("/api/staged/apply", json={}).json()["change_id"]

    blocker = _mp3(src)  # something new now sits at the original path
    res = client.post(f"/api/library/history/{cid}/undo").json()
    assert res["errors"] and "already exists" in res["errors"][0]["error"]
    assert client.get("/api/library/history").json()[0]["undone"] == 0

    blocker.unlink()
    res = client.post(f"/api/library/history/{cid}/undo").json()
    assert res["errors"] == [] and src.exists()


@needs_ffmpeg
def test_undo_must_go_newest_first_per_track(client, lib):
    tid = _insert(_mp3(lib / "Shared" / "x.mp3"), title="A")
    other = _insert(_mp3(lib / "Shared" / "y.mp3"), title="Y")
    client.patch("/api/config", json={"stage_changes": False})
    first = client.patch(f"/api/tags/{tid}", json={"title": "B"})
    client.patch(f"/api/tags/{tid}", json={"title": "C"})
    client.patch(f"/api/tags/{other}", json={"title": "Z"})
    assert first.status_code == 200
    hist = client.get("/api/library/history").json()
    oldest = hist[-1]["id"]
    r = client.post(f"/api/library/history/{oldest}/undo")
    assert r.status_code == 400 and "later change first" in r.json()["detail"]
    # an unrelated track's change can be undone out of order
    assert client.post(f"/api/library/history/{hist[0]['id']}/undo").status_code == 200
    assert hist[0]["count"] == 1


# ── move_file ────────────────────────────────────────────────────────────────

def test_move_file_never_overwrites(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.write_text("a")
    b.write_text("b")
    with pytest.raises(fileops.MoveError):
        fileops.move_file(a, b)
    assert b.read_text() == "b"


def test_move_file_case_only_rename(tmp_path):
    a = tmp_path / "song.mp3"
    a.write_text("x")
    fileops.move_file(a, tmp_path / "Song.mp3")
    assert [p.name for p in tmp_path.iterdir()] == ["Song.mp3"]


def test_root_for_picks_the_deepest(tmp_path):
    (tmp_path / "Libraries" / "Kids").mkdir(parents=True)
    roots = fileops.expand_roots([str(tmp_path), str(tmp_path / "Libraries" / "*")])
    assert fileops.root_for(tmp_path / "Libraries" / "Kids" / "a" / "b.mp3", roots) == tmp_path / "Libraries" / "Kids"
    assert fileops.root_for(tmp_path / "x.mp3", roots) == tmp_path
    assert fileops.root_for("/nowhere/x.mp3", roots) is None


def test_rename_preview_for_a_track_shows_its_root(client, lib):
    tid = _insert(lib / "Libraries" / "Music - Christmas" / "x.mp3",
                  title="T", album="Al", album_artist="A", track_number="1")
    r = client.post("/api/config/rename-preview", json={
        "template": "{album_artist}/{album}/{track_number:02d} {title}",
        "track_id": tid, "tags": {"title": "New"},
    }).json()
    assert r["ok"] and r["preview"] == "Libraries/Music - Christmas/A/Al/01 New.mp3"


# ── staging undo steps ───────────────────────────────────────────────────────

def _staged(client, tid):
    return client.get(f"/api/library/track/{tid}").json()["staged"]


def test_undo_staged_steps_newest_first(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A", genre="Rock", album="Al", album_artist="X", track_number="1")
    b = _insert(lib / "Shared" / "b.mp3", title="B", genre="Rock")
    client.patch(f"/api/tags/{a}", json={"genre": "Folk"})                       # step 1
    client.post("/api/tags/bulk", json={"track_ids": [a, b], "tags": {"genre": "Soundtrack"}})  # step 2
    client.post("/api/tags/reorganize", json={"track_ids": [a]})                  # step 3

    c = client.get("/api/staged/count").json()
    assert c["steps"] == 3 and c["last_step"]["summary"].startswith("Re-file")

    assert client.post("/api/staged/undo").json()["restored"] == 1
    assert _staged(client, a) == {"tags": {"genre": "Soundtrack"}, "new_path": None}
    client.post("/api/staged/undo")                                              # bulk
    assert _staged(client, a)["tags"] == {"genre": "Folk"}
    assert _staged(client, b) is None
    client.post("/api/staged/undo")                                              # first edit
    assert _staged(client, a) is None
    assert client.post("/api/staged/undo").status_code == 400


def test_no_op_staging_is_not_a_step(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A")
    client.patch(f"/api/tags/{a}", json={"title": "A"})
    assert client.get("/api/staged/count").json()["steps"] == 0


def test_discard_drops_tracks_from_steps(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A")
    b = _insert(lib / "Shared" / "b.mp3", title="B")
    client.patch(f"/api/tags/{a}", json={"title": "A2"})
    client.post("/api/tags/bulk", json={"track_ids": [a, b], "tags": {"genre": "G"}})
    client.post("/api/staged/discard", json={"track_ids": [a]})
    c = client.get("/api/staged/count").json()
    assert c["steps"] == 1 and c["last_step"]["count"] == 1   # step 1 emptied and gone
    client.post("/api/staged/undo")
    assert _staged(client, a) is None and _staged(client, b) is None


@needs_ffmpeg
def test_writing_clears_the_step_stack(client, lib):
    a = _insert(_mp3(lib / "Shared" / "a.mp3"), title="A")
    client.patch(f"/api/tags/{a}", json={"title": "A2"})
    client.post("/api/staged/apply", json={})
    assert client.get("/api/staged/count").json()["steps"] == 0


# ── browsing ─────────────────────────────────────────────────────────────────

def test_tag_values_and_tag_filter(client, lib):
    _insert(lib / "Shared" / "a.mp3", genre="Soundtrack")
    _insert(lib / "Shared" / "b.mp3", genre="Soundtrack")
    _insert(lib / "Shared" / "c.mp3")
    vals = client.get("/api/library/tag-values?field=genre").json()
    assert {v["value"]: v["track_count"] for v in vals} == {"": 1, "Soundtrack": 2}
    assert client.get("/api/library/tracks?tag=genre&value=Soundtrack").json()["total"] == 2
    assert client.get("/api/library/tracks?tag=genre&value=").json()["total"] == 1
    assert client.get("/api/library/tag-values?field=path").status_code == 400
    # an unknown tag is ignored, never interpolated
    assert client.get("/api/library/tracks?tag=path&value=x").json()["total"] == 3


def test_tree_reports_subfolders(client, lib):
    (lib / "Libraries" / "Music - Christmas" / "Album").mkdir()
    tree = client.get(f"/api/fs/tree?path={lib / 'Libraries'}").json()
    xmas = next(d for d in tree["dirs"] if d["name"] == "Music - Christmas")
    assert xmas["has_dirs"] is True
    inner = client.get(f"/api/fs/tree?path={lib / 'Libraries' / 'Music - Christmas'}").json()
    assert inner["dirs"][0]["has_dirs"] is False


def test_step_label_names_the_changed_fields(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A", genre="Rock", year="1999")
    b = _insert(lib / "Shared" / "b.mp3", title="B", genre="Rock", year="1999")
    # the editor sends every field; only genre actually changes
    client.post("/api/tags/bulk", json={"track_ids": [a, b], "tags": {"genre": "Folk", "year": "1999"}})
    assert client.get("/api/staged/count").json()["last_step"]["summary"] == "Set genre on 2 tracks"
    client.patch(f"/api/tags/{a}", json={"title": "A2", "album_artist": "X"})
    assert client.get("/api/staged/count").json()["last_step"]["summary"] == "Edited album artist, title — A"


# ── Review grouped by action ─────────────────────────────────────────────────

def test_actions_group_lines_by_step_newest_first(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A", genre="Rock", album="Al", album_artist="X", track_number="1")
    b = _insert(lib / "Shared" / "b.mp3", title="B", genre="Rock")
    client.post("/api/tags/bulk", json={"track_ids": [a, b], "tags": {"genre": "Folk"}})
    client.patch(f"/api/tags/{a}", json={"genre": "Jazz", "year": "2001"})
    client.post("/api/tags/reorganize", json={"track_ids": [a]})
    r = client.get("/api/staged/actions").json()
    assert [s["summary"] for s in r["steps"]] == ["Re-file 1 file to the library layout", "Edited genre, year — A", "Set genre on 2 tracks"]
    org, edit, bulk = r["steps"]
    assert [l["kind"] for l in org["lines"]] == ["path"] and org["lines"][0]["new"].endswith("/X/Al/01 A.mp3")
    assert {(l["field"], l["old"], l["new"]) for l in edit["lines"]} == {("genre", "Folk", "Jazz"), ("year", None, "2001")}
    assert {(l["name"], l["old"], l["new"]) for l in bulk["lines"]} == {("A", "Rock", "Folk"), ("B", "Rock", "Folk")}
    assert r["other"] == [] and r["count"] == 2


def test_actions_track_discards_and_undo(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A")
    b = _insert(lib / "Shared" / "b.mp3", title="B")
    client.post("/api/tags/bulk", json={"track_ids": [a, b], "tags": {"genre": "G"}})
    client.post("/api/staged/discard", json={"track_ids": [a]})
    s = client.get("/api/staged/actions").json()["steps"]
    assert len(s) == 1 and [l["name"] for l in s[0]["lines"]] == ["B"]
    client.post("/api/staged/undo")
    assert client.get("/api/staged/actions").json() == {"count": 0, "steps": [], "other": []}


def test_actions_show_folder_moves_and_untracked_changes(client, lib):
    (lib / "Shared" / "A").mkdir()
    client.post("/api/fs/move", json={"src": str(lib / "Shared" / "A"), "dst": str(lib / "Shared" / "B")})
    line = client.get("/api/staged/actions").json()["steps"][0]["lines"][0]
    assert line["kind"] == "folder" and line["old"] is None and line["new"].endswith("/Shared/B")
    # a staged entry with no step (e.g. a move left over from a failed write)
    t = _insert(lib / "Shared" / "c.mp3", title="C")
    from core.database import db
    with db() as conn:
        conn.execute("INSERT INTO staged (track_id, tags, new_path, staged_at) VALUES (?, '{}', ?, 1)",
                     (t, str(lib / "Shared" / "d.mp3")))
    other = client.get("/api/staged/actions").json()["other"]
    assert [(l["kind"], l["name"]) for l in other] == [("path", "C")]


def test_steps_from_before_details_still_list_and_undo(client, lib):
    a = _insert(lib / "Shared" / "a.mp3", title="A")
    client.patch(f"/api/tags/{a}", json={"title": "B"})
    from core.database import db
    with db() as conn:
        conn.execute("UPDATE staged_steps SET after = NULL")
    s = client.get("/api/staged/actions").json()["steps"][0]
    assert s["details"] is False and s["lines"] == [] and s["count"] == 1
    client.post("/api/staged/undo")
    assert client.get("/api/staged/count").json()["count"] == 0


def test_migration_adds_after_to_an_existing_steps_table(tmp_path, monkeypatch):
    import sqlite3
    from core.database import init_db
    monkeypatch.setattr(settings, "config_dir", tmp_path)
    con = sqlite3.connect(tmp_path / "library.db")
    con.execute("CREATE TABLE staged_steps (id INTEGER PRIMARY KEY, ts REAL, summary TEXT, data TEXT)")
    con.execute("INSERT INTO staged_steps (ts, summary, data) VALUES (1, 'old', '{}')")
    con.commit(); con.close()
    init_db()
    con = sqlite3.connect(tmp_path / "library.db")
    assert "after" in {r[1] for r in con.execute("PRAGMA table_info(staged_steps)")}
    assert con.execute("SELECT summary, after FROM staged_steps").fetchall() == [("old", None)]


# ── files must exist: write and undo check the disk, not just the DB ─────────

@needs_ffmpeg
def test_write_refuses_everything_when_a_file_is_missing(client, lib):
    here = _insert(_mp3(lib / "Shared" / "here.mp3", title="Old"), title="Old")
    gone = _insert(lib / "Shared" / "gone.mp3", title="Gone")
    client.patch(f"/api/tags/{here}", json={"title": "New"})
    client.patch(f"/api/tags/{gone}", json={"title": "New"})
    res = client.post("/api/staged/apply", json={}).json()
    assert res["applied"] == 0 and res["missing"] == 1
    assert res["errors"] == [{"id": gone, "name": "Gone", "error": "file missing"}]
    assert read_tags(str(lib / "Shared" / "here.mp3"))["title"] == "Old"   # nothing written
    assert client.get("/api/staged/count").json()["count"] == 2              # all still staged


@needs_ffmpeg
def test_undo_with_the_file_gone_stays_not_undone(client, lib):
    src = _mp3(lib / "Shared" / "x.mp3")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    cid = client.post("/api/staged/apply", json={}).json()["change_id"]
    moved = lib / "Shared" / "A" / "Al" / "01 T.mp3"
    moved.unlink()   # deleted behind Tagger's back

    res = client.post(f"/api/library/history/{cid}/undo").json()
    assert res["restored"] == 0 and res["errors"][0]["error"] == f"file missing: {moved}"
    assert client.get(f"/api/library/track/{tid}").json()["path"] == str(moved)   # row untouched
    assert client.get("/api/library/history").json()[0]["undone"] == 0


# ── library layouts ──────────────────────────────────────────────────────────

def _layout(client, lib, template="{album_artist_the}/{album} ({year})/{track_number:02d} {title}"):
    """Check Shared against a layout: its own override of the standard one."""
    r = client.patch("/api/config", json={"layout_libraries": [str(lib / "Shared")],
                                          "library_templates": {str(lib / "Shared"): template}})
    assert r.status_code == 200
    return r


def test_not_in_layout_lists_misfiled_tracks_with_their_layout_path(client, lib):
    _layout(client, lib)
    good = _insert(lib / "Shared" / "Pogues, The" / "Rum (1985)" / "01 Sally.mp3",
                   title="Sally", album="Rum", album_artist="The Pogues", year="1985", track_number="1")
    bad = _insert(lib / "Shared" / "The Pogues" / "Rum" / "Sally 2.mp3",
                  title="Sally 2", album="Rum", album_artist="The Pogues", year="1985", track_number="2")
    xmas = _insert(lib / "Libraries" / "Music - Christmas" / "anywhere.mp3", title="X")   # no layout: not checked
    assert client.get("/api/library/issues").json()["not_in_layout"] == 1
    tracks = client.get("/api/library/tracks", params={"issue": "not_in_layout"}).json()["tracks"]
    assert [t["id"] for t in tracks] == [bad]
    assert tracks[0]["layout_path"] == str(lib / "Shared" / "Pogues, The" / "Rum (1985)" / "02 Sally 2.mp3")
    by = {t["id"]: t["layout_path"] for t in client.get("/api/library/tracks").json()["tracks"]}
    assert by[good] is None and by[xmas] is None


def test_layouts_are_listed_per_library_and_validated(client, lib):
    _layout(client, lib, "{album}/{title}")
    libs = {l["name"]: (l["layout"], l["template"]) for l in client.get("/api/config/libraries").json()}
    assert libs == {"Shared": (True, "{album}/{title}"), "Music - Christmas": (False, "")}
    r = client.patch("/api/config", json={"library_templates": {str(lib / "Shared"): "{nope}"}})
    assert r.status_code == 400 and "Shared" in r.json()["detail"]
    assert client.get("/api/config").json()["library_templates"] == {str(lib / "Shared"): "{album}/{title}"}


@needs_ffmpeg
def test_refile_stages_the_move_to_the_layout(client, lib):
    _layout(client, lib)
    src = _mp3(lib / "Shared" / "loose.mp3")
    tid = _insert(src, title="Sally", album="Rum", album_artist="The Pogues", year="1985", track_number="1")
    res = client.post("/api/tags/reorganize", json={"track_ids": [tid]}).json()
    assert res["planned"] == 1 and res["staged"] is True
    dest = lib / "Shared" / "Pogues, The" / "Rum (1985)" / "01 Sally.mp3"
    assert client.get("/api/staged").json()["tracks"][0]["new_path"] == str(dest)
    assert src.exists()                                   # nothing moves until written
    client.post("/api/staged/apply", json={})
    assert dest.exists()
    assert client.get("/api/library/issues").json()["not_in_layout"] == 0


@needs_ffmpeg
def test_rename_on_save_follows_the_library_layout(client, lib):
    _layout(client, lib, "{artist_the}/{title}")
    tid = _insert(_mp3(lib / "Shared" / "x.mp3"), title="T", artist="The Band")
    client.patch("/api/config", json={"rename_on_save": True})
    client.patch(f"/api/tags/{tid}", json={"title": "U"})
    assert client.get(f"/api/library/track/{tid}").json()["staged"]["new_path"] == str(lib / "Shared" / "Band, The" / "U.mp3")


def test_checked_library_uses_the_standard_layout_unless_overridden(client, lib):
    xmas = lib / "Libraries" / "Music - Christmas"
    client.patch("/api/config", json={"rename_template": "{album}/{title}",
                                      "layout_libraries": [str(xmas)]})
    tid = _insert(xmas / "loose.mp3", title="T", album="A")
    shared = _insert(lib / "Shared" / "loose.mp3", title="S", album="A")   # unchecked
    tracks = client.get("/api/library/tracks", params={"issue": "not_in_layout"}).json()["tracks"]
    assert [t["id"] for t in tracks] == [tid] and tracks[0]["layout_path"] == str(xmas / "A" / "T.mp3")

    client.patch("/api/config", json={"library_templates": {str(xmas): "{title}"}})
    assert client.get(f"/api/library/track/{tid}").json()["path"] == str(xmas / "loose.mp3")
    tracks = client.get("/api/library/tracks", params={"issue": "not_in_layout"}).json()["tracks"]
    assert tracks[0]["layout_path"] == str(xmas / "T.mp3")

    # an override on an unchecked library isn't compared
    client.patch("/api/config", json={"library_templates": {str(lib / "Shared"): "{title}"}})
    assert client.get("/api/library/issues").json()["not_in_layout"] == 1
    assert shared


def test_the_old_default_layout_follows_the_new_one(client):
    from api.config import _OLD_DEFAULT_TEMPLATE
    assert client.get("/api/config").json()["rename_template"] == "{album_artist_the}/{album_the}/{track_number:02d} {title}"
    client.patch("/api/config", json={"rename_template": _OLD_DEFAULT_TEMPLATE})
    assert client.get("/api/config").json()["rename_template"].startswith("{album_artist_the}/{album_the}/")
    client.patch("/api/config", json={"rename_template": "{album}/{title}"})        # a real choice stays
    assert client.get("/api/config").json()["rename_template"] == "{album}/{title}"


def test_group_layout_beats_library_and_standard(client, lib):
    shared = lib / "Shared"
    client.patch("/api/config", json={"rename_template": "{album}/{title}", "layout_libraries": [str(shared)],
                                      "library_templates": {str(shared): "{artist}/{title}"},
                                      "lyrics_groups": [{"id": "cast", "name": "Cast album", "layout": "Cast/{album}/{title}"}]})
    a = _insert(shared / "loose1.mp3", title="T", artist="X", album="A")
    b = _insert(shared / "loose2.mp3", title="U", artist="X", album="A")
    client.post("/api/lyrics/assign", json={"track_ids": [a], "group_id": "cast"})
    by = {t["id"]: t["layout_path"] for t in client.get("/api/library/tracks", params={"issue": "not_in_layout"}).json()["tracks"]}
    assert by == {a: str(shared / "Cast" / "A" / "T.mp3"), b: str(shared / "X" / "U.mp3")}
    bad = {"id": "", "name": "Live", "layout": "{nope}"}
    r = client.patch("/api/config", json={"lyrics_groups": [bad]})
    assert r.status_code == 400 and "group Live" in r.json()["detail"]


@needs_ffmpeg
def test_cover_art_left_in_an_emptied_folder_follows_or_goes_to_trash(client, lib):
    old = lib / "Shared" / "old"
    src = _mp3(old / "x.mp3")
    (old / "cover.jpg").write_bytes(b"c")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    cid = client.post("/api/staged/apply", json={}).json()["change_id"]
    new = lib / "Shared" / "A" / "Al"
    assert (new / "cover.jpg").read_bytes() == b"c" and not old.exists()   # followed; folder pruned

    res = client.post(f"/api/library/history/{cid}/undo").json()
    assert res["errors"] == [] and (old / "cover.jpg").exists() and src.exists()
    assert not (lib / "Shared" / "A").exists()

    (new).mkdir(parents=True)
    (new / "cover.jpg").write_bytes(b"theirs")                            # the destination has its own
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    client.post("/api/staged/apply", json={})
    assert (new / "cover.jpg").read_bytes() == b"theirs" and not old.exists()
    assert [p.name.endswith("_cover.jpg") for p in (settings.config_dir / "trash").iterdir()] == [True]


@needs_ffmpeg
def test_a_folder_with_more_than_images_keeps_them(client, lib):
    old = lib / "Shared" / "old"
    src = _mp3(old / "x.mp3")
    (old / "cover.jpg").write_bytes(b"c")
    (old / "rip.log").write_text("eac")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    client.post("/api/staged/apply", json={})
    assert (old / "cover.jpg").exists() and (old / "rip.log").exists()


@needs_ffmpeg
def test_cover_art_left_in_an_emptied_folder_follows_or_goes_to_trash(client, lib):
    old = lib / "Shared" / "old"
    src = _mp3(old / "x.mp3")
    (old / "cover.jpg").write_bytes(b"c")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    cid = client.post("/api/staged/apply", json={}).json()["change_id"]
    new = lib / "Shared" / "A" / "Al"
    assert (new / "cover.jpg").read_bytes() == b"c" and not old.exists()   # followed; folder pruned

    res = client.post(f"/api/library/history/{cid}/undo").json()
    assert res["errors"] == [] and (old / "cover.jpg").exists() and src.exists()
    assert not (lib / "Shared" / "A").exists()

    new.mkdir(parents=True)
    (new / "cover.jpg").write_bytes(b"theirs")                            # the destination has its own
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    client.post("/api/staged/apply", json={})
    assert (new / "cover.jpg").read_bytes() == b"theirs" and not old.exists()
    assert [p.name.endswith("_cover.jpg") for p in (settings.config_dir / "trash").iterdir()] == [True]


@needs_ffmpeg
def test_a_folder_with_more_than_images_keeps_them(client, lib):
    old = lib / "Shared" / "old"
    src = _mp3(old / "x.mp3")
    (old / "cover.jpg").write_bytes(b"c")
    (old / "rip.log").write_text("eac")
    tid = _insert(src, title="T", album="Al", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [tid]})
    client.post("/api/staged/apply", json={})
    assert (old / "cover.jpg").exists() and (old / "rip.log").exists()
