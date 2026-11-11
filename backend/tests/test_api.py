"""API-level tests exercising the HTTP layer via TestClient."""


def test_settings_roundtrip(client):
    s = client.get("/api/config").json()
    assert "discogs_token" in s
    assert "default_music_dir" in s

    client.patch("/api/config", json={"discogs_token": "abc123"})
    s = client.get("/api/config").json()
    assert s["discogs_token"] == "" and s["secrets_set"]["discogs_token"] is True   # set, never echoed


def test_rename_preview_ok_and_error(client):
    ok = client.post("/api/config/rename-preview",
                     json={"template": "{artist}/{album}/{track_number:02d} {title}"}).json()
    assert ok["ok"] is True
    assert ok["preview"].endswith(".flac")

    bad = client.post("/api/config/rename-preview", json={"template": "{bogus}"}).json()
    assert bad["ok"] is False
    assert "error" in bad


def test_rename_preview_with_track_tags(client):
    r = client.post("/api/config/rename-preview", json={
        "template": "{artist}/{title}", "tags": {"artist": "A", "title": "B"}, "ext": ".mp3",
    }).json()
    assert r["ok"] is True
    assert r["preview"] == "A/B.mp3"


def test_replaygain_status(client):
    body = client.get("/api/tags/replaygain/status").json()
    assert "available" in body and "tool" in body


def test_history_empty_and_bad_undo(client):
    assert client.get("/api/library/history").json() == []
    assert client.post("/api/library/history/999/undo").status_code == 400


def test_export_m3u_empty(client):
    r = client.get("/api/library/export.m3u")
    assert r.status_code == 200
    assert r.text.startswith("#EXTM3U")
    assert "attachment" in r.headers.get("content-disposition", "")


def test_infer_missing_track(client):
    assert client.post("/api/lookup/infer/999").status_code == 404


def test_lookup_status(client):
    body = client.get("/api/lookup/status").json()
    assert body["method"] in ("text", "acoustid")


def test_tracks_listing_empty(client):
    body = client.get("/api/library/tracks").json()
    assert body == {"total": 0, "tracks": []}


def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert "version" in body


def test_openapi_available(client):
    assert client.get("/openapi.json").status_code == 200


def _track(title, artist, filename):
    from core.database import db
    with db() as conn:
        return conn.execute(
            "INSERT INTO tracks (path, filename, directory, format, scanned_at, title, artist) VALUES (?,?,?,?,?,?,?)",
            (f"/m/{filename}", filename, "/m", "flac", 1.0, title, artist)).lastrowid


def test_search_modes(client):
    love = _track("Love Me Do", "The Beatles", "01 Love Me Do.flac")
    all_ = _track("All You Need Is Love", "The Beatles", "02 All You Need Is Love.flac")
    rip = _track("", "", "Track_01.flac")

    def ids(**p):
        r = client.get("/api/library/tracks", params=p)
        assert r.status_code == 200, r.text
        return sorted(t["id"] for t in r.json()["tracks"])

    assert ids(q="love") == sorted([love, all_])                       # plain: word prefix
    assert ids(q="love*", q_mode="glob") == [love]                     # glob: the whole field
    assert ids(q="*LOVE", q_mode="glob") == [all_]
    assert ids(q="track_??.flac", q_mode="glob") == []                 # file names: only when chosen
    client.patch("/api/config", json={"search_fields": ["title", "filename"]})
    assert ids(q="track_??.flac", q_mode="glob") == [rip]
    assert ids(q=r"^\d\d ", q_mode="regex") == sorted([love, all_])     # regex: anywhere
    assert ids(q="need|do$", q_mode="regex") == sorted([love, all_])
    assert client.get("/api/library/tracks", params={"q": "(", "q_mode": "regex"}).status_code == 400


def test_search_fields_setting(client):
    a = _track("Yesterday", "The Beatles", "a.flac")
    from core.database import db
    with db() as conn:
        conn.execute("UPDATE tracks SET year='1965', album='Help!' WHERE id=?", (a,))
    ids = lambda q: [t["id"] for t in client.get("/api/library/tracks", params={"q": q}).json()["tracks"]]
    assert ids("1965") == [] and ids("help") == [a]
    client.patch("/api/config", json={"search_fields": ["title", "artist"]})       # index, fewer columns
    assert ids("help") == [] and ids("beat yest") == [a]
    client.patch("/api/config", json={"search_fields": ["title", "year"]})          # off the index
    assert ids("1965") == [a] and ids("yest 196") == [a] and ids("beatles") == [] and ids("esterday") == []
