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


def test_undo_tag_edit_restores_db(temp_db):
    _insert(BASE_ROW)
    with db() as conn:
        snap = history.snapshot(conn.execute("SELECT * FROM tracks WHERE id=1").fetchone())
        conn.execute("UPDATE tracks SET title=? WHERE id=1", ("NEW",))
        history.log_change(conn, "tag_edit", "edit", [snap])

    with db() as conn:
        assert conn.execute("SELECT title FROM tracks WHERE id=1").fetchone()[0] == "NEW"
        change = history.list_changes(conn)[0]
        assert change["undone"] == 0
        result = history.undo_change(conn, change["id"])
        assert result["restored"] == 1
        assert conn.execute("SELECT title FROM tracks WHERE id=1").fetchone()[0] == "old"


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
