// The dashboard's storage keys were bane.* before the rename. Move each to its nightmail.* name before anything reads
// it, so the theme, privacy mode, region, workspace and this tab's account carry over. A bane.* key that appears again
// was written since by a tab still on an older build, so it is the newer value. The support panel (features/support)
// still keeps its conversations under bane.support.*.
;(() => {
  for (const area of ['localStorage', 'sessionStorage']) {
    let storage, old = []
    try { storage = window[area]; for (let i = 0; i < storage.length; i++) old.push(storage.key(i)) } catch { continue }
    for (const key of old) {
      if (!key?.startsWith('bane.') || key.startsWith('bane.support.')) continue
      try { storage.setItem('nightmail.' + key.slice('bane.'.length), storage.getItem(key)); storage.removeItem(key) } catch {}
    }
  }
})()

;(() => {
  let saved = null
  try { saved = localStorage.getItem('nightmail.theme') } catch {}
  const theme = saved === 'light' || saved === 'dark'
    ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  // The browser's own bars (a phone's status bar, Safari's toolbar) take the page's frame colour.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', theme === 'dark' ? '#080808' : '#FAFAFA')
})()

// Start the session check while the app's scripts download. The app (data/live.ts) takes these
// responses over, and only when the account and workspace headers match what it would have sent itself.
// The account is this tab's (sessionStorage); a new tab asks as the browser default account.
;(() => {
  const path = location.pathname, query = new URLSearchParams(location.search)
  if (path === '/docs' || path.startsWith('/docs/') || query.get('invitation') || query.get('account')) return
  let account = null, workspace = null, ready = null
  try { account = sessionStorage.getItem('nightmail.account'); workspace = account && localStorage.getItem('nightmail.workspace:' + account); ready = localStorage.getItem('nightmail.dashboard-ready') } catch {}
  const header = '%HEADER_PREFIX%' // api/src/brand.ts's headerPrefix, filled in by vite.config.ts
  const start = url => {
    const response = fetch(url, { credentials: 'include', headers: { Accept: 'application/json', ...(account ? { [header + 'Account']: account } : {}), ...(workspace ? { [header + 'Workspace']: workspace } : {}) } })
    response.catch(() => {}) // The app awaits the real rejection; this only silences the unhandled one.
    return response
  }
  const responses = { '/v1/me': start('/v1/me') }
  // The public homepage check, for visitors whose workspace is not remembered as ready.
  if (path === '/' && ready !== (workspace ?? '*')) responses['/health'] = start('/health')
  window.__nightmailEarly = { account, workspace: workspace || null, at: Date.now(), responses }
})()
