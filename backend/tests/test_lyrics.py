"""Lyrics from LRCLIB: per-track status, prefer synced, skip existing, stage as one step."""
from core import lyrics as lrclib
from tests.test_staging import _insert, lib  # noqa: F401  (fixture)

SYNCED = "[00:12.00] Here comes old flat top"


def test_fetch_statuses_and_stage(client, lib, monkeypatch):
    def fake(title, artist, album=None, duration=None):
        return {"Come Together": {"synced": SYNCED, "plain": "Here comes old flat top", "instrumental": False},
                "Sun King": {"synced": None, "plain": None, "instrumental": True}}.get(title)
    monkeypatch.setattr(lrclib, "fetch", fake)
    d = lib / "Shared" / "Beatles" / "Abbey Road"
    a = _insert(d / "01.mp3", title="Come Together", artist="The Beatles", track_number="1")
    b = _insert(d / "02.mp3", title="Sun King", artist="The Beatles", track_number="2")
    c = _insert(d / "03.mp3", title="Unknown", artist="The Beatles", track_number="3")
    e = _insert(d / "04.mp3", title="Something", artist="The Beatles", track_number="4", lyrics="already")
    f = _insert(d / "05.mp3", title="No artist", track_number="5")
    items = client.post("/api/lyrics/fetch", json={"track_ids": [a, b, c, e, f]}).json()["items"]
    assert [(i["id"], i["status"]) for i in items] == [
        (a, "synced"), (b, "instrumental"), (c, "missing"), (e, "has_plain"), (f, "untagged")]   # e: plain, no synced found
    assert items[0]["lyrics"] == SYNCED
    plain = client.post("/api/lyrics/fetch", json={"track_ids": [a], "prefer": "plain"}).json()["items"][0]
    assert (plain["status"], plain["lyrics"]) == ("plain", "Here comes old flat top")

    res = client.post("/api/lyrics/stage", json={"items": {str(a): SYNCED}}).json()
    assert res["changed"] == 1 and res["staged"] is True
    assert client.get(f"/api/library/track/{a}").json()["staged"]["tags"]["lyrics"] == SYNCED
    assert client.get("/api/staged/actions").json()["steps"][0]["summary"] == "Lyrics on 1 track"
    assert client.post("/api/lyrics/stage", json={"items": {}}).status_code == 400


# ── lyrics groups ────────────────────────────────────────────────────────────

from core import lyricsgroups  # noqa: E402


def test_base_variables_drop_what_lrclib_names_lack():
    v = lyricsgroups.variables({"title": 'Let It Go (From "Frozen")', "album": "Hamilton (Original Broadway Cast Recording)",
                                "artist": "Idina Menzel; Cast", "album_artist": "Original Broadway Cast of Hamilton"})
    assert v["title_base"] == "Let It Go"
    assert v["album_base"] == "Hamilton"
    assert v["artist_first"] == "Idina Menzel"
    assert lyricsgroups._base("My Shot - From the Motion Picture") == "My Shot"
    assert lyricsgroups._base("(Intro)") == "(Intro)"          # nothing left: keep it


def test_cast_group_falls_back_to_title_and_album(monkeypatch):
    calls = []
    monkeypatch.setattr(lrclib, "fetch", lambda *a: calls.append(("artist",) + a[:3]) or None)
    monkeypatch.setattr(lrclib, "fetch_by_album",
                        lambda *a: calls.append(("album",) + a[:2]) or {"synced": None, "plain": "words", "instrumental": False})
    cast = next(g for g in lyricsgroups.DEFAULT_GROUPS if g["id"] == "cast")
    res = lyricsgroups.look_up({"title": "My Shot", "artist": "Lin-Manuel Miranda", "album_artist": "Original Cast",
                                "album": "Hamilton (Original Broadway Cast Recording)"}, cast)
    assert res["status"] == "plain" and res["lyrics"] == "words"
    assert res["query"] == {"title": "My Shot", "artist": "", "album": "Hamilton"}
    assert calls == [("artist", "My Shot", "Lin-Manuel Miranda", "Hamilton (Original Broadway Cast Recording)"),
                     ("artist", "My Shot", "Original Cast", None), ("album", "My Shot", "Hamilton")]


