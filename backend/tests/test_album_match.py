"""Album-level MusicBrainz match: pairing, the match endpoint, staged apply."""
from core import albummatch
from core.providers import musicbrainz as mbp
from tests.test_staging import _insert, lib  # noqa: F401  (fixture)

REL_ID = "11111111-2222-3333-4444-555555555555"
RELEASE = {
    "mb_album_id": REL_ID, "album": "Abbey Road", "album_artist": "The Beatles",
    "mb_album_artist_id": "aa", "date": "2019-09-27", "year": "2019", "original_year": "1969",
    "country": "GB", "discs": 1,
    "tracks": [
        {"key": "1-1", "disc": 1, "position": 1, "number": "1", "title": "Come Together", "artist": "The Beatles",
         "mb_artist_id": "aa", "mb_track_id": "r1", "duration": 259.9},
        {"key": "1-2", "disc": 1, "position": 2, "number": "2", "title": "Something", "artist": "The Beatles",
         "mb_artist_id": "aa", "mb_track_id": "r2", "duration": 182.0},
        {"key": "1-3", "disc": 1, "position": 3, "number": "3", "title": "Maxwell's Silver Hammer",
         "artist": "The Beatles", "mb_artist_id": "aa", "mb_track_id": "r3", "duration": 207.0},
    ],
}


def test_pairs_on_number_title_and_duration_best_first():
    local = [
        {"id": 1, "title": "Something (2019 Mix)", "track_number": "2", "duration": 182.5},
        {"id": 2, "title": "come together", "track_number": "1", "duration": 260},
        {"id": 3, "title": "Maxwells Silver Hammer", "track_number": "", "duration": 207},   # no number
        {"id": 4, "title": "Her Majesty", "track_number": "17", "duration": 23},           # not on it
    ]
    m = albummatch.match(local, RELEASE["tracks"])
    assert {k: v[0] for k, v in m.items()} == {1: "1-2", 2: "1-1", 3: "1-3", 4: None}
    assert m[2][1] > 0.9 and m[4][1] == 0.0


def test_tags_prefer_the_original_year():
    t = albummatch.tags_for(RELEASE, RELEASE["tracks"][1])
    assert t["year"] == "1969" and t["track_number"] == "2" and t["mb_album_id"] == REL_ID
    assert albummatch.tags_for(RELEASE, RELEASE["tracks"][1], original_year=False)["year"] == "2019"


def test_match_then_stage_chosen_fields(client, lib, monkeypatch):
    monkeypatch.setattr(mbp, "get_release", lambda _id: RELEASE)
    d = lib / "Shared" / "Beatles" / "Abbey Road"
    a = _insert(d / "01.mp3", title="Come Together", track_number="1", album="Abbey Road", duration=259.0)
    b = _insert(d / "02.mp3", title="Somthing", track_number="2", duration=181.0)
    r = client.post("/api/lookup/album/match", json={"track_ids": [a, b], "mb_album_id": REL_ID}).json()
    assert [(i["id"], i["key"]) for i in r["items"]] == [(a, "1-1"), (b, "1-2")]
    assert r["unmatched"] == ["1-3"] and r["release"]["album"] == "Abbey Road"

    res = client.post("/api/lookup/album/apply", json={
        "mb_album_id": REL_ID, "pairs": {str(a): "1-1", str(b): "1-2"},
        "fields": ["title", "album", "year", "mb_track_id"]}).json()
    assert res["changed"] == 2 and res["staged"] is True
    assert client.get(f"/api/library/track/{b}").json()["staged"]["tags"] == {
        "title": "Something", "album": "Abbey Road", "year": "1969", "mb_track_id": "r2"}
    assert client.get(f"/api/library/track/{a}").json()["staged"]["tags"] == {"year": "1969", "mb_track_id": "r1"}
    assert client.get("/api/staged/actions").json()["steps"][0]["summary"] == "MusicBrainz: Abbey Road (2 tracks)"
    assert client.post("/api/lookup/album/match", json={"track_ids": [a], "mb_album_id": "x"}).status_code == 400


