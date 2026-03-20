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
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  year: string | null
  genre: string | null
  track_number: string | null
  disc_number: string | null
  comment: string | null
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
  scan_tags: string[]
  music_dirs: string[]
  default_music_dir?: string
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

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${url} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// Library
export const api = {
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
    artists: () => request<Artist[]>('GET', '/api/library/artists'),
    albums: (artist?: string) =>
      request<Album[]>('GET', `/api/library/albums${artist ? '?artist=' + encodeURIComponent(artist) : ''}`),
  },

  tags: {
    update: (trackId: number, tags: TagUpdate) =>
      request<{ ok: boolean }>('PATCH', `/api/tags/${trackId}`, tags),
    bulk: (trackIds: number[], tags: TagUpdate) =>
      request<{ ok: boolean; errors: unknown[] }>('POST', '/api/tags/bulk', { track_ids: trackIds, tags }),
  },

  jobs: {
    startScan: () => request<{ job_id: string }>('POST', '/api/jobs/scan'),
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
  },

  lookup: {
    search: (trackId: number) =>
      request<LookupResult[]>('POST', `/api/lookup/search/${trackId}`),
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
