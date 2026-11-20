// The homepage's first screen (home.html, home-shell.ts) before the app: it starts the app's code once the first
// picture is in and the page is idle (or at once on a touch, key or scroll, a press of the button, or after 8 s), so
// nothing else takes the picture's bandwidth; it holds a press on Get started for the page to act on; and it gives
// way at once to anything the app shows at "/" other than the homepage. The homepage itself takes over from it
// (features/home/factory-home.tsx). Its script tag names the app's files: data-css, data-preload, data-entry.
;(() => {
  const me = document.currentScript, shell = document.getElementById('home-shell'), root = document.getElementById('root')
  let started = false
  const add = (tag, props) => document.head.appendChild(Object.assign(document.createElement(tag), props))
  const start = () => {
    if (started) return
    started = true
    // The stylesheet and the modules download side by side; the entry runs once the stylesheet is in.
    const css = add('link', { rel: 'stylesheet', href: me.dataset.css, crossOrigin: '' })
    for (const href of (me.dataset.preload || '').split(' ').filter(Boolean)) add('link', { rel: 'modulepreload', href, crossOrigin: '' })
    const entry = () => add('script', { type: 'module', src: me.dataset.entry, crossOrigin: '' })
    css.addEventListener('load', entry, { once: true }); css.addEventListener('error', entry, { once: true })
  }
  if (!shell || !root || document.documentElement.dataset.shell === 'off') { if (shell) shell.remove(); start(); return }

  shell.addEventListener('click', event => {
    const button = event.target instanceof Element && event.target.closest('button.fac-cta')
    if (!button) return
    window.__nightmailHomeStart = true
    button.setAttribute('aria-busy', 'true'); button.dataset.busy = ''
    start()
  })
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, start, { once: true, passive: true })
  const later = () => { if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1000 }); else setTimeout(start, 200) }
  const poster = [...shell.querySelectorAll('.fac-poster')].find(img => img.getClientRects().length)
  if (!poster || poster.complete) later()
  else { poster.addEventListener('load', later, { once: true }); poster.addEventListener('error', later, { once: true }) }
  setTimeout(start, 8000)

  // Anything but the homepage (and the moment's spinner before it) replaces the first screen at once.
  new MutationObserver((_, observer) => {
    const first = root.firstElementChild
    if (!shell.isConnected) return observer.disconnect()
    if (!first || first.matches('.boot-loader, .fac-page')) return
    shell.remove(); observer.disconnect()
  }).observe(root, { childList: true })
})()
