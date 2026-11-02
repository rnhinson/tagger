"""Merge albums: one album's tags on every track, discs renumbered, files moved."""
from tests.test_staging import _insert, lib  # noqa: F401  (fixture)


def _two_albums(lib):
    a_dir = lib / "Shared" / "Beatles" / "Abbey Road"
    b_dir = lib / "Shared" / "Beatles" / "Abbey Road (Remaster)"
    a = [_insert(a_dir / f"0{i} t.mp3", album="Abbey Road", album_artist="The Beatles", year="1969",
                 track_number=str(i)) for i in (1, 2)]
    b = [_insert(b_dir / "01 t.mp3", album="Abbey Road (Remaster)", album_artist="Beatles", disc_number="1", track_number="1"),
         _insert(b_dir / "03 t.mp3", album="Abbey Road (Remaster)", album_artist="Beatles", disc_number="2", track_number="1")]
    return a_dir, b_dir, a, b


def test_preview_groups_and_disc_plan(client, lib):
    a_dir, b_dir, a, b = _two_albums(lib)
    r = client.post("/api/tags/merge-albums", json={"track_ids": a + b, "album": "Abbey Road",
                                                    "album_artist": "The Beatles", "discs": "per_album"}).json()
    assert [(g["album"], g["tracks"], g["discs"], g["new_discs"]) for g in r["groups"]] == [
        ("Abbey Road", 2, [1], ["1"]), ("Abbey Road (Remaster)", 2, [1, 2], ["2", "3"])]
    assert r["target"] == r["groups"][0]["key"] and r["moves"] == 0
    assert r["tracks"] == 4                      # A gets disc 1 written; B gets album/artist/discs
    assert client.get(f"/api/library/track/{a[0]}").json()["staged"] is None   # preview only


def test_apply_moves_into_target_folder_and_reports_clashes(client, lib):
    a_dir, b_dir, a, b = _two_albums(lib)
    a_dir.mkdir(parents=True, exist_ok=True)
    (a_dir / "01 t.mp3").write_bytes(b"x")       # B's 01 would land on A's 01
    body = {"track_ids": a + b, "album": "Abbey Road", "album_artist": "The Beatles",
            "year": "1969", "move": True}
    prev = client.post("/api/tags/merge-albums", json=body).json()
    assert prev["moves"] == 1 and [c["id"] for c in prev["clashes"]] == [b[0]]

    res = client.post("/api/tags/merge-albums", json={**body, "preview": False}).json()
    assert res["staged"] is True and res["tracks"] == 2
    st = client.get(f"/api/library/track/{b[1]}").json()["staged"]
    assert st["tags"] == {"album": "Abbey Road", "album_artist": "The Beatles", "year": "1969"}
    assert st["new_path"] == str(a_dir / "03 t.mp3")
    assert client.get(f"/api/library/track/{b[0]}").json()["staged"]["new_path"] is None  # clash: tags only
    step = client.get("/api/staged/actions").json()["steps"][0]
    assert step["summary"] == "Merge 2 albums into Abbey Road (2 tracks)"
    client.post("/api/staged/undo")
    assert client.get(f"/api/library/track/{b[1]}").json()["staged"] is None


def test_order_and_target_are_chosen(client, lib):
    a_dir, b_dir, a, b = _two_albums(lib)
    keys = [g["key"] for g in client.post("/api/tags/merge-albums", json={"track_ids": a + b}).json()["groups"]]
    r = client.post("/api/tags/merge-albums", json={"track_ids": a + b, "order": [keys[1]], "target": keys[1],
                                                    "discs": "per_album", "move": True}).json()
    assert [g["new_discs"] for g in r["groups"]] == [["1", "2"], ["3"]]   # remaster first
    assert r["target"] == keys[1] and r["moves"] == 2                     # A's files move to B's folder


def test_validation(client, lib):
    a_dir, b_dir, a, b = _two_albums(lib)
    assert client.post("/api/tags/merge-albums", json={"track_ids": a}).status_code == 400   # one album
    assert client.post("/api/tags/merge-albums", json={"track_ids": a + b, "discs": "x"}).status_code == 400
