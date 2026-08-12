// Typed API client — thin wrappers around fetch

export interface Track {
  id: number
  path: string
  filename: string
  directory: string
  format: string
  size: number | null
  mtime: number | null
  duration: number | null
  bitrate: number | null
  sample_rate: number | null
  channels: number | null
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  year: string | null
  genre: string | null
  track_number: string | null
  disc_number: string | null
  comment: string | null
  composer: string | null
  bpm: string | null
  lyrics: string | null
  compilation: string | null
  mb_track_id: string | null
  mb_artist_id: string | null
  mb_album_id: string | null
  mb_album_artist_id: string | null
  scanned_at: number
  tagged_at: number | null
}

export interface TrackList {
  total: number
  tracks: Track[]
}

export interface Artist {
  artist: string
  track_count: number
}

export interface Album {
  album: string
  artist: string | null
  album_artist: string | null
  track_count: number
  cover_track_id: number
}

export interface AppSettings {
  rename_on_save: boolean
  rename_template: string
  acoustid_api_key: string
  discogs_token: string
  scan_tags: string[]
  music_dirs: string[]
  default_music_dir?: string
}

export interface ChangeLogEntry {
  id: number
  ts: number
  kind: string
  summary: string
  undone: number
}

export interface ScanJob {
  id: string
  status: 'pending' | 'running' | 'done' | 'error'
  started_at: number | null
  finished_at: number | null
  total: number
  scanned: number
  error: string | null
}

export interface TagUpdate {
  title?: string | null
  artist?: string | null
  album?: string | null
  album_artist?: string | null
  year?: string | null
  genre?: string | null
  track_number?: string | null
  disc_number?: string | null
  comment?: string | null
  composer?: string | null
  bpm?: string | null
  lyrics?: string | null
  compilation?: string | null
  mb_track_id?: string | null
  mb_artist_id?: string | null
  mb_album_id?: string | null
  mb_album_artist_id?: string | null
}

export interface LookupResult {
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  year: string | null
  track_number: string | null
  disc_number: string | null
  mb_track_id: string | null
  mb_artist_id: string | null
  mb_album_id: string | null
  mb_album_artist_id: string | null
  score: number
  source: string
}

export interface MbRelease {
  mb_album_id: string | null
  album: string | null
  year: string | null
  country: string | null
  format: string | null
  track_count: number | null
}

export interface IssueCount {
  missing_title: number
  missing_artist: number
  missing_album: number
  missing_year: number
  missing_genre: number
  missing_track_number: number
  duplicate_tracks: number
  missing_files: number
}

export interface TreeEntry {
  name: string
  path: string
}

export interface TreeResult {
  path: string
  dirs: TreeEntry[]
  files: TreeEntry[]
}

let unauthorizedHandler: (() => void) | null = null

