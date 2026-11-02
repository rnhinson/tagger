import { Track, Artist, Album, ScanJob, LookupResult, IssueCount, TagValue } from './api'

export const PAGE_SIZE = 100
export const DEFAULT_COLS = ['quality', 'title', 'artist', 'album', 'year', 'track_number', 'format', 'duration']
const COLS_KEY = 'tagger_visible_cols'

export function loadColPrefs(): Set<string> {
  try {
    const saved = localStorage.getItem(COLS_KEY)
    if (saved) return new Set(JSON.parse(saved))
  } catch { /* ignore */ }
  return new Set(DEFAULT_COLS)
}

const WIDTHS_KEY = 'tagger_col_widths'

/** Column widths (px) the user dragged; empty = the stylesheet's defaults. */
export function loadColWidths(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(WIDTHS_KEY) || '{}') } catch { return {} }
}

export function saveColWidths(w: Record<string, number>): void {
  try {
    if (Object.keys(w).length) localStorage.setItem(WIDTHS_KEY, JSON.stringify(w))
    else localStorage.removeItem(WIDTHS_KEY)
  } catch { /* storage blocked */ }
}

export function saveColPrefs(cols: Set<string>): void {
  localStorage.setItem(COLS_KEY, JSON.stringify([...cols]))
}

export type TagField = 'title' | 'artist' | 'album' | 'album_artist' | 'year' | 'track_number' | 'disc_number' | 'genre' | 'comment' | 'composer' | 'bpm' | 'lyrics'

// Text/textarea fields driven by the generic form loop. `compilation` is a
// boolean checkbox handled separately in populateForm/saveTags.
export const TAG_FIELDS: TagField[] = [
  'title', 'artist', 'album', 'album_artist', 'year',
  'track_number', 'disc_number', 'genre', 'comment', 'composer', 'bpm', 'lyrics',
]

// Tags the Tags panel browses by, in order. Artist values open to their albums.
export const BROWSE_TAGS: { field: string; label: string }[] = [
  { field: 'artist',       label: 'Artist' },
  { field: 'album_artist', label: 'Album Artist' },
  { field: 'album',        label: 'Album' },
  { field: 'genre',        label: 'Genre' },
  { field: 'year',         label: 'Year' },
  { field: 'composer',     label: 'Composer' },
]

export interface DirNode {
  name:     string
  path:     string
  hasDirs?: boolean   // false = known to have no subfolders (no arrow)
  children: DirNode[] | null
  loading:  boolean
  expanded: boolean
}

export interface State {
  // sidebar
  sidebarMode:       'tags' | 'files' | 'quality'
  // tags panel
  artists:           Artist[]
  albumsByArtist:    Map<string, Album[]>
  selectedArtist:    string | null
  selectedAlbum:     string | null
  expandedArtists:   Set<string>
  // tag tree: which tags are open, their values (loaded on open), and a
  // selected value for any tag other than artist (artist uses selectedArtist)
  expandedTags:      Set<string>
  tagValues:         Map<string, TagValue[]>
  selectedTag:       { field: string; value: string } | null
  // files panel
  rootNode:          DirNode | null
  selectedDirectory: string | null
  // track list
  tracks:            Track[]
  total:             number
  selectedIds:       Set<number>
  query:             string
  // scan
  scanJob:           ScanJob | null
  scanPollTimer:     ReturnType<typeof setInterval> | null
  // columns
  visibleCols:       Set<string>
  colPickerOpen:     boolean
  // view
  viewMode:          'list' | 'albums'
  // quality panel
  qualityIssues:     IssueCount | null
  selectedIssue:     string | null
  // pending cover from lookup
  pendingCoverAlbumId: string | null
  // pending MB IDs from lookup result (written on save)
  pendingLookupResult: LookupResult | null
  // incremented after every cover write to bust browser cache
  coverBust: number
  // sorting
  sortKey:           string | null
  sortDir:           'asc' | 'desc'
  // filters
  filterFormat:      string
  filterQuality:     string
  // configured music dirs (for source column) and library roots (folder moves)
  musicDirs:         string[]
  libraryRoots:      string[]
  // pagination
  page:              number
}

export const state: State = {
  sidebarMode:       'tags',
  artists:           [],
  albumsByArtist:    new Map(),
  selectedArtist:    null,
  selectedAlbum:     null,
  expandedArtists:   new Set(),
  expandedTags:      new Set(['artist']),
  tagValues:         new Map(),
  selectedTag:       null,
  rootNode:          null,
  selectedDirectory: null,
  tracks:            [],
  total:             0,
  selectedIds:       new Set(),
  query:             '',
  scanJob:           null,
  scanPollTimer:     null,
  visibleCols:       loadColPrefs(),
  colPickerOpen:     false,
  viewMode:          'list',
  qualityIssues:     null,
  selectedIssue:     null,
  pendingCoverAlbumId: null,
  pendingLookupResult: null,
  coverBust: 0,
  sortKey:           null,
  sortDir:           'asc',
  filterFormat:      '',
  filterQuality:     '',
  musicDirs:         [],
  libraryRoots:      [],
  page:              0,
}
