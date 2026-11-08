// Typed API client — thin wrappers around fetch

export interface Track {
  id: number
  read_only?: boolean
  missing?: boolean                  // the file isn't at its scanned path any more
  layout_path?: string | null        // where its library's layout puts it, when that's elsewhere
  lyrics_group?: string              // its lyrics group's name
  has_cover?: number | null          // embedded cover art (1/0; null = not scanned since covers were tracked)
  cover_width?: number | null
  cover_height?: number | null
  cover_bytes?: number | null
  lyrics_lookup?: { status: string; at: number } | null   // the last lyrics lookup
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
  missing?: number                   // files gone from disk: nothing was written
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

export interface DuplicateTrack {
  id: number; title: string | null; artist: string | null; album: string | null; path: string; directory: string
  format: string; bitrate: number | null; sample_rate: number | null; size: number | null; duration: number | null
  read_only: boolean
}
export interface DuplicateGroup { tracks: DuplicateTrack[] }   // keeper first

export interface AlbumRow {
  album: string; directory: string; tracks: number; expected: number | null; discs: number
  album_artist: string | null; artist: string | null; year: string | null; genre: string | null
  format: string | null; bitrate: number | null; cover_track_id: number; mixed: string[]
  values: Record<string, string[]>     // distinct values of each mixed field, most common first
  ids: number[]                        // its tracks (none when read-only)
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
  layout_libraries: string[]
  library_templates: Record<string, string>
  lyrics_groups: LyricsGroup[]
  library_lyrics_groups: Record<string, string>
  lrclib_api_key: string
  lrclib_app_id: string
  cover_target: 'folder' | 'tracks' | 'both'
  cover_embed_size: number
  cover_folder_size: number
  secrets_set?: Record<string, boolean>   // keys/tokens are never sent back, only whether set
  secrets_encrypted?: boolean
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
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
  started_at: number | null
  finished_at: number | null
  total: number
  scanned: number
  error: string | null
  directory?: string | null          // null = whole library
  phase?: string | null              // listing | reading | pruning
  changed?: number | null
  kind?: 'scan' | 'lyrics' | 'fingerprint'
}

export interface About {
  version: string; image: string | null; commit: string | null; built: string | null; started: number
  python: string; mutagen: string; tools: Record<string, boolean>; tracks: number; staged: number
  scan_dirs: string[]; source: string
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
  duplicate_albums: number
  missing_files: number
  not_in_layout: number
  missing_lyrics: number
  covers_none: number
  covers_no_folder: number
  covers_no_tracks: number
  covers_both: number
  covers_oversized: number
}

export type CoverAction = 'copy_to_folder' | 'move_to_folder' | 'copy_to_tracks' | 'move_to_tracks' | 'delete_folder' | 'delete_tracks' | 'shrink'
export interface CoverAlbum { directory: string; track_ids: number[]; embedded: number; folder: boolean }
export interface CoverResult { directory: string; folder: number; tracks: number; note: string | null; errors: { id: number | null; error: string }[] }

export interface TreeEntry {
  name: string
  path: string
  has_dirs?: boolean
}

export interface MbCandidate {
  mb_album_id: string; album: string; artist: string | null; date: string | null; country: string | null
  formats: string[]; discs: number | null; tracks: number | null; type: string | null; score: number; tagged?: boolean
}

export interface MbReleaseTrack {
  key: string; disc: number; position: number; number: string | null; title: string; artist: string | null
  mb_artist_id: string | null; mb_track_id: string | null; duration: number | null
}

export interface MbMatch {
  release: { mb_album_id: string; album: string; album_artist: string | null; date: string | null
             year: string | null; original_year: string | null; country: string | null; discs: number }
  release_tracks: MbReleaseTrack[]
  items: { id: number; filename: string; title: string | null; artist: string | null; track_number: string | null
           disc_number: string | null; duration: number | null; key: string | null; score: number
           title_similarity: number | null }[]
  unmatched: string[]
}

export interface LyricsItem {
  id: number; title: string; artist: string | null; status: string; lyrics: string | null; error?: string
  group?: string; query?: LyricsQuery | null
}

export interface LyricsQuery { title: string; artist: string; album: string }
export interface LyricsGroup { id: string; name: string; skip: boolean; queries: LyricsQuery[]; layout?: string; assigned?: number }
export interface LyricsHit {
  id: number; title: string; artist: string; album: string | null; duration: number | null
  synced: string | null; plain: string | null; instrumental: boolean
}
export interface LyricsPlan {
  track: { id: number; title: string | null; artist: string | null; album: string | null; album_artist: string | null
           duration: number | null; lyrics: string | null }
  group: { id: string; name: string; skip: boolean }
  queries: LyricsQuery[]
  last: { status: string; at: number } | null
}

export interface MergeGroup {
  key: string; directory: string; album: string; album_artist: string; tracks: number
  artists: string[]; year: string; discs: number[]; new_discs: string[]
}

export interface MergeAlbumsRequest {
  track_ids: number[]; target: string | null; order: string[]; preview: boolean
  album: string; album_artist: string; year: string; discs: 'keep' | 'per_album'; move: boolean
}

export interface LibraryInfo {
  path: string; name: string; parent: string; active: boolean; writable: boolean; tracks: number
  layout: boolean                    // checked against a layout (Quality → Not in layout)
  template: string                   // its own layout ('' = the standard one)
  lyrics_group: string               // its default lyrics group ('' = Standard)
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

/**
 * Behind an auth proxy (Pomerium), an expired session answers every API call
 * with a redirect to the sign-in page. fetch can't follow that cross-origin,
 * so without this each call -- and every 1-2 s poll -- fails as "Failed to
 * fetch". `redirect: 'manual'` turns it into a detectable opaqueredirect: we
 * stop calling the API and show one "sign in again" banner instead.
 */
export class SessionExpired extends Error {
  constructor() { super('Your sign-in has expired') }
}
export let sessionExpired = false
let sessionExpiredHandler: (() => void) | null = null
export function onSessionExpired(fn: () => void) { sessionExpiredHandler = fn }

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (sessionExpired) throw new SessionExpired()
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  if (res.type === 'opaqueredirect') {
    if (!sessionExpired) { sessionExpired = true; sessionExpiredHandler?.() }
    throw new SessionExpired()
  }
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
      request<{ count: number; values: Record<string, string>; mixed: string[]; read_only: number }>(
        'POST', '/api/library/summary', { track_ids: ids }),
    search: (q: string, limit = 50, offset = 0) =>
      request<TrackList>('GET', `/api/library/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
    track: (id: number) => request<Track>('GET', `/api/library/track/${id}`),
    issues: () => request<IssueCount>('GET', '/api/library/issues'),
    dead: () => request<TrackList>('GET', '/api/library/dead'),
    removeTracks: (ids: number[]) => request<{ removed: number }>('POST', '/api/library/remove', ids),
    deleteFiles: (ids: number[]) => request<{ deleted: number }>('POST', '/api/library/delete-files', ids),
    artists: () => request<Artist[]>('GET', '/api/library/artists'),
    valueCounts: (ids: number[], field: string) =>
      request<{ count: number; values: { value: string; tracks: number }[] }>(
        'POST', '/api/library/value-counts', { track_ids: ids, field }),
    tagValues: (field: string) =>
      request<TagValue[]>('GET', `/api/library/tag-values?field=${encodeURIComponent(field)}`),
    albumList: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return request<AlbumRow[]>('GET', `/api/library/album-list${qs ? '?' + qs : ''}`)
    },
    albums: (artist?: string) =>
      request<Album[]>('GET', `/api/library/albums${artist ? '?artist=' + encodeURIComponent(artist) : ''}`),
    exportM3uUrl: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return `/api/library/export.m3u${qs ? '?' + qs : ''}`
    },
    history: (limit = 50) => request<ChangeLogEntry[]>('GET', `/api/library/history?limit=${limit}`),
    undo: (id: number) => request<{ restored: number; kind: string; errors: WriteError[] }>('POST', `/api/library/history/${id}/undo`),
    duplicates: () => request<{ total: number; groups: DuplicateGroup[] }>('GET', '/api/library/duplicates'),
    fingerprints: () => request<{ tracks: number; fingerprinted: number; available: boolean }>('GET', '/api/library/fingerprints'),
    fingerprintAll: () => request<{ job_id: string | null; tracks: number }>('POST', '/api/library/fingerprints'),
    trashInfo: () => request<{ count: number; bytes: number }>('GET', '/api/library/trash'),
    emptyTrash: () => request<{ removed: number; bytes: number }>('POST', '/api/library/trash/empty'),
  },

  tags: {
    update: (trackId: number, tags: TagUpdate) =>
      request<EditResult>('PATCH', `/api/tags/${trackId}`, tags),
    bulk: (trackIds: number[], tags: TagUpdate) =>
      request<EditResult>('POST', '/api/tags/bulk', { track_ids: trackIds, tags }),
    separators: (field: string, trackIds: number[] | null) =>
      request<{ separators: { sep: string; tracks: number; values: { value: string; tracks: number }[] }[] }>(
        'POST', '/api/tags/separators', { field, track_ids: trackIds }),
    standardize: (body: { field: string; track_ids: number[] | null; separators: string[]; keep: string[]; preview: boolean }) =>
      request<EditResult & { tracks: number; changes: { old: string; new: string; tracks: number }[] }>(
        'POST', '/api/tags/standardize', body),
    parsePreview: (trackIds: number[], pattern: string) =>
      request<{ total: number; matched: number; changing: number;
                items: { id: number; path: string; matched: boolean; tags: Record<string, string>; changes: Record<string, string> }[] }>(
        'POST', '/api/tags/parse-preview', { track_ids: trackIds, pattern }),
    parseNames: (trackIds: number[], pattern: string, exclude: number[]) =>
      request<EditResult & { changed: number }>('POST', '/api/tags/parse', { track_ids: trackIds, pattern, exclude }),
    mergeAlbums: (body: MergeAlbumsRequest) =>
      request<EditResult & { groups: MergeGroup[]; target: string; tracks: number; moves: number;
                             clashes: { id: number; filename: string; error: string }[] }>(
        'POST', '/api/tags/merge-albums', body),
    editValues: (trackIds: number[], field: string, add: string[], remove: string[]) =>
      request<EditResult & { changed: number }>('POST', '/api/tags/values', { track_ids: trackIds, field, add, remove }),
    replaygain: (trackIds: number[], albumMode = false) =>
      request<{ ok: boolean; tool: string | null; processed: number; error?: string }>(
        'POST', '/api/tags/replaygain', { track_ids: trackIds, album_mode: albumMode }),
    replaygainStatus: () =>
      request<{ available: boolean; tool: string | null }>('GET', '/api/tags/replaygain/status'),
    renamePreview: (req: BulkRenameRequest) =>
      request<{ items: RenameItem[]; counts: Record<string, number> }>('POST', '/api/tags/rename-preview', req),
    rename: (req: BulkRenameRequest & { exclude: number[] }) =>
      request<{ planned: number; skipped: number; staged: boolean; moved: number; errors: WriteError[] }>(
        'POST', '/api/tags/rename', req),
    refile: (trackIds: number[]) =>
      request<{ planned: number; moved: number; staged: boolean; errors: WriteError[]; missing?: number }>(
        'POST', '/api/tags/reorganize', { track_ids: trackIds }),
    moveTo: (trackIds: number[], folder: string) =>
      request<{ planned: number; moved: number; staged: boolean; errors: WriteError[]; missing?: number }>(
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
      request<{ applied: number; folders?: number; errors: WriteError[]; missing?: number; change_id: number | null }>(
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
    cancel: (jobId: string) => request<{ cancelling: boolean }>('POST', `/api/jobs/${jobId}/cancel`),
  },

  about: () => request<About>('GET', '/api/about'),

  fs: {
    tree: (path?: string) =>
      request<TreeResult>('GET', `/api/fs/tree${path ? '?path=' + encodeURIComponent(path) : ''}`),
    move: (src: string, dst: string) => request<EditResult>('POST', '/api/fs/move', { src, dst }),
    rename: (path: string, name: string) => request<EditResult>('POST', '/api/fs/rename', { path, name }),
  },

  settings: {
    get: () => request<AppSettings>('GET', '/api/config'),
    libraries: () => request<LibraryInfo[]>('GET', '/api/config/libraries'),
    testSource: (source: string, value: string, app_id?: string) =>
      request<{ ok: boolean; message: string }>('POST', `/api/config/test/${source}`, { value, app_id }),
    setLibrary: (path: string, active: boolean) =>
      request<{ active: boolean; removed?: number; job_id?: string | null }>('POST', '/api/config/libraries', { path, active }),
    update: (s: Partial<AppSettings>) => request<AppSettings>('PATCH', '/api/config', s),
    renamePreview: (template: string, tags?: Record<string, string>, ext?: string, trackId?: number) =>
      request<{ ok: boolean; preview?: string; path?: string; error?: string }>(
        'POST', '/api/config/rename-preview', { template, tags, ext, track_id: trackId }),
  },

  lyrics: {
    fetch: (trackIds: number[], prefer: string, overwrite: boolean, query: LyricsQuery | null = null) =>
      request<{ items: LyricsItem[]; common: Record<keyof LyricsQuery, string | null> }>(
        'POST', '/api/lyrics/fetch', { track_ids: trackIds, prefer, overwrite, query }),
    stage: (items: Record<number, string>) =>
      request<EditResult & { changed: number }>('POST', '/api/lyrics/stage', { items }),
    groups: () => request<LyricsGroup[]>('GET', '/api/lyrics/groups'),
    assign: (trackIds: number[], groupId: string | null) =>
      request<{ assigned: number }>('POST', '/api/lyrics/assign', { track_ids: trackIds, group_id: groupId }),
    assigned: (trackIds: number[]) =>
      request<{ group_id: string | null }>('POST', '/api/lyrics/assigned', { track_ids: trackIds }),
    plan: (trackId: number) => request<LyricsPlan>('GET', `/api/lyrics/plan/${trackId}`),
    search: (q: { title?: string; artist?: string; album?: string; q?: string }) =>
      request<{ hits: LyricsHit[] }>('POST', '/api/lyrics/search', q),
    lookup: (opts: { track_ids?: number[] | null; prefer?: string; retry?: boolean; instrumental_to_none?: boolean }) =>
      request<{ job_id: string | null; tracks: number }>('POST', '/api/lyrics/lookup', opts),
  },

  lookup: {
    albumSearch: (trackIds: number[], album?: string, artist?: string, by: 'album' | 'artist' | 'track' = 'album', track?: string,
                  source: 'auto' | 'names' | 'tags' = 'auto') =>
      request<{ album: string | null; artist: string | null; track?: string; by: string; local_tracks: number; candidates: MbCandidate[] }>(
        'POST', '/api/lookup/album/search', { track_ids: trackIds, album, artist, by, track, source }),
    albumScore: (trackIds: number[], mbAlbumId: string) =>
      request<{ mb_album_id: string; quality: number; matched: number; local: number; release_tracks: number }>(
        'POST', '/api/lookup/album/score', { track_ids: trackIds, mb_album_id: mbAlbumId }),
    albumMatch: (trackIds: number[], mbAlbumId: string) =>
      request<MbMatch>('POST', '/api/lookup/album/match', { track_ids: trackIds, mb_album_id: mbAlbumId }),
    albumApply: (body: { mb_album_id: string; pairs: Record<number, string>; fields: string[]; original_year: boolean; cover: boolean }) =>
      request<EditResult & { changed: number; covers: number; folder_covers: number }>('POST', '/api/lookup/album/apply', body),
    search: (trackId: number) =>
      request<LookupResult[]>('POST', `/api/lookup/search/${trackId}`),
    infer: (trackId: number) =>
      request<LookupResult | null>('POST', `/api/lookup/infer/${trackId}`),
    releases: (mbTrackId: string) =>
      request<MbRelease[]>('GET', `/api/lookup/releases/${encodeURIComponent(mbTrackId)}`),
    status: () =>
      request<{ fpcalc_installed: boolean; acoustid_configured: boolean; fpcalc_available: boolean; method: string }>(
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
    plan: (trackIds: number[]) =>
      request<{ albums: CoverAlbum[] }>('POST', '/api/covers/albums', { track_ids: trackIds, dry_run: true }),
    albums: (trackIds: number[], action: CoverAction) =>
      request<{ albums: CoverResult[] }>('POST', '/api/covers/albums', { track_ids: trackIds, action }),
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
