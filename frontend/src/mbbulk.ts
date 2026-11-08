// Match albums: more than one album folder selected. Each folder gets its best
// MusicBrainz release (searched by its tags, else its folder names; the top
// few scored track by track) and the album-level tags it would get are listed
// for approval. Review… opens the full Match album for one folder (titles,
// numbers, pairing). Staged per album, like any edit; the release's cover art
// (or one picked by hand) is written now, where Settings → Cover Art says.
// Backend: /api/lookup/album/*, /api/covers/set.
import { api, CoverAlbum, MbMatch } from './api'
import { caa, hasArt, openChangeCover, CoverSrc } from './covers'
import { toast } from './toast'
import { esc } from './util'
import { errText, shortPath } from './staged'
import { openMbAlbum, KEEP } from './mbalbum'

const TRIES = 4           // candidates scored per album
const GOOD = 0.8          // share of your tracks paired with the release (titles agree) at or above: ticked

const FIELDS: { key: string; label: string }[] = [
  { key: 'album', label: 'Album' }, { key: 'album_artist', label: 'Album artist' }, { key: 'year', label: 'Year' },
  { key: 'genre', label: 'Genre' }, { key: 'composer', label: 'Composer' }, { key: 'mb', label: 'MusicBrainz IDs' },
]
const TAG_KEYS = FIELDS.map(f => f.key)
const splitGenres = (g: string | null | undefined) => (g ?? '').split(';').map(x => x.trim()).filter(Boolean)
const MB_IDS = ['mb_track_id', 'mb_artist_id', 'mb_album_id', 'mb_album_artist_id']

interface Row {
  a: CoverAlbum
  status: 'waiting' | 'searching' | 'found' | 'none' | 'error' | 'staged'
  match: MbMatch | null
  quality: number
  paired: number           // share of the folder's tracks paired with a release track
  on: boolean
  off: Set<string>         // tags left out for this album (the switches above still apply to all)
  offGenres: Set<string>   // single genres left out
  cover: { src: CoverSrc; preview: string; label: string } | null
  coverCheck: 'waiting' | 'checking' | 'done'
  note: string
}

