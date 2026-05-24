/**
 * subBrand.test.jsx — vitest unit coverage for
 * frontend/src/utils/subBrand.jsx (Travel active-sub-brand React context;
 * PRD §4.10 / Q25 "I'm working on TMC today" session-scoped switcher).
 *
 * Distinct from the sibling util at frontend/src/utils/travelSubBrand.js:
 *   - travelSubBrand.js (pure helper, tested 2026-05-24 commit 1a920ace):
 *       constants + label/background lookup functions. No state, no React.
 *   - subBrand.jsx (this SUT): React context + provider + `useActiveSubBrand`
 *       hook that holds the user's current "active sub-brand" preference in
 *       sessionStorage (per-tab, dies on close).
 *
 *   The two co-exist by design — travelSubBrand.js is the "what are the
 *   sub-brand IDs / colors / labels" surface; subBrand.jsx is the "which
 *   one is the user currently working in" surface. SUT header for
 *   travelSubBrand.js calls out "SUB_BRAND_IDS … keep these two in sync"
 *   which is exactly the cross-consistency invariant tested below.
 *
 * Exports under test:
 *   1. `ActiveSubBrandProvider` — React provider component
 *   2. `useActiveSubBrand()` — hook returning `{ activeSubBrand, setActiveSubBrand }`
 *   3. `VALID_SUB_BRANDS` — exported Set alias for the canonical id set
 *
 * Coverage:
 *   - Default value is `null` when sessionStorage empty
 *   - Reads valid stored value on mount (tmc / rfu / travelstall / visasure)
 *   - Ignores invalid stored value (returns null instead of garbage)
 *   - setActiveSubBrand(validId) updates context AND writes sessionStorage
 *   - setActiveSubBrand(null) / "" / undefined clears to null + removes key
 *   - setActiveSubBrand(garbage) is a no-op (defensive against URL-driven
 *     set calls per SUT inline comment)
 *   - VALID_SUB_BRANDS Set contains the 4 canonical ids — and matches the
 *     SUB_BRAND_IDS array in travelSubBrand.js (the cross-file invariant)
 *   - Hook used outside a provider returns the default no-op context shape
 *
 * Mocking discipline:
 *   - sessionStorage is jsdom-provided; we clear it in beforeEach for isolation.
 *   - No fetchApi / AuthContext / notify mocks needed — SUT has no external IO
 *     beyond sessionStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, renderHook } from '@testing-library/react';
import {
  ActiveSubBrandProvider,
  useActiveSubBrand,
  VALID_SUB_BRANDS,
} from '../utils/subBrand';
import { SUB_BRAND_IDS } from '../utils/travelSubBrand';

const STORAGE_KEY = 'travel.activeSubBrand';

beforeEach(() => {
  sessionStorage.clear();
});

describe('VALID_SUB_BRANDS', () => {
  it('is a Set with the 4 canonical sub-brand identifiers', () => {
    expect(VALID_SUB_BRANDS).toBeInstanceOf(Set);
    expect(VALID_SUB_BRANDS.size).toBe(4);
    for (const id of ['tmc', 'rfu', 'travelstall', 'visasure']) {
      expect(VALID_SUB_BRANDS.has(id)).toBe(true);
    }
  });

  it('matches the SUB_BRAND_IDS array in travelSubBrand.js (cross-file invariant)', () => {
    // SUT inline comment: "Matches the VALID_SUB_BRANDS Set in
    // frontend/src/utils/subBrand.jsx — keep these two in sync if the
    // canonical id set ever changes."
    const sortedIds = [...SUB_BRAND_IDS].sort();
    const sortedValid = [...VALID_SUB_BRANDS].sort();
    expect(sortedValid).toEqual(sortedIds);
  });
});

describe('useActiveSubBrand — outside a provider', () => {
  it('returns the default no-op context shape', () => {
    const { result } = renderHook(() => useActiveSubBrand());
    expect(result.current.activeSubBrand).toBeNull();
    expect(typeof result.current.setActiveSubBrand).toBe('function');
    // The default setter is a no-op — calling it must not throw.
    expect(() => result.current.setActiveSubBrand('tmc')).not.toThrow();
  });
});

describe('<ActiveSubBrandProvider /> — initial state', () => {
  const wrap = ({ children }) => <ActiveSubBrandProvider>{children}</ActiveSubBrandProvider>;

  it('defaults activeSubBrand to null when sessionStorage is empty', () => {
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    expect(result.current.activeSubBrand).toBeNull();
  });

  it('reads a valid stored value from sessionStorage on mount', () => {
    sessionStorage.setItem(STORAGE_KEY, 'tmc');
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    expect(result.current.activeSubBrand).toBe('tmc');
  });

  it('reads every canonical sub-brand id from storage', () => {
    for (const id of ['tmc', 'rfu', 'travelstall', 'visasure']) {
      sessionStorage.setItem(STORAGE_KEY, id);
      const { result, unmount } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
      expect(result.current.activeSubBrand).toBe(id);
      unmount();
      sessionStorage.clear();
    }
  });

  it('ignores an invalid stored value (returns null instead of garbage)', () => {
    sessionStorage.setItem(STORAGE_KEY, 'not-a-real-brand');
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    expect(result.current.activeSubBrand).toBeNull();
  });
});

describe('<ActiveSubBrandProvider /> — setActiveSubBrand()', () => {
  const wrap = ({ children }) => <ActiveSubBrandProvider>{children}</ActiveSubBrandProvider>;

  it('sets a valid sub-brand and persists it to sessionStorage', () => {
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    act(() => result.current.setActiveSubBrand('rfu'));
    expect(result.current.activeSubBrand).toBe('rfu');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('rfu');
  });

  it('switches between valid sub-brands', () => {
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    act(() => result.current.setActiveSubBrand('tmc'));
    expect(result.current.activeSubBrand).toBe('tmc');
    act(() => result.current.setActiveSubBrand('visasure'));
    expect(result.current.activeSubBrand).toBe('visasure');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('visasure');
  });

  it('clears the value (null) on explicit null', () => {
    sessionStorage.setItem(STORAGE_KEY, 'tmc');
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    expect(result.current.activeSubBrand).toBe('tmc');
    act(() => result.current.setActiveSubBrand(null));
    expect(result.current.activeSubBrand).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clears the value (null) on empty string', () => {
    sessionStorage.setItem(STORAGE_KEY, 'rfu');
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    act(() => result.current.setActiveSubBrand(''));
    expect(result.current.activeSubBrand).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clears the value (null) on undefined', () => {
    sessionStorage.setItem(STORAGE_KEY, 'travelstall');
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    act(() => result.current.setActiveSubBrand(undefined));
    expect(result.current.activeSubBrand).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('no-ops on garbage input (defensive against URL-driven set calls)', () => {
    const { result } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    act(() => result.current.setActiveSubBrand('tmc'));
    expect(result.current.activeSubBrand).toBe('tmc');
    act(() => result.current.setActiveSubBrand('not-a-real-brand'));
    // Value should NOT change — garbage is ignored, not stored.
    expect(result.current.activeSubBrand).toBe('tmc');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('tmc');
  });

  it('setActiveSubBrand reference is stable across renders (useCallback contract)', () => {
    const { result, rerender } = renderHook(() => useActiveSubBrand(), { wrapper: wrap });
    const first = result.current.setActiveSubBrand;
    rerender();
    const second = result.current.setActiveSubBrand;
    expect(first).toBe(second);
  });
});

describe('<ActiveSubBrandProvider /> — render integration', () => {
  function Consumer() {
    const { activeSubBrand } = useActiveSubBrand();
    return <div data-testid="active">{activeSubBrand ?? 'none'}</div>;
  }

  it('renders children and exposes the context value to deep consumers', () => {
    sessionStorage.setItem(STORAGE_KEY, 'travelstall');
    render(
      <ActiveSubBrandProvider>
        <div>
          <Consumer />
        </div>
      </ActiveSubBrandProvider>
    );
    expect(screen.getByTestId('active')).toHaveTextContent('travelstall');
  });

  it('renders "none" when no stored value', () => {
    render(
      <ActiveSubBrandProvider>
        <Consumer />
      </ActiveSubBrandProvider>
    );
    expect(screen.getByTestId('active')).toHaveTextContent('none');
  });
});
