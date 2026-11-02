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
        (a, "synced"), (b, "instrumental"), (c, "missing"), (e, "has"), (f, "untagged")]
    assert items[0]["lyrics"] == SYNCED
    plain = client.post("/api/lyrics/fetch", json={"track_ids": [a], "prefer": "plain"}).json()["items"][0]
    assert (plain["status"], plain["lyrics"]) == ("plain", "Here comes old flat top")

    res = client.post("/api/lyrics/stage", json={"items": {str(a): SYNCED}}).json()
    assert res["changed"] == 1 and res["staged"] is True
    assert client.get(f"/api/library/track/{a}").json()["staged"]["tags"]["lyrics"] == SYNCED
    assert client.get("/api/staged/actions").json()["steps"][0]["summary"] == "Lyrics on 1 track"
    assert client.post("/api/lyrics/stage", json={"items": {}}).status_code == 400
