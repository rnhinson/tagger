// Staged changes: overlay on tracks, the Review dialog and the History dialog.
import { api, EditResult, StagedLine, Track, WriteError } from './api'
import { toast } from './toast'
import { esc } from './util'
import { state } from './state'

const FIELD_LABELS: Record<string, string> = {
  title: 'Title', artist: 'Artist', album: 'Album', album_artist: 'Album Artist',
  year: 'Year', genre: 'Genre', track_number: 'Track #', disc_number: 'Disc #',
  comment: 'Comment', composer: 'Composer', bpm: 'BPM', lyrics: 'Lyrics',
  compilation: 'Compilation', mb_track_id: 'MB Track ID', mb_artist_id: 'MB Artist ID',
  mb_album_id: 'MB Album ID', mb_album_artist_id: 'MB Album Artist ID',
}

/** Show staged values in place of the on-file ones (kept in t._orig). */
export function overlayStaged(t: Track): Track {
  const tags = t.staged?.tags
  if (!tags) return t
  const rec = t as unknown as Record<string, string | null>
  t._orig = {}
  for (const [k, v] of Object.entries(tags)) {
    t._orig[k] = rec[k] ?? null
    rec[k] = v
  }
  return t
}

/** Path relative to the music dir it lives in, for display. */
export function shortPath(p: string): string {
  const root = state.musicDirs.find(d => p === d || p.startsWith(d + '/'))
  return root ? p.slice(root.length + 1) : p
}

/** Toast for an editing call: "Staged …" or "Saved …", plus any write errors. */
export function editToast(res: EditResult | undefined, what: string) {
  if (!res || res.staged) {
    toast(`Staged ${what} — Review to write`, 'info')
  } else if (res.errors?.length) {
    toast(`Saved ${what}; ${res.errors.length} failed: ${res.errors[0].error}`, 'error')
  } else {
    toast(`Saved ${what}`, 'success')
  }
}

/** The server's message out of a failed request ("… → 400: {"detail": …}"). */
export function errText(e: unknown): string {
  const m = String(e).match(/→ \d+: ([\s\S]*)$/)
  if (!m) return String(e)
  try { return JSON.parse(m[1]).detail ?? m[1] } catch { return m[1] }
}

// ─── Review dialog ──────────────────────────────────────────────────────────

