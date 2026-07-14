/**
 * superAdminApi.js — fetch helper for the Super Admin Portal.
 *
 * Deliberately separate from utils/api.js's fetchApi: the Super Admin token
 * is stored under its own localStorage key (never mixed with the regular
 * app JWT) and 401s redirect to /super-admin/login, not the main /login.
 */

const TOKEN_KEY = "superAdminToken";
const USERNAME_KEY = "superAdminUsername";

export function getSuperAdminToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSuperAdminSession(token, username) {
  localStorage.setItem(TOKEN_KEY, token);
  if (username) localStorage.setItem(USERNAME_KEY, username);
}

export function getSuperAdminUsername() {
  return localStorage.getItem(USERNAME_KEY);
}

export function clearSuperAdminSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export async function superAdminFetch(path, options = {}) {
  const token = getSuperAdminToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api/super-admin${path}`, { ...options, headers });

  // A 401 on /auth/login means "wrong credentials", not "session expired" —
  // there's no prior session to expire. Only treat 401 as a dead session
  // when we actually sent a token (i.e. this wasn't a login attempt).
  if (res.status === 401 && token) {
    clearSuperAdminSession();
    if (!window.location.pathname.endsWith("/login")) {
      window.location.href = "/super-admin/login";
    }
    throw new Error("Super Admin session expired");
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // no body / non-JSON response
  }

  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.code = body && body.code;
    throw err;
  }

  return body;
}
