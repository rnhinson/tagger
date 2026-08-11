from core.inference import infer_tags_from_path

MUSIC = ["/music"]


def test_artist_album_track_title():
    got = infer_tags_from_path("/music/Radiohead/OK Computer/03 Subterranean.mp3", MUSIC)
    assert got["artist"] == "Radiohead"
    assert got["album"] == "OK Computer"
    assert got["track_number"] == "3"
    assert got["title"] == "Subterranean"


def test_year_pulled_from_album_folder():
    got = infer_tags_from_path("/music/Miles Davis/1959 - Kind of Blue/01 - So What.flac", MUSIC)
    assert got["year"] == "1959"
    assert got["album"] == "Kind of Blue"
    assert got["artist"] == "Miles Davis"
    assert got["track_number"] == "1"
    assert got["title"] == "So What"


def test_parenthesised_year():
    got = infer_tags_from_path("/music/Artist/Album (2001)/02. Song.ogg", MUSIC)
    assert got["year"] == "2001"
    assert got["album"] == "Album"
    assert got["track_number"] == "2"


def test_disc_prefixed_track():
    got = infer_tags_from_path("/music/A/B/1-05 Track.flac", MUSIC)
    assert got["disc_number"] == "1"
    assert got["track_number"] == "5"
    assert got["title"] == "Track"


def test_artist_title_in_filename():
    got = infer_tags_from_path("/music/Compilation/Some Artist - A Song.mp3", MUSIC)
    # Folder supplies the album; filename supplies artist + title
    assert got["album"] == "Compilation"
    assert got["artist"] == "Some Artist"
    assert got["title"] == "A Song"


def test_loose_file_only_title():
    got = infer_tags_from_path("/music/loose.flac", MUSIC)
    assert got == {"title": "loose"}


def test_folder_artist_wins_over_filename():
    got = infer_tags_from_path("/music/Real Artist/Album/01 Filename Artist - Title.mp3", MUSIC)
    assert got["artist"] == "Real Artist"
    assert got["title"] == "Filename Artist - Title"


def test_path_outside_music_dir():
    got = infer_tags_from_path("/other/place/song.mp3", MUSIC)
    assert got == {"title": "song"}
