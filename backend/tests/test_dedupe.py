from core.database import db


def _insert(title, artist, bitrate, size):
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO tracks (path, filename, directory, format, scanned_at, "
            "title, artist, bitrate, size) VALUES (?,?,?,?,?,?,?,?,?)",
            (f"/m/{title}-{bitrate}.flac", f"{title}.flac", "/m", "flac", 1.0,
             title, artist, bitrate, size),
        )
        return cur.lastrowid


def test_keep_best_removes_lower_quality(client):
    lo = _insert("Song", "Artist", 128, 100)
    hi = _insert("Song", "artist", 320, 200)   # same title/artist (case-insensitive)
    uniq = _insert("Other", "Artist", 256, 150)

    res = client.post("/api/library/dedupe/keep-best").json()
    assert res["removed"] == 1

    remaining = {t["id"] for t in client.get("/api/library/tracks").json()["tracks"]}
    assert hi in remaining      # highest bitrate kept
    assert uniq in remaining    # non-duplicate untouched
    assert lo not in remaining  # lower bitrate removed


def test_keep_best_is_undoable(client):
    lo = _insert("Song", "Artist", 128, 100)
    _insert("Song", "Artist", 320, 200)
    client.post("/api/library/dedupe/keep-best")

    change = client.get("/api/library/history").json()[0]
    assert change["kind"] == "remove"
    client.post(f"/api/library/history/{change['id']}/undo")

    ids = {t["id"] for t in client.get("/api/library/tracks").json()["tracks"]}
    assert lo in ids  # restored


def test_keep_best_noop_without_duplicates(client):
    _insert("A", "X", 128, 100)
    _insert("B", "X", 128, 100)
    assert client.post("/api/library/dedupe/keep-best").json()["removed"] == 0
