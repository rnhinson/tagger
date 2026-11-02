"""PowerRename-style bulk rename: engine + preview/stage endpoints."""
import pytest

from core import powerrename as pr
from tests.test_staging import _insert, _mp3, lib, needs_ffmpeg  # noqa: F401  (fixture)


def ren(name, i=0, **kw):
    o = pr.Options(**kw)
    return pr.rename_one(name, o, pr.compile_search(o), pr.parse_template(o.replace, o.regex), i)


# ── engine ───────────────────────────────────────────────────────────────────

def test_plain_text_is_literal_and_case_insensitive_by_default():
    assert ren("01 Track.mp3", find="track", replace="Song") == "01 Song.mp3"
    assert ren("a.b.mp3", find=".", replace="_") == "a_b.mp3"        # not a regex dot
    assert ren("x $1.mp3", find="x", replace="$1") == "$1 $1.mp3"    # $1 literal without regex
    assert ren("Aa.mp3", find="a", replace="b", case_sensitive=True) == "Ab.mp3"


def test_regex_captures_numbered_named_and_whole():
    kw = dict(regex=True, find=r"^(\d+) - (?P<t>.+)$")
    assert ren("03 - Silent Night.mp3", replace="${t} ($1)", **kw) == "Silent Night (03).mp3"
    assert ren("03 - x.mp3", replace="[$0]", **kw) == "[03 - x].mp3"
    assert ren("a.mp3", regex=True, find="a", replace="$$5") == "$5.mp3"
    with pytest.raises(pr.RenameError):
        ren("a.mp3", regex=True, find="a", replace="$2")


def test_match_all_vs_first():
    assert ren("a a a.mp3", find="a", replace="b") == "b b b.mp3"
    assert ren("a a a.mp3", find="a", replace="b", match_all=False) == "b a a.mp3"


def test_apply_to_name_ext_both():
    assert ren("song.MP3", find="mp3", replace="x") == "song.MP3"          # name only
    assert ren("song.MP3", find="MP3", replace="mp3", apply_to="ext") == "song.mp3"
    assert ren("a.flac", find=r"a\.flac", replace="b.mp3", regex=True, apply_to="both") == "b.mp3"


def test_counters():
    assert [ren("x.mp3", i, find="x", replace="${}") for i in range(3)] == ["1.mp3", "2.mp3", "3.mp3"]
    assert ren("x.mp3", 2, find="x", replace="${start=10,increment=5,padding=3}") == "020.mp3"
    assert ren("x.mp3", 0, regex=True, find="(x)", replace="${padding=2} $1") == "01 x.mp3"


def test_transforms():
    assert ren("the sound of music.mp3", transform="title") == "The Sound of Music.mp3"
    assert ren("the sound of music.mp3", transform="capitalize") == "The Sound Of Music.mp3"
    assert ren("Loud.MP3", transform="lower", apply_to="both") == "loud.mp3"
    assert ren("quiet.mp3", transform="upper") == "QUIET.mp3"


def test_bad_inputs():
    with pytest.raises(pr.RenameError):
        ren("a.mp3", regex=True, find="(", replace="")
    with pytest.raises(pr.RenameError):
        ren("a.mp3", find="a", replace="${start=x}")
    assert pr.check_name("a/b.mp3") and pr.check_name("") and pr.check_name(".x")
    assert pr.check_name("ok.mp3") is None


# ── endpoints ────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_preview_then_stage_then_write(client, lib):
    d = lib / "Shared" / "Al"
    ids = [_insert(_mp3(d / f"{n:02d} - Song {n}.mp3")) for n in (1, 2, 3)]
    body = {"track_ids": ids, "regex": True, "find": r"^(\d+) - Song (\d+)$", "replace": "Track ${padding=3} ($2)"}
    prev = client.post("/api/tags/rename-preview", json=body).json()
    assert [it["new"] for it in prev["items"]] == ["Track 001 (1).mp3", "Track 002 (2).mp3", "Track 003 (3).mp3"]
    assert prev["counts"] == {"rename": 3}
    assert client.get("/api/staged/count").json()["count"] == 0          # preview stages nothing

    r = client.post("/api/tags/rename", json={**body, "exclude": [ids[1]]}).json()
    assert r["planned"] == 2 and r["staged"] is True
    client.post("/api/staged/apply", json={})
    assert sorted(p.name for p in d.iterdir()) == ["02 - Song 2.mp3", "Track 001 (1).mp3", "Track 003 (3).mp3"]


@needs_ffmpeg
def test_preview_flags_clashes_and_bad_names(client, lib):
    d = lib / "Shared" / "Al"
    a = _insert(_mp3(d / "a1.mp3"))
    b = _insert(_mp3(d / "a2.mp3"))
    _mp3(d / "taken.mp3")
    st = lambda **kw: [(it["status"], it["message"]) for it in client.post(
        "/api/tags/rename-preview", json={"track_ids": [a, b], **kw}).json()["items"]]
    s = st(regex=True, find=r"\d", replace="")                 # both -> a.mp3
    assert [x[0] for x in s] == ["conflict", "conflict"]
    s = st(find="a1", replace="taken")
    assert s[0][0] == "conflict" and "already exists" in s[0][1] and s[1][0] == "same"
    s = st(find="a1", replace="x/y")
    assert s[0] == ("error", "name contains '/'")
    s = st(find="a1", replace="a2")                            # a1 -> a2 while a2 stays
    assert s[0][0] == "conflict"
    r = client.post("/api/tags/rename-preview", json={"track_ids": [a], "regex": True, "find": "("})
    assert r.status_code == 400 and "regular expression" in r.json()["detail"]


@needs_ffmpeg
def test_rename_chain_is_flagged_and_case_only_rename_works(client, lib):
    d = lib / "Shared" / "Al"
    a = _insert(_mp3(d / "1.mp3"))
    b = _insert(_mp3(d / "2.mp3"))
    items = client.post("/api/tags/rename-preview", json={
        "track_ids": [a, b], "regex": True, "find": r"^(\d)$", "replace": "${start=2}"}).json()["items"]
    assert items[0]["status"] == "conflict" and "two passes" in items[0]["message"]   # 1 -> 2 while 2 -> 3
    c = _insert(_mp3(d / "song.mp3"))
    client.post("/api/tags/rename", json={"track_ids": [c], "transform": "capitalize"})
    client.post("/api/staged/apply", json={})
    assert "Song.mp3" in [p.name for p in d.iterdir()]


@needs_ffmpeg
def test_rename_builds_on_a_staged_move_and_undoes_in_one_step(client, lib):
    d = lib / "Shared" / "Al"
    t = _insert(_mp3(d / "x.mp3"), title="T", album="Alb", album_artist="A", track_number="1")
    client.post("/api/tags/reorganize", json={"track_ids": [t]})       # -> Shared/A/Alb/01 T.mp3
    client.post("/api/tags/rename", json={"track_ids": [t], "find": "01 ", "replace": ""})
    assert client.get(f"/api/library/track/{t}").json()["staged"]["new_path"].endswith("/A/Alb/T.mp3")
    client.post("/api/staged/undo")
    assert client.get(f"/api/library/track/{t}").json()["staged"]["new_path"].endswith("/A/Alb/01 T.mp3")
