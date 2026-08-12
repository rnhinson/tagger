# Contributing

Thanks for your interest in improving tagger.

## Development setup

Requires Python 3.11+ and Node 18+.

```bash
# Backend (from ./backend)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

# Frontend (from ./frontend)
npm install
```

The quickest full-stack loop is `./dev.sh` from the repo root — it runs the
backend (uvicorn, auto-reload) and the Vite dev server together. See the README
for details.

## Checks

CI runs these on every pull request; run them locally before pushing:

```bash
# Backend tests (install ffmpeg for the audio round-trip tests; they skip
# automatically when it's missing)
cd backend && pytest

# Frontend typecheck + build
cd frontend && npx tsc --noEmit && npm run build
```

## Project layout

- `backend/api/` — FastAPI routers (one file per area).
- `backend/core/` — logic: scanning, tagging, DB, providers, auth, history.
- `frontend/src/` — the SPA. `main.ts` holds app logic; `template.ts` the
  markup; `state.ts` / `columns.ts` / `quality.ts` / `util.ts` are extracted
  modules; `api.ts` is the typed REST client.

`core.tagger.TAG_FIELDS` is the single source of truth for editable tag fields —
adding one there cascades through the DB schema, scanner, and undo. Match the
surrounding style; keep comment density and naming consistent.

## Conventions

- Add or update tests for behavior changes — pure logic and API-level tests
  live in `backend/tests/`.
- Keep pull requests focused; describe what changed and why.
- Database schema changes need a matching `ALTER`-based migration in
  `core/database.py` (`_migrate`) so existing libraries upgrade cleanly.