function modalShell(title: string) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal review-modal" role="dialog" aria-label="${esc(title)}">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title"></span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="fix-confirm-body"></div>
      <div class="fix-confirm-footer"></div>
    </div>`
  document.body.appendChild(overlay)
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  overlay.querySelector('.fix-confirm-close')!.addEventListener('click', close)
  return {
    titleEl: overlay.querySelector<HTMLElement>('.fix-confirm-title')!,
    body: overlay.querySelector<HTMLElement>('.fix-confirm-body')!,
    footer: overlay.querySelector<HTMLElement>('.fix-confirm-footer')!,
    close,
  }
}

function fmtVal(v: string | null): string {
  return v ? esc(v.length > 60 ? v.slice(0, 60) + '…' : v) : '<span class="fix-empty">empty</span>'
}

const base = (p: string) => p.split('/').pop() ?? p
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))

/** One compact line for one change. */
function lineHtml(l: StagedLine, failures: Map<string, string>): string {
  let what: string, from: string, to: string
  if (l.kind === 'tag') {
    what = `<span class="rv-subject">${esc(l.name)}</span> · ${esc(FIELD_LABELS[l.field] ?? l.field)}`
    from = fmtVal(l.old); to = fmtVal(l.new)
  } else if (l.kind === 'path') {
    const sameDir = dirOf(l.old!) === dirOf(l.new!)
    what = `<span class="rv-subject">${esc(l.name)}</span> · ${sameDir ? 'rename' : 'move'}`
    from = esc(sameDir ? base(l.old!) : shortPath(l.old!))
    to = esc(sameDir ? base(l.new!) : shortPath(l.new!))
  } else {
    what = `<span class="rv-subject">📁 ${esc(base(l.src))}</span> · folder (${l.tracks} track${l.tracks !== 1 ? 's' : ''} + files)`
    from = esc(l.old ? shortPath(l.old) : shortPath(l.src))
    to = l.new ? esc(shortPath(l.new)) : '<span class="fix-empty">stays</span>'
  }
  const key = l.kind === 'folder' ? `dir:${l.src}` : `id:${l.id}`
  const err = failures.get(key)
  const shared = l.kind === 'folder' && l.new && /\/Shared(\/|$)/.test(l.src) && !/\/Shared(\/|$)/.test(l.new)
  return `<li class="rv-line${err ? ' rv-failed' : ''}">
      <span class="rv-what">${what}</span>
      <span class="rv-from">${from}</span><span class="rv-arrow">→</span><span class="rv-to">${to}</span>
      ${err ? `<span class="rv-note rv-err">⚠ ${esc(err)}</span>` : ''}
      ${shared ? '<span class="rv-note rv-warn">leaving Shared: unmonitor in Lidarr first</span>' : ''}
    </li>`
}

const MAX_LINES = 500

/** Staged changes as actions (newest first); expand one to see its changes. */
export async function openReview(onChanged: () => Promise<void>) {
  const m = modalShell('Review changes')
  const failures = new Map<string, string>()
  const open = new Set<string>()

  const render = async () => {
    const r = await api.staged.actions()
    const groups: { key: string; summary: string; ts?: number; lines: StagedLine[]; details: boolean; count: number; undo: boolean }[] =
      r.steps.map((s, i) => ({ key: `s${s.id}`, summary: s.summary, ts: s.ts, lines: s.lines,
                               details: s.details, count: s.count, undo: i === 0 }))
    if (r.other.length) groups.push({ key: 'other', summary: 'Other staged changes', lines: r.other,
                                      details: true, count: r.other.length, undo: false })
    // Open anything with a failure, and a lone action.
    for (const g of groups) {
      if (g.lines.some(l => failures.has(l.kind === 'folder' ? `dir:${l.src}` : `id:${l.id}`))) open.add(g.key)
    }
    if (groups.length === 1) open.add(groups[0].key)

    m.titleEl.textContent = 'Review changes'
      + (groups.length ? ` — ${groups.length} action${groups.length !== 1 ? 's' : ''}` : '')
    m.body.innerHTML = ''
    m.footer.innerHTML = ''
    if (!groups.length) {
      m.body.innerHTML = '<p class="review-empty">Nothing staged. Edits wait here until you write them.</p>'
      const ok = document.createElement('button')
      ok.className = 'btn btn-ghost'
      ok.textContent = 'Close'
      ok.addEventListener('click', m.close)
      m.footer.append(ok)
      return
    }

    const list = document.createElement('ul')
    list.className = 'rv-actions'
    for (const g of groups) {
      const isOpen = open.has(g.key)
      const n = g.details ? g.lines.length : g.count
      const li = document.createElement('li')
      li.className = 'rv-action' + (isOpen ? ' rv-open' : '')
      const when = g.ts ? new Date(g.ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
      li.innerHTML = `
        <div class="rv-head" data-key="${g.key}">
          <span class="rv-caret">${isOpen ? '▾' : '▸'}</span>
          <span class="rv-summary">${esc(g.summary)}</span>
          <span class="rv-meta">${n.toLocaleString()} change${n !== 1 ? 's' : ''}${when ? ' · ' + esc(when) : ''}</span>
          ${g.undo ? '<button class="btn btn-ghost btn-sm rv-undo" title="Undo this staged action (files are untouched)">↶ Undo</button>' : ''}
        </div>
        ${isOpen ? `<ul class="rv-lines">${
          !g.details ? '<li class="rv-line rv-nodetail">Details weren\'t recorded for this action (staged before this version).</li>'
          : g.lines.slice(0, MAX_LINES).map(l => lineHtml(l, failures)).join('')
            + (g.lines.length > MAX_LINES ? `<li class="rv-line rv-nodetail">…and ${(g.lines.length - MAX_LINES).toLocaleString()} more</li>` : '')
        }</ul>` : ''}`
      list.appendChild(li)
    }
    m.body.appendChild(list)

    list.querySelectorAll<HTMLElement>('.rv-head').forEach(h => {
      h.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.rv-undo')) return
        const k = h.dataset.key!
        open.has(k) ? open.delete(k) : open.add(k)
        render()
      })
    })
    list.querySelector<HTMLButtonElement>('.rv-undo')?.addEventListener('click', async (e) => {
      const b = e.currentTarget as HTMLButtonElement
      b.disabled = true
      try {
        const u = await api.staged.undo()
        toast(`Undid staged: ${u.summary}`, 'success')
        await onChanged()
        await render()
      } catch (err) {
        toast(`Undo failed: ${errText(err)}`, 'error')
        b.disabled = false
      }
    })

    const discardAll = document.createElement('button')
    discardAll.className = 'btn btn-ghost'
    discardAll.textContent = 'Discard all'
    discardAll.addEventListener('click', async () => {
      if (!confirm('Discard everything staged?')) return
      await api.staged.discard()
      await onChanged()
      m.close()
      toast('Discarded staged changes', 'info')
    })
    const write = document.createElement('button')
    write.className = 'btn btn-primary'
    write.textContent = `Write all (${r.count.toLocaleString()} item${r.count !== 1 ? 's' : ''})`
    write.addEventListener('click', async () => {
      write.disabled = discardAll.disabled = true
      write.textContent = 'Writing…'
      try {
        const res = await api.staged.apply()
        await onChanged()
        failures.clear()
        for (const e of res.errors as WriteError[]) failures.set(e.dir ? `dir:${e.dir}` : `id:${e.id}`, e.error)
        const done = `Wrote ${res.applied} track${res.applied !== 1 ? 's' : ''}`
          + (res.folders ? ` · moved ${res.folders} folder${res.folders !== 1 ? 's' : ''}` : '')
        if (res.errors.length) {
          toast(`${done}; ${res.errors.length} need attention`, 'error')
          await render()
        } else {
          toast(done, 'success')
          m.close()
        }
      } catch (e) {
        toast(`Write failed: ${e}`, 'error')
        write.disabled = discardAll.disabled = false
        write.textContent = 'Write all'
      }
    })
    m.footer.append(discardAll, write)
  }
  try { await render() } catch (e) { toast(`Failed to load changes: ${e}`, 'error'); m.close() }
}

// ─── History dialog ─────────────────────────────────────────────────────────

export async function openHistory(onChanged: () => Promise<void>) {
  const m = modalShell('History')
  m.titleEl.textContent = 'History'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'btn btn-ghost'
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', m.close)
  m.footer.append(closeBtn)

  const render = async () => {
    const entries = await api.library.history(100)
    if (!entries.length) {
      m.body.innerHTML = '<p class="review-empty">No changes yet.</p>'
      return
    }
    m.body.innerHTML = `<p class="review-hint">Undo works newest-first for each track. Cover art and ReplayGain aren't recorded.</p>`
    const list = document.createElement('ul')
    list.className = 'history-list'
    for (const h of entries) {
      const li = document.createElement('li')
      li.className = 'history-item' + (h.undone ? ' history-undone' : '')
      const when = new Date(h.ts * 1000).toLocaleString()
      li.innerHTML = `
        <div class="history-main">
          <span class="history-summary">${esc(h.summary)}</span>
          <span class="history-meta">${esc(when)}${h.count ? ` · ${h.count} track${h.count !== 1 ? 's' : ''}` : ''}</span>
        </div>
        ${h.undone ? '<span class="history-badge">Undone</span>'
                   : `<button class="btn btn-ghost btn-sm history-undo" data-id="${h.id}">Undo</button>`}`
      list.appendChild(li)
    }
    m.body.appendChild(list)
    list.querySelectorAll<HTMLButtonElement>('.history-undo').forEach(b => {
      b.addEventListener('click', async () => {
        b.disabled = true
        try {
          const res = await api.library.undo(Number(b.dataset.id))
          if (res.errors?.length) {
            toast(`Undo incomplete — ${res.errors.length} failed: ${res.errors[0].error}`, 'error')
          } else {
            toast(`Undone — restored ${res.restored} track${res.restored !== 1 ? 's' : ''}`, 'success')
          }
          await onChanged()
          await render()
        } catch (e) {
          toast(`Undo failed: ${errText(e)}`, 'error')
          b.disabled = false
        }
      })
    })
  }
  try { await render() } catch (e) { toast(`Failed to load history: ${e}`, 'error') }
}