/** Register a callback invoked whenever an API call returns 401. */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    // A 401 on anything other than the login attempt means the session lapsed.
    if (res.status === 401 && !url.startsWith('/api/auth/login')) unauthorizedHandler?.()
    const text = await res.text()
    throw new Error(`${method} ${url} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// Library
export const api = {
  auth: {
    status: () => request<{ required: boolean; authed: boolean }>('GET', '/api/auth/status'),
    login: (password: string) => request<{ ok: boolean }>('POST', '/api/auth/login', { password }),
    logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),
  },

  library: {
    tracks: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return request<TrackList>('GET', `/api/library/tracks${qs ? '?' + qs : ''}`)
    },
    search: (q: string, limit = 50, offset = 0) =>
      request<TrackList>('GET', `/api/library/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
    track: (id: number) => request<Track>('GET', `/api/library/track/${id}`),
    issues: () => request<IssueCount>('GET', '/api/library/issues'),
    dead: () => request<TrackList>('GET', '/api/library/dead'),
    removeTracks: (ids: number[]) => request<{ removed: number }>('POST', '/api/library/remove', ids),
    deleteFiles: (ids: number[]) => request<{ deleted: number }>('POST', '/api/library/delete-files', ids),
    artists: () => request<Artist[]>('GET', '/api/library/artists'),
    albums: (artist?: string) =>
      request<Album[]>('GET', `/api/library/albums${artist ? '?artist=' + encodeURIComponent(artist) : ''}`),
    exportM3uUrl: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return `/api/library/export.m3u${qs ? '?' + qs : ''}`
    },
    history: (limit = 50) => request<ChangeLogEntry[]>('GET', `/api/library/history?limit=${limit}`),
    undo: (id: number) => request<{ restored: number; kind: string }>('POST', `/api/library/history/${id}/undo`),
    dedupeKeepBest: () => request<{ removed: number }>('POST', '/api/library/dedupe/keep-best'),
    trashInfo: () => request<{ count: number; bytes: number }>('GET', '/api/library/trash'),
    emptyTrash: () => request<{ removed: number; bytes: number }>('POST', '/api/library/trash/empty'),
  },

  tags: {
    update: (trackId: number, tags: TagUpdate) =>
      request<{ ok: boolean }>('PATCH', `/api/tags/${trackId}`, tags),
    bulk: (trackIds: number[], tags: TagUpdate) =>
      request<{ ok: boolean; errors: unknown[] }>('POST', '/api/tags/bulk', { track_ids: trackIds, tags }),
    replaygain: (trackIds: number[], albumMode = false) =>
      request<{ ok: boolean; tool: string | null; processed: number; error?: string }>(
        'POST', '/api/tags/replaygain', { track_ids: trackIds, album_mode: albumMode }),
    replaygainStatus: () =>
      request<{ available: boolean; tool: string | null }>('GET', '/api/tags/replaygain/status'),
    reorganize: (trackIds: number[]) =>
      request<{ moved: number; errors: unknown[] }>('POST', '/api/tags/reorganize', { track_ids: trackIds }),
    autonumber: (trackIds: number[]) =>
      request<{ numbered: number }>('POST', '/api/tags/autonumber', { track_ids: trackIds }),
    findReplace: (trackIds: number[], field: string, find: string, replace: string) =>
      request<{ changed: number }>('POST', '/api/tags/find-replace',
        { track_ids: trackIds, field, find, replace }),
  },

  jobs: {
    startScan: (directory?: string) =>
      request<{ job_id: string; directory: string | null }>(
        'POST', `/api/jobs/scan${directory ? '?directory=' + encodeURIComponent(directory) : ''}`),
    list: () => request<ScanJob[]>('GET', '/api/jobs'),
    get: (jobId: string) => request<ScanJob>('GET', `/api/jobs/${jobId}`),
  },

  fs: {
    tree: (path?: string) =>
      request<TreeResult>('GET', `/api/fs/tree${path ? '?path=' + encodeURIComponent(path) : ''}`),
  },

  settings: {
    get: () => request<AppSettings>('GET', '/api/config'),
    update: (s: Partial<AppSettings>) => request<AppSettings>('PATCH', '/api/config', s),
    renamePreview: (template: string, tags?: Record<string, string>, ext?: string) =>
      request<{ ok: boolean; preview?: string; error?: string }>(
        'POST', '/api/config/rename-preview', { template, tags, ext }),
  },

  lookup: {
    search: (trackId: number) =>
      request<LookupResult[]>('POST', `/api/lookup/search/${trackId}`),
    infer: (trackId: number) =>
      request<LookupResult | null>('POST', `/api/lookup/infer/${trackId}`),
    releases: (mbTrackId: string) =>
      request<MbRelease[]>('GET', `/api/lookup/releases/${encodeURIComponent(mbTrackId)}`),
    status: () =>
      request<{ acoustid_configured: boolean; fpcalc_available: boolean; method: string }>(
        'GET', '/api/lookup/status'
      ),
    applyCover: (trackId: number, mbAlbumId: string) =>
      request<{ ok: boolean }>('POST', `/api/lookup/cover/${trackId}?mb_album_id=${encodeURIComponent(mbAlbumId)}`),
  },

  covers: {
    url: (trackId: number) => `/api/covers/${trackId}`,
    update: async (trackId: number, file: File): Promise<{ ok: boolean }> => {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/covers/${trackId}`, { method: 'POST', body: form })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`POST /api/covers/${trackId} → ${res.status}: ${text}`)
      }
      return res.json()
    },
  },
}
