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
  // Edits held for review (null when none). The UI overlays these on the
  // fields above and keeps the on-file values in _orig.
  staged?: (StagedEntry & { via_folder?: boolean }) | null
  _orig?: Record<string, string | null>
}

export interface StagedEntry {
  tags: Record<string, string | null>
  new_path: string | null
}

export interface BulkRenameRequest {
  track_ids: number[]
  find: string
  replace: string
  regex: boolean
  case_sensitive: boolean
  match_all: boolean
  apply_to: 'name' | 'ext' | 'both'
  transform: 'none' | 'lower' | 'upper' | 'title' | 'capitalize'
}

export interface RenameItem {
  id: number
  folder: string
  old: string
  new: string
  status: 'rename' | 'same' | 'conflict' | 'error'
  message: string | null
}

export type StagedLine =
  | { kind: 'tag'; id: number; name: string; field: string; old: string | null; new: string | null }
  | { kind: 'path'; id: number; name: string; old: string; new: string }
  | { kind: 'folder'; src: string; old: string | null; new: string | null; tracks: number }

export interface StagedAction {
  id: number
  ts: number
  summary: string
  count: number
  details: boolean
  lines: StagedLine[]
}

export interface StagedDir {
  src: string
  dst: string
  tracks: number
}

export interface StagedTrack {
  id: number
  title: string | null
  filename: string
  path: string
  new_path: string | null
  changes: { field: string; old: string | null; new: string | null }[]
}

export interface WriteError { id?: number; dir?: string; name?: string; error: string }

/** What an editing call did: held for review, or written straight away. */
export interface EditResult {
  staged: boolean
  applied?: number
  errors?: WriteError[]
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
  scan_exclude: string[]
  auto_scan_minutes: number
  stage_changes: boolean
  library_roots: string[]
  default_music_dir?: string
  env_library_roots?: string[]
  effective_library_roots?: string[]
}

export interface ChangeLogEntry {
  id: number
  ts: number
  kind: string
  summary: string
  undone: number
  count: number | null
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
  has_dirs?: boolean
}

export interface TagValue {
  value: string
  track_count: number
}

