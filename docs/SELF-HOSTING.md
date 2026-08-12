# Self-hosting guide

tagger is a single container that serves the API and the built UI on port 8000.
It needs two mounts: your music library (read/write, since it edits tags and can
rename/move files) and a config directory that holds `library.db` and
`settings.json`.

## docker-compose

```yaml
services:
  tagger:
    image: ghcr.io/rnhinson/tagger:latest   # or `build: .` to build locally
    container_name: tagger
    restart: unless-stopped
    ports:
      - "8000:8000"
    volumes:
      - /srv/music:/music                    # your library (read/write)
      - tagger-config:/config                # library.db + settings.json
    environment:
      - TAGGER_PASSWORD=change-me            # omit to run without a login
      - TAGGER_SECURE_COOKIE=1               # set when served over HTTPS
      # - ACOUSTID_API_KEY=...               # optional fingerprint lookup

volumes:
  tagger-config:
```

`docker compose up -d`, then open http://localhost:8000.

## Authentication & HTTPS

- Set `TAGGER_PASSWORD` to require a login. The session is an HttpOnly cookie;
  failed logins are rate-limited per IP.
- When you serve tagger over HTTPS (recommended for anything beyond a trusted
  LAN), also set `TAGGER_SECURE_COOKIE=1` so the session cookie is marked
  `Secure` and never sent over plain HTTP.

### Reverse proxy (Caddy)

Caddy gives you automatic HTTPS with a one-line config:

```
tagger.example.com {
    reverse_proxy localhost:8000
}
```

### Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name tagger.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;                 # audio streaming + range
    }
}
```

## Health check

`GET /api/health` returns `{"status":"ok","version":"…"}` without auth — use it
for a container `HEALTHCHECK` or an uptime monitor:

```yaml
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"]
      interval: 30s
      timeout: 5s
      retries: 3
```

## Backups

Everything worth keeping lives in the config volume: `library.db` (the index,
scan jobs, and undo history) and `settings.json`. Back that volume up. The
index can always be rebuilt with a rescan, but settings and undo history can't.

Deleted files are moved to `/config/trash` (recoverable via Undo) until you
empty the trash from Settings.

## ReplayGain

ReplayGain scanning needs `rsgain` (bundled in the image) or `loudgain` on the
server's `PATH`. If it's unavailable the feature simply hides itself.

## Updating

```bash
docker compose pull && docker compose up -d
```

Schema changes migrate automatically on start; your library and settings are
preserved.
