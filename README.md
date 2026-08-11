# tagger

A self-hosted web application for editing audio file tags. Supports FLAC, MP3,
AAC/M4A, and OGG Vorbis. Designed to run as a server so you can tag files on a
NAS or remote machine from any browser.

## Features

- Scan a music library into a SQLite index (FLAC, MP3, AAC/M4A, OGG Vorbis)
- Browse by artist/album, by directory tree, or by data-quality issues
- Read and edit tags for individual files, or bulk-edit across a selection
- Full-text search across title/artist/album
- MusicBrainz text lookup, plus AcoustID fingerprint identification (optional)
- One-click Auto-fix to apply the best match, with a before/after confirmation
- Embedded cover art: view, upload, or pull from the Cover Art Archive
- Album grid view with cover thumbnails
- Case normalization (Title Case) for shouty or lowercase tags
- Quality panel surfacing missing tags, duplicates, and dead files
- Configurable rename-on-save (template-based move/rename)
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
│   │   ├── library.py             # Track/artist/album listing, search, issues
│   │   ├── tags.py                # Tag read/write/bulk + rename-on-save
│   │   ├── jobs.py                # Scan job endpoints
│   │   ├── config.py              # Settings model + persistence
│   │   ├── fs.py                  # Filesystem browse/tree endpoints
│   │   ├── covers.py              # Cover art read/write
│   │   └── lookup.py              # MusicBrainz / AcoustID lookup
│   └── core/
│       ├── config.py             # Env-based settings + paths
│       ├── database.py           # SQLite schema, connection, FTS index
│       ├── scanner.py            # Library walk + incremental upsert
│       ├── tagger.py             # mutagen read/write for all formats
│       ├── tasks.py              # Background scan job runner
│       └── providers/            # Metadata providers
│           ├── base.py           # Provider interface + TrackMetadata
│           ├── musicbrainz.py    # MusicBrainz text search
│           └── acoustid_provider.py  # AcoustID fingerprint lookup
├── frontend/
│   ├── index.html
│   ├── vite.config.ts            # Builds into backend/static/
│   └── src/
│       ├── main.ts               # App shell, panels, track list, tag editor
│       ├── api.ts                # Typed REST client
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

AcoustID also requires the `fpcalc` binary (`libchromaprint-tools`), which is
already included in the Docker image. The API key can also be set at runtime in
the Settings panel.

## Planned

- Filename/path → tag inference for untagged files
- Live rename-template preview before saving
- Discogs as an additional metadata provider
- Undo for destructive actions (rename, remove, bulk edits)
