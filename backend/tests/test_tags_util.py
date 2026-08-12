import pytest

from api.tags import render_template, _safe
from api.library import _m3u, _fts_query
from core.tagger import TAG_FIELDS, is_audio_file, _detect_format
from api.config import ALL_SCAN_TAGS


# ── render_template ────────────────────────────────────────────────────────

SAMPLE = {
    "title": "So What", "artist": "Miles Davis", "album": "Kind of Blue",
    "album_artist": "Miles Davis", "year": "1959", "track_number": "1", "disc_number": "1",
}


def test_render_basic():
    out = render_template("{album_artist}/{album}/{track_number:02d} {title}", SAMPLE, ".flac")
    assert out == "Miles Davis/Kind of Blue/01 So What.flac"


def test_render_sanitizes_unsafe_chars():
    tags = {**SAMPLE, "title": "A: B?", "album": "X<Y>"}
    out = render_template("{album}/{title}", tags, ".mp3")
    assert out.count("/") == 1  # only the template's own separator survives
    for ch in ':?<>*|"':
        assert ch not in out


def test_render_defaults_missing_numbers_to_zero():
    out = render_template("{track_number:02d} {title}", {"title": "T"}, ".flac")
    assert out == "00 T.flac"


def test_render_bad_template_raises():
    with pytest.raises((KeyError, ValueError, IndexError)):
        render_template("{nonexistent}", SAMPLE, ".flac")


def test_safe_never_empty():
    assert _safe("...") == "_"
    assert _safe("") == "_"


# ── m3u ────────────────────────────────────────────────────────────────────

def test_m3u_format():
    tracks = [
        {"path": "/m/a.flac", "duration": 191.5, "artist": "Miles", "title": "So What"},
        {"path": "/m/b.mp3", "duration": None, "artist": None, "title": None, "filename": "b.mp3"},
    ]
    out = _m3u(tracks)
    lines = out.splitlines()
    assert lines[0] == "#EXTM3U"
    assert lines[1] == "#EXTINF:191,Miles - So What"
    assert lines[2] == "/m/a.flac"
    assert lines[3] == "#EXTINF:-1,b.mp3"
    assert lines[4] == "/m/b.mp3"


# ── fts query ──────────────────────────────────────────────────────────────

def test_fts_query_prefix_terms():
    assert _fts_query("miles blue") == '"miles"* "blue"*'
    assert _fts_query("  ") == ""


# ── tagger helpers ─────────────────────────────────────────────────────────

def test_tag_fields_is_canonical():
    assert ALL_SCAN_TAGS is TAG_FIELDS
    assert TAG_FIELDS == [
        "title", "artist", "album", "album_artist", "year",
        "genre", "track_number", "disc_number", "comment", "composer", "bpm",
    ]


@pytest.mark.parametrize("name,expected", [
    ("a.flac", True), ("a.mp3", True), ("a.m4a", True), ("a.ogg", True),
    ("a.txt", False), ("a", False),
])
def test_is_audio_file(name, expected):
    assert is_audio_file(name) is expected


@pytest.mark.parametrize("name,fmt", [
    ("x.mp3", "mp3"), ("x.flac", "flac"), ("x.m4a", "aac"),
    ("x.ogg", "ogg"), ("x.wav", "unknown"),
])
def test_detect_format(name, fmt):
    assert _detect_format(name) == fmt
