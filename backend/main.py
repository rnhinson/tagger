import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from core.config import settings
from core.database import init_db
from core.auth import COOKIE_NAME, auth_enabled, valid_token
from api.auth import router as auth_router
from api.library import router as library_router
from api.tags import router as tags_router
from api.jobs import router as jobs_router
from api.config import router as config_router
from api.fs import router as fs_router
from api.covers import router as covers_router
from api.lookup import router as lookup_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.config_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    yield


app = FastAPI(title="Tagger", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def require_auth(request: Request, call_next):
    """Gate /api/* behind the session cookie when a password is configured."""
    path = request.url.path
    if (
        auth_enabled()
        and path.startswith("/api/")
        and not path.startswith("/api/auth/")
        and not valid_token(request.cookies.get(COOKIE_NAME))
    ):
        return JSONResponse({"detail": "Authentication required"}, status_code=401)
    return await call_next(request)


app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(library_router, prefix="/api/library", tags=["library"])
app.include_router(tags_router, prefix="/api/tags", tags=["tags"])
app.include_router(jobs_router, prefix="/api/jobs", tags=["jobs"])
app.include_router(config_router, prefix="/api/config", tags=["config"])
app.include_router(fs_router, prefix="/api/fs", tags=["fs"])
app.include_router(covers_router, prefix="/api/covers", tags=["covers"])
app.include_router(lookup_router, prefix="/api/lookup", tags=["lookup"])

# Serve built frontend assets (production only — dev uses Vite's server)
_static = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
