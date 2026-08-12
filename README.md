# tagger

A self-hosted web application for editing audio file tags. Supports FLAC, MP3,
AAC/M4A, and OGG Vorbis. Designed to run as a server so you can tag files on a
NAS or remote machine from any browser.

## Screenshots

| Track list | Album grid | Tag editor |
|:---:|:---:|:---:|
| ![Track list](docs/tracks.png) | ![Album grid](docs/albums.png) | ![Tag editor](docs/editor.png) |

## Features

- Scan a music library into a SQLite index (FLAC, MP3, AAC/M4A, OGG Vorbis)
- Browse by artist/album, by directory tree, or by data-quality issues
- Read and edit tags (incl. composer & BPM) individually or in bulk
- Album flows: auto-number by filename, and find/replace within a tag
- Inline audio playback in the tag editor (range-streamed, seekable)
- Full-text search across title/artist/album
- MusicBrainz text lookup, plus AcoustID fingerprint identification (optional)
- Discogs as an optional second metadata source (token-gated)
- Tag inference from a file's path/name for untagged files ("From filename")
- One-click Auto-fix to apply the best match, with a before/after confirmation
- Embedded cover art: view, upload, or pull from the Cover Art Archive
- Album grid view with cover thumbnails
- Case normalization (Title Case) for shouty or lowercase tags
- Audio-quality columns (bitrate / sample rate / channels)
- Quality panel surfacing missing tags, duplicates, and dead files, with a
  one-click "keep best quality" de-duplicator
- Optional single-password authentication with login rate-limiting
- Full-library or single-folder rescan, with a concurrent-scan guard
- File operations: move to a recoverable trash, or reorganize on disk
  using the rename template (both undoable)
- Configurable rename-on-save with a live template preview
- ReplayGain scanning via `rsgain`/`loudgain` (bundled in the Docker image)
- Export the current filtered view or search as an `.m3u` playlist
- Undo for tag edits, bulk edits, renames, removals, deletes, and reorganizes
- Multiple music directories, persisted to `/config/settings.json`

## Quick Start — Docker

```bash
# 1. Clone / download the project
git clone <repo> tagger && cd tagger

# 2. Edit docker-compose.yml — set the left side of the music volume:
#      - /your/actual/music/path:/music

# 3. Build and run
docker compose up --build

# 4. Open http://localhost:8000
```

## Prebuilt image (GHCR)

Multi-arch images (`linux/amd64` + `linux/arm64`) are published to the GitHub
Container Registry on every version tag, so you can run without building:

```bash
docker run -p 8000:8000 \
  -v /your/music:/music -v tagger-config:/config \
  ghcr.io/rnhinson/tagger:latest
```

### Apple `container` runtime

