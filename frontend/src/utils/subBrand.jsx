// Travel CRM — active-sub-brand context (PRD §4.10 / Q25).
//
// Tiny session-persisted state holder for the "I'm working on TMC today"
// shortcut. Travel pages (Leads, Dashboard tiles, Reports) can pre-seed
// their own subBrand filter from this context, so the user picks ONCE
// and the whole vertical respects it.
//
// Storage: sessionStorage (per-tab, dies on close). Persistent
// preference would belong on User.preferences (server-side) — that's
// a follow-up; sessionStorage is the minimum useful Phase 1 ship.
//
// Reading: `useActiveSubBrand()` → returns the current value or `null`
// when no preference set (= "show everything I have access to").
// Writing: `setActiveSubBrand(value)` from the same hook.
//
// Pages remain responsible for actually narrowing their data fetches
// by this value — the switcher is a SUGGESTION, not an enforcement
// mechanism. Server-side sub-brand access (User.subBrandAccess +
// the getSubBrandAccessSet middleware) is the authoritative gate.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "travel.activeSubBrand";
const VALID = new Set(["tmc", "rfu", "travelstall", "visasure"]);

const ActiveSubBrandContext = createContext({
  activeSubBrand: null,
  setActiveSubBrand: () => {},
});

export function ActiveSubBrandProvider({ children }) {
  const [value, setValue] = useState(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      return VALID.has(stored) ? stored : null;
    } catch {
      return null;
    }
  });

  // Persist on change. Wrapping in try/catch because some browsers throw
  // on sessionStorage in private mode.
  useEffect(() => {
    try {
      if (value && VALID.has(value)) sessionStorage.setItem(STORAGE_KEY, value);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* swallow */ }
  }, [value]);

  const setActiveSubBrand = useCallback((next) => {
    if (next === null || next === "" || next == null) {
      setValue(null);
      return;
    }
    if (!VALID.has(next)) {
      // No-op on garbage input — defensive against URL-driven set calls.
      return;
    }
    setValue(next);
  }, []);

  const ctx = useMemo(() => ({ activeSubBrand: value, setActiveSubBrand }), [value, setActiveSubBrand]);
  return (
    <ActiveSubBrandContext.Provider value={ctx}>
      {children}
    </ActiveSubBrandContext.Provider>
  );
}

export function useActiveSubBrand() {
  return useContext(ActiveSubBrandContext);
}

export { VALID as VALID_SUB_BRANDS };
