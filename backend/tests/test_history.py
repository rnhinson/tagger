import pytest

from core.database import db
from core import history

BASE_ROW = dict(
    id=1, path="/music/a/b/1.flac", filename="1.flac", directory="/music/a/b",
    format="flac", size=10, mtime=1.0, duration=100.0,
    title="old", artist="OldArt", album="OldAlb", album_artist="OldAA",
    year="1999", genre="Rock", track_number="1", disc_number="1", comment="c",
    mb_track_id=None, mb_artist_id=None, mb_album_id=None, mb_album_artist_id=None,
    scanned_at=1.0, tagged_at=None,
)


def _insert(row):
    cols = ", ".join(row)
    ph = ", ".join("?" * len(row))
    with db() as conn:
        conn.execute(f"INSERT INTO tracks ({cols}) VALUES ({ph})", list(row.values()))


def test_undo_tag_edit_with_missing_file_restores_nothing(temp_db):
    """The 11-01 recovery: undo fixed the rows but not the files. A track
    whose file is gone stays as it is, the change stays not-undone, and the
    file is listed."""
    _insert(BASE_ROW)   # /music/a/b/1.flac does not exist
    with db() as conn:
        snap = history.snapshot(conn.execute("SELECT * FROM tracks WHERE id=1").fetchone())
        conn.execute("UPDATE tracks SET title=? WHERE id=1", ("NEW",))
        history.log_change(conn, "tag_edit", "edit", [snap])

    with db() as conn:
        change = history.list_changes(conn)[0]
        result = history.undo_change(conn, change["id"])
        assert result["restored"] == 0
        assert result["errors"][0]["error"] == "file missing: /music/a/b/1.flac"
        assert conn.execute("SELECT title FROM tracks WHERE id=1").fetchone()[0] == "NEW"
        assert history.list_changes(conn)[0]["undone"] == 0


def test_undo_delete_with_trash_emptied_restores_nothing(temp_db):
    _insert(BASE_ROW)
    with db() as conn:
        snap = {**history.snapshot(conn.execute("SELECT * FROM tracks WHERE id=1").fetchone()),
                "_trash": "/nowhere/1.flac"}
        conn.execute("DELETE FROM tracks WHERE id=1")
        history.log_change(conn, "delete_files", "deleted", [snap])
    with db() as conn:
        result = history.undo_change(conn, history.list_changes(conn)[0]["id"])
        assert result["restored"] == 0 and "no copy left" in result["errors"][0]["error"]
        assert conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0] == 0
        assert history.list_changes(conn)[0]["undone"] == 0


def test_undo_remove_reinserts(temp_db):
    _insert(BASE_ROW)
    with db() as conn:
        snap = history.snapshot(conn.execute("SELECT * FROM tracks WHERE id=1").fetchone())
        conn.execute("DELETE FROM tracks WHERE id=1")
        history.log_change(conn, "remove", "removed", [snap])

    with db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0] == 0
        cid = history.list_changes(conn)[0]["id"]
        history.undo_change(conn, cid)
        row = conn.execute("SELECT title, album FROM tracks WHERE id=1").fetchone()
        assert row["title"] == "old" and row["album"] == "OldAlb"


def test_double_undo_rejected(temp_db):
    _insert(BASE_ROW)
    with db() as conn:
        snap = history.snapshot(conn.execute("SELECT * FROM tracks WHERE id=1").fetchone())
        conn.execute("DELETE FROM tracks WHERE id=1")
        history.log_change(conn, "remove", "removed", [snap])
    with db() as conn:
        cid = history.list_changes(conn)[0]["id"]
        history.undo_change(conn, cid)
        with pytest.raises(ValueError):
            history.undo_change(conn, cid)


def test_log_change_noop_on_empty(temp_db):
    with db() as conn:
        history.log_change(conn, "tag_edit", "nothing", [])
        assert history.list_changes(conn) == []
