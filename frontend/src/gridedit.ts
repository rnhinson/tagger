// Edit mode for the track table: tag cells edit in place like a spreadsheet.
// Only the cell you're on is an input; edits are kept here (per track and
// field) until staged, with their own undo/redo, and leaving the view with
// edits pending asks first.
import { api, EditResult, Track, TagUpdate } from './api'
import { COL_DEFS } from './columns'
import { editToast } from './staged'
import { esc } from './util'
import { toast } from './toast'

const EDITABLE = new Set(['title', 'artist', 'album', 'album_artist', 'year', 'track_number',
  'disc_number', 'genre', 'composer', 'bpm'])

interface Step { id: number; field: string; before: string; after: string }

interface Host {
  tbody: HTMLElement
  tracks: () => Track[]
  rerender: () => void
  staging: () => boolean
  afterStage: (res: EditResult | undefined) => Promise<void>
}

let host: Host
let active = false
const edits = new Map<number, Record<string, string>>()
let undoStack: Step[] = []
let redoStack: Step[] = []
let cur: { id: number; field: string; td: HTMLTableCellElement; input: HTMLInputElement; start: string } | null = null
let resume: { id: number; field: string } | null = null
let busy = false

const btn = () => document.getElementById('grid-edit-btn') as HTMLButtonElement
const discardBtn = () => document.getElementById('grid-discard-btn') as HTMLButtonElement

export const gridActive = () => active
// Edits waiting to be staged, the cell being typed in included.
function count() {
  let n = [...edits.values()].reduce((n, e) => n + Object.keys(e).length, 0)
  const t = cur && track(cur.id)
  if (cur && t && cur.input.value !== value(t, cur.field) && !(cur.field in (edits.get(cur.id) ?? {}))) n++
  return n
}

const raw = (t: Track, field: string) => String((t as unknown as Record<string, unknown>)[field] ?? '')
const value = (t: Track, field: string) => edits.get(t.id)?.[field] ?? raw(t, field)
const track = (id: number) => host.tracks().find(t => t.id === id)

/** The track as edit mode shows it: pending edits over the loaded values. */
export function gridView(t: Track): Track {
  const e = edits.get(t.id)
  return e ? { ...t, ...e } as Track : t
}

/** Extra attributes for a table cell: data-edit marks it editable, cell-edited shows a pending change. */
export function gridCell(t: Track, key: string): { attrs: string; cls: string } {
  if (!active || t.read_only || !EDITABLE.has(key)) return { attrs: '', cls: '' }
  const e = edits.get(t.id)
  if (!e || !(key in e)) return { attrs: ` data-edit="${key}"`, cls: '' }
  return { attrs: ` data-edit="${key}" title="Edited — was: ${esc(raw(t, key) || '(empty)')}"`, cls: ' cell-edited' }
}

function set(id: number, field: string, v: string) {
  const t = track(id)
  const e = edits.get(id) ?? {}
  if (t && v === raw(t, field)) delete e[field]
  else e[field] = v
  if (Object.keys(e).length) edits.set(id, e)
  else edits.delete(id)
}

function paint(td: HTMLTableCellElement, t: Track, field: string) {
  const col = COL_DEFS.find(c => c.key === field)!
  td.innerHTML = col.render(gridView(t))
  const { cls } = gridCell(t, field)
  td.classList.toggle('cell-edited', !!cls)
  td.title = cls ? `Edited — was: ${raw(t, field) || '(empty)'}` : ''
}

/** Leave the current cell, keeping what was typed as one undo step. */
function commit() {
  if (!cur) return
  const c = cur
  cur = null
  const t = track(c.id)
  if (!t) return
  const before = value(t, c.field)
  if (c.input.value !== before) {
    undoStack.push({ id: c.id, field: c.field, before, after: c.input.value })
    redoStack = []
    set(c.id, c.field, c.input.value)
  }
  c.td.classList.remove('grid-cell-active')
  if (c.td.isConnected) paint(c.td, t, c.field)
  updateButtons()
}