def test_missing_lyrics_skips_no_lyrics_group_and_library_default(client, lib):
    d = lib / "Shared" / "A"
    a = _insert(d / "1.mp3", title="One", artist="X")
    b = _insert(d / "2.mp3", title="Two", artist="X")
    _insert(d / "3.mp3", title="Three", artist="X", lyrics="la la")
    xmas = lib / "Libraries" / "Music - Christmas"
    c = _insert(xmas / "4.mp3", title="Four", artist="Y")
    assert client.get("/api/library/issues").json()["missing_lyrics"] == 3
    assert client.post("/api/lyrics/assign", json={"track_ids": [b], "group_id": "none"}).json()["assigned"] == 1
    client.patch("/api/config", json={"library_lyrics_groups": {str(xmas): "none"}})
    tracks = client.get("/api/library/tracks", params={"issue": "missing_lyrics"}).json()["tracks"]
    assert [t["id"] for t in tracks] == [a] and tracks[0]["lyrics_group"] == "Standard"
    assert {l["name"]: l["lyrics_group"] for l in client.get("/api/config/libraries").json()}["Music - Christmas"] == "none"
    client.post("/api/lyrics/assign", json={"track_ids": [b]})              # back to the default
    assert client.get("/api/library/issues").json()["missing_lyrics"] == 2
    assert client.post("/api/lyrics/assign", json={"track_ids": [c], "group_id": "nope"}).status_code == 400


def test_background_lookup_stages_records_and_skips_next_time(client, lib, monkeypatch):
    answers = {"Found": {"synced": SYNCED, "plain": "p", "instrumental": False},
               "Instr": {"synced": None, "plain": None, "instrumental": True}}
    monkeypatch.setattr(lrclib, "fetch", lambda title, *a: answers.get(title))
    d = lib / "Shared" / "B"
    f = _insert(d / "1.mp3", title="Found", artist="X")
    i = _insert(d / "2.mp3", title="Instr", artist="X")
    m = _insert(d / "3.mp3", title="Nothing", artist="X")
    r = client.post("/api/lyrics/lookup", json={}).json()
    assert r["tracks"] == 3
    job = client.get(f"/api/jobs/{r['job_id']}").json()
    assert (job["kind"], job["status"], job["scanned"], job["changed"]) == ("lyrics", "done", 3, 1)
    assert client.get(f"/api/library/track/{f}").json()["staged"]["tags"]["lyrics"] == SYNCED
    by = {t["id"]: t for t in client.get("/api/library/tracks").json()["tracks"]}
    assert by[m]["lyrics_lookup"]["status"] == "missing"
    assert by[i]["lyrics_group"] == "No lyrics"                          # instrumental -> No lyrics
    assert client.post("/api/lyrics/lookup", json={}).json() == {"job_id": None, "tracks": 0}
    assert client.post("/api/lyrics/lookup", json={"retry": True}).json()["tracks"] == 1   # m again


def test_lyrics_groups_are_validated_and_keep_the_built_ins(client):
    bad = {"id": "", "name": "Mine", "queries": [{"title": "{nope}"}]}
    assert client.patch("/api/config", json={"lyrics_groups": [bad]}).status_code == 400
    mine = {"id": "", "name": "Live albums", "queries": [{"title": "{title_base}", "artist": "{artist}"}]}
    assert client.patch("/api/config", json={"lyrics_groups": [mine]}).status_code == 200
    ids = [g["id"] for g in client.get("/api/lyrics/groups").json()]
    assert ids == ["live-albums", "standard", "none"]


def test_search_returns_every_hit(client, monkeypatch):
    seen = {}

    def fake_get(path, params):
        seen.update(params)
        return [{"id": 7, "trackName": "My Shot", "artistName": "Hamilton Cast", "albumName": "Hamilton",
                 "duration": 333, "syncedLyrics": SYNCED, "plainLyrics": "p", "instrumental": False}]
    monkeypatch.setattr(lrclib, "_get", fake_get)
    hits = client.post("/api/lyrics/search", json={"title": "My Shot", "album": "Hamilton"}).json()["hits"]
    assert hits == [{"id": 7, "title": "My Shot", "artist": "Hamilton Cast", "album": "Hamilton", "duration": 333,
                     "synced": SYNCED, "plain": "p", "instrumental": False}]
    assert seen == {"q": "", "track_name": "My Shot", "artist_name": "", "album_name": "Hamilton"}
    assert client.post("/api/lyrics/search", json={}).status_code == 400


