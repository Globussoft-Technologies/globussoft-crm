import {
  Fragment,
  useContext,
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  useCallback,
} from "react";
import { NavLink, useLocation } from "react-router-dom";
import { io } from "socket.io-client";
import {
  Users,
  LayoutDashboard,
  Briefcase,
  Settings,
  LifeBuoy,
  Send,
  Inbox as InboxIcon,
  BarChart3,
  Code,
  FileDigit,
  Database,
  Network,
  Target,
  CheckSquare,
  UserPlus,
  Building2,
  Receipt,
  Ticket,
  UsersRound,
  FileText,
  FileSpreadsheet,
  FolderKanban,
  DollarSign,
  Trophy,
  ShoppingBag,
  Radio,
  PanelTop,
  Calendar,
  Shield,
  ShieldCheck,
  ScrollText,
  GitBranch,
  TrendingUp,
  BookOpen,
  PenTool,
  ClipboardList,
  MessageSquare,
  Eye,
  BadgePercent,
  Bot,
  FileSignature,
  Award,
  CreditCard,
  Sparkles,
  ExternalLink,
  PhoneCall,
  Stethoscope,
  HeartPulse,
  Bell,
  Clock,
  Crown,
  Wallet as WalletIcon,
  Gift,
  TicketPercent,
  Coins,
  Loader2,
  // Wave 11 Agent HH — Inventory backbone admin entries
  Layers,
  Truck,
  ArrowDownToLine,
  Recycle,
  Package,
  // Wave 2 Agent II — POS / Cash Register / Shift / Sale
  Calculator,
  // Used by the dynamic page-catalog → sidebar icon lookup for /portal
  UserCircle,
} from "lucide-react";
import { AuthContext } from "../App";
import { fetchApi } from "../utils/api";
import { launchAdsGptAs, ADSGPT_DASHBOARD } from "../utils/adsgpt";
import { launchCallifiedSSO } from "../utils/callified";
import { useNotify } from "../utils/notify";
import { usePermissions } from "../hooks/usePermissions";

// T2.1: focus trap selector. Limited to actually-focusable elements inside the
// drawer (anchors, buttons, [tabindex]). Used by the focus-trap effect below
// when the drawer is open at <900px so Tab cycles within the drawer instead of
// escaping to the (visually hidden) main content.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

