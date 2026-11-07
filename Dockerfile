# ── Stage 1: Build frontend ───────────────────────────────────────────────
# Pin this stage to the build machine's architecture ($BUILDPLATFORM). The
# frontend compiles to static JS/CSS/HTML that is identical on every target
# arch, so there's no reason to run `npm install`/`npm run build` under QEMU
# emulation for arm64 — doing so is slow and can deadlock (emulated Node has
# hung `npm install` for hours). The built assets are copied into each arch's
# runtime image below.
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build
# Output lands in /build/backend/static (per vite.config.ts outDir)


# ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM python:3.14-slim

# fpcalc (chromaprint) for AcoustID fingerprinting; ffmpeg for spectrograms;
# rsgain for ReplayGain (Debian's own package: the upstream .deb targets
# bookworm's libavcodec59 and never installed on this trixie base).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libchromaprint-tools \
    ffmpeg \
    rsgain \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./

# Copy built frontend static files from stage 1
COPY --from=frontend-build /build/backend/static ./static

# Config and music are mounted at runtime
RUN mkdir -p /music /config

ENV TAGGER_MUSIC_DIR=/music
ENV TAGGER_CONFIG_DIR=/config

# Build stamp for the About page (set by .github/workflows/publish.yml).
ARG IMAGE_VERSION=""
ARG GIT_SHA=""
ARG BUILD_DATE=""
ENV TAGGER_IMAGE_VERSION=$IMAGE_VERSION TAGGER_GIT_SHA=$GIT_SHA TAGGER_BUILD_DATE=$BUILD_DATE

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
