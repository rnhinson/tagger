#!/usr/bin/env bash
# dev.sh — Run tagger locally for development (no Docker required)
#
# Starts:
#   - FastAPI backend on :8000  (with --reload)
#   - Vite dev server on :5173  (proxies /api to :8000)
#
# Usage:
#   ./dev.sh                        # uses /tmp/tagger-music as music dir
#   TAGGER_MUSIC_DIR=~/Music ./dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Check deps ────────────────────────────────────────────────────────────
command -v python3 &>/dev/null || { echo "python3 not found"; exit 1; }
command -v node    &>/dev/null || { echo "node not found";    exit 1; }
command -v npm     &>/dev/null || { echo "npm not found";     exit 1; }

# ── Python venv ───────────────────────────────────────────────────────────
VENV="$ROOT/.venv"
if [ ! -d "$VENV" ]; then
  echo "→ Creating Python venv..."
  python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"

echo "→ Installing Python deps..."
pip install -q -r "$ROOT/backend/requirements.txt"

# ── Node deps ─────────────────────────────────────────────────────────────
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "→ Installing Node deps..."
  npm --prefix "$ROOT/frontend" install
fi

# ── Default dirs ──────────────────────────────────────────────────────────
export TAGGER_MUSIC_DIR="${TAGGER_MUSIC_DIR:-/tmp/tagger-music}"
export TAGGER_CONFIG_DIR="${TAGGER_CONFIG_DIR:-/tmp/tagger-config}"
mkdir -p "$TAGGER_MUSIC_DIR" "$TAGGER_CONFIG_DIR"

echo
echo "  Music dir:  $TAGGER_MUSIC_DIR"
echo "  Config dir: $TAGGER_CONFIG_DIR"
echo "  Backend:    http://localhost:8000"
echo "  Frontend:   http://localhost:5173"
echo

# ── Launch both processes ─────────────────────────────────────────────────
trap 'kill $(jobs -p) 2>/dev/null' EXIT

cd "$ROOT/backend"
uvicorn main:app --reload --port 8000 &

cd "$ROOT/frontend"
npm run dev &

wait