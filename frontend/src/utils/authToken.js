let inMemoryToken = null;

export function setAuthToken(token, opts = {}) {
  inMemoryToken = token || null;
  try {
    if (token) sessionStorage.setItem('token', token);
    else sessionStorage.removeItem('token');
  } catch {
    // sessionStorage can be unavailable; the in-memory copy still works.
  }

  if (typeof opts.remember === 'boolean') {
    try {
      if (opts.remember && token) localStorage.setItem('token', token);
      else localStorage.removeItem('token');
    } catch {
      // Storage can be unavailable in hardened browser contexts.
    }
  }
}

export function getAuthToken() {
  if (inMemoryToken) return inMemoryToken;
  try {
    const fromSession = sessionStorage.getItem('token');
    if (fromSession) {
      inMemoryToken = fromSession;
      return fromSession;
    }
  } catch {
    // Continue to the opt-in persistent copy.
  }
  try {
    const fromLocal = localStorage.getItem('token');
    if (fromLocal) {
      inMemoryToken = fromLocal;
      try { sessionStorage.setItem('token', fromLocal); } catch { /* ignore */ }
      return fromLocal;
    }
  } catch {
    // No available token store.
  }
  return null;
}

export function clearAuthToken() {
  inMemoryToken = null;
  try { sessionStorage.removeItem('token'); } catch { /* ignore */ }
  try { localStorage.removeItem('token'); } catch { /* ignore */ }
}
