// Staged changes: overlay on tracks, the Review dialog and the History dialog.
import { api, EditResult, Track, WriteError } from './api'
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
  return v ? esc(v.length > 80 ? v.slice(0, 80) + '…' : v) : '<span class="fix-empty">empty</span>'
}

/** List every staged change; write or discard all, or discard per track. */
export async function openReview(onChanged: () => Promise<void>) {
  const m = modalShell('Review changes')
  let failures = new Map<number, string>()

  const render = async () => {
    const { count, tracks } = await api.staged.list()
    m.titleEl.textContent = count
      ? `Review changes — ${count} track${count !== 1 ? 's' : ''}`
      : 'Review changes'
    m.body.innerHTML = ''
    m.footer.innerHTML = ''
    if (!count) {
      m.body.innerHTML = '<p class="review-empty">Nothing staged. Edits wait here until you write them.</p>'
      const ok = document.createElement('button')
      ok.className = 'btn btn-ghost'
      ok.textContent = 'Close'
      ok.addEventListener('click', m.close)
      m.footer.append(ok)
      return
    }
    for (const t of tracks) {
      const rows = t.changes.map(c => `<tr>
          <td class="fix-col-field">${esc(FIELD_LABELS[c.field] ?? c.field)}</td>
          <td class="fix-col-current">${fmtVal(c.old)}</td>
          <td class="fix-col-arrow">→</td>
          <td class="fix-col-proposed">${fmtVal(c.new)}</td>
        </tr>`).join('')
      const move = t.new_path ? `<tr>
          <td class="fix-col-field">Move</td>
          <td class="fix-col-current review-path">${esc(shortPath(t.path))}</td>
          <td class="fix-col-arrow">→</td>
          <td class="fix-col-proposed review-path">${esc(shortPath(t.new_path))}</td>
        </tr>` : ''
      const err = failures.get(t.id)
      const section = document.createElement('div')
      section.className = 'fix-confirm-track'
      section.innerHTML = `
        <div class="fix-confirm-track-header">
          <span class="fix-confirm-track-name" title="${esc(t.path)}">${esc(t.title || t.filename)}</span>
          <button class="btn btn-ghost btn-sm review-discard" data-id="${t.id}">Discard</button>
        </div>
        ${err ? `<div class="review-error">⚠ ${esc(err)}</div>` : ''}
        <table class="fix-confirm-table"><tbody>${rows}${move}</tbody></table>`
      m.body.appendChild(section)
    }
    m.body.querySelectorAll<HTMLButtonElement>('.review-discard').forEach(b => {
      b.addEventListener('click', async () => {
        b.disabled = true
        await api.staged.discard([Number(b.dataset.id)])
        await onChanged()
        await render()
      })
    })

    const discardAll = document.createElement('button')
    discardAll.className = 'btn btn-ghost'
    discardAll.textContent = 'Discard all'
    discardAll.addEventListener('click', async () => {
      if (!confirm(`Discard all ${count} staged change${count !== 1 ? 's' : ''}?`)) return
      await api.staged.discard()
      await onChanged()
      m.close()
      toast('Discarded staged changes', 'info')
    })
    const write = document.createElement('button')
    write.className = 'btn btn-primary'
    write.textContent = `Write ${count} track${count !== 1 ? 's' : ''}`
    write.addEventListener('click', async () => {
      write.disabled = discardAll.disabled = true
      write.textContent = 'Writing…'
      try {
        const res = await api.staged.apply()
        await onChanged()
        if (res.errors.length) {
          failures = new Map(res.errors.map((e: WriteError) => [e.id, e.error]))
          toast(`Wrote ${res.applied}; ${res.errors.length} need attention`, 'error')
          await render()
        } else {
          toast(`Wrote ${res.applied} track${res.applied !== 1 ? 's' : ''}`, 'success')
          m.close()
        }
      } catch (e) {
        toast(`Write failed: ${e}`, 'error')
        write.disabled = discardAll.disabled = false
        write.textContent = `Write ${count} tracks`
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
