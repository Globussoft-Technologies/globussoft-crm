// Lazy reference to the notify API. Set by NotifyProvider on mount via
// registerGlobalNotify() so this module — which loads BEFORE React renders —
// can still surface errors in a toast without an import cycle.
let _globalNotify = null;
export function registerGlobalNotify(notify) {
  _globalNotify = notify;
}

// ---------------------------------------------------------------------------
// #343 [SECURITY] In-memory JWT holder.
//
// Pre-fix: the bearer token lived in localStorage, so any XSS on any page
// could exfiltrate it (`localStorage.getItem('token')`) and use it for ~30
// days against the API. Tenant.ownerEmail and the user object also lived
// in localStorage; those are still PII but not credentials.
//
// This round (smallest meaningful hardening that ships):
//   - Token is held in a module-level variable (`_inMemoryToken`).
//   - On login, AuthContext mirrors it to sessionStorage so a hard refresh
//     of the SPA can rehydrate the token without forcing a re-login.
//   - sessionStorage clears when the browser tab/window closes — so the
//     token no longer persists across browser restarts the way localStorage
//     did. That removes the "30-day stolen token from a coffee-shop laptop"
//     class of attack.
//   - Logout clears both the in-memory holder and sessionStorage.
//
// HONEST CAVEAT: XSS still wins here — the token is in JS scope and
// readable by any script that runs in this origin. The real fix is an
// httpOnly cookie set by the server on /auth/login plus a CSRF token,
// fetch credentials: 'include' on every call, and a server-side logout
// that clears the cookie. That's a multi-day cross-stack change tracked
// in TODOS.md as a long-term wishlist item. This round is the half-step
// that ships today.
// ---------------------------------------------------------------------------
let _inMemoryToken = null;

// "Keep me signed in" — opt-in cross-tab token persistence.
//
// Default (remember=false): token lives in memory + sessionStorage only.
// sessionStorage is tab-scoped, which means deep links opened in NEW tabs
// land on /login instead of the requested page — the tab can't see the
// originating tab's session. Acceptable for short, focused work sessions
// on a shared/public device.
//
// Opt-in (remember=true): token ALSO mirrored to localStorage. New tabs
// rehydrate from localStorage on cold start, so shared deep links land on
// the requested page without a re-login. Cost: XSS can still exfiltrate
// the token from localStorage; we accept that risk for users who chose
// the "Keep me signed in" UX.
//
// The flag is passed by Login.jsx (checkbox state) on successful auth.
// Callsites that don't pass it (SSO callback, programmatic token install)
// leave the localStorage entry alone — they don't change a user's prior
// remember choice in either direction.
export function setAuthToken(token, opts = {}) {
  _inMemoryToken = token || null;
  try {
    if (token) {
      sessionStorage.setItem('token', token);
    } else {
      sessionStorage.removeItem('token');
    }
  } catch {
    /* sessionStorage may be disabled in private mode; in-memory still works */
  }
  // `remember` is a tri-state: true → enable persistence; false → explicitly
  // turn it off (clears any prior "remember" entry); undefined → preserve
  // the caller's prior choice. The Login form always passes a boolean; SSO
  // and silent-refresh paths pass undefined.
  if (typeof opts.remember === 'boolean') {
    try {
      if (opts.remember && token) {
        localStorage.setItem('token', token);
      } else {
        localStorage.removeItem('token');
      }
    } catch {
      /* ignore */
    }
  }
}

