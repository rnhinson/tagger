from core.providers.musicbrainz import recording_to_metadata


def test_full_recording():
    rec = {
        "id": "rec-1",
        "title": "So What",
        "artist-credit": [{"artist": {"id": "art-1", "name": "Miles Davis"}}],
        "release-list": [{
            "id": "rel-1",
            "title": "Kind of Blue",
            "date": "1959-08-17",
            "artist-credit": [{"artist": {"id": "aa-1", "name": "Miles Davis"}}],
            "medium-list": [{
                "position": 1,
                "track-list": [{"number": "A1", "position": 1}],
            }],
        }],
    }
    m = recording_to_metadata(rec, source="musicbrainz", score=0.9)
    assert m.title == "So What"
    assert m.artist == "Miles Davis"
    assert m.album == "Kind of Blue"
    assert m.year == "1959"
    assert m.track_number == "A1"
    assert m.disc_number == "1"
    assert m.mb_track_id == "rec-1"
    assert m.mb_album_id == "rel-1"
    assert m.source == "musicbrainz"
    assert m.score == 0.9


def test_empty_recording_is_safe():
    m = recording_to_metadata({}, source="acoustid", score=1.0)
    assert m.title is None
    assert m.artist is None
    assert m.album is None
    assert m.source == "acoustid"


def test_album_artist_falls_back_to_track_artist():
    rec = {
        "id": "r",
        "title": "T",
        "artist-credit": [{"artist": {"id": "a", "name": "Solo Artist"}}],
        "release-list": [{"id": "rl", "title": "Album"}],
    }
    m = recording_to_metadata(rec, source="musicbrainz", score=0.5)
    assert m.album_artist == "Solo Artist"
    assert m.disc_number is None
