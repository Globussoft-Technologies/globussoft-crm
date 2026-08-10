import { useCallback, useContext, useMemo } from "react";
import { UNSAFE_NavigationContext } from "react-router-dom";

const noop = () => {};

const fallbackLocation = { pathname: "/", search: "", hash: "", state: null };

/**
 * Drop-in replacement for react-router's useNavigate that returns a no-op
 * when the component is rendered outside a <Router>. This lets presentational
 * components call navigate() in unit tests without wrapping every test in a
 * router, while preserving full navigation behaviour in the real app.
 *
 * Signature matches useNavigate: navigate(to, { state?, replace? }?)
 */
export function useNavigateSafe() {
  const { navigator } = useContext(UNSAFE_NavigationContext) || {};

  const navigate = useCallback((to, options = {}) => {
    if (!navigator) return;
    if (typeof to === "number") {
      navigator.go(to);
      return;
    }
    const { state, replace } = options;
    if (replace && typeof navigator.replace === "function") {
      navigator.replace(to, state);
    } else if (typeof navigator.push === "function") {
      navigator.push(to, state);
    }
  }, [navigator]);

  return navigator ? navigate : noop;
}

/**
 * Drop-in replacement for react-router's useLocation that returns a safe
 * fallback location object when rendered outside a <Router>. This lets
 * components read query params in unit tests without a MemoryRouter wrapper.
 */
export function useLocationSafe() {
  const { navigator } = useContext(UNSAFE_NavigationContext) || {};

  return useMemo(() => {
    if (navigator && navigator.location) {
      return navigator.location;
    }
    if (typeof window !== "undefined") {
      return {
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
        state: null,
      };
    }
    return fallbackLocation;
  }, [navigator]);
}
