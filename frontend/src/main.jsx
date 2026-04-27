import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/responsive.css'
import App from './App.jsx'

const rootEl = document.getElementById('root')
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// #284: mount watchdog. If for any reason React fails to render the app
// (silent chunk-load failure swallowed by Suspense, an early throw past the
// boundary, an extension stomping on the bootstrap, etc.), the user sees a
// blank gradient and is stuck unless they manually hard-reload.
//
// Watchdog: 4 seconds after bootstrap, if #root is still empty AND we
// haven't already auto-reloaded this session, force one reload. Guarded by
// sessionStorage so a genuinely-broken build can't get into a reload loop —
// the user will then see the RouteErrorBoundary fallback (or the blank page
// if the failure is upstream of the boundary, but at most once per session).
const WATCHDOG_MS = 4000
const WATCHDOG_KEY = 'mountWatchdogReloaded'
setTimeout(() => {
  try {
    if (!rootEl) return
    if (rootEl.children.length > 0) return
    if (sessionStorage.getItem(WATCHDOG_KEY)) return
    sessionStorage.setItem(WATCHDOG_KEY, '1')
    // Also clear lazyChunkReloaded so a subsequent stale-chunk recovery can fire.
    sessionStorage.removeItem('lazyChunkReloaded')
    console.warn('[mount-watchdog] #root empty after', WATCHDOG_MS, 'ms — reloading')
    window.location.reload()
  } catch {
    /* swallow — watchdog must never throw */
  }
}, WATCHDOG_MS)

// Clear the watchdog flag on a successful render (next macrotask, after React
// has flushed). This way a one-off transient failure that the watchdog rescued
// doesn't permanently disable the watchdog for the rest of the session.
queueMicrotask(() => {
  setTimeout(() => {
    if (rootEl && rootEl.children.length > 0) {
      sessionStorage.removeItem(WATCHDOG_KEY)
    }
  }, WATCHDOG_MS + 500)
})