def test_search_puts_the_tagged_release_first(client, lib, monkeypatch):
    monkeypatch.setattr(mbp, "get_release", lambda _id: RELEASE)
    monkeypatch.setattr(mbp, "search_releases", lambda album, artist: [
        {"mb_album_id": "x-other", "album": album, "artist": artist, "tracks": 17, "score": 1.0},
        {"mb_album_id": REL_ID, "album": album, "artist": artist, "tracks": 3, "score": 0.9}])
    a = _insert(lib / "Shared" / "x" / "1.mp3", album="Abbey Road", artist="The Beatles", mb_album_id=REL_ID)
    r = client.post("/api/lookup/album/search", json={"track_ids": [a]}).json()
    assert [c["mb_album_id"] for c in r["candidates"]] == [REL_ID, "x-other"] and r["candidates"][0]["tagged"]
    assert (r["album"], r["artist"], r["local_tracks"]) == ("Abbey Road", "The Beatles", 1)


def test_quality_counts_unmatched_tracks_as_zero(client, lib, monkeypatch):
    local = [{"id": 1, "title": "Come Together", "track_number": "1", "duration": 259},
             {"id": 2, "title": "Something", "track_number": "2", "duration": 182}]
    full = albummatch.quality(local, RELEASE["tracks"])
    half = albummatch.quality(local, RELEASE["tracks"][:1])
    assert full["matched"] == 2 and half["matched"] == 1 and full["quality"] > half["quality"] > 0
    monkeypatch.setattr(mbp, "get_release", lambda _id: RELEASE)
    a = _insert(lib / "Shared" / "x" / "1.mp3", title="Come Together", track_number="1", duration=259.0)
    r = client.post("/api/lookup/album/score", json={"track_ids": [a], "mb_album_id": REL_ID}).json()
    assert (r["matched"], r["local"], r["release_tracks"]) == (1, 1, 3) and r["quality"] > 0.9


def test_number_and_length_alone_never_pair_without_a_title_match():
    local = [{"id": 1, "title": "Her Majesty", "track_number": "1", "duration": 259.9},   # #1 + Come Together's length
             {"id": 2, "title": "", "filename": "02 - Somthing.mp3", "track_number": "", "duration": None}]
    m = albummatch.match(local, RELEASE["tracks"])
    assert m[1] == (None, 0.0)          # right number and length, wrong song
    assert m[2][0] == "1-2"             # untitled: compared by file name


def test_search_by_artist_and_by_track(client, lib, monkeypatch):
    calls = []
    monkeypatch.setattr(mbp, "search_releases", lambda album, artist, limit=15: calls.append(("rel", album, artist)) or
                        [{"mb_album_id": "a", "album": "X", "artist": artist, "tracks": 3, "score": 1.0}])
    monkeypatch.setattr(mbp, "releases_with_recording", lambda title, artist: calls.append(("rec", title, artist)) or
                        [{"mb_album_id": "b", "album": "Y", "artist": artist, "tracks": 9, "score": 0.9}])
    a = _insert(lib / "Shared" / "x" / "1.mp3", title="Something", artist="The Beatles", album="Abbey Road")
    r = client.post("/api/lookup/album/search", json={"track_ids": [a], "by": "artist"}).json()
    assert r["by"] == "artist" and calls[-1] == ("rec", "Something", "The Beatles")   # by your titles
    assert r["candidates"][0]["titles_found"] == 1
    r = client.post("/api/lookup/album/search", json={"track_ids": [a], "by": "track", "track": "Something"}).json()
    assert r["by"] == "track" and r["track"] == "Something" and calls[-1] == ("rec", "Something", "The Beatles")
    assert client.post("/api/lookup/album/search", json={"track_ids": [a], "by": "track"}).status_code == 400
