"""Duplicates: by cleaned-up tags + length, by sound (fingerprints), and albums."""
import json
import random

from core import duplicates, fingerprintjob
from core.database import db


def _insert(title, artist, *, duration=200.0, fmt="mp3", bitrate=320, size=100, directory="/m/A", album=None,
            album_artist=None, mtime=1.0):
    with db() as conn:
        return conn.execute(
            "INSERT INTO tracks (path, filename, directory, format, scanned_at, title, artist, duration, bitrate, "
            "size, album, album_artist, mtime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"{directory}/{title}-{random.random()}.{fmt}", f"{title}.{fmt}", directory, fmt, 1.0, title, artist,
             duration, bitrate, size, album, album_artist, mtime)).lastrowid


def _groups(client):
    return [[t["id"] for t in g["tracks"]] for g in client.get("/api/library/duplicates").json()["groups"]]


def test_cleaned_up_names_match_and_lossless_is_kept(client):
    mp3 = _insert("Come Together", "The Beatles", bitrate=320)
    flac = _insert("Come Together - Remastered 2009", "Beatles", fmt="flac", bitrate=900)
    feat = _insert("Come Together (feat. Billy Preston)", "The Beatles feat. Billy Preston", bitrate=128)
    _insert("Something", "The Beatles")
    assert _groups(client) == [[flac, mp3, feat]]


def test_lengths_must_be_close(client):
    studio = _insert("Wait For It", "Leslie Odom Jr.", duration=193.0)
    copy = _insert("Wait For It", "Leslie Odom Jr.", duration=194.5)
    _insert("Wait For It", "Leslie Odom Jr.", duration=240.0)                # a live take
    assert sorted(_groups(client)[0]) == sorted([studio, copy]) and len(_groups(client)) == 1


def test_issue_counts_and_view_follow_the_groups(client):
    a = _insert("Song", "Artist")
    b = _insert("Song", "artist")
    _insert("Other", "Artist")
    assert client.get("/api/library/issues").json()["duplicate_tracks"] == 2
    got = [t["id"] for t in client.get("/api/library/tracks", params={"issue": "duplicate_tracks"}).json()["tracks"]]
    assert sorted(got) == sorted([a, b])
    c = _insert("Song", "ARTIST")                                           # the cache notices new tracks
    assert client.get("/api/library/issues").json()["duplicate_tracks"] == 3 and c


def test_duplicate_albums_by_folder(client):
    for d in ("/m/Beatles/Abbey Road", "/m/Beatles/Abbey Road (Remaster)"):
        _insert("Come Together", "The Beatles", directory=d, album="Abbey Road" if "Rem" not in d else "Abbey Road (Remastered)",
                album_artist="The Beatles")
    _insert("X", "Y", directory="/m/Y/Solo", album="Solo")
    assert client.get("/api/library/issues").json()["duplicate_albums"] == 2
    rows = client.get("/api/library/album-list", params={"issue": "duplicate_albums"}).json()
    assert sorted(r["directory"] for r in rows) == ["/m/Beatles/Abbey Road", "/m/Beatles/Abbey Road (Remaster)"]


def test_sound_matches_copies_whose_tags_disagree(client):
    rnd = random.Random(1)
    fp = [rnd.getrandbits(32) for _ in range(240)]
    near = [x ^ (1 << rnd.randrange(12)) if i % 3 == 0 else x for i, x in enumerate(fp)]   # a re-encode: low bits flip
    other = [rnd.getrandbits(32) for _ in range(240)]
    a = _insert("Track 01", "Unknown Artist", duration=200)
    b = _insert("Wait For It", "Leslie Odom Jr.", duration=201)
    c = _insert("Something else", "Someone", duration=200)
    with db() as conn:
        conn.executemany("INSERT INTO fingerprints (track_id, mtime, fp) VALUES (?, 1.0, ?)",
                         [(a, json.dumps(fp)), (b, json.dumps(near)), (c, json.dumps(other))])
    assert [sorted(g) for g in _groups(client)] == [sorted([a, b])]


def test_fingerprint_job_stores_and_resumes(client, monkeypatch):
    a = _insert("A", "X")
    b = _insert("B", "X")
    monkeypatch.setattr(fingerprintjob, "available", lambda: True)
    monkeypatch.setattr(fingerprintjob, "fingerprint", lambda path: [1, 2, 3] if path.startswith("/m/A/A-") else [])
    r = client.post("/api/library/fingerprints").json()
    assert r["tracks"] == 2
    job = client.get(f"/api/jobs/{r['job_id']}").json()
    assert (job["kind"], job["status"], job["scanned"], job["changed"]) == ("fingerprint", "done", 2, 1)
    assert client.get("/api/library/fingerprints").json()["fingerprinted"] == 2   # a failure counts as done
    assert client.post("/api/library/fingerprints").json() == {"job_id": None, "tracks": 0}
    with db() as conn:
        conn.execute("UPDATE tracks SET mtime = 2.0 WHERE id = ?", (a,))
    assert client.post("/api/library/fingerprints").json()["tracks"] == 1          # changed file: again
    assert b


def test_normalizing():
    assert duplicates.norm_title('Let It Go (From "Frozen")') == "let it go"
    assert duplicates.norm_artist("The Pogues; Kirsty MacColl") == "pogues"
