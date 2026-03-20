import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from core.config import settings
from core.database import init_db
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
