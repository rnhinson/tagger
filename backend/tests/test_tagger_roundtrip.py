"""
Real-audio round-trip tests. These require ffmpeg to synthesise fixtures and
are skipped when it is unavailable (they run in CI, which installs ffmpeg).
"""
import base64

import pytest

from core.tagger import read_tags, write_tags, read_cover, write_cover

# 1×1 transparent PNG
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

FORMATS = [".mp3", ".flac", ".ogg", ".m4a"]


@pytest.mark.parametrize("ext", FORMATS)
def test_tag_write_read_roundtrip(make_audio, ext):
    path = make_audio(ext)
    write_tags(path, {
        "title": "So What", "artist": "Miles Davis", "album": "Kind of Blue",
        "year": "1959", "track_number": "3", "genre": "Jazz",
        "composer": "Miles Davis", "bpm": "132",
        "lyrics": "So what\nSo what", "compilation": "1",
    })
    tags = read_tags(path)
    assert tags["composer"] == "Miles Davis"
    assert tags["bpm"] == "132"
    assert tags["lyrics"] == "So what\nSo what"
    assert tags["compilation"] == "1"
    assert tags["title"] == "So What"
    assert tags["artist"] == "Miles Davis"
    assert tags["album"] == "Kind of Blue"
    assert tags["year"] == "1959"
    # MP4 may round-trip a track number as "3/0"; normalise before comparing.
    assert (tags["track_number"] or "").split("/")[0] == "3"
    assert tags["genre"] == "Jazz"
    assert tags["format"] != "unknown"
    assert tags["duration"] and tags["duration"] > 0
    # Audio-quality info read from the stream (fixtures are mono 44.1 kHz).
    assert tags["sample_rate"] == 44100
    assert tags["channels"] == 1
    assert tags["bitrate"] and tags["bitrate"] > 0


@pytest.mark.parametrize("ext", FORMATS)
def test_tag_deletion_via_empty_string(make_audio, ext):
    path = make_audio(ext)
    write_tags(path, {"title": "Temp"})
    assert read_tags(path)["title"] == "Temp"
    write_tags(path, {"title": ""})
    assert read_tags(path)["title"] in (None, "")


@pytest.mark.parametrize("ext", FORMATS)
def test_extended_fields_deletion(make_audio, ext):
    path = make_audio(ext)
    write_tags(path, {"lyrics": "keep", "compilation": "1"})
    assert read_tags(path)["lyrics"] == "keep"
    assert read_tags(path)["compilation"] == "1"
    write_tags(path, {"lyrics": "", "compilation": ""})
    tags = read_tags(path)
    assert tags["lyrics"] in (None, "")
    assert tags["compilation"] is None


@pytest.mark.parametrize("ext", FORMATS)
def test_cover_write_read_roundtrip(make_audio, ext):
    path = make_audio(ext)
    write_cover(path, "image/png", _PNG)
    result = read_cover(path)
    assert result is not None
    mime, data = result
    assert data == _PNG
