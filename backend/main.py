import os
from contextlib import asynccontextmanager
from http.cookies import SimpleCookie

from fastapi import FastAPI
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
from api.stream import router as stream_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.config_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    yield


class AuthMiddleware:
    """
    Pure-ASGI gate for /api/* when a password is configured.

    Implemented at the ASGI layer (not BaseHTTPMiddleware) so it passes
    streaming responses — e.g. the Range-aware audio stream — through
    untouched, only short-circuiting with a 401 when the session is invalid.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and auth_enabled():
            path = scope["path"]
            if path.startswith("/api/") and not path.startswith("/api/auth/"):
                cookies = SimpleCookie()
                for name, value in scope["headers"]:
                    if name == b"cookie":
                        cookies.load(value.decode("latin-1"))
                token = cookies[COOKIE_NAME].value if COOKIE_NAME in cookies else None
                if not valid_token(token):
                    resp = JSONResponse({"detail": "Authentication required"}, status_code=401)
                    await resp(scope, receive, send)
                    return
        await self.app(scope, receive, send)


app = FastAPI(title="Tagger", version="0.2.0", lifespan=lifespan)
app.add_middleware(AuthMiddleware)

app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(library_router, prefix="/api/library", tags=["library"])
app.include_router(tags_router, prefix="/api/tags", tags=["tags"])
app.include_router(jobs_router, prefix="/api/jobs", tags=["jobs"])
app.include_router(config_router, prefix="/api/config", tags=["config"])
app.include_router(fs_router, prefix="/api/fs", tags=["fs"])
app.include_router(covers_router, prefix="/api/covers", tags=["covers"])
app.include_router(lookup_router, prefix="/api/lookup", tags=["lookup"])
app.include_router(stream_router, prefix="/api/stream", tags=["stream"])

# Serve built frontend assets (production only — dev uses Vite's server)
_static = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
