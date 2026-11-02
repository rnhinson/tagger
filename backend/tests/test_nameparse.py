"""Tags from file names: %field% patterns over the end of the path."""
import pytest

from core.nameparse import PatternError, compile_pattern, parse_path
from tests.test_staging import _insert, lib  # noqa: F401  (fixture)


def p(pattern, path):
    return parse_path(path, compile_pattern(pattern))


def test_filename_only():
    assert p("%track% - %title%", "/m/A/B/03 - So What.mp3") == {"track_number": "3", "title": "So What"}
    assert p("%artist% - %title%", "/m/x/Miles Davis - So What - Live.flac") == \
        {"artist": "Miles Davis", "title": "So What - Live"}          # first ' - ' splits


def test_folders_count_from_the_end():
    pat = "%artist%/%album% (%year%)/%disc%-%track% %title%"
    assert p(pat, "/music/Shared/Miles Davis/Kind of Blue (1959)/1-02 Freddie Freeloader.mp3") == {
        "artist": "Miles Davis", "album": "Kind of Blue", "year": "1959",
        "disc_number": "1", "track_number": "2", "title": "Freddie Freeloader"}


def test_no_match_and_dummy():
    assert p("%track% - %title%", "/m/So What.mp3") is None           # no number
    assert p("%dummy% - %title%", "/m/Side A - So What.mp3") == {"title": "So What"}


def test_bad_patterns():
    for bad, msg in (("", "empty"), ("%nope% - %title%", "unknown field"), ("%dummy%.x", "sets no fields")):
        with pytest.raises(PatternError, match=msg):
            compile_pattern(bad)


def test_preview_then_stage_skipping_opt_outs(client, lib):
    d = lib / "Shared" / "Miles Davis" / "Kind of Blue"
    a = _insert(d / "01 - So What.mp3", title="Track 1")
    b = _insert(d / "02 - Freddie Freeloader.mp3", title="Freddie Freeloader", track_number="2")
    c = _insert(d / "bonus.mp3")
    body = {"track_ids": [a, b, c], "pattern": "%artist%/%album%/%track% - %title%"}
    prev = client.post("/api/tags/parse-preview", json=body).json()
    assert (prev["total"], prev["matched"], prev["changing"]) == (3, 2, 2)
    first = prev["items"][0]
    assert first["changes"] == {"artist": "Miles Davis", "album": "Kind of Blue", "track_number": "1", "title": "So What"}
    assert prev["items"][1]["changes"] == {"artist": "Miles Davis", "album": "Kind of Blue"}   # unchanged fields left out

    res = client.post("/api/tags/parse", json={**body, "exclude": [b]}).json()
    assert res["changed"] == 1 and res["staged"] is True
    assert client.get(f"/api/library/track/{a}").json()["staged"]["tags"]["title"] == "So What"
    assert client.get(f"/api/library/track/{b}").json()["staged"] is None
    assert client.get("/api/staged/actions").json()["steps"][0]["summary"] == \
        "Tags from file names (%artist%/%album%/%track% - %title%) on 1 tracks"
    assert client.post("/api/tags/parse-preview", json={**body, "pattern": "%x%"}).status_code == 400