The same image runs under Apple's [`container`](https://github.com/apple/container)
CLI on Apple Silicon (macOS 15+). There's no Compose equivalent, so run it
directly and bind-mount a local config folder (named volumes aren't supported):

```bash
container system start
mkdir -p ./tagger-config
container run --detach --name tagger \
  --publish 8000:8000 \
  --volume /Users/you/Music:/music \
  --volume "$PWD/tagger-config:/config" \
  ghcr.io/rnhinson/tagger:latest
```

Open <http://localhost:8000>. If the host can't reach `localhost`, Apple
`container` gives each container its own IP — run `container ls` and browse to
`http://<container-ip>:8000`. Add `--env TAGGER_PASSWORD=…` to require a login.
(GHCR packages start private; make the package public or `container registry
login ghcr.io` first, otherwise the pull is denied.)

## Local Development (no Docker)

Requires Python 3.11+ and Node 18+.

```bash
# Optional: point at your real music library
export TAGGER_MUSIC_DIR=~/Music

./dev.sh
```

- Backend:  http://localhost:8000  (FastAPI + uvicorn, auto-reload)
- Frontend: http://localhost:5173  (Vite dev server, HMR)

The Vite dev server proxies all `/api` requests to the backend, so there are no
CORS issues during development.

## Project Structure

```
tagger/
├── backend/
│   ├── main.py                    # FastAPI app entry point
│   ├── requirements.txt
│   ├── api/                       # HTTP routers
│   │   ├── auth.py                # Login / logout / status
│   │   ├── library.py             # Listing, search, issues, m3u, history, dedupe
│   │   ├── tags.py                # Tag read/write/bulk, rename, ReplayGain
│   │   ├── jobs.py                # Scan job endpoints
│   │   ├── config.py              # Settings model + rename preview
│   │   ├── fs.py                  # Filesystem browse/tree endpoints
│   │   ├── covers.py              # Cover art read/write
│   │   ├── lookup.py              # MusicBrainz / AcoustID / Discogs / infer
│   │   └── stream.py              # Range-aware audio streaming
│   ├── core/
│   │   ├── config.py             # Env-based settings + paths
│   │   ├── auth.py               # Password + HMAC session token
│   │   ├── database.py           # SQLite schema, migrations, FTS index
│   │   ├── scanner.py            # Library walk + incremental upsert
│   │   ├── tagger.py             # mutagen read/write + audio info
│   │   ├── tasks.py              # Background scan job runner
│   │   ├── inference.py          # Path/filename → tag heuristics
│   │   ├── history.py            # Change log + undo
│   │   ├── replaygain.py         # rsgain/loudgain wrapper
│   │   └── providers/            # Metadata providers
│   │       ├── base.py           # Provider interface + TrackMetadata
│   │       ├── musicbrainz.py    # MusicBrainz text search + result parser
│   │       ├── acoustid_provider.py  # AcoustID fingerprint lookup
│   │       └── discogs.py        # Discogs release search
│   └── tests/                     # pytest suite (logic, API, audio round-trip)
├── frontend/
│   ├── index.html
│   ├── vite.config.ts            # Builds into backend/static/
│   └── src/
│       ├── main.ts               # App logic: panels, track list, tag editor
│       ├── template.ts           # Static app markup
│       ├── api.ts                # Typed REST client
│       ├── state.ts              # Shared UI state + column prefs
│       ├── columns.ts            # Track-table column definitions
│       ├── quality.ts            # Quality rating + case normalization
│       ├── util.ts               # esc / fmtDuration / debounce
│       ├── toast.ts              # Toast notifications
│       └── style.css             # Dark theme
├── Dockerfile                    # Multi-stage: Node build + Python runtime
├── docker-compose.yml
└── dev.sh                        # Local dev launcher
```

## Environment Variables

| Variable            | Default    | Description                        |
|---------------------|------------|------------------------------------|
| `TAGGER_MUSIC_DIR`  | `/music`   | Root path of your music library    |
| `TAGGER_CONFIG_DIR` | `/config`  | Where settings.json is stored      |
| `ACOUSTID_API_KEY`  | *(unset)*  | Enables AcoustID fingerprint lookup |
| `TAGGER_PASSWORD`   | *(unset)*  | If set, requires this password to log in |

AcoustID also requires the `fpcalc` binary (`libchromaprint-tools`), which is
already included in the Docker image. The API key can also be set at runtime in
the Settings panel, alongside an optional **Discogs** token for a second
metadata source.

**Authentication** is off by default — the app is fully open unless
`TAGGER_PASSWORD` is set. When set, a login is required and the session is held
in an HttpOnly cookie that survives restarts (and invalidates if the password
changes); repeated failed logins from an IP are rate-limited. Put it behind
HTTPS if you expose it beyond a trusted LAN.

**ReplayGain** scanning shells out to [`rsgain`](https://github.com/complexlogic/rsgain)
or `loudgain` if either is on the server's `PATH`; when neither is installed the
feature reports itself unavailable in Settings. The Docker image installs
`rsgain` by default — build with `--build-arg INSTALL_RSGAIN=0` to skip it, or
`--build-arg RSGAIN_VERSION=x.y` to pin a version. If the install fails at build
time the image still builds; the feature just stays disabled.

## Testing

```bash
cd backend
pip install -r requirements-dev.txt
pytest
```

The suite covers pure logic (tag inference, rename-template rendering, the
MusicBrainz parser, playlist/FTS helpers, undo/history), the HTTP API via
TestClient (including auth and the audio stream), and real-audio tag/cover
round-trips across all four formats. The round-trip tests synthesise fixtures
with `ffmpeg` and skip automatically when it isn't installed.

GitHub Actions (`.github/workflows/ci.yml`) runs the backend suite (with
`ffmpeg`) and the frontend typecheck + build on every push and pull request.

## Planned

- Live per-file rename preview in the tag editor (settings preview exists today)
- MusicBrainz release browsing to pick a specific edition
- Batch cover-art fetch for whole albums
- Lyrics and compilation-flag tag fields
- An "empty trash" action for deleted files