const Sidebar = ({
  mobileOpen = false,
  onMobileClose = () => {},
  isMobileViewport = false,
}) => {
  const { user, tenant } = useContext(AuthContext);
  const notify = useNotify();
  const role = user?.role || "USER";
  const isAdmin = role === "ADMIN";
  const isManager = role === "ADMIN" || role === "MANAGER";
  const wellnessRole = user?.wellnessRole || null;
  // RBAC: fine-grained permission gate for new sidebar entries. Legacy
  // adminOnly / managerOnly / wellnessRoles continue to work as before;
  // requiredPermission stacks on top — only hides an entry once permissions
  // have RESOLVED (permissionsReady) so admin users don't see a flash of an
  // empty sidebar during the first 100ms of /auth/me/permissions resolving.
  const {
    hasPermission,
    isReady: permissionsReady,
    permissions,
  } = usePermissions();
  const isWellness = tenant?.vertical === "wellness";
  const location = useLocation();

  // T2.1: ref to the <aside> so the focus-trap effect below can locate
  // focusable descendants. Also used to read the drawer's bounding rect for
  // the click-outside check on the backdrop.
  const asideRef = useRef(null);

  // T2.1 (extends #228): ESC closes the mobile drawer (a11y). Also auto-close
  // on route change so navigating from the drawer doesn't leave it stuck open
  // over the destination page.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") onMobileClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onMobileClose]);

  useEffect(() => {
    if (mobileOpen) onMobileClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // T2.1: focus trap + initial-focus. When the drawer opens at <900px, move
  // focus to the first focusable element inside it (skipping the brand
  // header which has no interactive elements) and intercept Tab/Shift-Tab so
  // focus cycles within the drawer. Closing the drawer returns focus to the
  // hamburger — that side is handled in Layout.jsx via toggleRef.
  useEffect(() => {
    if (!mobileOpen || !isMobileViewport) return undefined;
    const aside = asideRef.current;
    if (!aside) return undefined;

    // Initial focus — defer one frame so the slide-in transition has started
    // and the element is actually visible / scrollable into view.
    const focusables = () =>
      Array.from(aside.querySelectorAll(FOCUSABLE_SELECTOR));
    const initialFocusFrame = requestAnimationFrame(() => {
      const first = focusables()[0];
      first?.focus();
    });

    const onTabKey = (e) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      // Shift-Tab on first → wrap to last
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
        return;
      }
      // Tab on last → wrap to first
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onTabKey);
    return () => {
      cancelAnimationFrame(initialFocusFrame);
      document.removeEventListener("keydown", onTabKey);
    };
  }, [mobileOpen, isMobileViewport]);

  // #392: Live sidebar counters. Previously counters were stale until
  // a manual page reload (initial-fetch-on-mount only). Strategy:
  //   1. One initial fetch on mount populates the badges.
  //   2. Subscribe to the same socket events the rest of the app uses
  //      (deal_updated, marketplace_lead_imported, marketplace_lead_new,
  //      booking_created) and bump the relevant counters locally.
  //   3. Re-fetch every 60s as a fallback in case a socket event is
  //      missed (nginx not proxying socket.io, brief disconnects).
  const [counts, setCounts] = useState({
    leads: 0,
    tasks: 0,
    tickets: 0,
    inbox: 0,
  });
  // #529 / #530 (BUG-001): pen-test observed 390+ requests in 2 minutes
  // against the four sidebar count endpoints when the dashboard was idle —
  // ~3/sec instead of the 4/min the 60s polling interval implies. Root
  // cause: the previous shape took `user` (an object reference from
  // AuthContext) as a useCallback + useEffect dep. Because AuthContext's
  // provider re-creates its value object on every App render (no useMemo),
  // every consumer sees `user` as a "new reference" each time, even
  // though the underlying user.id never changed. That cascaded into:
  //   1. refreshCounts useCallback re-creates (new fn ref)
  //   2. useEffect cleanup runs (clearInterval + socket.disconnect)
  //   3. useEffect body runs again — fires refreshCounts() AND opens a
  //      fresh socket AND sets a new 60s interval
  // Anything in the parent tree that re-rendered (notifications, route
  // change, theme toggle, in-flight fetches) thus fired four extra HTTP
  // requests + a socket reconnect. On a busy page that adds up fast.
  //
  // Two-part fix:
  //   • refreshCounts moves into a ref so the function identity stays
  //     stable across renders (the body still closes over the latest
  //     in-memory state).
  //   • useEffect depends only on `user?.id` — a primitive that's stable
  //     across re-renders unless the actual user changes. Cleanup +
  //     re-mount fires once per real session change, not per render.
  //
  // The pen-test's secondary observation about retry-on-400 was wrong
  // about cause: fetchApi has no retry logic (utils/api.js), and the
  // three filter values (status=Lead / PENDING / OPEN) are all accepted
  // by the backend (Lead matches contacts enum, tasks normalises
  // PENDING→Pending per #436, tickets ignores ?status entirely). The
  // storm was 100% the dep-cycle re-mount loop above.
  const refreshCountsRef = useRef(null);
  refreshCountsRef.current = async () => {
    if (!user) return;
    const safeLen = (p) =>
      p
        .then((r) => (Array.isArray(r) ? r.length : (r?.total ?? 0)))
        .catch(() => null);
    // #509: pass {silent:true} so transient 503s on these background polls
    // don't pile up "Server error" toasts. safeLen's .catch(()=>null) already
    // keeps previous count on failure; the toast was redundant noise. The
    // fetchApi docstring at utils/api.js:107-109 explicitly recommends
    // {silent} for background-poll callsites.
    const [leads, tasks, tickets, inbox] = await Promise.all([
      safeLen(fetchApi("/api/contacts?status=Lead", { silent: true })),
      safeLen(fetchApi("/api/tasks?status=PENDING", { silent: true })),
      safeLen(fetchApi("/api/tickets?status=OPEN", { silent: true })),
      safeLen(fetchApi("/api/email?unread=1", { silent: true })),
    ]);
    setCounts((prev) => ({
      leads: leads ?? prev.leads,
      tasks: tasks ?? prev.tasks,
      tickets: tickets ?? prev.tickets,
      inbox: inbox ?? prev.inbox,
    }));
  };
  // Stable wrapper for socket / interval handlers — they call through the
  // ref so the latest closure runs but the function identity itself never
  // changes. Lint-disable: the dep array intentionally omits the ref
  // (refs are stable by React contract).
  const refreshCounts = useCallback(() => {
    if (refreshCountsRef.current) refreshCountsRef.current();
  }, []);

  // Simple debounce helper for socket events (v3.7.16 perf fix)
  // Prevents rapid socket events (e.g. bulk import) from triggering
  // 50+ NavLink re-evaluations. Debounce horizon is 300ms — batches
  // events closer than 300ms apart into one re-render.
  const createDebouncedSetter = (delay = 300) => {
    let timeoutId = null;
    let pendingUpdates = null;
    return (updateFn) => {
      pendingUpdates = updateFn;
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (pendingUpdates) pendingUpdates();
        pendingUpdates = null;
      }, delay);
    };
  };
  const debouncedSetCounts = useRef(createDebouncedSetter(300)).current;

  useEffect(() => {
    if (!user) return;
    refreshCounts();
    // 60s safety-net polling — covers cases where the socket can't connect
    // (nginx without /socket.io proxy) or events are missed during reconnects.
    const intervalId = setInterval(refreshCounts, 60000);

    // Live socket bumps — using the same single-namespace io('/') pattern as
    // NotificationBell. Failures are silent so the polling fallback owns
    // correctness. (v3.7.16: socket events are now debounced to reduce
    // re-renders from rapid bulk imports).
    const socket = io("/", { reconnection: false, timeout: 5000 });
    socket.on("connect_error", () => {});
    socket.on("error", () => {});
    socket.on("marketplace_lead_imported", () =>
      debouncedSetCounts(() =>
        setCounts((c) => ({ ...c, leads: c.leads + 1 })),
      ),
    );
    socket.on("marketplace_lead_new", (p) =>
      debouncedSetCounts(() =>
        setCounts((c) => ({ ...c, leads: c.leads + (p?.count || 1) })),
      ),
    );
    socket.on("email_received", () =>
      debouncedSetCounts(() =>
        setCounts((c) => ({ ...c, inbox: c.inbox + 1 })),
      ),
    );
    socket.on("lead_created", () =>
      debouncedSetCounts(() =>
        setCounts((c) => ({ ...c, leads: c.leads + 1 })),
      ),
    );
    socket.on("task_created", () =>
      debouncedSetCounts(() =>
        setCounts((c) => ({ ...c, tasks: c.tasks + 1 })),
      ),
    );
    socket.on("ticket_created", () =>
      debouncedSetCounts(() =>
        setCounts((c) => ({ ...c, tickets: c.tickets + 1 })),
      ),
    );
    // Generic invalidation event — any module can emit and we re-fetch.
    socket.on("sidebar_counts_changed", () => refreshCounts());

    // #625: cross-component invalidation via DOM CustomEvent. Pages that
    // mutate tasks/tickets/etc. dispatch `sidebar:counts-changed` on window
    // to force the badge to re-fetch — the existing socket event above only
    // covers `*_created` (no server emit on `*_completed` today). Listening
    // here means a Tasks-page completion ripples into the Sidebar without a
    // page reload (the audit-trail bug in #625).
    const onLocalInvalidate = () => refreshCounts();
    window.addEventListener("sidebar:counts-changed", onLocalInvalidate);

    return () => {
      clearInterval(intervalId);
      socket.disconnect();
      window.removeEventListener("sidebar:counts-changed", onLocalInvalidate);
    };
    // Depend only on user?.id — a primitive that ONLY changes on real
    // login/logout. refreshCounts is now a stable useCallback (deps: []).
    // exhaustive-deps WANTS the full `user` object here; depending on it
    // is exactly the bug the storm-fix above unwound.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, refreshCounts]);

  // #625 (FIXED v3.7.16): re-fetch sidebar counters when the route changes.
  // Previous logic: (original mount fetch + 60s polling) + route-change fetch.
  // Issue: 4 unnecessary API calls on every navigation, causing sidebar lag.
  // New logic: 60s polling + socket events cover normal use cases. Cross-page
  // mutations (mark task complete, navigate away) can wait for the next 60s
  // tick or socket event. Clients who need immediate visibility use the
  // window.dispatchEvent('sidebar:counts-changed') invalidation mechanism
  // (line 298) which is already wired in forms/modals. Removing this effect
  // eliminates ~4 requests per navigation.
  // Disabled to improve sidebar performance — 60s safety interval covers stale reads.
  // If stale reads resurface, re-enable with higher debounce (5s instead of immediate).

  // #151: persist sidebar scroll across re-renders. The browser usually does this
  // for free, but route-driven re-renders sometimes cause the nav to reset to top
  // (reproducible via items in the lower part of the sidebar). useLayoutEffect
  // restores the saved scrollTop synchronously after every render, so users keep
  // the position they last scrolled to.
  const navRef = useRef(null);
  const scrollRef = useRef(0);
  useLayoutEffect(() => {
    if (navRef.current && scrollRef.current > 0) {
      navRef.current.scrollTop = scrollRef.current;
    }
  }, []);
  const brand = tenant?.name || "Globussoft";
  const logoUrl = tenant?.logoUrl || null;
  const brandColor = tenant?.brandColor || null;
  // Inline style applied to wellness section labels — overrides the gold
  // accent (#E0A68B) defined in wellness.css when a tenant brand color is set.
  const sectionLabelStyle = brandColor
    ? { ...sectionLabel, color: brandColor }
    : sectionLabel;

  // #631: defensive active-state. Some users reported /deal-insights,
  // /document-templates, /reports rendering without the active highlight
  // even though NavLink's isActive should catch them. We OR the NavLink
  // signal with an explicit segment-boundary startsWith check on the
  // current pathname so any future NavLink behavior shift (e.g. someone
  // adding `end` for a sibling) can't silently regress these top-level
  // entries. The segment boundary (next char is `/` or end-of-string)
  // prevents `/reports` from incorrectly matching `/reports-foo`.
  const segmentMatches = (current, target) => {
    if (current === target) return true;
    if (!current.startsWith(target)) return false;
    const tail = current[target.length];
    return tail === "/" || tail === undefined;
  };
  const Link = ({
    to,
    icon: Icon,
    label,
    adminOnly,
    managerOnly,
    wellnessRoles,
    requiredPermission,
    count,
    matchPaths = [],
  }) => {
    if (adminOnly && !isAdmin) return null;
    if (managerOnly && !isManager) return null;
    // wellnessRoles gates a link to specific wellnessRole values. Managers
    // and admins always pass through (mirrors the server's verifyWellnessRole
    // gate which whitelists admin/manager alongside the named clinical roles).
    if (wellnessRoles && !isManager && !wellnessRoles.includes(wellnessRole))
      return null;
    // RBAC permission gate. Only HIDE once permissions have resolved so admin
    // users don't see a flash of an empty sidebar during the first frame of
    // /auth/me/permissions resolving. After the answer arrives, an entry with
    // `requiredPermission={{module, action}}` is hidden when the user lacks
    // that grant. Stacks ON TOP of the legacy gates above — if a link sets
    // both `adminOnly` and `requiredPermission`, both must pass.
    if (
      requiredPermission &&
      permissionsReady &&
      !hasPermission(requiredPermission.module, requiredPermission.action)
    ) {
      return null;
    }
    return (
      <NavLink
        to={to}
        className={({ isActive }) => {
          const isPathMatch = matchPaths.some(
            (path) => location.pathname === path,
          );
          const isSegmentMatch = segmentMatches(location.pathname, to);
          const active = isActive || isPathMatch || isSegmentMatch;
          return `nav-link ${active ? "active" : ""}`;
        }}
        style={navStyle}
      >
        <Icon size={20} /> <span style={{ flex: 1 }}>{label}</span>
        {Number.isFinite(count) && count > 0 && (
          <span style={badgeStyle} aria-label={`${count} items`}>
            {count > 99 ? "99+" : count}
          </span>
        )}
      </NavLink>
    );
  };

  const ExtLink = ({ href, icon: Icon, label }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="nav-link"
      style={navStyle}
    >
      <Icon size={20} /> <span style={{ flex: 1 }}>{label}</span>
      <ExternalLink size={14} style={{ opacity: 0.6 }} />
    </a>
  );

  // Accessible pages — fetched from /api/pages/me (the server's
  // intersection of the page catalog with the signed-in user's effective
  // permissions). The wellness sidebar renders EVERY visible item from
  // this list, so when admin grants/revokes a permission via the Roles
  // & Permissions matrix the sidebar updates without a JSX change and
  // without any role-string check anywhere.
  //
  // Re-fetch triggers:
  //   • on mount (initial state)
  //   • when the user's permission list changes (handles same-user perm
  //     edits — usePermissions' module-level cache is invalidated by
  //     RolesAdmin after every PUT, which propagates a new `permissions`
  //     array here and re-fires this effect)
  //   • on the `sidebar:pages-changed` window event — cross-component
  //     invalidation channel for any code that mutates permissions
  //     (RolesAdmin, the assign-roles flow on Staff, etc.) and wants
  //     the sidebar to pick up the change immediately
  const [accessiblePages, setAccessiblePages] = useState([]);
  // Permissions from the shared usePermissions hook. Stable key avoids
  // re-fetching on every render — only when the actual permission set
  // changes (different membership, not same content).
  const permissionsKey = (permissions || []).slice().sort().join("|");
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetchApi("/api/pages/me", { silent: true })
        .then((res) => {
          if (cancelled) return;
          setAccessiblePages(Array.isArray(res?.pages) ? res.pages : []);
        })
        .catch(() => {
          if (cancelled) return;
          setAccessiblePages([]);
        });
    };
    refresh();
    const onInvalidate = () => refresh();
    window.addEventListener("sidebar:pages-changed", onInvalidate);
    return () => {
      cancelled = true;
      window.removeEventListener("sidebar:pages-changed", onInvalidate);
    };
  }, [permissionsKey]);

  // SSO-authenticated AdsGPT launcher — does the same token + Redis-key
  // handoff as the wellness OwnerDashboard card. If the SSO flow fails
  // (network / provider down), degrade to opening the plain dashboard URL
  // so the link is never dead.
  const [adsLoading, setAdsLoading] = useState(false);
  const [adsgptLogin, setAdsgptLogin] = useState("");

  useEffect(() => {
    fetchApi("/api/integrations/adsgpt/config")
      .then((res) => setAdsgptLogin(res.adsgptLogin || ""))
      .catch(() => setAdsgptLogin(""));

    // Listen for config updates from Settings page
    const handleConfigUpdate = (event) => {
      setAdsgptLogin(event.detail?.adsgptLogin || "");
    };
    window.addEventListener("adsgpt:config-updated", handleConfigUpdate);
    return () =>
      window.removeEventListener("adsgpt:config-updated", handleConfigUpdate);
  }, []);

  const AdsGptLink = ({ icon: Icon = Sparkles, label = "AdsGPT" }) => {
    const handleClick = async (e) => {
      e.preventDefault();
      if (adsLoading) return;
      setAdsLoading(true);
      try {
        await launchAdsGptAs(adsgptLogin);
      } catch (err) {
        console.error("[Sidebar] AdsGPT SSO error:", err.message);
        notify.error(err.message || "Failed to open AdsGPT");
      } finally {
        setAdsLoading(false);
      }
    };
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={adsLoading}
        className="nav-link"
        aria-label="Open AdsGPT"
        title="Open AdsGPT in a new tab"
        style={{
          ...navStyle,
          background: "transparent",
          border: "none",
          width: "100%",
          textAlign: "left",
          cursor: adsLoading ? "wait" : "pointer",
          fontFamily: "inherit",
          fontSize: "inherit",
        }}
      >
        {adsLoading ? (
          <Loader2 size={20} className="spin" />
        ) : (
          <Icon size={20} />
        )}
        <span style={{ flex: 1 }}>{label}</span>
        <ExternalLink size={14} style={{ opacity: 0.6 }} />
      </button>
    );
  };

  // SSO-authenticated Callified launcher — generates a signed JWT and opens
  // the Callified dashboard. If SSO fails, shows an error notification.
  const [callifiedLoading, setCallifiedLoading] = useState(false);
  const CallifiedLink = ({ icon: Icon = PhoneCall, label = "Callified" }) => {
    const handleClick = async (e) => {
      e.preventDefault();
      if (callifiedLoading) return;
      setCallifiedLoading(true);
      try {
        await launchCallifiedSSO();
      } catch (err) {
        console.error("[Sidebar] Callified SSO error:", err.message);
        const message = err.message?.includes("not yet available")
          ? "Callified integration will be available soon. Please check back later."
          : "Unable to open Callified. Please try again.";
        notify.error(message);
      } finally {
        setCallifiedLoading(false);
      }
    };
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={callifiedLoading}
        className="nav-link"
        aria-label="Open Callified dashboard"
        title="Open Callified dashboard in a new tab"
        style={{
          ...navStyle,
          background: "transparent",
          border: "none",
          width: "100%",
          textAlign: "left",
          cursor: callifiedLoading ? "wait" : "pointer",
          fontFamily: "inherit",
          fontSize: "inherit",
        }}
      >
        {callifiedLoading ? (
          <Loader2 size={20} className="spin" />
        ) : (
          <Icon size={20} />
        )}
        <span style={{ flex: 1 }}>{label}</span>
        <ExternalLink size={14} style={{ opacity: 0.6 }} />
      </button>
    );
  };

  // T2.1: when the drawer is open at <900px, the sidebar IS a modal dialog —
  // it's the focused, foregrounded layer over a backdrop and the rest of the
  // app is inert. Switch role from "navigation" to "dialog" + add aria-modal
  // so screen readers announce it correctly. On desktop (or when closed),
  // it's plain navigation.
  const isDrawerOpen = mobileOpen && isMobileViewport;
  const asideRole = isDrawerOpen ? "dialog" : "navigation";
  const asideAriaModal = isDrawerOpen ? true : undefined;

  return (
    <>
      {/* T2.1 (extends #228): backdrop is only visible at <900px (responsive.css)
          and only when the drawer is open. Tap dismisses. */}
      <div
        className={`sidebar-backdrop ${mobileOpen ? "is-open" : ""}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      <aside
        ref={asideRef}
        id="app-sidebar"
        role={asideRole}
        aria-modal={asideAriaModal}
        aria-label="Main navigation"
        className={`glass app-sidebar ${mobileOpen ? "is-open" : ""}`}
        style={{
          width: "250px",
          height: "100vh",
          padding: "1rem 1.25rem",
          display: "flex",
          flexDirection: "column",
          borderRadius: "0",
          borderLeft: "none",
          borderTop: "none",
          borderBottom: "none",
        }}
      >
        <div
          style={{
            marginBottom: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            flexShrink: 0,
          }}
        >
          <img
            src="/globussoft-logo.png"
            alt={brand}
            style={{
              width: 44,
              height: 44,
              borderRadius: 6,
              objectFit: "cover",
              objectPosition: "left",
              flexShrink: 0,
            }}
          />
          <h1
            style={{
              fontSize: "1.1rem",
              fontWeight: "bold",
              fontFamily: "var(--font-family)",
              lineHeight: 1.1,
              margin: 0,
            }}
          >
            {brand}
          </h1>
        </div>

        <nav
          ref={navRef}
          onScroll={(e) => {
            scrollRef.current = e.currentTarget.scrollTop;
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
            flex: 1,
            overflowY: "auto",
            minHeight: 0,
          }}
        >
          {isWellness
            ? renderWellnessNav({
                Link,
                AdsGptLink,
                CallifiedLink,
                isAdmin,
                isManager,
                hasPermission,
                permissionsReady,
                sectionLabelStyle,
                counts,
                accessiblePages,
              })
            : renderGenericNav({
                Link,
                ExtLink,
                AdsGptLink,
                CallifiedLink,
                isAdmin,
                isManager,
                hasPermission,
                permissionsReady,
                counts,
                user,
              })}
        </nav>
      </aside>
    </>
  );
};

// ── Wellness sidebar — slim, clinic-focused ───────────────────────

// Icon lookup keyed by page path. Each page-catalog entry doesn't carry
// its own icon (the catalog lives on the backend; importing lucide icons
// there would be wrong). Instead we look up the icon here by path, with
// a sensible defaultIcon fallback so a brand-new catalog entry still
// renders (just with a generic icon until someone adds a row here).
const PAGE_ICON_BY_PATH = {
  // Core
  "/home": LayoutDashboard,
  // Manager
  "/wellness": LayoutDashboard,
  "/wellness/recommendations": Sparkles,
  // Clinical
  "/wellness/calendar": Calendar,
  "/wellness/appointments": Calendar,
  "/wellness/my-appointments": Calendar,
  "/wellness/patients": HeartPulse,
  "/wellness/waitlist": Clock,
  "/wellness/prescriptions": PenTool,
  "/wellness/visits": HeartPulse,
  "/signatures": FileSignature,
  "/wellness/inventory": Package,
  // Catalog
  "/wellness/services": Stethoscope,
  "/wellness/service-categories": Layers,
  "/wellness/drugs": Stethoscope,
  "/wellness/memberships": Crown,
  // Scheduling
  "/wellness/resources": Building2,
  "/wellness/holidays": Calendar,
  "/wellness/working-hours": Clock,
  // Staff self-service
  "/wellness/attendance": Clock,
  "/wellness/leave": Calendar,
  // Leads & Revenue
  "/inbox": InboxIcon,
  "/wellness/whatsapp": MessageSquare,
  "/wellness/telecaller": PhoneCall,
  "/leads": UserPlus,
  "/converted-leads": UserPlus,
  "/callified-data": PhoneCall,
  "/tasks": CheckSquare,
  "/marketplace-leads": ShoppingBag,
  "/lead-routing": Send,
  // Sales (generic only, not in wellness sidebar)
  "/dashboard": LayoutDashboard,
  "/contacts": Users,
  "/pipeline": Briefcase,
  // Finance
  "/wellness/pos": Calculator,
  "/invoices": Receipt,
  "/estimates": FileSpreadsheet,
  "/expenses": DollarSign,
  "/payments": CreditCard,
  "/wellness/wallet": WalletIcon,
  "/wellness/giftcards": Gift,
  "/wellness/coupons": TicketPercent,
  "/wellness/cashback-rules": Coins,
  // Marketing
  "/marketing": Send,
  "/sequences": Network,
  "/landing-pages": PanelTop,
  // Reports
  "/wellness/reports": BarChart3,
  "/wellness/per-location": Building2,
  "/wellness/loyalty": Award,
  "/surveys": ClipboardList,
  "/knowledge-base": BookOpen,
  "/reports": BarChart3,
  "/dashboards": LayoutDashboard,
  // Appointments
  "/wellness/book-appointment": Calendar,
  // Patient portal
  "/portal": UserCircle,
  // Admin
  "/wellness/locations": Building2,
  "/staff": UsersRound,
  "/settings/roles": ShieldCheck,
  "/commission-profiles": Award,
  "/revenue-goals": Target,
  "/channels": Radio,
  "/approvals": CheckSquare,
  "/audit-log": ScrollText,
  "/privacy": Shield,
  "/settings": Settings,
  // Inventory Admin
  "/wellness/product-categories": Layers,
  "/wellness/products": Package,
  "/wellness/vendors": Truck,
  "/wellness/inventory-receipts": ArrowDownToLine,
  "/wellness/inventory-adjustments": Receipt,
  "/wellness/auto-consumption-rules": Recycle,
  // User self-service
  "/notification-settings": Bell,
};

// Wellness sidebar — which catalog categories render here and in what
// order. Categories not in this list (e.g. 'Sales' which holds generic-
// CRM-only pages, or 'Patient' which is the customer-facing portal entry
// surfaced elsewhere) are intentionally skipped so the wellness sidebar
// stays clinic-focused even for users whose role happens to grant a
// generic-CRM permission like contacts.read.
const WELLNESS_CATEGORY_ORDER = [
  "Core",
  "Manager",
  "Clinical",
  "Catalog",
  "Scheduling",
  "Staff",
  "Leads & Revenue",
  "Finance",
  "Marketing",
  "Reports",
  "Appointments",
  // Products is the master catalog config (categories, products, auto-
  // consumption rules); Inventory Admin is the operational ledger
  // (vendors, receipts, adjustments). Same underlying permission module
  // (`inventory`) — split into two sections only for sidebar grouping.
  "Products",
  "Inventory Admin",
  // User holds personal-user surfaces (Notification Settings) — only
  // rendered for non-admin-tier users. Admin sits last so admin sees
  // management surfaces (Locations / Staff / Roles / Settings / etc.) at
  // the very bottom of the nav; non-admin users see User there instead.
  "User",
  "Admin",
];

// Categories rendered without a section header — they appear at the top of
// the sidebar as the landing items (Home + manager dashboards) so a label
// above them would be redundant. Every other category gets its name as the
// section header.
const WELLNESS_HEADERLESS_CATEGORIES = new Set(["Core", "Manager"]);

// Count-badge mapping. Path → key on the `counts` state object. Live counters
// come from /api/{contacts|tasks|tickets|email} polling + socket events and
// are rendered as a pill on the right side of the matching nav entry.
const PATH_COUNT_KEY = {
  "/inbox": "inbox",
  "/leads": "leads",
  "/tasks": "tasks",
  "/tickets": "tickets",
};

// Some links want to highlight as active even when on a different path
// (e.g. /marketplace-leads stays active when the user is on /marketplace,
// the legacy alias). Path → list of additional pathnames to treat as matches.
const PATH_MATCH_ALIASES = {
  "/marketplace-leads": ["/marketplace"],
};

function renderWellnessNav({
  Link,
  AdsGptLink,
  CallifiedLink,
  isAdmin,
  isManager,
  hasPermission = () => false,
  permissionsReady = false,
  sectionLabelStyle,
  counts = {},
  accessiblePages = [],
}) {
  // Sidebar is rendered ENTIRELY from `accessiblePages` — the per-user
  // intersection of the server's page catalog and their effective RBAC
  // permissions returned by /api/pages/me. Editing a role's permissions in
  // RolesAdmin invalidates the cache + dispatches `sidebar:pages-changed`,
  // so the sidebar updates without a page reload and with zero JSX edits.
  //
  // No hardcoded adminOnly / managerOnly / wellnessRoles gating here — the
  // backend has already filtered the list by permission. The only role-
  // sensitive UI bits left are:
  //   • hideForAdminTier — catalog-level UX flag to hide clinical-day-to-
  //     day surfaces from users who already see the Admin category.
  //   • AdsGPT / Callified — external integrations, kept visible only for
  //     admin/manager so doctors / nurses / telecallers don't see them in
  //     their nav.
  void hasPermission;
  void permissionsReady;
  const labelStyle = sectionLabelStyle || sectionLabel;

  // Group accessible pages by category for ordered rendering.
  const byCategory = {};
  for (const page of accessiblePages) {
    if (!page || !page.category || !page.path) continue;
    if (page.hideForAdminTier && isAdmin) continue;
    if (!byCategory[page.category]) byCategory[page.category] = [];
    byCategory[page.category].push(page);
  }

  const renderPage = (page) => {
    const Icon = PAGE_ICON_BY_PATH[page.path] || LayoutDashboard;
    const countKey = PATH_COUNT_KEY[page.path];
    const matchPaths = PATH_MATCH_ALIASES[page.path] || [];
    return (
      <Link
        key={page.path}
        to={page.path}
        icon={Icon}
        label={page.label}
        count={countKey ? counts[countKey] : undefined}
        matchPaths={matchPaths}
      />
    );
  };

  const renderCategory = (category, { showHeader } = { showHeader: true }) => {
    const items = byCategory[category];
    if (!items || items.length === 0) return null;
    return (
      <Fragment key={category}>
        {showHeader && <div style={labelStyle}>{category}</div>}
        {items.map(renderPage)}
      </Fragment>
    );
  };

  return (
    <>
      {/* Core + Manager render at the top with no section header — they're
          the landing-area items. Manager-tier dashboards (Owner Dashboard,
          Recommendations) only appear when the user has reports.read, so
          regular users (doctors, nurses, telecallers) won't see them even
          though they're grouped near the top. */}
      {renderCategory("Core", { showHeader: false })}
      {renderCategory("Manager", { showHeader: false })}

      {/* External integrations: admin/manager only. Doctors, nurses,
          telecallers, etc. don't need AdsGPT (marketing tool) or Callified
          (call-centre console) in their day-to-day nav — they land on the
          role-aware /home dashboard instead. */}
      {isManager && <AdsGptLink icon={Sparkles} label="AdsGPT" />}
      {isManager && <CallifiedLink icon={PhoneCall} label="Callified" />}

      {/* Remaining categories — order driven by WELLNESS_CATEGORY_ORDER so
          a new catalog entry slots into the right section automatically.
          WELLNESS_HEADERLESS_CATEGORIES is the set already rendered above
          (Core / Manager); everything else gets its category name as the
          section header. Empty categories (user has no accessible pages
          in them) collapse silently. */}
      {WELLNESS_CATEGORY_ORDER
        .filter((cat) => !WELLNESS_HEADERLESS_CATEGORIES.has(cat))
        .map((cat) => renderCategory(cat, { showHeader: true }))}
    </>
  );
}

// ── Generic sidebar (preserved unchanged) ─────────────────────────

function renderGenericNav({
  Link,
  ExtLink,
  AdsGptLink,
  CallifiedLink,
  isAdmin,
  isManager,
  hasPermission = () => false,
  permissionsReady = false,
  counts = {},
}) {
  // Generic-nav finance links use the per-link `requiredPermission` prop
  // directly; the hook references here keep the destructure stable for
  // when we promote generic to the same fully-dynamic shape wellness uses.
  void hasPermission;
  void permissionsReady;
  return (
    <>
      {/* Core — visible to ALL roles */}
      <Link to="/home" icon={LayoutDashboard} label="Home" />
      <Link to="/dashboard" icon={LayoutDashboard} label="Dashboard" />
      {/* AdsGPT + Callified are marketing / call-centre integrations
          intended for ADMIN + MANAGER only. Mirrors the same gate in the
          wellness sidebar; keep both branches in sync. */}
      {isManager && <AdsGptLink icon={Sparkles} label="AdsGPT" />}
      {isManager && <CallifiedLink icon={PhoneCall} label="Callified" />}
      <Link to="/inbox" icon={InboxIcon} label="Inbox" count={counts.inbox} />
      <Link to="/contacts" icon={Users} label="Contacts" />
      <Link to="/pipeline" icon={Briefcase} label="Pipeline" />
      <Link to="/leads" icon={UserPlus} label="Leads" count={counts.leads} />
      <Link to="/converted-leads" icon={UserPlus} label="Converted Leads" />
      <Link to="/clients" icon={Building2} label="Clients" />
      <Link
        to="/tasks"
        icon={CheckSquare}
        label="Task Queue"
        count={counts.tasks}
      />
      <Link
        to="/tickets"
        icon={Ticket}
        label="Tickets"
        count={counts.tickets}
      />
      {/* #474: label was "Calendar" pointing at /calendar-sync — the integration
          settings page (Google/Outlook bindings), not an event calendar. Users
          clicked expecting a day/week agenda view. There IS no generic event
          calendar in this CRM (wellness has /wellness/calendar; generic does
          not yet). Rename to match the destination so the affordance matches
          reality; a future event-list /calendar route can be added separately
          and re-promoted to the bare "Calendar" label then. */}
      <Link to="/calendar-sync" icon={Calendar} label="Calendar Sync" />
      <Link to="/live-chat" icon={MessageSquare} label="Live Chat" />

      <Link to="/deal-insights" icon={Eye} label="Deal Insights" />
      <Link to="/playbooks" icon={FileText} label="Playbooks" />
      <Link to="/booking-pages" icon={Calendar} label="Booking Pages" />
      <Link to="/signatures" icon={FileSignature} label="E-Signatures" />
      <Link to="/document-templates" icon={FileText} label="Doc Templates" />
      <Link to="/document-tracking" icon={Eye} label="Doc Tracking" />

      {/* Finance items gated on per-module read perms so a custom role
          without billing access doesn't see the surfaces at all. */}
      <Link
        to="/invoices"
        icon={Receipt}
        label="Invoices"
        requiredPermission={{ module: "billing", action: "read" }}
      />
      <Link
        to="/estimates"
        icon={FileSpreadsheet}
        label="Estimates"
        requiredPermission={{ module: "estimates", action: "read" }}
      />
      <Link
        to="/expenses"
        icon={DollarSign}
        label="Expenses"
        requiredPermission={{ module: "expenses", action: "read" }}
      />
      <Link
        to="/contracts"
        icon={FileText}
        label="Contracts"
        requiredPermission={{ module: "contracts", action: "read" }}
      />
      <Link to="/projects" icon={FolderKanban} label="Projects" />

      <Link to="/pipelines" icon={GitBranch} label="Pipelines" managerOnly />
      <Link
        to="/forecasting"
        icon={TrendingUp}
        label="Forecasting"
        managerOnly
      />
      <Link to="/quotas" icon={Award} label="Quotas" managerOnly />
      <Link to="/win-loss" icon={BadgePercent} label="Win/Loss" managerOnly />
      <Link to="/funnel" icon={BarChart3} label="Funnel" managerOnly />
      <Link to="/reports" icon={BarChart3} label="Reports" managerOnly />
      <Link
        to="/agent-reports"
        icon={Trophy}
        label="Agent Reports"
        managerOnly
      />
      <Link
        to="/dashboards"
        icon={LayoutDashboard}
        label="Dashboards"
        managerOnly
      />
      <Link
        to="/custom-reports"
        icon={BarChart3}
        label="Custom Reports"
        managerOnly
      />
      <Link to="/approvals" icon={CheckSquare} label="Approvals" managerOnly />
      <Link to="/lead-routing" icon={Send} label="Lead Routing" managerOnly />
      <Link to="/territories" icon={Network} label="Territories" managerOnly />

      <Link to="/marketing" icon={Send} label="Marketing" managerOnly />
      <Link to="/sequences" icon={Network} label="Sequences" managerOnly />
      <Link to="/ab-tests" icon={PenTool} label="A/B Tests" managerOnly />
      <Link to="/web-visitors" icon={Eye} label="Web Visitors" managerOnly />
      <Link to="/chatbots" icon={Bot} label="Chatbots" managerOnly />
      <Link to="/social" icon={Send} label="Social Media" managerOnly />
      <Link
        to="/landing-pages"
        icon={PanelTop}
        label="Landing Pages"
        managerOnly
      />
      <Link
        to="/marketplace-leads"
        icon={ShoppingBag}
        label="Marketplace Leads"
        managerOnly
      />

      <Link to="/support" icon={LifeBuoy} label="Support" managerOnly />
      <Link
        to="/knowledge-base"
        icon={BookOpen}
        label="Knowledge Base"
        managerOnly
      />
      <Link to="/surveys" icon={ClipboardList} label="Surveys" managerOnly />
      <Link to="/sla" icon={Target} label="SLA Policies" managerOnly />
      <Link to="/payments" icon={CreditCard} label="Payments" managerOnly />
      <Link to="/lead-scoring" icon={Target} label="Lead Scoring" managerOnly />
      <Link to="/cpq" icon={FileDigit} label="CPQ" managerOnly />

      {isAdmin && (
        <div
          style={{
            paddingTop: "0.75rem",
            marginTop: "0.5rem",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          <Link to="/staff" icon={UsersRound} label="Staff" adminOnly />
          {/* RBAC role + permission admin. Shown to anyone with `roles.read`
              granted via RBAC (typically ADMIN). The page itself rechecks. */}
          <Link
            to="/settings/roles"
            icon={ShieldCheck}
            label="Roles"
            requiredPermission={{ module: "roles", action: "read" }}
          />
          <Link to="/audit-log" icon={ScrollText} label="Audit Log" adminOnly />
          <Link to="/privacy" icon={Shield} label="Privacy" adminOnly />
          <Link
            to="/field-permissions"
            icon={Shield}
            label="Field Permissions"
            adminOnly
          />
          {/* PRD Gap §1.5 / §1.6 — Commission profiles + revenue goals admin pages. */}
          <Link
            to="/commission-profiles"
            icon={Award}
            label="Commission Profiles"
            adminOnly
          />
          <Link
            to="/commission-data"
            icon={Award}
            label="Commission Data"
            adminOnly
          />
          <Link
            to="/revenue-goals"
            icon={Target}
            label="Revenue Goals"
            adminOnly
          />
          <Link to="/channels" icon={Radio} label="Channels" adminOnly />
          <Link
            to="/industry-templates"
            icon={Building2}
            label="Industry Templates"
            adminOnly
          />
          <Link to="/sandbox" icon={Database} label="Sandbox" adminOnly />
          <Link to="/objects" icon={Database} label="App Builder" adminOnly />
          <Link
            to="/currencies"
            icon={DollarSign}
            label="Currencies"
            adminOnly
          />
          <Link to="/zapier" icon={Code} label="Zapier" adminOnly />
          <Link to="/developer" icon={Code} label="Developers" adminOnly />
          <Link
            to="/data-import-export"
            icon={Database}
            label="Import / Export"
            adminOnly
          />
          <Link to="/settings" icon={Settings} label="Settings" adminOnly />
        </div>
      )}

      {!isAdmin && isManager && (
        <div
          style={{
            paddingTop: "0.75rem",
            marginTop: "0.5rem",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          <Link to="/settings" icon={Settings} label="Settings" />
        </div>
      )}

      {/* User Notification Settings — only for regular users, not admin/manager */}
      {!isAdmin && !isManager && (
        <div
          style={{
            paddingTop: "0.75rem",
            marginTop: "0.5rem",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          <Link
            to="/notification-settings"
            icon={Settings}
            label="Notification Settings"
          />
        </div>
      )}
    </>
  );
}

// #707: sidebar group labels (STAFF, LEADS & REVENUE, etc.) were rendering
// in muted small caps at 0.65rem / 600 weight / var(--text-secondary). At
// that combination, the text failed AA contrast on both the dark generic
// surface (#4b5563 on #161821 ≈ 3.4:1) and the wellness cream surface
// (#5C5046 on #FFFFFF ≈ 6.5:1 — passes AA but reads as muted-grey-on-cream
// which users described as "fading into the background"). Fix: bump
// contrast to var(--text-primary) + 700 weight + slight size increase
// so the labels read as section anchors, not optional metadata.
const sectionLabel = {
  fontSize: "0.7rem",
  fontWeight: 700,
  color: "var(--text-primary)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  padding: "0.75rem 0.5rem 0.25rem",
  opacity: 0.85,
};

const navStyle = {
  display: "flex",
  alignItems: "center",
  padding: "0.5rem 0.875rem",
  gap: "0.625rem",
  borderRadius: "8px",
  color: "var(--text-primary)",
  transition: "all 0.2s ease",
  textDecoration: "none",
  fontSize: "0.9rem",
  flexShrink: 0,
};

// #392: live counter badge — shown on /leads, /tasks, /tickets, /inbox.
const badgeStyle = {
  fontSize: "0.7rem",
  fontWeight: 700,
  padding: "0.05rem 0.45rem",
  borderRadius: "999px",
  background: "var(--accent-color, #6366f1)",
  color: "#fff",
  minWidth: "20px",
  textAlign: "center",
  lineHeight: 1.4,
};

export default Sidebar;
