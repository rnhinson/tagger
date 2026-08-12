from core.config import settings
from core.database import db


def _insert(path):
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO tracks (path, filename, directory, format, scanned_at) VALUES (?,?,?,?,?)",
            (str(path), "x.mp3", str(path), "mp3", 1.0),
        )
        return cur.lastrowid


def test_fs_tree_blocks_symlink_escape(client, tmp_path, monkeypatch):
    music = tmp_path / "music"
    music.mkdir()
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "passwd").write_text("secret")
    (music / "link").symlink_to(outside)
    (music / "real").mkdir()
    monkeypatch.setattr(settings, "music_dir", music)

    # A symlink pointing outside the library must be denied…
    assert client.get("/api/fs/tree", params={"path": str(music / "link")}).status_code == 403
    # …but a genuine subdirectory is allowed.
    assert client.get("/api/fs/tree", params={"path": str(music / "real")}).status_code == 200


def test_fs_tree_blocks_parent_traversal(client, tmp_path, monkeypatch):
    music = tmp_path / "music"
    music.mkdir()
    monkeypatch.setattr(settings, "music_dir", music)
    assert client.get("/api/fs/tree", params={"path": str(music / ".." / "..")}).status_code == 403


def test_cover_upload_rejects_oversize(client, tmp_path, monkeypatch):
    import api.covers as covers
    monkeypatch.setattr(covers, "_MAX_COVER_BYTES", 50)
    tid = _insert(tmp_path / "song.mp3")
    files = {"file": ("big.png", b"x" * 200, "image/png")}
    assert client.post(f"/api/covers/{tid}", files=files).status_code == 413


def test_apply_cover_rejects_non_uuid(client):
    r = client.post("/api/lookup/cover/1", params={"mb_album_id": "not-a-uuid/../etc"})
    assert r.status_code == 400


def test_search_survives_quote(client):
    # A stray double quote must not produce a malformed FTS query (500).
    assert client.get("/api/library/search", params={"q": 'a"b"'}).status_code == 200
