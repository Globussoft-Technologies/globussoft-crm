import { useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { AuthContext } from "../appContexts";
import { fetchApi } from "../utils/api";
import AccessDenied from "./AccessDenied";

// The backend page catalog is the shared contract for all verticals. Keep a
// small token-keyed cache here so the Layout guard and the Sidebar do not
// create a request on every route change.
const pageCache = new Map();
const pageRequests = new Map();
const pageCacheVersions = new Map();

function loadAccessiblePages(token) {
  if (!token) return Promise.resolve(null);
  if (pageCache.has(token)) return Promise.resolve(pageCache.get(token));
  if (pageRequests.has(token)) return pageRequests.get(token);

  const version = pageCacheVersions.get(token) || 0;
  let request;
  request = Promise.all([
    fetchApi("/api/pages/me", { silent: true }),
    fetchApi("/api/pages/catalog", { silent: true }),
  ])
    .then(([accessibleResponse, catalogResponse]) => {
      if (!Array.isArray(accessibleResponse?.pages) || !Array.isArray(catalogResponse?.catalog)) {
        throw new Error("Page catalog is unavailable");
      }
      const result = {
        accessible: accessibleResponse.pages,
        catalog: catalogResponse.catalog,
      };
      // A permission update may have invalidated this request while it was
      // pending. Never let its old grant set replace the newer one.
      if (pageCacheVersions.get(token) === version && pageRequests.get(token) === request) {
        pageCache.set(token, result);
      }
      return result;
    })
    .finally(() => {
      if (pageRequests.get(token) === request) pageRequests.delete(token);
    });
  pageRequests.set(token, request);
  return request;
}

function invalidateAccessiblePageCache(token) {
  if (token) {
    pageCache.delete(token);
    pageCacheVersions.set(token, (pageCacheVersions.get(token) || 0) + 1);
    // A role update can arrive while the previous catalog request is still
    // pending. Do not let that stale promise repopulate the cache after the
    // permission-change event.
    pageRequests.delete(token);
  } else {
    pageCache.clear();
    pageRequests.clear();
    pageCacheVersions.clear();
  }
}

function findPageForPath(pages, pathname) {
  if (!Array.isArray(pages) || !pathname) return null;
  return pages
    .filter((page) => {
      const path = page?.path;
      return path && (pathname === path || pathname.startsWith(`${path}/`));
    })
    .sort((left, right) => right.path.length - left.path.length)[0] || null;
}

/**
 * Applies the server's permission-filtered page catalog to every route inside
 * the authenticated Layout. Routes that are not represented in the catalog
 * (profile, detail pages, legacy utilities) are intentionally left alone.
 *
 * A catalog failure does not replace a working page with a false denial. The
 * API middleware remains the security boundary; this component only keeps
 * the UI from mounting a page that the catalog explicitly says is unavailable.
 */
export default function PageAccessGuard({ children }) {
  const { token } = useContext(AuthContext) || {};
  const { pathname } = useLocation();
  const [state, setState] = useState(() => ({
    token,
    pages: null,
    catalog: null,
    loading: Boolean(token),
    failed: false,
  }));
  const refreshSequenceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const requestSequence = ++refreshSequenceRef.current;
    const commit = (nextState, sequence = requestSequence) => {
      if (!cancelled && sequence === refreshSequenceRef.current) setState(nextState);
    };

    if (!token) {
      commit({ token: null, pages: null, catalog: null, loading: false, failed: false });
      return undefined;
    }

    const cached = pageCache.get(token);
    if (cached) {
      commit({ token, pages: cached.accessible, catalog: cached.catalog, loading: false, failed: false });
    } else {
      commit({ token, pages: null, catalog: null, loading: true, failed: false });
      loadAccessiblePages(token)
        .then(({ accessible, catalog }) => {
          commit({ token, pages: accessible, catalog, loading: false, failed: false });
        })
        .catch(() => {
          commit({ token, pages: null, catalog: null, loading: false, failed: true });
        });
    }

    const onPermissionChange = () => {
      invalidateAccessiblePageCache(token);
      const nextSequence = ++refreshSequenceRef.current;
      setState({ token, pages: null, catalog: null, loading: true, failed: false });
      loadAccessiblePages(token)
        .then(({ accessible, catalog }) => {
          commit({ token, pages: accessible, catalog, loading: false, failed: false }, nextSequence);
        })
        .catch(() => {
          commit({ token, pages: null, catalog: null, loading: false, failed: true }, nextSequence);
        });
    };
    window.addEventListener("sidebar:pages-changed", onPermissionChange);
    return () => {
      cancelled = true;
      window.removeEventListener("sidebar:pages-changed", onPermissionChange);
    };
  }, [token]);

  // Do not render a protected page while its effective permission set is
  // resolving. This avoids the old pattern where the page mounted, fired
  // requests, and then showed a generic 403 toast.
  if (token && (state.token !== token || state.loading)) return null;

  // Keep the application available during a catalog outage. Explicit API
  // permission middleware still protects the data and mutations.
  if (!token || state.failed || state.token !== token || !Array.isArray(state.pages)) {
    return children;
  }

  const catalogPage = findPageForPath(state.catalog, pathname);
  if (!catalogPage) return children;
  const page = findPageForPath(state.pages, pathname);
  if (!page) {
    const permission = catalogPage.requiredPermissions?.[0];
    return <AccessDenied permission={permission} />;
  }

  return children;
}

export { findPageForPath, invalidateAccessiblePageCache };
