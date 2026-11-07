// Two paths with what differs marked: a word-level diff (the common
// subsequence of words, separators and punctuation with the most characters,
// so "The Pogues" vs "Pogues, The" keeps "Pogues"), so an added folder or
// an "(Original Soundtrack)" lights up and the rest stays plain.
import { esc } from './util'

const words = (s: string) => s.match(/[\p{L}\p{N}_']+|\s+|[^\p{L}\p{N}_'\s]/gu) ?? []

export function pathDiff(from: string, to: string): [string, string] {
  const a = words(from), b = words(to)
  const n = a.length, m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + a[i].length : Math.max(L[i + 1][j], L[i][j + 1])
  const outA: [string, boolean][] = [], outB: [string, boolean][] = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { outA.push([a[i++], false]); outB.push([b[j++], false]) }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) outB.push([b[j++], true])
    else outA.push([a[i++], true])
  }
  // Runs of changed words in one <mark>; a lone space between two marks joins them.
  const html = (parts: [string, boolean][]) => {
    let out = '', open = false
    parts.forEach(([w, changed], k) => {
      const bridge = !changed && open && /^\s+$/.test(w) && parts[k + 1]?.[1]
      const on = changed || !!bridge
      if (on && !open) out += '<mark>'
      if (!on && open) out += '</mark>'
      out += esc(w); open = on
    })
    return open ? out + '</mark>' : out
  }
  return [html(outA), html(outB)]
}

// One hover card for the whole page: elements with data-diff-from/-to show
// both paths, differences marked, under the pointer.
let card: HTMLElement | null = null

export function wirePathDiff(root: HTMLElement) {
  root.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-diff-to]')
    if (!el) return
    const [now, then] = pathDiff(el.dataset.diffFrom!, el.dataset.diffTo!)
    card ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'path-diff' }))
    card.innerHTML = `<div><span class="path-diff-label">Now</span>${now}</div><div><span class="path-diff-label">Layout</span>${then}</div>`
    const r = el.getBoundingClientRect()
    card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - card.offsetWidth - 8))}px`
    card.style.top = `${r.bottom + 4 + card.offsetHeight > window.innerHeight ? r.top - card.offsetHeight - 4 : r.bottom + 4}px`
    card.hidden = false
  })
  root.addEventListener('mouseout', (e) => {
    const el = (e.target as HTMLElement).closest('[data-diff-to]')
    if (el && card && !el.contains(e.relatedTarget as Node)) card.hidden = true
  })
}
