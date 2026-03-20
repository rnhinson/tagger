# ── Stage 1: Build frontend ───────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build
# Output lands in /build/backend/static (per vite.config.ts outDir)


# ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM python:3.12-slim

# fpcalc is required for AcoustID fingerprinting (chromaprint package)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libchromaprint-tools \
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

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
