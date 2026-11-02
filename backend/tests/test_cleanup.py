"""Separator cleanup: find other separators, preview, stage as one step."""
from core.cleanup import found_separators, standardize
from tests.test_staging import _insert, lib  # noqa: F401  (fixture)


def test_standardize_splits_only_chosen_separators_and_spares_kept_values():
    assert standardize("Folk/Celtic", ["/"]) == "Folk; Celtic"
    assert standardize("AC/DC; Rock/Pop", ["/"], keep={"ac/dc"}) == "AC/DC; Rock; Pop"
    assert standardize("Earth, Wind & Fire", ["/"]) == "Earth, Wind & Fire"
    assert standardize("Ann & Bob, Cy", [",", "&"]) == "Ann; Bob; Cy"
    assert standardize("R&B", ["&"]) == "R&B"                       # '&' needs spaces
    assert standardize("Folk / folk|Trad", ["/", "|"]) == "Folk; Trad"


def test_found_separators_counts_tracks_per_value():
    found = found_separators({"Folk/Celtic": 3, "Rock; AC/DC": 2, "R&B": 4, "Ann & Bob": 1})
    by = {f["sep"]: f for f in found}
    assert set(by) == {"/", "&"}
    assert by["/"]["values"] == [{"value": "Folk/Celtic", "tracks": 3}, {"value": "AC/DC", "tracks": 2}]
    assert by["&"]["values"] == [{"value": "Ann & Bob", "tracks": 1}]


def test_preview_then_stage_one_step(client, lib):
    d = lib / "Shared" / "A"
    a = _insert(d / "1.mp3", genre="Folk/Celtic")
    b = _insert(d / "2.mp3", genre="Folk/Celtic")
    c = _insert(d / "3.mp3", genre="AC/DC")
    sel = client.post("/api/tags/separators", json={"field": "genre"}).json()["separators"]
    assert sel[0]["sep"] == "/" and sel[0]["tracks"] == 3

    body = {"field": "genre", "separators": ["/"], "keep": ["AC/DC"]}
    prev = client.post("/api/tags/standardize", json=body).json()
    assert prev == {"tracks": 2, "changes": [{"old": "Folk/Celtic", "new": "Folk; Celtic", "tracks": 2}]}
    assert client.get(f"/api/library/track/{a}").json()["staged"] is None   # preview stages nothing

    res = client.post("/api/tags/standardize", json={**body, "preview": False}).json()
    assert res["tracks"] == 2 and res["staged"] is True
    assert client.get(f"/api/library/track/{b}").json()["staged"]["tags"]["genre"] == "Folk; Celtic"
    assert client.get(f"/api/library/track/{c}").json()["staged"] is None
    assert client.get("/api/staged/actions").json()["steps"][0]["summary"] == \
        "Standardize genre separators (/) on 2 tracks"


def test_scope_is_the_selection_when_given(client, lib):
    d = lib / "Shared" / "A"
    a = _insert(d / "1.mp3", genre="Folk/Celtic")
    _insert(d / "2.mp3", genre="Rock/Pop")
    prev = client.post("/api/tags/standardize", json={"field": "genre", "separators": ["/"], "track_ids": [a]}).json()
    assert prev["tracks"] == 1 and prev["changes"][0]["old"] == "Folk/Celtic"


def test_validation(client, lib):
    assert client.post("/api/tags/separators", json={"field": "title"}).status_code == 400
    assert client.post("/api/tags/standardize", json={"field": "genre", "separators": []}).status_code == 400