export function openMbAlbums(albums: CoverAlbum[], onDone: () => Promise<void>) {
  const rows: Row[] = albums.map(a => ({ a, status: 'waiting', match: null, quality: 0, paired: 0, on: false, off: new Set(), offGenres: new Set(),
    cover: null, coverCheck: 'waiting', note: '' }))
  let closed = false, busy = false, staged = false
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal bc-modal mbb-modal" role="dialog" aria-label="Match albums on MusicBrainz">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Match albums on MusicBrainz · ${albums.length} albums</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-options mbb-fields" id="mbb-fields">
        ${FIELDS.map(f => `<label class="settings-toggle"><input type="checkbox" data-field="${f.key}" checked /><span>${f.label}</span></label>`).join('')}
        <label class="settings-toggle"><input type="checkbox" id="mbb-orig" checked /><span>Original year</span></label>
        <label class="settings-toggle" title="Off: replace the genre and composer tracks already have"><input type="checkbox" id="mbb-keep" checked /><span>Keep existing genre &amp; composer</span></label>
        <label class="settings-toggle" title="Written now, not staged; ticked per album only where it has no cover yet"><input type="checkbox" data-field="cover" checked /><span>Cover art</span></label>
      </div>
      <div class="bc-body"><table class="track-table bc-table mbb-table"><thead><tr>
        <th class="bc-check"><input type="checkbox" id="mbb-all" title="All found matches" /></th><th>Now</th><th>MusicBrainz</th><th></th>
      </tr></thead><tbody></tbody></table></div>
      <div class="settings-hint bc-where" id="mbb-hint">Click a tag (or one genre, or the cover) to leave it out for that album. Album-level tags only (composer goes to the tracks that pair with the release); titles and track numbers: Review… one album.</div>
      <div class="fix-confirm-footer">
        <span id="mbb-sum" class="ma-dim bc-sum"></span>
        <button class="btn btn-ghost" id="mbb-cancel">Cancel</button>
        <button class="btn btn-primary" id="mbb-go" disabled>Stage</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const tbody = $('tbody'), goBtn = $<HTMLButtonElement>('#mbb-go'), sumEl = $('#mbb-sum'), allEl = $<HTMLInputElement>('#mbb-all')
  const origEl = $<HTMLInputElement>('#mbb-orig')
  const fieldOn = (f: string) => overlay.querySelector<HTMLInputElement>(`#mbb-fields input[data-field="${f}"]`)!.checked

  const close = async () => {
    if (busy) return
    closed = true
    for (const r of rows) if (r.cover?.src.file) URL.revokeObjectURL(r.cover.preview)
    overlay.remove(); document.removeEventListener('keydown', onKey)
    if (staged) await onDone()
  }
  // Escape closes the topmost dialog only (Review… sits above this one).
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.body.lastElementChild === overlay) close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#mbb-cancel').addEventListener('click', close)

  const usable = (r: Row) => !!r.match && r.status === 'found'

  // What a row would write: its tag fields, its genres, its cover.
  const tagFields = (r: Row) => TAG_KEYS.filter(f => fieldOn(f) && !r.off.has(f)
    && (f !== 'genre' || splitGenres(r.match?.release.genre).some(g => !r.offGenres.has(g))))
  const coverOn = (r: Row) => !!r.cover && fieldOn('cover') && !r.off.has('cover')
  const anything = (r: Row) => tagFields(r).length > 0 || coverOn(r)

  function renderRow(i: number) {
    const r = rows[i], a = r.a, m = r.match
    const tr = tbody.querySelector<HTMLElement>(`tr[data-i="${i}"]`) ?? tbody.appendChild(document.createElement('tr'))
    tr.dataset.i = String(i)
    const cur = m?.current ?? { album: a.album, album_artist: a.artist, year: null, genre: null }
    const now = [cur.album || '(no album)', cur.album_artist, cur.year, cur.genre].filter(Boolean)
    const hasCover = a.folder || a.embedded > 0
    let theirs = ''
    if (m) {
      const rel = m.release
      const year = (origEl.checked ? rel.original_year : null) || rel.year
      // Each tag is a chip: click to leave it out for this album. A value that
      // would change is highlighted (genre: only where the tracks have none, when kept).
      const keeping = $<HTMLInputElement>('#mbb-keep').checked
      const chip = (f: string, v: string | null | undefined, had: string | null | undefined, title: string, value?: string) => {
        if (!v) return ''
        const kept = keeping && f === 'genre' && !!had
        const off = !fieldOn(f) || r.off.has(f) || (value !== undefined && r.offGenres.has(value))
        const cls = off || kept ? 'mbb-off' : had !== undefined && v === had ? '' : 'mbb-new'
        const why = !fieldOn(f) ? 'Off for every album (the switches above)' : kept ? 'Kept: the tracks already have a genre'
          : `${title} — click to ${off ? 'include it' : 'leave it out'} for this album`
        return `<button type="button" class="mbb-chip ${cls}" data-chip="${f}" ${value !== undefined ? `data-value="${esc(value)}"` : ''}
          title="${esc(why)}" ${fieldOn(f) && !busy && !kept ? '' : 'disabled'}>${esc(v)}</button>`
      }
      const genres = splitGenres(rel.genre)
      const curGenres = new Set(splitGenres(cur.genre).map(g => g.toLowerCase()))
      const genreChips = genres.map(g => chip('genre', g, cur.genre ? (curGenres.has(g.toLowerCase()) ? g : cur.genre) : null, 'Genre', g)).join('')
      const paired = m.items.filter(it => it.key)
      const writers = new Set(paired.map(it => m.release_tracks.find(t => t.key === it.key)?.composer).filter(Boolean))
      const matched = paired.length
      const coverCell = r.cover
        ? `<button type="button" class="mbb-cover ${coverOn(r) ? '' : 'mbb-cover-off'}" data-chip="cover" ${fieldOn('cover') && !busy ? '' : 'disabled'}
             title="${esc(`${r.cover.label}${hasCover ? ' · this album already has a cover' : ''} — click to ${coverOn(r) ? 'leave it out' : 'write it'}`)}"><img src="${esc(r.cover.preview)}" alt="" /></button>`
        : `<span class="mbb-cover mbb-cover-none">${r.coverCheck === 'done' ? 'no art' : '…'}</span>`
      theirs = `<div class="mbb-theirs">${coverCell}<div>
        <div class="mbb-chips">${[chip('album', rel.album, cur.album, 'Album'), chip('album_artist', rel.album_artist, cur.album_artist, 'Album artist'),
                        chip('year', year, cur.year, 'Year'), genreChips || '<span class="ma-dim">no genre</span>',
                        chip('composer', writers.size ? `✎ ${[...writers].slice(0, 2).join(', ')}${writers.size > 2 ? ` +${writers.size - 2}` : ''}` : '', undefined, 'Composers of the paired tracks'),
                        chip('mb', 'MB IDs', undefined, 'MusicBrainz IDs')]
                       .filter(Boolean).join('')}</div>
        <div class="ma-dim bc-folder">${[rel.date, rel.country, `${m.release_tracks.length} tracks`].filter(Boolean).map(x => esc(String(x))).join(' · ')}
          · <span class="mb-score ${r.paired >= GOOD ? 'mb-good' : r.paired >= 0.5 ? 'mb-ok' : 'mb-bad'}" title="Your tracks whose title (or number and length) pairs with one of its tracks · overall fit ${Math.round(r.quality * 100)}%">${matched} of your ${m.items.length} tracks on it</span>
          ${r.paired < GOOD ? ' — weak match, check it' : ''}</div></div></div>`
    }
    const status = {
      waiting: '<span class="ma-dim">Waiting…</span>', searching: '<span class="ma-dim">Searching…</span>',
      none: '<span class="ma-dim">No release found — Review… to search by hand</span>',
      error: `<span class="review-error">${esc(r.note)}</span>`, found: '', staged: '',
    }[r.status]
    tr.innerHTML = `
      <td class="bc-check"><input type="checkbox" ${r.on ? 'checked' : ''} ${usable(r) ? '' : 'disabled'} /></td>
      <td class="bc-album"><div class="mbb-theirs"><img class="mbb-cover" src="/api/covers/${a.track_ids[0]}" alt="" onerror="this.style.visibility='hidden'" />
        <div><div>${now.map(x => esc(String(x))).join(' · ')}</div>
        <div class="ma-dim bc-folder" title="${esc(a.directory)}">${esc(shortPath(a.directory))} · ${a.track_ids.length} track${a.track_ids.length !== 1 ? 's' : ''}</div></div></div></td>
      <td class="bc-album">${theirs}${status ? `<div>${status}</div>` : ''}${r.status === 'staged' ? `<div class="bc-done">✓ ${esc(r.note || 'Staged')}</div>` : ''}</td>
      <td class="mbb-actions"><button type="button" class="btn btn-ghost btn-sm" data-review ${r.status === 'staged' || busy ? 'disabled' : ''}>Review…</button>
        ${usable(r) ? `<button type="button" class="btn btn-ghost btn-sm" data-pick-cover ${busy ? 'disabled' : ''} title="Another cover: search MusicBrainz, a URL or a file">Cover…</button>` : ''}</td>`
  }
  function summary() {
    const n = rows.filter(r => r.on && usable(r) && anything(r)).length
    const pending = rows.filter(r => r.status === 'waiting' || r.status === 'searching').length
    sumEl.textContent = (pending ? `Searching… ${rows.length - pending} of ${rows.length} done · ` : '') + `${n} album${n !== 1 ? 's' : ''} to stage`
    goBtn.disabled = busy || !n
    goBtn.textContent = n ? `Stage ${n} album${n !== 1 ? 's' : ''}` : 'Stage'
    const can = rows.filter(usable)
    allEl.checked = can.length > 0 && can.every(r => r.on)
    allEl.indeterminate = !allEl.checked && can.some(r => r.on)
  }
  const renderAll = () => { rows.forEach((_, i) => renderRow(i)); summary() }
  renderAll()

  $('#mbb-fields').addEventListener('change', renderAll)
  tbody.addEventListener('change', e => {
    const cb = e.target as HTMLInputElement
    rows[Number(cb.closest<HTMLElement>('tr')!.dataset.i)].on = cb.checked
    summary()
  })
  allEl.addEventListener('change', () => {
    rows.forEach(r => { if (usable(r)) r.on = allEl.checked })
    renderAll()
  })
  tbody.addEventListener('click', e => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-chip]')
    if (c) {
      const i = Number(c.closest<HTMLElement>('tr')!.dataset.i), f = c.dataset.chip!, r = rows[i]
      if (c.dataset.value !== undefined) {
        const g = c.dataset.value
        if (!r.offGenres.delete(g)) r.offGenres.add(g)
      } else if (!r.off.delete(f)) r.off.add(f)
      renderRow(i); summary()
      return
    }
    const pc = (e.target as HTMLElement).closest<HTMLElement>('[data-pick-cover]')
    if (pc) {
      const i = Number(pc.closest<HTMLElement>('tr')!.dataset.i), r = rows[i], rel = r.match!.release
      openChangeCover(r.a.track_ids, rel.mb_album_id, { album: rel.album, artist: rel.album_artist ?? '' }, async () => {}, (src, preview) => {
        if (r.cover?.src.file) URL.revokeObjectURL(r.cover.preview)
        r.cover = { src, preview, label: src.file ? `From disk: ${src.file.name}` : src.url ? `From ${src.url}` : 'Picked by hand' }
        r.off.delete('cover')
        renderRow(i); summary()
      })
      return
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-review]')
    if (!b) return
    const i = Number(b.closest<HTMLElement>('tr')!.dataset.i), r = rows[i]
    openMbAlbum(r.a.track_ids, async () => {
      Object.assign(r, { status: 'staged', on: false, note: 'Staged from Review' })
      staged = true
      renderRow(i); summary()
    })
  })

  // The best of the first few candidates, scored track by track; stop early on a near-perfect one.
  async function find(r: Row) {
    const s = await api.lookup.albumSearch(r.a.track_ids)
    let best: { id: string; quality: number } | null = null, failed: unknown = null
    for (const c of s.candidates.slice(0, TRIES)) {
      if (closed) return
      let q
      try { q = await api.lookup.albumScore(r.a.track_ids, c.mb_album_id) } catch (e) { failed = e; continue }   // try the next one
      if (!best || q.quality > best.quality) best = { id: c.mb_album_id, quality: q.quality }
      if (q.quality >= 0.9) break
    }
    if (!best && failed) throw failed
    if (!best || closed) { r.status = 'none'; return }
    const m = r.match = await api.lookup.albumMatch(r.a.track_ids, best.id)
    const paired = m.items.length ? m.items.filter(it => it.key).length / m.items.length : 0
    Object.assign(r, { quality: best.quality, paired, status: 'found', on: paired >= GOOD })
    // Its cover: written by default only where the album has none.
    if (r.a.folder || r.a.embedded > 0) r.off.add('cover')
    r.coverCheck = 'checking'
    // The release's own art, else the album's (another edition's, via its release group).
    const id = m.release.mb_album_id, rg = m.release.rg_id
    const rgArt = (size: number) => `https://coverartarchive.org/release-group/${rg}/front-${size}`
    ;(async () => {
      if (await hasArt(caa(id))) r.cover ??= { src: { mb_album_id: id }, preview: caa(id), label: "The release's cover (Cover Art Archive)" }
      else if (rg && await hasArt(rgArt(250))) r.cover ??= { src: { url: rgArt(1200) }, preview: rgArt(250), label: "The album's cover from another edition (Cover Art Archive)" }
      r.coverCheck = 'done'
      if (!closed) { renderRow(rows.indexOf(r)); summary() }
    })()
  }

  ;(async () => {
    // Two at a time: MusicBrainz is throttled server side, one request a second.
    let next = 0
    const worker = async () => {
      while (!closed && next < rows.length) {
        const i = next++, r = rows[i]
        if (r.status === 'staged') continue
        r.status = 'searching'; renderRow(i); summary()
        try { await find(r) } catch (e) { r.status = 'error'; r.note = errText(e) }
        if (closed) return
        renderRow(i); summary()
      }
    }
    await Promise.all([worker(), worker()])
  })()

  goBtn.addEventListener('click', async () => {
    busy = true; renderAll()
    let albumsDone = 0, tracks = 0, covers = 0, failed = 0, direct = false
    for (const [i, r] of rows.entries()) {
      if (!r.on || !usable(r) || !anything(r)) continue
      const m = r.match!
      sumEl.textContent = `Staging ${m.release.album}…`
      const done: string[] = []
      try {
        const fields = tagFields(r).flatMap(f => f === 'mb' ? MB_IDS : [f])
        if (fields.length) {
          const pairs: Record<number, string> = {}
          for (const it of m.items) if (it.key) pairs[it.id] = it.key
          const genres = splitGenres(m.release.genre)
          const res = await api.lookup.albumApply({
            mb_album_id: m.release.mb_album_id, pairs, fields, original_year: origEl.checked, cover: false,
            keep: $<HTMLInputElement>('#mbb-keep').checked ? KEEP : [],
            unpaired: m.items.filter(it => !it.key).map(it => it.id),
            genre: r.offGenres.size ? genres.filter(g => !r.offGenres.has(g)).join('; ') : undefined,
          })
          tracks += res.changed; albumsDone++
          direct ||= res.changed > 0 && !res.staged     // staging off in Settings: written now
          done.push(res.changed ? `${res.staged ? 'Staged' : 'Written to'} ${res.changed} track${res.changed !== 1 ? 's' : ''}` : 'Tags already match')
        }
        if (coverOn(r)) {
          const res = await api.covers.set(r.a.track_ids, r.cover!.src)
          if (res.errors.length) throw new Error(`cover: ${res.errors[0].error}`)
          covers++; done.push('cover written')
        }
        Object.assign(r, { status: 'staged', on: false, note: done.join(' · ') })
      } catch (e) { failed++; r.status = 'error'; r.note = [...done, errText(e)].join(' · ') }
      staged = true
      renderRow(i)
    }
    busy = false; renderAll()
    const parts = [albumsDone ? `MusicBrainz tags ${direct ? 'written to' : 'staged on'} ${tracks} track${tracks !== 1 ? 's' : ''} in ${albumsDone} album${albumsDone !== 1 ? 's' : ''}` : '',
                   covers ? `${covers} cover${covers !== 1 ? 's' : ''} written` : ''].filter(Boolean)
    if (parts.length) toast(`${parts.join(' · ')}${albumsDone && !direct ? ' — Review to write the tags' : ''}${failed ? ` · ${failed} failed` : ''}`, failed ? 'error' : 'success')
    else if (failed) toast(`Match albums: ${failed} failed`, 'error')
    if (!failed) close()
  })
}
