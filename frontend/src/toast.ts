export type ToastLevel = 'info' | 'success' | 'error'

export function toast(message: string, level: ToastLevel = 'info', duration = 3500): void {
  const container = getContainer()
  const el = document.createElement('div')
  el.className = `toast toast-${level}`
  el.textContent = message
  container.appendChild(el)
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-show')))
  setTimeout(() => dismiss(el), duration)
}

function dismiss(el: HTMLElement) {
  el.classList.remove('toast-show')
  el.addEventListener('transitionend', () => el.remove(), { once: true })
}

function getContainer(): HTMLElement {
  let c = document.getElementById('toast-container')
  if (!c) {
    c = document.createElement('div')
    c.id = 'toast-container'
    document.body.appendChild(c)
  }
  return c
}
