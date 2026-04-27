// Lazy reference to the notify API. Set by NotifyProvider on mount via
// registerGlobalNotify() so this module — which loads BEFORE React renders —
// can still surface errors in a toast without an import cycle.
let _globalNotify = null;
export function registerGlobalNotify(notify) {
  _globalNotify = notify;
}

// Pages can opt OUT of the auto-toast by passing { silent: true }. Useful for
// background polls and probe requests where a transient failure shouldn't
// bother the user.
export const fetchApi = async (url, options = {}) => {
  const token = localStorage.getItem('token');
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
      localStorage.removeItem('token');
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