function activate(td: HTMLTableCellElement) {
  if (cur?.td === td) return
  commit()
  const tr = td.closest('tr')!
  const id = Number(tr.dataset.id)
  const field = td.dataset.edit!
  const t = track(id)
  if (!t) return
  const input = document.createElement('input')
  input.className = 'grid-input'
  input.value = value(t, field)
  input.spellcheck = false
  td.innerHTML = ''
  td.classList.add('grid-cell-active')
  td.appendChild(input)
  cur = { id, field, td, input, start: input.value }
  input.addEventListener('keydown', onKey)
  input.addEventListener('input', updateButtons)
  input.addEventListener('blur', () => { if (cur?.input === input) commit() })
  input.focus()
  input.select()
  td.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function cells(): HTMLTableCellElement[][] {
  return [...host.tbody.querySelectorAll('tr')]
    .map(tr => [...tr.querySelectorAll<HTMLTableCellElement>('td[data-edit]')])
    .filter(r => r.length)
}

function move(dRow: number, dCol: number, wrap = false) {
  if (!cur) return
  const grid = cells()
  let r = grid.findIndex(row => row.includes(cur!.td))
  if (r < 0) return
  let c = grid[r].indexOf(cur.td) + dCol
  if (wrap && c >= grid[r].length && r + 1 < grid.length) { r++; c = 0 }
  if (wrap && c < 0 && r > 0) { r--; c = grid[r].length - 1 }
  r = Math.max(0, Math.min(grid.length - 1, r + dRow))
  c = Math.max(0, Math.min(grid[r].length - 1, c))
  activate(grid[r][c])
}

function cellFor(id: number, field: string) {
  return host.tbody.querySelector<HTMLTableCellElement>(`tr[data-id="${id}"] td[data-edit="${field}"]`)
}

function step(from: Step[], to: Step[], undo: boolean) {
  commit()
  const s = from.pop()
  if (!s) return
  to.push(s)
  set(s.id, s.field, undo ? s.before : s.after)
  const td = cellFor(s.id, s.field)
  const t = track(s.id)
  if (td && t) { paint(td, t, s.field); activate(td) }
  updateButtons()
}
const undo = () => step(undoStack, redoStack, true)
const redo = () => step(redoStack, undoStack, false)

function onKey(e: KeyboardEvent) {
  const input = e.target as HTMLInputElement
  const mod = e.ctrlKey || e.metaKey
  const all = input.selectionStart === 0 && input.selectionEnd === input.value.length
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
  switch (e.key) {
    case 'Enter': e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); break
    case 'ArrowDown': e.preventDefault(); move(1, 0); break
    case 'ArrowUp': e.preventDefault(); move(-1, 0); break
    case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1, true); break
    case 'ArrowLeft':
      if (all || input.selectionEnd === 0) { e.preventDefault(); move(0, -1) }
      break
    case 'ArrowRight':
      if (all || input.selectionStart === input.value.length) { e.preventDefault(); move(0, 1) }
      break
    case 'Escape':
      // First Esc drops what was typed in this cell; the next leaves the cell.
      e.preventDefault()
      e.stopPropagation()
      if (cur && input.value !== cur.start) { input.value = cur.start; input.select() }
      else input.blur()
      break
  }
}

function updateButtons() {
  const b = btn(), n = count()
  if (!b) return
  b.classList.toggle('btn-primary', n > 0)
  b.classList.toggle('btn-ghost', n === 0)
  b.setAttribute('aria-pressed', String(active))
  if (n > 0) {
    const verb = host.staging() ? 'Stage' : 'Save'
    b.textContent = `${verb} ${n} change${n !== 1 ? 's' : ''}`
    b.title = host.staging() ? 'Stage every edit in the table for Review' : 'Write every edit in the table to the files'
  } else {
    b.textContent = '✎'
    b.title = active ? 'Editing the table — click to stop' : 'Edit tags in the table, like a spreadsheet'
  }
  discardBtn().hidden = !active
  discardBtn().title = n ? 'Discard the edits and stop editing' : 'Stop editing'
}

