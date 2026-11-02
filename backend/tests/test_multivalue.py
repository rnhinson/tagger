"""Multi-value tags ("Folk; Celtic"): splitting, browsing, filtering, add/remove."""
from core.multivalue import edit_values, has_value, split_values
from tests.test_staging import _insert, lib  # noqa: F401  (fixture)


def test_split_trims_and_drops_blanks_and_case_duplicates():
    assert split_values("Folk ; Celtic;; folk ;") == ["Folk", "Celtic"]
    assert split_values(None) == [] and split_values("") == []
    assert has_value("Folk; Celtic", "Celtic") and not has_value("Folk; Celtic", "Celt")


def test_edit_removes_then_adds_case_insensitively_keeping_order():
    assert edit_values("Rock; Folk", add=["Celtic", "rock"], remove=["folk"]) == "Rock; Celtic"
    assert edit_values("", add=["Folk"]) == "Folk"
    assert edit_values("Folk", remove=["Folk"]) == ""


def _lib_tracks(lib):
    d = lib / "Shared" / "A"
    return [
        _insert(d / "1.mp3", genre="Folk; Celtic", artist="Ann; Bob", album="X"),
        _insert(d / "2.mp3", genre="Folk", artist="Ann"),
        _insert(d / "3.mp3", genre=None, artist="Cy"),
    ]


def test_tag_tree_lists_each_value_separately(client, lib):
    _lib_tracks(lib)
    genres = client.get("/api/library/tag-values", params={"field": "genre"}).json()
    assert genres == [{"value": "", "track_count": 1}, {"value": "Celtic", "track_count": 1},
                      {"value": "Folk", "track_count": 2}]


def test_tag_and_artist_filters_match_one_of_the_values(client, lib):
    a, b, c = _lib_tracks(lib)
    ids = lambda **p: {t["id"] for t in client.get("/api/library/tracks", params=p).json()["tracks"]}
    assert ids(tag="genre", value="Folk") == {a, b}
    assert ids(tag="genre", value="Celtic") == {a}
    assert ids(tag="genre", value="") == {c}
    assert ids(artist="Bob") == {a}
    albums = client.get("/api/library/albums", params={"artist": "Bob"}).json()
    assert [x["track_count"] for x in albums] == [1]


def test_value_counts_are_per_selection_and_staged(client, lib):
    a, b, c = _lib_tracks(lib)
    client.patch(f"/api/tags/{c}", json={"genre": "Celtic"})          # staged only
    r = client.post("/api/library/value-counts", json={"track_ids": [a, b, c], "field": "genre"}).json()
    assert r == {"count": 3, "values": [{"value": "Celtic", "tracks": 2}, {"value": "Folk", "tracks": 2}]}
    assert client.post("/api/library/value-counts", json={"track_ids": [a], "field": "title"}).status_code == 400


def test_add_and_remove_values_per_track_as_one_staged_step(client, lib):
    a, b, c = _lib_tracks(lib)
    r = client.post("/api/tags/values", json={
        "track_ids": [a, b, c], "field": "genre", "add": ["Trad"], "remove": ["Folk"]}).json()
    assert r["changed"] == 3 and r["staged"] is True
    eff = {t: client.get(f"/api/library/track/{t}").json()["staged"]["tags"]["genre"] for t in (a, b, c)}
    assert eff == {a: "Celtic; Trad", b: "Trad", c: "Trad"}
    steps = client.get("/api/staged/actions").json()["steps"]
    assert steps[0]["summary"] == "Genre +Trad, −Folk on 3 tracks"

    # Builds on the staged value; a no-op change stages nothing.
    r = client.post("/api/tags/values", json={"track_ids": [a, b], "field": "genre", "add": ["trad"]}).json()
    assert r["changed"] == 0
    client.post("/api/staged/undo")
    assert client.get(f"/api/library/track/{a}").json()["staged"] is None


def test_value_edit_validation(client, lib):
    a, *_ = _lib_tracks(lib)
    assert client.post("/api/tags/values", json={"track_ids": [a], "field": "title", "add": ["x"]}).status_code == 400
    assert client.post("/api/tags/values", json={"track_ids": [a], "field": "genre"}).status_code == 400
