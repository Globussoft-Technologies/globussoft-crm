import { useContext, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { AuthContext } from "../App";
import { usePermissions } from "../hooks/usePermissions";

/**
 * RoleGuard — route-level RBAC gate.
 *
 * Two checking modes (per call) — only one needs to apply, both can be
 * supplied for belt-and-braces:
 *  - Permission mode (preferred): `requiredPermission={{module, action}}` or
 *    `requiredPermissions=[{module, action}, …]`. Passes when the user has
 *    ALL listed permissions in their effective grant set (resolved via the
 *    same /api/auth/me/permissions cache `usePermissions` uses). This is
 *    the mode that aligns with the page-catalog gating in Sidebar.jsx —
 *    any role (system or custom) whose permissions overlap the page's
 *    requiredPermissions passes the gate.
 *  - Role mode (legacy): `allow={["ADMIN", "MANAGER", ...]}`. Hard-codes
 *    against the user's User.role string. Kept for info-disclosure routes
 *    that don't yet have a clean permission mapping (audit-log, settings,
 *    field-permissions) — those will migrate later.
 *
 * Two render modes:
 *  - Strict (default): silently redirect away from the route.
 *    Used for info-disclosure-sensitive routes like /audit-log, /staff,
 *    /field-permissions, /settings — even the chrome of the page would leak
 *    internal model names / pipelines, so we never mount it. (#589 / #574.)
 *  - In-place locked empty state (`lockedInPlace`): mount a friendly locked
 *    panel WHERE the user navigated, so the URL bar stays put and the user
 *    keeps context. Used for the wellness/marketing manager-or-admin family
 *    (#721 / #727). Denials do not emit a redundant error toast.
 *
 * Auth-loading safety: when the AuthContext is still rehydrating (`loading`
 * true), the user object is null AFTER loading completes, OR permissions
 * are still resolving on first render, we DO NOT fire the toast + DO NOT
 * redirect — that would surface a misleading "you don't have access"
 * message to a user whose session simply hadn't finished loading. Instead
 * we render a silent splash; the AuthContext provider upstream is
 * responsible for bouncing to /login if the token is gone.
 *
 * Props:
 *   requiredPermission   — {module, action}              single perm required
 *   requiredPermissions  — Array<{module, action}>       all perms required (AND)
 *   allow                — string | string[]             legacy role-string gate
 *   children             — React node                    the protected page
 *   feature              — string (optional)             user-facing feature label,
 *                                                        e.g. "Gift Cards". Drives
 *                                                        the locked-panel
 *                                                        heading copy.
 *   roles                — string (optional)             user-facing role list
 *                                                        (legacy mode only).
 *   message              — string (optional)             accepted for legacy call-site
 *                                                        compatibility; not displayed.
 *   redirectTo           — string (default /dashboard)   where to send the user
 *                                                        in strict mode.
 *   lockedInPlace        — bool (default false)          opt-in in-place panel.
 */
const ROLE_LABELS = {
  ADMIN: "admin",
  MANAGER: "manager",
  USER: "staff",
};

function humaniseRoles(allow) {
  const arr = Array.isArray(allow) ? allow : [allow];
  const labels = arr.map((r) => ROLE_LABELS[r] || String(r).toLowerCase());
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

export default function RoleGuard({
  allow,
  requiredPermission,
  requiredPermissions,
  children,
  redirectTo = "/dashboard",
  feature,
  roles,
  lockedInPlace = false,
}) {
  const auth = useContext(AuthContext) || {};
  const { user, loading, token } = auth;
  const { hasAllPermissions, isReady: permissionsReady } = usePermissions();
  const role = user?.role;

  // Permission mode wins when present — it's the more granular check and
  // aligns with the page catalog. Falls back to legacy `allow` role-string
  // matching only when no permission props are supplied.
  const permsList = useMemo(() => {
    if (Array.isArray(requiredPermissions) && requiredPermissions.length > 0) {
      return requiredPermissions;
    }
    if (
      requiredPermission &&
      requiredPermission.module &&
      requiredPermission.action
    ) {
      return [requiredPermission];
    }
    return null;
  }, [requiredPermission, requiredPermissions]);

  const permissionMode = permsList !== null;
  const allowed = permissionMode
    ? hasAllPermissions(permsList)
    : Array.isArray(allow)
      ? allow.includes(role)
      : role === allow;

  // #721 auth-loading safety: don't deny access while the session is still
  // rehydrating, OR when we're in permission mode but the perms
  // haven't finished resolving yet. The upstream provider already gates
  // initial render on `loading`, but a corrupted/race-y session can leave
  // user=null after loading completes; firing the access toast in that
  // case is the most likely repro for the user's "ADMIN sees manager-
  // access toast" report.
  const sessionReady =
    !loading && !!user && !!role && (!permissionMode || permissionsReady);

  // Session not ready → render nothing yet (or fall through to children if
  // there's no token; the route-level Layout wrapper handles the /login bounce).
  if (!sessionReady) {
    // If we have neither loading nor a token, App.jsx's Layout wrapper will
    // already have redirected to /login. We render nothing rather than
    // toasting a misleading role denial.
    if (!token && !loading) {
      return null;
    }
    return null;
  }

  if (allowed) return children;

  // In-place locked panel (#721 / #727 UX): keep the user on the URL they
  // navigated to + show a friendly explanation instead of a silent redirect.
  if (lockedInPlace) {
    return (
      <LockedPanel
        feature={feature}
        rolesText={permissionMode ? null : roles || humaniseRoles(allow)}
      />
    );
  }

  // Strict mode — redirect (legacy /audit-log family).
  return <Navigate to={redirectTo} replace />;
}

/**
 * LockedPanel — in-place "you don't have access" empty state. Renders inside
 * the same <main> the page would have used so the URL stays intact and the
 * sidebar/header chrome remain visible. No KPI leakage, no internal model
 * names — only the human label + role requirement.
 */
function LockedPanel({ feature, rolesText }) {
  const heading = feature
    ? `${feature} is restricted`
    : "This page is restricted";
  const body = rolesText
    ? `You need ${rolesText} access to view this page. Contact your administrator to request access.`
    : "Contact your administrator to request access.";
  return (
    <div
      role="region"
      aria-label={heading}
      data-testid="role-guard-locked-panel"
      style={{
        padding: "3rem 2rem",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        minHeight: "60vh",
        color: "var(--text-primary)",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: "var(--subtle-bg-3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "1rem",
        }}
      >
        <Lock size={28} aria-hidden="true" />
      </div>
      <h2
        style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}
      >
        {heading}
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          maxWidth: 480,
          lineHeight: 1.5,
        }}
      >
        {body}
      </p>
    </div>
  );
}
