import { Track } from './api'
import { state } from './state'
import { esc, fmtDuration, fmtBitrate, fmtSampleRate, fmtChannels } from './util'

export interface ColDef {
  key:    string
  label:  string
  cls:    string
  render: (t: Track) => string
}

export const COL_DEFS: ColDef[] = [
  { key: 'quality',      label: 'Quality',      cls: 'col-quality', render: () => '' },
  { key: 'title',        label: 'Title',        cls: 'col-title',  render: t => esc(t.title || t.filename) },
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
  { key: 'source',       label: 'Source Folder', cls: 'col-source', render: t => {
    const rel = sourcePath(t.directory)
    return `<span title="${esc(t.directory)}">${t.read_only ? '🔒 ' : ''}${esc(rel)}</span>`
  }},
]

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
