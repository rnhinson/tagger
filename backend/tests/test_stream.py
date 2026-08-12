from core.database import db


def _insert_track(path):
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO tracks (path, filename, directory, format, scanned_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (str(path), path.name, str(path.parent), "mp3", 1.0),
        )
        return cur.lastrowid


def test_stream_serves_audio(client, make_audio):
    path = make_audio(".mp3")
    tid = _insert_track(path)
    r = client.get(f"/api/stream/{tid}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    # Must not force a download — an <audio> element needs to play it inline.
    assert "attachment" not in r.headers.get("content-disposition", "")
    assert len(r.content) == path.stat().st_size


def test_stream_supports_range(client, make_audio):
    path = make_audio(".mp3")
    tid = _insert_track(path)
    r = client.get(f"/api/stream/{tid}", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert len(r.content) == 100
    assert "content-range" in {k.lower() for k in r.headers}


def test_stream_missing_track(client):
    assert client.get("/api/stream/999").status_code == 404
