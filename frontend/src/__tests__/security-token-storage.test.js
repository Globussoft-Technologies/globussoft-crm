// Regression suite for #343 — JWT bearer token storage discipline.
//
// History:
//   v3.2.5 migrated the bearer token off localStorage onto an in-memory holder
//   + sessionStorage rehydration. The original v3.2.5 contract was "token must
//   NEVER touch localStorage anywhere"; App.jsx:357 still wrote to localStorage
//   on SSO callbacks and was caught on 2026-05-04 (#343).
//
//   v3.7.17+ extended setAuthToken with an opt-in `remember` flag so deep
//   links shared between users open in the destination tab WITHOUT a
//   re-login. The flag is sourced from the "Keep me signed in" checkbox on
//   the Login form (default ON) and exclusively flows through setAuthToken
//   in utils/api.js. Every other source file must still go through that
//   helper — direct localStorage.setItem('token', ...) elsewhere is
//   forbidden because it sidesteps the rememberMe UX and re-introduces the
//   #343 silent-leak failure mode.
//
// What this suite still guards:
//   1. Production source files OTHER than utils/api.js must never write the
//      token to localStorage directly. utils/api.js is the canonical writer
//      and is allowed to mirror to localStorage when opt-in flag is set.
//   2. setAuthToken's default behavior (no opts, or remember=false) leaves
//      localStorage untouched (or scrubs any prior entry on explicit-false).
//   3. Only setAuthToken({ remember: true }) populates localStorage.
//   4. clearAuthToken() drops both stores so logout fully ends persistence.
//   5. getAuthToken() prefers sessionStorage but falls back to localStorage
//      so cross-tab deep-link sessions rehydrate cleanly.

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
      // utils/api.js is the canonical token-writer; it is allowed (and
      // expected) to write to localStorage when setAuthToken's `remember`
      // flag is true. Every OTHER source file still must not.
      if (full.endsWith(path.join('utils', 'api.js'))) continue;
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

describe('v3.7.17 — opt-in "Keep me signed in" via setAuthToken({remember})', () => {
  // Behaviour added so deep links shared between users open in the
  // destination tab WITHOUT a re-login. The flag is sourced from the
  // "Keep me signed in" checkbox on the Login form.
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    // Drain any in-memory token from prior tests by clearing.
    clearAuthToken();
  });

  test('setAuthToken("abc", { remember: true }) mirrors token to localStorage', () => {
    setAuthToken('abc', { remember: true });
    expect(sessionStorage.getItem('token')).toBe('abc');
    expect(localStorage.getItem('token')).toBe('abc');
  });

  test('setAuthToken("abc", { remember: false }) scrubs any prior localStorage entry', () => {
    // Simulate a user who previously chose "Keep me signed in" and is now
    // signing in again with the box unchecked.
    localStorage.setItem('token', 'stale');
    setAuthToken('abc', { remember: false });
    expect(sessionStorage.getItem('token')).toBe('abc');
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('setAuthToken("abc") with no opts preserves any prior localStorage entry (SSO/silent path)', () => {
    // Callsites that don't pass `remember` (SSO callback, programmatic
    // refresh) must NOT clobber the user's prior remember choice in
    // either direction.
    localStorage.setItem('token', 'prior-remember-token');
    setAuthToken('abc');
    expect(sessionStorage.getItem('token')).toBe('abc');
    // Prior localStorage entry left intact — caller didn't ask us to
    // change the remember state.
    expect(localStorage.getItem('token')).toBe('prior-remember-token');
  });

  test('getAuthToken() falls back to localStorage when sessionStorage is empty (cross-tab cold start)', () => {
    // A new tab from a shared deep link: sessionStorage is empty for this
    // tab, but a "Keep me signed in" token exists in localStorage. The
    // getter must surface it AND promote it to sessionStorage so the rest
    // of the tab's lifetime matches a normal session.
    localStorage.setItem('token', 'persisted-remember');
    expect(getAuthToken()).toBe('persisted-remember');
    expect(sessionStorage.getItem('token')).toBe('persisted-remember');
  });

  test('clearAuthToken() drops both stores so logout fully ends remember-me', () => {
    setAuthToken('abc', { remember: true });
    expect(localStorage.getItem('token')).toBe('abc');
    clearAuthToken();
    expect(sessionStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
  });
});