class _Resp:
    def __init__(self, body): self.body = body
    def read(self): return self.body
    def __enter__(self): return self
    def __exit__(self, *a): return False


def test_rate_limit_waits_retry_after_and_sends_the_key(client, monkeypatch):
    import urllib.error
    from email.message import Message
    calls, paused = [], []
    def fake_open(req, timeout):
        calls.append((req.get_header("Lrclib-app-id"), req.get_header("Lrclib-api-key")))
        if len(calls) == 1:
            h = Message(); h["Retry-After"] = "2"
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", h, None)
        return _Resp(b"[]")
    monkeypatch.setattr(lrclib.urllib.request, "urlopen", fake_open)
    monkeypatch.setattr(lrclib, "_wait_turn", lambda gap: None)
    monkeypatch.setattr(lrclib, "_pause", paused.append)
    client.patch("/api/config", json={"lrclib_api_key": "k1", "lrclib_app_id": "app1"})
    assert lrclib._get("search", {"q": "x"}) == []
    assert calls == [("app1", "k1"), ("app1", "k1")] and paused == [2.0]

    def always_429(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", Message(), None)
    monkeypatch.setattr(lrclib.urllib.request, "urlopen", always_429)
    import pytest
    with pytest.raises(lrclib.RateLimited):
        lrclib._get("search", {"q": "x"})


def test_background_lookup_stops_on_the_rate_limit(client, lib, monkeypatch):
    def limited(*a):
        raise lrclib.RateLimited("LRCLIB: too many requests (429)")
    monkeypatch.setattr(lrclib, "fetch", limited)
    _insert(lib / "Shared" / "C" / "1.mp3", title="One", artist="X")
    r = client.post("/api/lyrics/lookup", json={}).json()
    job = client.get(f"/api/jobs/{r['job_id']}").json()
    assert job["status"] == "error" and "rate limit" in job["error"]
    assert client.get("/api/library/tracks").json()["tracks"][0]["lyrics_lookup"] is None   # not recorded
    assert client.post("/api/lyrics/lookup", json={}).json()["tracks"] == 1


def test_assigned_is_the_shared_group_or_null(client, lib):
    a, b = (_insert(lib / "Shared" / f"{n}.mp3") for n in "ab")
    assert client.post("/api/lyrics/assigned", json={"track_ids": [a, b]}).json() == {"group_id": ""}
    client.post("/api/lyrics/assign", json={"track_ids": [a], "group_id": "cast"})
    assert client.post("/api/lyrics/assigned", json={"track_ids": [a]}).json() == {"group_id": "cast"}
    assert client.post("/api/lyrics/assigned", json={"track_ids": [a, b]}).json() == {"group_id": None}


def test_has_lyrics_sorts_none_plain_synced(client, lib):
    ids = [_insert(lib / "Shared" / "s.mp3", lyrics="[00:01.00] la"),
           _insert(lib / "Shared" / "n.mp3"),
           _insert(lib / "Shared" / "p.mp3", lyrics="la la")]
    got = client.get("/api/library/track-ids", params={"sort": "has_lyrics"}).json()["ids"]
    assert got == [ids[1], ids[2], ids[0]]


def test_fetch_with_one_query_for_every_track(client, lib, monkeypatch):
    calls = []
    monkeypatch.setattr(lrclib, "fetch", lambda *a: calls.append(a[:3]) or {"synced": None, "plain": "w", "instrumental": False})
    monkeypatch.setattr(lrclib, "fetch_by_album", lambda *a: calls.append(("by album",) + a[:2]) or None)
    d = lib / "Shared" / "Hamilton"
    a = _insert(d / "01.mp3", title="My Shot", artist="Lin-Manuel Miranda", album="Hamilton")
    b = _insert(d / "02.mp3", title="Wait For It", artist="Leslie Odom Jr.", album="Hamilton")
    client.post("/api/lyrics/assign", json={"track_ids": [b], "group_id": "none"})
    r = client.post("/api/lyrics/fetch", json={"track_ids": [a, b]}).json()
    assert r["common"] == {"title": None, "artist": None, "album": "Hamilton"}
    assert [i["status"] for i in r["items"]] == ["plain", "skipped"]

    calls.clear()
    q = {"title": "{title}", "artist": "Original Broadway Cast", "album": "Hamilton (OBC)"}
    r = client.post("/api/lyrics/fetch", json={"track_ids": [a, b], "query": q}).json()
    assert calls == [("My Shot", "Original Broadway Cast", "Hamilton (OBC)"),
                     ("Wait For It", "Original Broadway Cast", "Hamilton (OBC)")]   # No lyrics too: asked for
    assert [i["group"] for i in r["items"]] == ["this search"] * 2

    calls.clear()
    client.post("/api/lyrics/fetch", json={"track_ids": [a], "query": {"title": "{title_base}", "album": "{album}"}})
    assert calls == [("by album", "My Shot", "Hamilton")]                  # blank artist: by title + album
    bad = client.post("/api/lyrics/fetch", json={"track_ids": [a], "query": {"title": "{titel}"}})
    assert bad.status_code == 400 and "{titel}" in bad.json()["detail"]
    assert client.post("/api/lyrics/fetch", json={"track_ids": [a], "query": {"artist": "x"}}).status_code == 400


def test_plain_lyrics_are_looked_up_again_for_synced(client, lib, monkeypatch):
    hits = {"Synced There": {"synced": SYNCED, "plain": "p", "instrumental": False},
            "Plain There": {"synced": None, "plain": "p2", "instrumental": False}}
    monkeypatch.setattr(lrclib, "fetch", lambda title, *a: hits.get(title))
    d = lib / "Shared" / "X"
    up = _insert(d / "1.mp3", title="Synced There", artist="A", lyrics="old plain words")
    keep = _insert(d / "2.mp3", title="Plain There", artist="A", lyrics="old plain words")
    done = _insert(d / "3.mp3", title="Synced There", artist="A", lyrics="[00:01.00] already synced")
    items = client.post("/api/lyrics/fetch", json={"track_ids": [up, keep, done]}).json()["items"]
    assert [(i["status"], i["lyrics"]) for i in items] == [("synced", SYNCED), ("has_plain", None), ("has", None)]
    plain = client.post("/api/lyrics/fetch", json={"track_ids": [up], "prefer": "plain"}).json()["items"]
    assert plain[0]["status"] == "has"                       # plain wanted: plain is enough

    assert client.post("/api/lyrics/lookup", json={"track_ids": [done]}).json()["tracks"] == 0   # synced: done


def test_background_lookup_upgrades_plain_to_synced_only(client, lib, monkeypatch):
    hits = {"Synced There": {"synced": SYNCED, "plain": "p", "instrumental": False},
            "Plain There": {"synced": None, "plain": "p2", "instrumental": False}}
    monkeypatch.setattr(lrclib, "fetch", lambda title, *a: hits.get(title))
    d = lib / "Shared" / "X"
    up = _insert(d / "1.mp3", title="Synced There", artist="A", lyrics="old plain words")
    keep = _insert(d / "2.mp3", title="Plain There", artist="A", lyrics="old plain words")
    r = client.post("/api/lyrics/lookup", json={"track_ids": [up, keep]}).json()
    assert r["tracks"] == 2
    assert client.get(f"/api/jobs/{r['job_id']}").json()["changed"] == 1
    assert client.get(f"/api/library/track/{up}").json()["staged"]["tags"]["lyrics"] == SYNCED
    assert client.get(f"/api/library/track/{keep}").json()["staged"] is None       # plain for plain: kept
    assert client.post("/api/lyrics/lookup", json={"track_ids": [keep]}).json()["tracks"] == 0   # recorded