export interface StagedCount {
  count: number
  steps: number
  last_step: { id: number; ts: number; summary: string; count: number } | null
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
    trackIds: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return request<{ ids: number[] }>('GET', `/api/library/track-ids${qs ? '?' + qs : ''}`)
    },
    formats: () => request<string[]>('GET', '/api/library/formats'),
    summary: (ids: number[]) =>
      request<{ count: number; values: Record<string, string>; mixed: string[] }>(
        'POST', '/api/library/summary', { track_ids: ids }),
    search: (q: string, limit = 50, offset = 0) =>
      request<TrackList>('GET', `/api/library/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
    track: (id: number) => request<Track>('GET', `/api/library/track/${id}`),
    issues: () => request<IssueCount>('GET', '/api/library/issues'),
    dead: () => request<TrackList>('GET', '/api/library/dead'),
    removeTracks: (ids: number[]) => request<{ removed: number }>('POST', '/api/library/remove', ids),
    deleteFiles: (ids: number[]) => request<{ deleted: number }>('POST', '/api/library/delete-files', ids),
    artists: () => request<Artist[]>('GET', '/api/library/artists'),
    tagValues: (field: string) =>
      request<TagValue[]>('GET', `/api/library/tag-values?field=${encodeURIComponent(field)}`),
    albums: (artist?: string) =>
      request<Album[]>('GET', `/api/library/albums${artist ? '?artist=' + encodeURIComponent(artist) : ''}`),
    exportM3uUrl: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return `/api/library/export.m3u${qs ? '?' + qs : ''}`
    },
    history: (limit = 50) => request<ChangeLogEntry[]>('GET', `/api/library/history?limit=${limit}`),
    undo: (id: number) => request<{ restored: number; kind: string; errors: WriteError[] }>('POST', `/api/library/history/${id}/undo`),
    dedupeKeepBest: () => request<{ removed: number }>('POST', '/api/library/dedupe/keep-best'),
    trashInfo: () => request<{ count: number; bytes: number }>('GET', '/api/library/trash'),
    emptyTrash: () => request<{ removed: number; bytes: number }>('POST', '/api/library/trash/empty'),
  },

  tags: {
    update: (trackId: number, tags: TagUpdate) =>
      request<EditResult>('PATCH', `/api/tags/${trackId}`, tags),
    bulk: (trackIds: number[], tags: TagUpdate) =>
      request<EditResult>('POST', '/api/tags/bulk', { track_ids: trackIds, tags }),
    replaygain: (trackIds: number[], albumMode = false) =>
      request<{ ok: boolean; tool: string | null; processed: number; error?: string }>(
        'POST', '/api/tags/replaygain', { track_ids: trackIds, album_mode: albumMode }),
    replaygainStatus: () =>
      request<{ available: boolean; tool: string | null }>('GET', '/api/tags/replaygain/status'),
    reorganize: (trackIds: number[]) =>
      request<{ planned: number; moved: number; staged: boolean; errors: WriteError[] }>(
        'POST', '/api/tags/reorganize', { track_ids: trackIds }),
    renamePreview: (req: BulkRenameRequest) =>
      request<{ items: RenameItem[]; counts: Record<string, number> }>('POST', '/api/tags/rename-preview', req),
    rename: (req: BulkRenameRequest & { exclude: number[] }) =>
      request<{ planned: number; skipped: number; staged: boolean; moved: number; errors: WriteError[] }>(
        'POST', '/api/tags/rename', req),
    moveTo: (trackIds: number[], folder: string) =>
      request<{ planned: number; moved: number; staged: boolean; errors: WriteError[] }>(
        'POST', '/api/tags/move-to', { track_ids: trackIds, folder }),
    autonumber: (trackIds: number[]) =>
      request<EditResult & { numbered: number }>('POST', '/api/tags/autonumber', { track_ids: trackIds }),
    findReplace: (trackIds: number[], field: string, find: string, replace: string) =>
      request<EditResult & { changed: number }>('POST', '/api/tags/find-replace',
        { track_ids: trackIds, field, find, replace }),
  },

  staged: {
    list: () => request<{ count: number; tracks: StagedTrack[]; dirs: StagedDir[] }>('GET', '/api/staged'),
    count: () => request<StagedCount>('GET', '/api/staged/count'),
    actions: () => request<{ count: number; steps: StagedAction[]; other: StagedLine[] }>('GET', '/api/staged/actions'),
    undo: () => request<{ summary: string; restored: number }>('POST', '/api/staged/undo'),
    apply: (trackIds?: number[]) =>
      request<{ applied: number; folders?: number; errors: WriteError[]; change_id: number | null }>(
        'POST', '/api/staged/apply', { track_ids: trackIds ?? null }),
    discard: (trackIds?: number[], dirs?: string[]) =>
      request<{ discarded: number }>('POST', '/api/staged/discard',
        { track_ids: trackIds ?? null, dirs: dirs ?? null }),
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
    move: (src: string, dst: string) => request<EditResult>('POST', '/api/fs/move', { src, dst }),
    rename: (path: string, name: string) => request<EditResult>('POST', '/api/fs/rename', { path, name }),
  },

  settings: {
    get: () => request<AppSettings>('GET', '/api/config'),
    update: (s: Partial<AppSettings>) => request<AppSettings>('PATCH', '/api/config', s),
    renamePreview: (template: string, tags?: Record<string, string>, ext?: string, trackId?: number) =>
      request<{ ok: boolean; preview?: string; path?: string; error?: string }>(
        'POST', '/api/config/rename-preview', { template, tags, ext, track_id: trackId }),
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

  spectrogram: {
    url: (trackId: number) => `/api/spectrogram/${trackId}`,
    status: () => request<{ available: boolean }>('GET', '/api/spectrogram/status'),
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