function reset() {
  cur = null
  resume = null
  edits.clear()
  undoStack = []
  redoStack = []
}

function stop() {
  active = false
  reset()
  document.body.classList.remove('grid-editing')
  host.rerender()
  updateButtons()
}

/** Ask before edits are lost; true when it's fine to go on (and edit mode is left). */
export function gridConfirmLeave(): boolean {
  commit()
  if (!active) return true
  const n = count()
  if (n && !confirm(`Discard ${n} unstaged edit${n !== 1 ? 's' : ''} in the table?`)) return false
  stop()
  return true
}

async function stage() {
  commit()
  if (busy) return
  busy = true
  btn().disabled = true
  const n = count()
  let res: EditResult | undefined
  let failed = 0, firstErr = ''
  const queue = [...edits.entries()]
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [id, tags] = item
      try {
        res = await api.tags.update(id, tags as TagUpdate)
        edits.delete(id)
      } catch (err) {
        failed++
        firstErr ||= String(err)
      }
    }
  }
  try {
    await Promise.all([worker(), worker(), worker(), worker()])
  } finally {
    busy = false
    btn().disabled = false
  }
  undoStack = []
  redoStack = []
  if (failed) toast(`${failed} track${failed !== 1 ? 's' : ''} failed: ${firstErr} — their edits are still in the table`, 'error')
  else editToast(res, `${n} edit${n !== 1 ? 's' : ''}`)
  await host.afterStage(res)
  updateButtons()
}

/** Call before the table is rebuilt: keep the cell you're on. */
export function gridBeforeRender() {
  if (cur) resume = { id: cur.id, field: cur.field }
  commit()
}

/** Call after the table is rebuilt: back to that cell, if it's still shown. */
export function gridAfterRender() {
  if (!active || !resume) return
  const td = cellFor(resume.id, resume.field)
  resume = null
  if (td) activate(td)
}

export function initGridEdit(h: Host) {
  host = h
  btn().addEventListener('click', () => {
    if (!active) {
      active = true
      document.body.classList.add('grid-editing')
      host.rerender()
      updateButtons()
      const first = host.tbody.querySelector<HTMLTableCellElement>('td[data-edit]')
      if (first) activate(first)
    } else if (count()) {
      void stage()
    } else {
      stop()
    }
  })
  discardBtn().addEventListener('click', () => { gridConfirmLeave() })

  // In edit mode a click on a tag cell edits it: it doesn't select the row or follow its links.
  host.tbody.addEventListener('click', (e) => {
    if (!active) return
    const td = (e.target as HTMLElement).closest<HTMLTableCellElement>('td[data-edit]')
    if (!td) return
    e.stopPropagation()
    e.preventDefault()
    activate(td)
  }, true)

  // Undo/redo with no cell open.
  document.addEventListener('keydown', (e) => {
    if (!active || cur || !(e.ctrlKey || e.metaKey)) return
    const t = e.target as HTMLElement
    if (t.matches('input, textarea, select') || t.isContentEditable || document.querySelector('.modal-overlay')) return
    const k = e.key.toLowerCase()
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
    else if (k === 'y') { e.preventDefault(); redo() }
  })

  // Anything that would change the view asks first while edits are pending.
  document.addEventListener('click', (e) => {
    if (!active || !count()) return
    const t = e.target as HTMLElement
    if (t.closest('.track-table, #grid-edit-btn, #grid-discard-btn, .modal-overlay, .toast')) return
    if (!t.closest('button, a, select, input, label, li, [role=button], .nav-item, .tree-row, .album-tile')) return
    if (!gridConfirmLeave()) { e.preventDefault(); e.stopImmediatePropagation() }
  }, true)
  window.addEventListener('beforeunload', (e) => {
    if (active && count()) { e.preventDefault(); e.returnValue = '' }
  })
  updateButtons()
}
