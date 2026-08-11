import { Track } from './api'
import { state } from './state'
import { esc, fmtDuration } from './util'

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
  { key: 'format',       label: 'Format',       cls: 'col-format', render: t => t.format.toUpperCase() },
  { key: 'duration',     label: 'Duration',     cls: 'col-dur',    render: t => fmtDuration(t.duration) },
  { key: 'source',       label: 'Source Folder', cls: 'col-source', render: t => {
    const match = state.musicDirs.find(d => t.directory === d || t.directory.startsWith(d + '/'))
    const dir = match ?? t.directory
    return esc(dir.split('/').filter(Boolean).pop() ?? dir)
  }},
]
