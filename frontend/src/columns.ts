import { Track } from './api'
import { state, loadColOrder } from './state'
import { esc, fmtDuration, fmtBitrate, fmtSampleRate, fmtChannels } from './util'

const fmtBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`

export interface ColDef {
  key:    string
  label:  string
  cls:    string
  render: (t: Track) => string
}

export const COL_DEFS: ColDef[] = [
  { key: 'quality',      label: 'Quality',      cls: 'col-quality', render: () => '' },
  { key: 'title',        label: 'Title',        cls: 'col-title',  render: t =>
    `<span title="${esc(t.path)}">${t.missing ? '<span class="missing-mark" title="File not found on disk — moved or deleted since the last scan">⚠</span> ' : ''}${esc(t.title || t.filename)}</span>` },
  { key: 'artist',       label: 'Artist',       cls: 'col-artist', render: t => t.artist       ? `<span class="tag-link" data-artist="${esc(t.artist)}">${esc(t.artist)}</span>` : '' },
  { key: 'album',        label: 'Album',        cls: 'col-album',  render: t => t.album        ? `<span class="tag-link" data-artist="${esc(t.artist||'')}" data-album="${esc(t.album)}">${esc(t.album)}</span>` : '' },
  { key: 'album_artist', label: 'Album Artist', cls: 'col-aa',     render: t => t.album_artist ? `<span class="tag-link" data-artist="${esc(t.album_artist)}">${esc(t.album_artist)}</span>` : '' },
  { key: 'year',         label: 'Year',         cls: 'col-year',   render: t => esc(t.year || '') },
  { key: 'track_number', label: 'Track #',      cls: 'col-num',    render: t => esc(t.track_number || '') },
  { key: 'disc_number',  label: 'Disc #',       cls: 'col-disc',   render: t => esc(t.disc_number || '') },
  { key: 'genre',        label: 'Genre',        cls: 'col-genre',  render: t => esc(t.genre || '') },
  { key: 'composer',     label: 'Composer',     cls: 'col-composer', render: t => esc(t.composer || '') },
  { key: 'bpm',          label: 'BPM',          cls: 'col-bpm',    render: t => esc(t.bpm || '') },
  { key: 'format',       label: 'Format',       cls: 'col-format', render: t => t.format.toUpperCase() },
  { key: 'bitrate',      label: 'Bitrate',      cls: 'col-bitrate', render: t => fmtBitrate(t.bitrate) },
  { key: 'sample_rate',  label: 'Sample Rate',  cls: 'col-srate',  render: t => fmtSampleRate(t.sample_rate) },
  { key: 'channels',     label: 'Channels',     cls: 'col-chan',   render: t => fmtChannels(t.channels) },
  { key: 'duration',     label: 'Duration',     cls: 'col-dur',    render: t => fmtDuration(t.duration) },
  { key: 'has_lyrics',   label: 'Lyrics',       cls: 'col-lyrics', render: t => {
    const k = lyricsKind(t.lyrics)
    return k === 'none' ? '' : `<span class="mb-score ${k === 'synced' ? 'mb-good' : 'mb-ok'}">${k}</span>`
  }},
  { key: 'cover',        label: 'Cover',        cls: 'col-cover', render: t => !t.has_cover ? '' :
    `<span title="Embedded cover art">${t.cover_width ? `${t.cover_width}×${t.cover_height}` : '?'}${t.cover_bytes ? ` · ${fmtBytes(t.cover_bytes)}` : ''}</span>` },
  { key: 'source',       label: 'Source Folder', cls: 'col-source', render: t =>
    `<span title="${esc(t.directory)}">${t.read_only ? '🔒 ' : ''}${esc(sourcePath(t.directory))}</span>` },
]

export function lyricsKind(text: string | null | undefined): 'synced' | 'plain' | 'none' {
  if (!text?.trim()) return 'none'
  return /\[\d\d:\d\d/.test(text) ? 'synced' : 'plain'
}

/** Columns a Quality view adds after the user's own, always shown there: what the view is about. */
export function viewCols(): ColDef[] {
  if (state.selectedIssue === 'missing_lyrics') return [{ key: 'lookup', label: 'Lookup', cls: 'col-view', render: t => {
    const lk = t.lyrics_lookup
    const text = `♪ ${t.lyrics_group ?? ''}${lk ? ` · ${LOOKUP_TEXT[lk.status] ?? lk.status} ${new Date(lk.at * 1000).toLocaleDateString()}` : ''}`
    return `<div class="view-cell"><button type="button" class="btn btn-link btn-sm" data-lyrics-search="${t.id}" title="Search LRCLIB for this track by hand">Search…</button>
      <span class="view-text" title="${esc(text)}">${esc(text)}</span></div>`
  }}]
  if (state.selectedIssue === 'not_in_layout') return [{ key: 'layout', label: 'Layout puts it at', cls: 'col-view', render: t =>
    t.layout_path ? `<span class="layout-path" data-diff-from="${esc(sourcePath(t.path))}" data-diff-to="${esc(sourcePath(t.layout_path))}">→ ${esc(sourcePath(t.layout_path))}</span>` : '' }]
  return []
}

const LOOKUP_TEXT: Record<string, string> = {
  missing: 'not found', instrumental: 'instrumental', untagged: 'needs title + artist', error: 'lookup failed',
  synced: 'found (staged)', plain: 'found (staged)', has_plain: 'plain only',
}

/**
 * The folder from the library's name down to the album: with roots
 * /music/Shared and /music/Libraries/*, ".../Libraries/Music - Christmas/A/B"
 * -> "Music - Christmas/A/B". Outside every root: relative to the music dir.
 */
export function sourcePath(dir: string): string {
  let best = ''
  for (const r of state.libraryRoots) {
    if ((dir === r || dir.startsWith(r + '/')) && r.length > best.length) best = r
  }
  const base = best ? best.slice(0, best.lastIndexOf('/'))
    : state.musicDirs.find(d => dir === d || dir.startsWith(d + '/')) ?? ''
  return base && dir.startsWith(base + '/') ? dir.slice(base.length + 1) : dir
}

/** COL_DEFS in the user's order (dragged headers); new columns keep their default spot at the end. */
export function orderedCols(): ColDef[] {
  const order = loadColOrder()
  const pos = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length + COL_DEFS.findIndex(c => c.key === k) : i }
  return [...COL_DEFS].sort((a, b) => pos(a.key) - pos(b.key))
}
