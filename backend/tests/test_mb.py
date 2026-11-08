import musicbrainzngs
import pytest

from core.providers import musicbrainz as mb


def test_with_retry_succeeds_after_transient(monkeypatch):
    monkeypatch.setattr(mb.time, "sleep", lambda *_: None)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise musicbrainzngs.WebServiceError("boom")
        return "ok"

    assert mb._with_retry(flaky) == "ok"
    assert calls["n"] == 3


def test_with_retry_gives_up(monkeypatch):
    monkeypatch.setattr(mb.time, "sleep", lambda *_: None)

    def always():
        raise musicbrainzngs.WebServiceError("down")

    with pytest.raises(musicbrainzngs.WebServiceError):
        mb._with_retry(always, attempts=2)


def test_releases_parsing(monkeypatch):
    resp = {"recording": {"release-list": [
        {"id": "r1", "title": "OK Computer", "date": "1997-05-21", "country": "GB",
         "medium-list": [{"format": "CD", "track-count": 12}]},
        {"id": "r2", "title": "OK Computer (Deluxe)", "date": "2007", "country": "US",
         "medium-list": [{}]},
    ]}}
    monkeypatch.setattr(mb.musicbrainzngs, "get_recording_by_id", lambda *a, **k: resp)

    out = mb.MusicBrainzProvider()._releases_sync("rec-id")
    assert out[0] == {
        "mb_album_id": "r1", "album": "OK Computer", "year": "1997",
        "country": "GB", "format": "CD", "track_count": 12,
    }
    assert out[1]["mb_album_id"] == "r2"
    assert out[1]["year"] == "2007"
    assert out[1]["format"] is None


def test_releases_empty_on_error(monkeypatch):
    def boom(*a, **k):
        raise musicbrainzngs.WebServiceError("nope")
    monkeypatch.setattr(mb.time, "sleep", lambda *_: None)
    monkeypatch.setattr(mb.musicbrainzngs, "get_recording_by_id", boom)
    assert mb.MusicBrainzProvider()._releases_sync("rec-id") == []


def _work(*credits):
    return {"type": "performance", "work": {"artist-relation-list": [
        {"type": t, "artist": {"name": n}} for t, n in credits]}}


def test_composers_prefer_composer_then_writer():
    assert mb._composers({"work-relation-list": [_work(("composer", "A"), ("lyricist", "B"), ("composer", "C"))]}) == "A; C"
    assert mb._composers({"work-relation-list": [_work(("writer", "W"), ("lyricist", "L"))]}) == "W"
    assert mb._composers({"work-relation-list": [_work(("composer", "[traditional]"), ("composer", "[unknown]"))]}) == "Traditional"
    assert mb._composers({}) is None


def test_genre_names_keep_real_genres_most_voted():
    tags = [{"name": "celtic punk", "count": "3"}, {"name": "seen live", "count": "9"},
            {"name": "folk rock", "count": "2"}, {"name": "rock", "count": "1"}, {"name": "rock and roll", "count": "2"}]
    assert mb._genre_names(tags) == ["Celtic Punk", "Rock and Roll", "Folk Rock"]
    assert mb._genre_names([{"name": "favourites", "count": "5"}]) == []


def test_release_genre_falls_back_to_artist(monkeypatch):
    monkeypatch.setattr(mb.musicbrainzngs, "get_artist_by_id",
                        lambda *a, **k: {"artist": {"tag-list": [{"name": "filk", "count": "2"}]}})
    rel = {"tag_list": [], "mb_album_artist_id": "x"}
    assert mb.release_genre(rel) == "Filk"
    assert rel["genre"] == "Filk"
