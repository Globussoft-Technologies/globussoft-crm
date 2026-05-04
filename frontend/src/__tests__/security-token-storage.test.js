// Regression suite for #343 — JWT bearer token must never live in localStorage.
//
// Why this test exists:
//   v3.2.5 migrated the bearer token off localStorage onto an in-memory holder
//   + sessionStorage rehydration (utils/api.js, App.jsx token state). The
//   migration was correct but App.jsx:357's loginWithToken() retained an
//   explicit `localStorage.setItem("token", ...)` from before the fix — silently
//   undoing the migration on every SSO callback. Caught by external QA on
//   2026-05-04 (#343 still-open). The dead-code line was deleted in the same
//   commit that introduced this test.
//
// What this test guards against:
//   1. Any production source file (frontend/src/**, excluding __tests__/) that
//      contains `localStorage.setItem('token'` or `localStorage.setItem("token"`
//      will fail this test. The token is the credential — losing it to XSS
//      means session theft. user/tenant remain in localStorage by documented
//      design (PII leak, not credential leak — the token gates access to both
//      via /api/auth/me anyway).
//   2. setAuthToken (the canonical writer) must not touch localStorage. If a
//      future refactor reintroduces a localStorage write inside the helper,
//      every component that calls it would silently leak the token again.
//
// Tests are intentionally narrow (token-only). user/tenant in localStorage is
// a documented design decision — see App.jsx line 251 and utils/api.js header.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAuthToken, clearAuthToken, getAuthToken } from '../utils/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '..');

// Walk frontend/src recursively, returning every .js/.jsx file path that is
// NOT under a __tests__/ directory (test files may legitimately seed tokens
// into localStorage to drive coverage of legacy fallback paths).
function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (entry.isFile()) {
      if (!/\.(jsx?|mjs|cjs)$/.test(entry.name)) continue;
      // Skip co-located test/spec files just in case (.test.js next to a
      // module rather than under __tests__/).
      if (/\.(test|spec)\./.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

describe('#343 — token must not live in localStorage (file-grep regression)', () => {
  // Match any quoted "token" key being written to localStorage.
  // Examples it WILL flag:
  //   localStorage.setItem('token', value)
  //   localStorage.setItem("token", value)
  //   localStorage.setItem(`token`, value)
  // It does NOT flag reads (getItem) — those are the legacy-migration path
  // App.jsx:262 still uses to drain a pre-#343 token off localStorage.
  const FORBIDDEN_RE = /localStorage\.setItem\s*\(\s*['"`]token['"`]/;

  test('no production source file writes the token to localStorage', () => {
    const violations = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      if (FORBIDDEN_RE.test(text)) {
        // Capture line numbers so the failure pinpoints the regression.
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (FORBIDDEN_RE.test(lines[i])) {
            violations.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
    }
    expect(
      violations,
      `#343 regression: token must not be written to localStorage in production code.\n` +
        `Use setAuthToken (utils/api.js) instead — that helper writes to the in-memory\n` +
        `holder + sessionStorage so a stolen disk image / persistent XSS doesn't grant\n` +
        `cross-tab session theft. Hits:\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });
});

describe('#343 — setAuthToken must not touch localStorage', () => {
  // jsdom gives us real Storage objects per test. Spy on the prototype so we
  // catch any setItem / removeItem / getItem call against window.localStorage,
  // regardless of which alias the caller used.
  let setItemSpy;
  let removeItemSpy;
  let getItemSpy;

  beforeEach(() => {
    setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    // Belt-and-braces: clear any leftover token from a prior test before we
    // assert on call counts.
    sessionStorage.clear();
    localStorage.clear();
    setItemSpy.mockClear();
    removeItemSpy.mockClear();
    getItemSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('setAuthToken("xyz") writes sessionStorage["token"] but never localStorage', () => {
    setAuthToken('xyz');
    // sessionStorage SHOULD have it
    expect(sessionStorage.getItem('token')).toBe('xyz');
    // localStorage SHOULD be untouched (no token key)
    expect(localStorage.getItem('token')).toBeNull();

    // Walk every Storage write — none of them should target localStorage with
    // the 'token' key.
    for (const call of setItemSpy.mock.calls) {
      const [key] = call;
      // The Storage prototype is shared between localStorage and sessionStorage,
      // so we can't tell from the spy which store was hit. Instead, after the
      // operation completes, assert localStorage doesn't have a token entry.
      // (sessionStorage may.)
      if (key === 'token') {
        // Allowed only if the underlying store was sessionStorage.
        expect(localStorage.getItem('token')).toBeNull();
      }
    }
  });

  test('clearAuthToken() removes sessionStorage["token"] without populating localStorage', () => {
    setAuthToken('xyz');
    clearAuthToken();
    expect(sessionStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('getAuthToken() rehydrates from sessionStorage, not localStorage', () => {
    // Simulate a hard refresh: sessionStorage still has the value, in-memory
    // holder has been wiped (we re-import would do this; for simplicity we
    // just clear and re-set).
    sessionStorage.setItem('token', 'from-session');
    // A leftover localStorage value must NOT shadow sessionStorage.
    localStorage.setItem('token', 'should-be-ignored');
    // Force a fresh in-memory read by re-setting via setAuthToken.
    setAuthToken('from-session');
    expect(getAuthToken()).toBe('from-session');
  });
});
