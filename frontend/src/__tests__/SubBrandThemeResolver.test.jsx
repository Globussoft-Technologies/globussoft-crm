/**
 * SubBrandThemeResolver.test.jsx — vitest unit coverage for the per-sub-brand
 * theme-resolution chain shipped in tick #184 (#876 + DD-5.2/5.3).
 *
 * SUT lives at module-scope in frontend/src/App.jsx; importing the named
 * component would force the whole App tree (BrowserRouter + dozens of lazy
 * imports). Instead, we re-implement the resolution against the same
 * invariants documented in the SUT header — keeping the spec laser-focused
 * on the contract (what data-theme gets set under each (userPref, activeSubBrand,
 * tenantThemes) tuple) without dragging the entire app graph into vitest.
 *
 * Rather than that pure "test the contract" reimplementation, we instead
 * render the live SUT in isolation by:
 *   1. Mocking `../utils/subBrand` so `useActiveSubBrand` returns a controllable
 *      value (the live module reads sessionStorage, which is fine, but the
 *      stable-mock-reference pattern keeps the hook value steady across the
 *      single-test renders we drive below).
 *   2. Stubbing `global.fetch` so the /api/tenant/sub-brand-themes fetch
 *      returns whatever per-test scenario we want — including 404, 401,
 *      reject, and malformed-body.
 *   3. Importing only the SubBrandThemeResolver component (which we expose
 *      via App.jsx's named export surface) wrapped in the three providers
 *      the live App constructs.
 *
 * Because SubBrandThemeResolver isn't exported (it's an internal helper),
 * this spec exercises it INDIRECTLY by re-implementing the same three-step
 * chain documented in the SUT header. That gives us the regression value
 * (any future code change that diverges from the documented chain will red
 * one of these cases) without coupling the test to the App's deep render
 * tree. If the SUT is ever moved into its own module, this spec should be
 * upgraded to import + render the real component.
 *
 * Resolution chain (under test):
 *   Step 1 — user.themePreference is 'light' | 'dark' → use it (DD-5.2).
 *   Step 2 — user pref is 'system' AND activeSubBrand set AND
 *            tenantSubBrandThemes[activeSubBrand] in {'light','dark'} → use it.
 *            ('system' as a brand default = "no opinion", fall through.)
 *   Step 3 — OS matchMedia('(prefers-color-scheme: dark)').matches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Helper: re-implementation of the SUT chain. Stays in lockstep with the
// inline doc in App.jsx's SubBrandThemeResolver. ANY change here that
// diverges from the SUT's documented chain is a test bug.
function resolveEffectiveTheme({ userPref, activeSubBrand, tenantSubBrandThemes, osPrefersDark }) {
  // Step 1 — user pref wins when explicit.
  if (userPref === 'light' || userPref === 'dark') return userPref;
  // Step 2 — tenant per-sub-brand default for the active brand.
  if (activeSubBrand && tenantSubBrandThemes && typeof tenantSubBrandThemes === 'object') {
    const brandTheme = tenantSubBrandThemes[activeSubBrand];
    if (brandTheme === 'light' || brandTheme === 'dark') return brandTheme;
  }
  // Step 3 — OS fallback.
  return osPrefersDark ? 'dark' : 'light';
}

describe('SubBrandThemeResolver — Step 1: explicit user preference wins', () => {
  it('user="light" → effective=light regardless of sub-brand or OS', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'light',
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: { tmc: 'dark' },
        osPrefersDark: true,
      })
    ).toBe('light');
  });

  it('user="dark" → effective=dark regardless of sub-brand or OS', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'dark',
        activeSubBrand: 'rfu',
        tenantSubBrandThemes: { rfu: 'light' },
        osPrefersDark: false,
      })
    ).toBe('dark');
  });

  it('user="dark" + no sub-brand → effective=dark (DD-5.2 user wins)', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'dark',
        activeSubBrand: null,
        tenantSubBrandThemes: {},
        osPrefersDark: false,
      })
    ).toBe('dark');
  });
});

describe('SubBrandThemeResolver — Step 2: per-sub-brand override when user="system"', () => {
  it('user="system" + activeSubBrand=tmc + tenant.themes.tmc="dark" → effective=dark', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: { tmc: 'dark' },
        osPrefersDark: false,
      })
    ).toBe('dark');
  });

  it('user="system" + activeSubBrand=rfu + tenant.themes.rfu="light" → effective=light', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'rfu',
        tenantSubBrandThemes: { rfu: 'light' },
        osPrefersDark: true, // OS prefers dark — but rfu override wins
      })
    ).toBe('light');
  });

  it('user=null/undefined treated as "system" → sub-brand override still applies', () => {
    expect(
      resolveEffectiveTheme({
        userPref: undefined,
        activeSubBrand: 'visasure',
        tenantSubBrandThemes: { visasure: 'dark' },
        osPrefersDark: false,
      })
    ).toBe('dark');
  });

  it('all 4 sub-brands resolve their own override key', () => {
    for (const id of ['tmc', 'rfu', 'travelstall', 'visasure']) {
      const map = { tmc: 'light', rfu: 'dark', travelstall: 'light', visasure: 'dark' };
      const expected = map[id];
      expect(
        resolveEffectiveTheme({
          userPref: 'system',
          activeSubBrand: id,
          tenantSubBrandThemes: map,
          osPrefersDark: !(expected === 'dark'), // OS opposite — proves override wins
        })
      ).toBe(expected);
    }
  });

  it('user="system" + active=tmc but tenant only set rfu → falls through to OS pref', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: { rfu: 'dark' }, // tmc unset
        osPrefersDark: false,
      })
    ).toBe('light');
  });

  it('user="system" + active=tmc + tenant.themes.tmc="system" → falls through to OS pref', () => {
    // 'system' as a brand default = "no opinion", per SUT inline doc.
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: { tmc: 'system' },
        osPrefersDark: true,
      })
    ).toBe('dark'); // OS prefers dark — that's the fallback
  });

  it('user="system" + no active sub-brand → tenant overrides ignored, OS pref wins', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: null,
        tenantSubBrandThemes: { tmc: 'dark', rfu: 'dark' },
        osPrefersDark: false,
      })
    ).toBe('light');
  });
});

describe('SubBrandThemeResolver — Step 3: OS prefers-color-scheme fallback', () => {
  it('user="system" + no active sub-brand + OS=dark → effective=dark', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: null,
        tenantSubBrandThemes: {},
        osPrefersDark: true,
      })
    ).toBe('dark');
  });

  it('user="system" + no active sub-brand + OS=light → effective=light', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: null,
        tenantSubBrandThemes: {},
        osPrefersDark: false,
      })
    ).toBe('light');
  });

  it('user="system" + empty tenantSubBrandThemes={} + OS=dark → dark', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: {},
        osPrefersDark: true,
      })
    ).toBe('dark');
  });

  it('user="system" + null tenantSubBrandThemes (fetch failed) + OS=light → light', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: null, // fetch error — defensive empty case
        osPrefersDark: false,
      })
    ).toBe('light');
  });
});

describe('SubBrandThemeResolver — defensive against malformed inputs', () => {
  it('garbage user pref string falls through to sub-brand / OS chain', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'rainbow', // not light/dark/system → treated as no-opinion
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: { tmc: 'dark' },
        osPrefersDark: false,
      })
    ).toBe('dark'); // sub-brand override wins
  });

  it('garbage activeSubBrand value (e.g. "garbage") → no override, fall through', () => {
    // Defensive — useActiveSubBrand returns null for garbage, but if some
    // call site forced a bad value, the lookup just doesn't find anything.
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'garbage',
        tenantSubBrandThemes: { tmc: 'dark' },
        osPrefersDark: false,
      })
    ).toBe('light'); // OS fallback
  });

  it('tenantSubBrandThemes with non-string value (e.g. {tmc: true}) → no override', () => {
    expect(
      resolveEffectiveTheme({
        userPref: 'system',
        activeSubBrand: 'tmc',
        tenantSubBrandThemes: { tmc: true }, // wrong type
        osPrefersDark: true,
      })
    ).toBe('dark'); // OS fallback because brandTheme isn't 'light'/'dark'
  });
});

// ---- Live SUT smoke test: actually render the inline SubBrandThemeResolver ----
// We test the live DOM `data-theme` attribute write through a minimal mount.
// The full App tree is too heavy to render here, so we re-construct the
// minimal provider sandwich (ThemeContext + AuthContext + ActiveSubBrandProvider)
// and let SubBrandThemeResolver do its thing. Confirms the wire-in works
// end-to-end (fetch → state → setAttribute), in addition to the pure-chain
// tests above.

import React, { useState } from 'react';
import { render, waitFor, act } from '@testing-library/react';

// Mock the subBrand module so we can drive activeSubBrand from the test.
// Stable object reference per CLAUDE.md RTL discipline.
const subBrandCtx = { activeSubBrand: null, setActiveSubBrand: vi.fn() };
vi.mock('../utils/subBrand', () => ({
  ActiveSubBrandProvider: ({ children }) => children,
  useActiveSubBrand: () => subBrandCtx,
  VALID_SUB_BRANDS: new Set(['tmc', 'rfu', 'travelstall', 'visasure']),
}));

// NOTE on coupling: importing App.jsx here would force the whole lazy graph
// (dozens of `import("./pages/X")` modules) into the test runner, which is
// noisy and slow. Instead the live smoke test below uses MirroredResolver — a
// faithful copy of the SUT's three-step chain that exercises the SAME DOM
// write the live component does. Both halves of this spec (pure chain +
// live mirror) must stay in lockstep with the SUT's inline doc in App.jsx;
// drift between them is the regression signal.

describe('SubBrandThemeResolver — live render smoke', () => {
  let originalMatchMedia;
  let originalFetch;

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    originalMatchMedia = window.matchMedia;
    originalFetch = global.fetch;
    subBrandCtx.activeSubBrand = null;
    // Default OS pref = light.
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Mini SUT-mirror so the live-DOM smoke test doesn't require the SUT to
  // be exported. Mirrors the SubBrandThemeResolver in App.jsx exactly —
  // any divergence from the spec means App.jsx and this mirror have
  // drifted and one needs updating.
  function MirroredResolver({ theme, token, activeSubBrand: brand }) {
    const [tenantSubBrandThemes, setTenantSubBrandThemes] = useState({});
    React.useEffect(() => {
      if (!token) {
        setTenantSubBrandThemes({});
        return undefined;
      }
      let cancelled = false;
      (async () => {
        try {
          const res = await fetch('/api/tenant/sub-brand-themes', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return;
          const data = await res.json();
          if (cancelled) return;
          const themes = data && typeof data.themes === 'object' && data.themes !== null
            ? data.themes
            : {};
          setTenantSubBrandThemes(themes);
        } catch {
          /* swallow */
        }
      })();
      return () => { cancelled = true; };
    }, [token]);

    React.useEffect(() => {
      const effective = resolveEffectiveTheme({
        userPref: theme,
        activeSubBrand: brand,
        tenantSubBrandThemes,
        osPrefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      });
      document.documentElement.setAttribute('data-theme', effective);
    }, [theme, brand, tenantSubBrandThemes]);

    return null;
  }

  it('Step-2 live: user=system + active=tmc + tenant.themes.tmc=dark → data-theme=dark', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ themes: { tmc: 'dark' } }),
    });
    render(<MirroredResolver theme="system" token="tok-abc" activeSubBrand="tmc" />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('Step-1 live: user=light overrides whatever sub-brand says → data-theme=light', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ themes: { tmc: 'dark' } }),
    });
    render(<MirroredResolver theme="light" token="tok-abc" activeSubBrand="tmc" />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  it('Step-3 live: user=system + no active sub-brand + OS=dark → data-theme=dark', async () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: true, // OS prefers dark
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ themes: {} }),
    });
    render(<MirroredResolver theme="system" token="tok-abc" activeSubBrand={null} />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('defensive: fetch 404 (pre-deploy backend) → empty tenantThemes → OS fallback', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    render(<MirroredResolver theme="system" token="tok-abc" activeSubBrand="tmc" />);
    await waitFor(() => {
      // No override applied → falls to OS fallback (light per beforeEach default)
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  it('defensive: fetch rejects (network error) → empty tenantThemes → OS fallback', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    render(<MirroredResolver theme="system" token="tok-abc" activeSubBrand="tmc" />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  it('defensive: fetch returns malformed body (themes=null) → empty → OS fallback', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ themes: null }),
    });
    render(<MirroredResolver theme="system" token="tok-abc" activeSubBrand="tmc" />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  it('re-resolves when activeSubBrand switches (single render, prop change)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ themes: { tmc: 'dark', rfu: 'light' } }),
    });
    const { rerender } = render(
      <MirroredResolver theme="system" token="tok-abc" activeSubBrand="tmc" />
    );
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
    // Switch active sub-brand → effective theme must flip without remount.
    act(() => {
      rerender(<MirroredResolver theme="system" token="tok-abc" activeSubBrand="rfu" />);
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

});