export function getAuthToken() {
  if (_inMemoryToken) return _inMemoryToken;
  // Cold start: try sessionStorage first (same-tab hard-refresh case),
  // then fall back to localStorage for users who chose "Keep me signed in".
  // When we find one in localStorage, promote it to sessionStorage so this
  // tab's subsequent reads stay fast and stay aligned with the in-memory
  // copy.
  try {
    const fromSession = sessionStorage.getItem('token');
    if (fromSession) {
      _inMemoryToken = fromSession;
      return fromSession;
    }
  } catch {
    /* ignore */
  }
  try {
    const fromLocal = localStorage.getItem('token');
    if (fromLocal) {
      _inMemoryToken = fromLocal;
      try { sessionStorage.setItem('token', fromLocal); } catch { /* ignore */ }
      return fromLocal;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearAuthToken() {
  _inMemoryToken = null;
  try {
    sessionStorage.removeItem('token');
  } catch {
    /* ignore */
  }
  // Always clear localStorage too — logout fully ends the "Keep me signed
  // in" persistence (and scrubs any legacy pre-#343 token).
  try {
    localStorage.removeItem('token');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// #347 [API] Auth-ready gate.
//
// On a fresh page load, AuthContext mounts and synchronously rehydrates the
// token from sessionStorage. But several components fire fetches in their
// own mount effects, racing the AuthContext mount — those calls would go out
// without an Authorization header and 403. AuthProvider now blocks rendering
// children behind a `loading` flag, but as a defence-in-depth fix we also
// expose a `tokenReady` Promise here so any code path that bypasses the gate
// (e.g. a util fetched at import time) can still wait.
// ---------------------------------------------------------------------------
let _resolveTokenReady;
let _tokenReady = new Promise((resolve) => { _resolveTokenReady = resolve; });

export function markAuthReady() {
  if (_resolveTokenReady) {
    _resolveTokenReady();
    _resolveTokenReady = null;
  }
}

export function whenAuthReady() {
  return _tokenReady;
}

// #555 (HI-06): the explicit tenant switcher writes the chosen tenantId
// into localStorage.activeTenantId. Every API call mirrors it into the
// X-Active-Tenant header so the backend can disambiguate cross-tenant
// requests once a UserTenant join table lands. Today (single-tenant per
// user) the backend ignores values that don't match the JWT's tenantId,
// so a stale value won't break anything.
export function getActiveTenantId() {
  try {
    const raw = localStorage.getItem('activeTenantId');
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setActiveTenantId(id) {
  try {
    if (id == null) localStorage.removeItem('activeTenantId');
    else localStorage.setItem('activeTenantId', String(id));
  } catch {
    /* ignore */
  }
}

// Pages can opt OUT of the auto-toast by passing { silent: true }. Useful for
// background polls and probe requests where a transient failure shouldn't
// bother the user.
export const fetchApi = async (url, options = {}) => {
  const token = getAuthToken();
  // FormData carries its own multipart boundary in the Content-Type header,
  // which the browser sets on send. Forcing application/json here would clobber
  // that boundary and the backend would parse zero fields. Detect FormData
  // and let the browser pick the header.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Attach the active tenant header on every authed request.
  const activeTenantId = getActiveTenantId();
  if (activeTenantId != null && !headers['X-Active-Tenant']) {
    headers['X-Active-Tenant'] = String(activeTenantId);
  }

  const { silent, ...fetchOpts } = options;

  let response;
  try {
    response = await fetch(url, { ...fetchOpts, headers });
  } catch (networkErr) {
    // No response at all — DNS failure, offline, CORS, etc.
    const msg = 'Network error — check your connection and try again.';
    if (!silent && _globalNotify) _globalNotify.error(msg);
    const err = new Error(msg);
    err.cause = networkErr;
    err.network = true;
    throw err;
  }

  if (!response.ok) {
    if (response.status === 401) {
      // #841 — background polls (Sidebar counters, dashboard refresh, queue
      // pollers, etc.) pass {silent:true}. Before this fix, ANY 401 — even from
      // a polling fetch that raced a token-rotation — force-navigated the user
      // to /login mid-flow. Users clicking an in-app link would land on the
      // login page because a sibling poll 401'd in the same tick.
      //
      // Foreground (user-initiated) requests still hard-redirect: a genuine
      // expired session must boot the user out. Background polls fail silently;
      // the next foreground request will surface the real 401 and redirect.
      clearAuthToken();
      if (!silent) {
        window.location.href = '/login';
        // Throw anyway so awaiting callers don't continue past this point.
        throw new Error('Session expired — please sign in again.');
      }
      const err = new Error('Unauthorized');
      err.status = 401;
      err.silent = true;
      throw err;
    }

    // #275: backend returns { error, code } (not { message }). Read both so
    // pre-existing { message } responses still surface their text. The auto-
    // toast at this level means even pages that don't .catch() see feedback.
    const errData = await response.json().catch(() => ({}));
    const serverMsg = errData.error || errData.message;
    const errorCode = errData.code || `HTTP_${response.status}`;
    let userMsg;
    if (response.status === 403) {
      // RBAC errors return a technical "requires module.action" string that's
      // not meaningful to end users. Detect the canonical RBAC codes and
      // surface a friendly fixed message instead. The raw err.message stays
      // on the thrown Error for any caller that wants the technical detail
      // (logging, dev consoles); only the user-facing toast is rewritten.
      if (errData.code === 'RBAC_DENIED' || errData.code === 'CUSTOMER_ACCESS_DENIED' || errData.code === 'PERMISSION_CHECK_FAILED') {
        userMsg = "You don't have permission to do this. Please contact your administrator if you need access.";
      } else {
        userMsg = serverMsg || 'You don’t have permission to do that.';
      }
    } else if (response.status === 404) {
      userMsg = serverMsg || 'Not found.';
    } else if (response.status >= 500) {
      // Never surface the raw server error text for a 5xx — it can be a raw
      // Prisma/driver message (column names, table names, connection
      // strings) that leaks internals to whoever's looking at the screen.
      // The error CODE is safe (an enum-like string, no data) and is what a
      // developer needs to correlate this toast with the matching backend
      // log line — so it rides along in small print / the console, not the
      // headline message.
      //
      // Two different 5xx shapes reach here, and they mean different things:
      //   - errData.code present ("REFUND_FAILED", "GATEWAY_UNAVAILABLE", …) —
      //     our OWN route handler ran, modeled the failure, and returned a
      //     structured { error, code } body. serverMsg is safe, specific,
      //     app-authored copy (never raw driver/SDK text) — show it.
      //   - errData.code absent (response.json() returned {} because the
      //     body wasn't JSON, or had no .code) — the request likely never
      //     reached our route handler at all: an infra-level 502/503/504
      //     from Nginx/PM2 (mid-deploy, backend restarting, briefly
      //     unreachable). The generic "something went wrong" text is
      //     genuinely correct there, but framed as a retry-shortly blip
      //     rather than an app error, since that's what it usually is.
      if (errData.code && serverMsg) {
        userMsg = serverMsg;
      } else if (response.status === 502 || response.status === 503 || response.status === 504) {
        userMsg = 'The server was temporarily unreachable (probably mid-deploy or restarting). Please wait a few seconds and try again.';
      } else {
        userMsg = 'Something went wrong on our end. Please try again — if it keeps happening, contact support.';
      }
      console.error(`[api] ${response.status} ${errorCode} on ${url}:`, serverMsg || '(no server message)');
    } else {
      userMsg = serverMsg || `Request failed (${response.status}).`;
    }

    if (!silent && _globalNotify) {
      // Append the error code in the toast for 5xx so a dev (or a user
      // screenshotting for support) can see it without opening DevTools —
      // it's a stable enum string, safe to show, and short enough to not
      // clutter the toast.
      const toastMsg = response.status >= 500 ? `${userMsg} (${errorCode})` : userMsg;
      _globalNotify.error(toastMsg);
    }
    const err = new Error(userMsg);
    err.status = response.status;
    err.code = errData.code || null;
    err.serverMessage = serverMsg || null;
    err.data = errData;
    throw err;
  }

  if (options.method === 'DELETE' || response.status === 204) {
    return true;
  }

  return response.json();
};
