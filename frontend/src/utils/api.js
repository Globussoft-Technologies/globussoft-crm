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

export function setAuthToken(token) {
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
}

export function getAuthToken() {
  if (_inMemoryToken) return _inMemoryToken;
  // Cold start after a hard refresh: rehydrate from sessionStorage. We
  // intentionally do NOT read localStorage — we're migrating off it.
  try {
    const fromSession = sessionStorage.getItem('token');
    if (fromSession) {
      _inMemoryToken = fromSession;
      return fromSession;
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
  // Belt-and-braces: scrub any legacy token stuck in localStorage from
  // a pre-#343 build / older session, so it can't be picked up later.
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

// Pages can opt OUT of the auto-toast by passing { silent: true }. Useful for
// background polls and probe requests where a transient failure shouldn't
// bother the user.
export const fetchApi = async (url, options = {}) => {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
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
      clearAuthToken();
      window.location.href = '/login';
      // Throw anyway so awaiting callers don't continue past this point.
      throw new Error('Session expired — please sign in again.');
    }

    // #275: backend returns { error, code } (not { message }). Read both so
    // pre-existing { message } responses still surface their text. The auto-
    // toast at this level means even pages that don't .catch() see feedback.
    const errData = await response.json().catch(() => ({}));
    const serverMsg = errData.error || errData.message;
    let userMsg;
    if (response.status === 403) {
      userMsg = serverMsg || 'You don’t have permission to do that.';
    } else if (response.status === 404) {
      userMsg = serverMsg || 'Not found.';
    } else if (response.status >= 500) {
      userMsg = serverMsg || 'Server error — please try again.';
    } else {
      userMsg = serverMsg || `Request failed (${response.status}).`;
    }

    if (!silent && _globalNotify) _globalNotify.error(userMsg);
    const err = new Error(userMsg);
    err.status = response.status;
    err.code = errData.code || null;
    err.data = errData;
    throw err;
  }

  if (options.method === 'DELETE' || response.status === 204) {
    return true;
  }

  return response.json();
};
