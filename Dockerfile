# ── Stage 1: Build frontend ───────────────────────────────────────────────
# Pin this stage to the build machine's architecture ($BUILDPLATFORM). The
# frontend compiles to static JS/CSS/HTML that is identical on every target
# arch, so there's no reason to run `npm install`/`npm run build` under QEMU
# emulation for arm64 — doing so is slow and can deadlock (emulated Node has
# hung `npm install` for hours). The built assets are copied into each arch's
# runtime image below.
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build
# Output lands in /build/backend/static (per vite.config.ts outDir)


# ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM python:3.12-slim

# fpcalc (chromaprint) for AcoustID fingerprinting; ffmpeg for spectrograms
RUN apt-get update && apt-get install -y --no-install-recommends \
    libchromaprint-tools \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ReplayGain scanning (optional). Installs rsgain from its GitHub .deb release.
# Wrapped so a download/dependency failure only warns — the app detects rsgain
# at runtime and disables the feature gracefully when it's absent. Override the
# version with --build-arg RSGAIN_VERSION=x.y, or disable with
# --build-arg INSTALL_RSGAIN=0.
ARG INSTALL_RSGAIN=1
ARG RSGAIN_VERSION=3.6
# TARGETARCH is set automatically by buildx (amd64/arm64); defaults for plain builds.
ARG TARGETARCH
RUN if [ "$INSTALL_RSGAIN" = "1" ]; then \
      arch="${TARGETARCH:-amd64}"; \
      ( apt-get update \
        && apt-get install -y --no-install-recommends curl ca-certificates \
        && curl -fsSL -o /tmp/rsgain.deb \
             "https://github.com/complexlogic/rsgain/releases/download/v${RSGAIN_VERSION}/rsgain_${RSGAIN_VERSION}_${arch}.deb" \
        && apt-get install -y --no-install-recommends /tmp/rsgain.deb \
        && rm -f /tmp/rsgain.deb ) \
      || echo "WARNING: rsgain install failed — ReplayGain will be unavailable"; \
      rm -rf /var/lib/apt/lists/*; \
    fi

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

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
