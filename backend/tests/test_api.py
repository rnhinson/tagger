"""API-level tests exercising the HTTP layer via TestClient."""


def test_settings_roundtrip(client):
    s = client.get("/api/config").json()
    assert "discogs_token" in s
    assert "default_music_dir" in s

    client.patch("/api/config", json={"discogs_token": "abc123"})
    assert client.get("/api/config").json()["discogs_token"] == "abc123"


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
