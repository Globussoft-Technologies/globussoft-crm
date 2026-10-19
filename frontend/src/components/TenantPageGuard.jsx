import { useContext, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AuthContext } from "../appContexts";
import { fetchApi } from "../utils/api";
import WorkspacePreloader from "./WorkspacePreloader";

function pathIsHidden(pathname, hiddenPaths) {
  if (!pathname || !Array.isArray(hiddenPaths)) return false;
  return hiddenPaths.some(
    (hiddenPath) => pathname === hiddenPath || pathname.startsWith(`${hiddenPath}/`),
  );
}

/**
 * Tenant page availability guard.
 *
 * RoleGuard remains responsible for user/role permissions. This guard only
 * applies the organization-wide upper bound returned by /api/pages/me. It is
 * intentionally mounted inside Layout so users keep the normal shell while a
 * hidden deep link is replaced with a clear, non-leaking state.
 */
export default function TenantPageGuard({ children }) {
  const { tenant } = useContext(AuthContext) || {};
  const location = useLocation();
  const hasTenantId = Boolean(tenant?.id);
  const [hiddenPaths, setHiddenPaths] = useState([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!hasTenantId) {
      setHiddenPaths([]);
      setIsLoaded(true);
      return undefined;
    }
    let cancelled = false;
    setIsLoaded(false);
    fetchApi("/api/pages/me", { silent: true })
      .then((res) => {
        if (cancelled) return;
        setHiddenPaths(Array.isArray(res?.hiddenPaths) ? res.hiddenPaths : []);
        setIsLoaded(true);
      })
      .catch(() => {
        // An unavailable optional setting must not break an existing session.
        // Backend permission middleware still protects feature APIs.
        if (!cancelled) {
          setHiddenPaths([]);
          setIsLoaded(true);
        }
      });
    const onInvalidate = () => {
      fetchApi("/api/pages/me", { silent: true })
        .then((res) => {
          if (cancelled) return;
          setHiddenPaths(Array.isArray(res?.hiddenPaths) ? res.hiddenPaths : []);
        })
        .catch(() => {});
    };
    window.addEventListener("sidebar:pages-changed", onInvalidate);
    return () => {
      cancelled = true;
      window.removeEventListener("sidebar:pages-changed", onInvalidate);
    };
  }, [hasTenantId, tenant?.id]);

  // A real authenticated tenant always has an id. Keep the guard inert for
  // shell-only renderers and transitional auth states that do not have one
  // yet; those states cannot resolve tenant-specific visibility safely.
  if (!hasTenantId) return children;

  if (isLoaded && pathIsHidden(location.pathname, hiddenPaths)) {
    return (
      <div
        data-testid="tenant-page-disabled"
        role="region"
        aria-label="Page unavailable"
        style={{
          minHeight: "60vh",
          display: "grid",
          placeItems: "center",
          padding: "2rem",
          textAlign: "center",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ maxWidth: 520 }}>
          <h2 style={{ marginBottom: "0.5rem" }}>Page unavailable</h2>
          <p style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
            This page is not enabled for your organization. Contact your organization administrator if you need access.
          </p>
        </div>
      </div>
    );
  }

  if (!isLoaded) {
    if (tenant?.vertical === "generic") {
      return <WorkspacePreloader label="Loading organization access..." />;
    }
    return (
      <div
        role="status"
        aria-label="Loading organization access"
        style={{
          minHeight: "60vh",
          display: "grid",
          placeItems: "center",
          padding: "2rem",
          color: "var(--text-secondary)",
        }}
      >
        Loading organization access...
      </div>
    );
  }

  return children;
}
