/**
 * Chip editor for a multi-value tag ("Folk; Celtic") across a selection.
 *
 * Values every selected track has are neutral chips; deleting one marks it
 * red (remove), deleting a red one puts it back. Clicking the box opens the
 * other values -- library-wide, with track counts -- each with + (green chip:
 * add to the tracks that lack it) and - (red chip: remove where it is).
 * Green chips and red chips for partly-present values delete outright.
 * Nothing is sent until Save: `add` / `remove` feed POST /api/tags/values.
 */
import type { TagValue } from './api'
import { esc } from './util'

export interface SelectionValue { value: string; tracks: number }

type Change = { value: string; mode: 'add' | 'remove' }
const key = (v: string) => v.trim().toLocaleLowerCase()

export class ValueChips {
  readonly el: HTMLElement
  private box: HTMLElement
  private input: HTMLInputElement
  private menu: HTMLElement
  private n = 0
  private have = new Map<string, SelectionValue>()
  private library: TagValue[] = []
  private changes = new Map<string, Change>()

  constructor(private noun: string) {
    this.el = document.createElement('div')
    this.el.className = 'chip-field'
    this.el.innerHTML = `
      <div class="chip-box"><input class="chip-input" type="text" autocomplete="off"
        placeholder="Add or remove ${noun}…" aria-label="Add or remove ${noun}" /></div>
      <div class="chip-menu" role="listbox" hidden></div>`
    this.box = this.el.querySelector('.chip-box')!
    this.input = this.el.querySelector('.chip-input')!
    this.menu = this.el.querySelector('.chip-menu')!

    this.box.addEventListener('mousedown', (e) => {
      if (e.target === this.box) { e.preventDefault(); this.input.focus() }
    })
    this.input.addEventListener('focus', () => this.openMenu())
    this.input.addEventListener('input', () => this.openMenu())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.closeMenu(); this.input.blur() }
      if (e.key === 'Enter') {
        e.preventDefault()  // never submit the form from here
        const v = this.input.value.trim()
        if (v) { this.mark(this.canonical(v), 'add'); this.input.value = ''; this.openMenu() }
      }
      if (e.key === 'Backspace' && !this.input.value) this.undoLast()
    })
    // Buttons act on mousedown so the input keeps focus (menu stays open).
    this.el.addEventListener('mousedown', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
      if (!b) return
      e.preventDefault()
      const v = b.dataset.value!
      if (b.dataset.act === 'add') this.mark(v, 'add')
      else if (b.dataset.act === 'remove') this.mark(v, 'remove')
      else this.unmark(v)
      this.input.value = ''
      if (this.menu.hidden) this.render(); else this.openMenu()
    })
    this.input.addEventListener('blur', () => setTimeout(() => this.closeMenu(), 120))
  }

  /** Show a new selection (n tracks, their values) against the library's values. */
  load(n: number, have: SelectionValue[], library: TagValue[]) {
    this.n = n
    this.have = new Map(have.map(h => [key(h.value), h]))
    this.library = library.filter(v => v.value)
    this.changes.clear()
    this.input.value = ''
    this.render()
  }

  get dirty(): boolean { return this.changes.size > 0 }
  get add(): string[] { return [...this.changes.values()].filter(c => c.mode === 'add').map(c => c.value) }
  get remove(): string[] { return [...this.changes.values()].filter(c => c.mode === 'remove').map(c => c.value) }

  private onAll(v: string) { return (this.have.get(key(v))?.tracks ?? 0) >= this.n && this.n > 0 }
  private count(v: string) { return this.have.get(key(v))?.tracks ?? 0 }
  /** Prefer the spelling already in the selection or library. */
  private canonical(v: string) {
    return this.have.get(key(v))?.value ?? this.library.find(l => key(l.value) === key(v))?.value ?? v.trim()
  }

  private mark(v: string, mode: 'add' | 'remove') {
    if (mode === 'add' && this.onAll(v)) { this.changes.delete(key(v)); return }  // already everywhere
    if (mode === 'remove' && !this.count(v)) return                              // nowhere to remove from
    this.changes.set(key(v), { value: v, mode })
  }

  /** Chip ×: neutral -> red; anything else -> back to no change. */
  private unmark(v: string) {
    if (this.onAll(v) && !this.changes.has(key(v))) this.changes.set(key(v), { value: v, mode: 'remove' })
    else this.changes.delete(key(v))
  }

  private undoLast() {
    const last = [...this.changes.keys()].pop()
    if (last) { this.changes.delete(last); this.render() }
  }

  private chip(v: string, state: 'keep' | 'add' | 'remove'): string {
    const n = state === 'add' ? this.n - this.count(v) : this.count(v)
    const title = state === 'keep' ? `On all ${this.n} tracks`
      : state === 'add' ? `Will be added to ${n} track${n !== 1 ? 's' : ''}`
      : `Will be removed from ${n} track${n !== 1 ? 's' : ''}`
    const badge = state === 'keep' ? '' : `<span class="chip-n">${state === 'add' ? '+' : '−'}${n}</span>`
    return `<span class="chip chip-${state}" title="${esc(title)}"><span class="chip-label">${esc(v)}</span>${badge}` +
      `<button type="button" class="chip-x" data-act="x" data-value="${esc(v)}" ` +
      `aria-label="${state === 'keep' ? 'Remove' : 'Undo'} ${esc(v)}">×</button></span>`
  }

  render() {
    const chips: string[] = []
    for (const h of this.have.values()) {
      if (h.tracks < this.n) continue
      chips.push(this.chip(h.value, this.changes.get(key(h.value))?.mode === 'remove' ? 'remove' : 'keep'))
    }
    for (const c of this.changes.values()) {
      if (this.onAll(c.value)) continue  // drawn above
      chips.push(this.chip(c.value, c.mode))
    }
    this.box.querySelectorAll('.chip').forEach(c => c.remove())
    this.input.insertAdjacentHTML('beforebegin', chips.join(''))
    this.el.classList.toggle('chip-dirty', this.dirty)
  }

  private openMenu() {
    this.render()
    const q = key(this.input.value)
    // Library values plus any in the selection the library list doesn't know (staged).
    const all = new Map(this.library.map(l => [key(l.value), { value: l.value, lib: l.track_count }]))
    for (const h of this.have.values()) if (!all.has(key(h.value))) all.set(key(h.value), { value: h.value, lib: 0 })
    const rows: string[] = []
    for (const [k, v] of all) {
      if (this.onAll(v.value) || this.changes.has(k)) continue
      if (q && !k.includes(q)) continue
      const sel = this.count(v.value)
      rows.push(`<div class="chip-opt" role="option">
        <span class="chip-opt-label">${esc(v.value)}</span>
        <span class="chip-opt-meta">${sel ? `${sel}/${this.n} selected · ` : ''}${v.lib.toLocaleString()} tracks</span>
        <button type="button" class="chip-btn chip-btn-add" data-act="add" data-value="${esc(v.value)}"
          title="Add to ${this.n - sel} track${this.n - sel !== 1 ? 's' : ''}">+</button>
        ${sel ? `<button type="button" class="chip-btn chip-btn-remove" data-act="remove" data-value="${esc(v.value)}"
          title="Remove from ${sel} track${sel !== 1 ? 's' : ''}">−</button>` : '<span class="chip-btn-gap"></span>'}
      </div>`)
      if (rows.length >= 200) break
    }
    const typed = this.input.value.trim()
    if (typed && !all.has(key(typed))) {
      rows.unshift(`<div class="chip-opt chip-opt-new" role="option">
        <span class="chip-opt-label">Add “${esc(typed)}”</span><span class="chip-opt-meta">new ${esc(this.noun)}</span>
        <button type="button" class="chip-btn chip-btn-add" data-act="add" data-value="${esc(typed)}">+</button>
        <span class="chip-btn-gap"></span></div>`)
    }
    this.menu.innerHTML = rows.join('') || `<div class="chip-opt-empty">No other ${esc(this.noun)}</div>`
    this.menu.hidden = false
  }

  private closeMenu() { this.menu.hidden = true }
}
