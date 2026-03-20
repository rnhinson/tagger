# tagger

A self-hosted web application for editing audio file tags. Supports FLAC, MP3,
AAC/M4A, and OGG Vorbis. Designed to run as a server so you can tag files on a
NAS or remote machine from any browser.

## Features (v0.1 — PoC)

- Browse your music library directory tree
- Read and edit tags for individual files
- Bulk-edit a shared tag across multiple files at once
- Strip non-standard tags, with optional `track` → `TRACKNUMBER` promotion
- Configurable rename-on-save (template-based, move or rename in place)
- Settings persisted to `/config/settings.json`

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
│   ├── main.py               # FastAPI app entry point
│   ├── requirements.txt
│   ├── api/
│   │   ├── fs.py             # Filesystem browse/tree endpoints
│   │   ├── tags.py           # Tag read/write/strip endpoints
│   │   └── config.py         # Settings endpoints
│   └── core/
│       ├── tagger.py         # mutagen read/write for all formats
│       └── settings.py       # Settings model + persistence
├── frontend/
│   ├── index.html
│   ├── vite.config.ts        # Builds into backend/static/
│   └── src/
│       ├── main.ts           # App shell, tree, file list, tag editor
│       ├── api.ts            # Typed REST client
│       ├── settings.ts       # Settings modal
│       ├── toast.ts          # Toast notifications
│       └── style.css         # Dark theme
├── Dockerfile                # Multi-stage: Node build + Python runtime
├── docker-compose.yml
└── dev.sh                    # Local dev launcher
```

## Environment Variables

| Variable            | Default    | Description                        |
|---------------------|------------|------------------------------------|
| `TAGGER_MUSIC_DIR`  | `/music`   | Root path of your music library    |
| `TAGGER_CONFIG_DIR` | `/config`  | Where settings.json is stored      |

## Planned (v0.2+)

- MusicBrainz API lookup by artist/album/title
- AcoustID acoustic fingerprinting for untagged files
- Filename/path → tag inference
- Rename/move engine with live template preview
