import {
  Children,
  Fragment,
  isValidElement,
  useContext,
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import {
  Users,
  LayoutDashboard,
  Briefcase,
  Settings,
  LifeBuoy,
  Send,
  Inbox as InboxIcon,
  Mail,
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
  IndianRupee,
  Trophy,
  ShoppingBag,
  Radio,
  PanelTop,
  Calendar,
  Shield,
  ShieldCheck,
  // #917 slice 5 — CSP Violations admin nav entry icon.
  ShieldAlert,
  ScrollText,
  GitBranch,
  TrendingUp,
  BookOpen,
  PenTool,
  Pill,
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
  // Cron PRD Priority A #1 — LLM Spend admin dashboard
  Activity,
  // #898 — Campaigns sidebar surfacing (Email / SMS / Push)
  Megaphone,
  // Travel CRM vertical (Day 1 scaffolding — Phase 1 per docs/TRAVEL_CRM_PRD.md §7)
  Compass,
  ClipboardCheck,
  Map as MapIcon,
  Luggage,
  // PRD §7 — FlightQuoteAgent nav entry icon (Flight quick-quote, the in-CRM
  // fallback for the Chrome flight plugin). Sits in the Quotes cluster.
  Plane,
  Key,
  // Phase 3 Visa Sure scaffolding (cluster B3) — admin-only sidebar group
  Stamp,
  BadgeCheck,
  // Phase 1 TMC curriculum-mappings admin (tick #181) — consumes
  // /api/travel-curriculum CRUD shipped tick #180 (commit 6d5919a8).
  GraduationCap,
  // Phase 2 SHELL for #908 Marketing Flyer Studio (tick #186) —
  // designed in docs/PRD_TRAVEL_MARKETING_FLYER.md. Scaffold-only
  // surface for now; MANAGER+ entry.
  FileImage,
  // Per-sub-brand BrandKit admin entry — consumes /api/brand-kits CRUD
  // (backend commit e4783e0).
  Palette,
  // RateHawk hotel-search admin entry — consumes /api/ratehawk (backend
  // commit be67789, tick #103).
  Hotel,
  // Booking.com / Expedia hotel-search admin entry — consumes
  // /api/booking-expedia (backend commit bb33cbe, tick #105). 4th and
  // FINAL cap-consumer UI in the wrapper-route series.
  BedDouble,
  // Arc 2 Travel Gap #907 slice 5/N — SightseeingMaster nav entry icon.
  // Sightseeing is framed as "the 6th category in Cost Master" per #907,
  // so the entry sits adjacent to Cost Master in renderTravelNav.
  Camera,
  // Arc 2 Travel Gap #907 slice 8/N — ItineraryTemplates nav entry icon.
  // Reusable itinerary template scaffolds — placed adjacent to Sightseeing
  // Master because both are #907 admin pages.
  LayoutTemplate,
  // S49 (TRAVEL_BIG_SCOPE_BACKLOG) — QuoteTemplates nav entry icon. Stack
  // of templates motif; sibling to FileText (Quotes). ADMIN+MANAGER gated.
  FileStack,
  // S55 (TRAVEL_BIG_SCOPE_BACKLOG) — CancellationPolicies nav entry icon.
  // Ban-circle motif matches cancellation / refund semantics. ADMIN+MANAGER
  // gated to mirror the backend POST/PATCH RBAC posture.
  Ban,
  // S79 (TRAVEL_BIG_SCOPE_BACKLOG) — Flyer Share Admin nav entry icon.
  // Share2 motif matches the mint-link / shareable-URL semantics. ADMIN-only
  // gated to mirror the share-link lifecycle's elevated-privilege posture
  // (revoke is destructive).
  Share2,
  // TravelSubBrandSwitcher — caret on the custom (non-native) sub-brand
  // dropdown trigger, replacing the native <select> so switching brands
  // can't race against an OS-rendered popup.
  ChevronDown,
} from "lucide-react";
import { AuthContext } from "../App";
import { fetchApi } from "../utils/api";
import { launchAdsGptAs, ADSGPT_DASHBOARD } from "../utils/adsgpt";
import { launchCallifiedSSO } from "../utils/callified";
import { useNotify } from "../utils/notify";
import { useActiveSubBrand } from "../utils/subBrand";
import { usePermissions } from "../hooks/usePermissions";
// Branding refactor (2026-07-08): the sidebar shows exactly ONE logo, driven
// by the fallback-resolved effective brand for the active sub-brand — never
// a separate, always-on tenant-wide logo stacked alongside a sub-brand logo.
import { useEffectiveBrand } from "../hooks/useEffectiveBrand";

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
  const navigate = useNavigate();
  const { activeSubBrand, setActiveSubBrand } = useActiveSubBrand();
  // Branding refactor (2026-07-08): fallback-resolved effective brand for
  // the active sub-brand (subBrand kit → tenant default-brand →
  // Tenant.logoUrl/brandColor → system default). This is the SINGLE source
  // the sidebar's one logo reads from — non-travel tenants pass subBrand=null
  // and get the tenant-wide kit / Tenant.logoUrl, unchanged from before.
  const { effective: effectiveBrand } = useEffectiveBrand(
    tenant?.vertical === "travel" ? activeSubBrand : null,
  );
  const role = user?.role || "USER";
  const isAdmin = role === "ADMIN";
  const isManager = role === "ADMIN" || role === "MANAGER";
  // Customer-tier = the low-privilege end-customer roles. Drives the
  // `customerOnly` page-catalog flag (e.g. Buy Gift Cards) so admin /
  // manager / staff roles don't see customer-facing storefront entries
  // in their nav. CUSTOMER is the self-service-registered role; USER is
  // the default low-privilege end-user role.
  const isCustomerTier = role === "USER" || role === "CUSTOMER";
  const wellnessRole = user?.wellnessRole || null;
  const subBrandAccess = (() => {
    if (isAdmin) return null;
    const raw = user?.subBrandAccess;
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr;
    } catch {
      return null;
    }
  })();
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
  const isTravel = tenant?.vertical === "travel";
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
      safeLen(fetchApi("/api/contacts?status=Lead&count=1", { silent: true })),
      safeLen(fetchApi("/api/tasks?status=PENDING&count=1", { silent: true })),
      safeLen(fetchApi("/api/tickets?status=OPEN&count=1", { silent: true })),
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
  // Self-heal a stale/invalid active sub-brand. The selection persists in
  // sessionStorage, which SURVIVES a logout→login in the SAME tab — so an
  // admin who picked "RFU", logged out, and logged back in as a TMC-only
  // manager would inherit activeSubBrand="rfu". Since that manager can't
  // access RFU, the brand-scoped nav would then hide ALL their own items
  // (including "TMC Trips") and the dashboard would scope to a brand they
  // don't own. When the persisted brand isn't in the current user's access
  // set, reset it to "All". Travel-only; generic/wellness never set a brand.
  useEffect(() => {
    if (
      isTravel &&
      activeSubBrand &&
      subBrandAccess !== null &&
      !subBrandAccess.includes(activeSubBrand)
    ) {
      setActiveSubBrand(null);
      return;
    }
    // Single-brand-scoped user (e.g. an "RFU Advisor" with
    // subBrandAccess=["rfu"]): there's no switcher to pick a brand from (see
    // soleBrand below), so without this, activeSubBrand stays null forever
    // and branding/data silently falls through to the tenant-wide default
    // even though the read-only "RFU" chip visually claims they're on RFU.
    // Auto-select their one accessible brand so branding + scoping actually
    // match what the chip shows. Multi-brand users are untouched — they
    // pick explicitly via the switcher.
    if (
      isTravel &&
      !activeSubBrand &&
      subBrandAccess !== null &&
      subBrandAccess.length === 1
    ) {
      setActiveSubBrand(subBrandAccess[0]);
    }
  }, [isTravel, activeSubBrand, subBrandAccess, setActiveSubBrand]);
  // Stable identity for the sub-brand switcher's onChange — without this,
  // Sidebar's frequent unrelated re-renders (60s count poll, socket events)
  // hand the switcher a brand-new handler each time. Debounced (250ms) so a
  // rapid run of clicks collapses into one actual switch (the last one)
  // instead of firing a network request per click.
  //
  // The switcher itself is a custom (non-native) dropdown — see
  // TravelSubBrandSwitcher below — specifically so this async round-trip
  // (network validation + the destination page's own re-render) can happen
  // without any native OS popup around to visually race against it, the
  // way a native <select> did.
  const subBrandDebounceRef = useRef(null);
  useEffect(() => () => clearTimeout(subBrandDebounceRef.current), []);
  const handleSubBrandChange = useCallback(
    (next) => {
      clearTimeout(subBrandDebounceRef.current);
      subBrandDebounceRef.current = setTimeout(async () => {
        if (!next) {
          setActiveSubBrand(null);
          navigate("/travel");
          return;
        }
        try {
          await fetchApi("/api/travel/session/switch-brand", {
            method: "POST",
            body: JSON.stringify({ subBrand: next }),
          });
          setActiveSubBrand(next);
          navigate("/travel");
        } catch {
          // Rejected (403 SUB_BRAND_FORBIDDEN) or invalid (400): the error
          // toast was already shown by fetchApi. Leave the selection
          // unchanged — the controlled switcher snaps back to the prior
          // activeSubBrand.
        }
      }, 250);
    },
    [setActiveSubBrand, navigate],
  );
  const brand = tenant?.name || "Globussoft";
  // Single logo source (2026-07-08): the active sub-brand's fallback-resolved
  // logo when one exists, else the tenant-wide default — never both shown
  // at once. Non-travel tenants (effectiveBrand always resolved with
  // subBrand=null) get exactly the old tenant.logoUrl behaviour.
  const logoUrl = effectiveBrand?.logoUrl || tenant?.logoUrl || null;
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
  // PERF: keep these inner components' identities STABLE across re-renders.
  // Defining `const Link = (...) => {...}` inside the function body creates a
  // fresh function reference every render. React treats fresh identities as
  // a DIFFERENT component type and unmounts + remounts the entire subtree —
  // ~50-60 NavLinks for a wellness admin, each with its own internal
  // useLocation subscription + className evaluation. With Sidebar
  // re-rendering on every route change, socket counter tick, permissions
  // resolve, AdsGPT config fetch, and mobileOpen toggle, that's the
  // dominant source of sidebar lag. Fix: ref-backed impls + useMemo([], …)
  // so the component identity React sees is stable, while the closure-
  // captured state (isAdmin, location, hasPermission, …) stays live.
  const linkImplRef = useRef(null);
  linkImplRef.current = ({
    to,
    icon: Icon,
    label,
    adminOnly,
    managerOnly,
    wellnessRoles,
    requiredPermission,
    count,
    matchPaths = [],
    end = false,
  }) => {
    if (adminOnly && !isAdmin) return null;
    if (managerOnly && !isManager) return null;
    // wellnessRoles gates a link to specific wellnessRole values. Managers
    // and admins always pass through (mirrors the server's verifyWellnessRole
    // gate which whitelists admin/manager alongside the named clinical roles).
    if (wellnessRoles && !isManager && !wellnessRoles.includes(wellnessRole))
      return null;
    // RBAC permission gate. Hide if:
    //   - requiredPermission is set AND
    //   - EITHER permissions haven't loaded yet OR user lacks that permission
    // This is more conservative (hide-by-default) to prevent data leakage if
    // permissions fail to load or are delayed. Once permissions load, show only
    // if the user has explicit permission.
    if (
      requiredPermission &&
      (!permissionsReady || !hasPermission(requiredPermission.module, requiredPermission.action))
    ) {
      return null;
    }
    return (
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) => {
          const isPathMatch = matchPaths.some(
            (path) => location.pathname === path,
          );
          const isSegmentMatch = end ? false : segmentMatches(location.pathname, to);
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
  const Link = useMemo(
    () =>
      function Link(props) {
        return linkImplRef.current(props);
      },
    [],
  );

  // Section — wraps a group label + its child Links so the label only renders
  // when at least one child would render. Mirrors the gating logic in
  // linkImplRef so the predicate stays in sync. Without this, custom roles
  // with all module reads revoked under "Admin" or "Platform" would still see
  // the orphan section heading sitting above an empty list. Same useRef +
  // useMemo identity-stability dance as Link so React doesn't unmount /
  // remount the subtree on every re-render.
  const wouldLinkRender = ({
    adminOnly,
    managerOnly,
    wellnessRoles: linkWellnessRoles,
    requiredPermission,
  }) => {
    if (adminOnly && !isAdmin) return false;
    if (managerOnly && !isManager) return false;
    if (
      linkWellnessRoles &&
      !isManager &&
      !linkWellnessRoles.includes(wellnessRole)
    )
      return false;
    // Match linkImplRef logic: hide if requiredPermission set AND
    // (permissions not ready OR user lacks permission)
    if (
      requiredPermission &&
      (!permissionsReady || !hasPermission(requiredPermission.module, requiredPermission.action))
    ) {
      return false;
    }
    return true;
  };
  const sectionImplRef = useRef(null);
  sectionImplRef.current = ({ label, children }) => {
    const labelStyle = sectionLabelStyle || sectionLabel;
    const hasVisibleChild = Children.toArray(children).some((child) => {
      if (child === null || child === undefined || child === false) return false;
      if (!isValidElement(child)) return Boolean(child);
      // Link is the memoized identity created above; child.type === Link
      // matches when the JSX site wrote `<Link ... />`. Anything else
      // (raw <div>, nested fragments, custom components) is assumed
      // visible — Section is a label gate, not a child filter.
      if (child.type === Link) return wouldLinkRender(child.props);
      return true;
    });
    if (!hasVisibleChild) return null;
    return (
      <>
        <div style={labelStyle}>{label}</div>
        {children}
      </>
    );
  };
  const Section = useMemo(
    () =>
      function Section(props) {
        return sectionImplRef.current(props);
      },
    [],
  );

  const extLinkImplRef = useRef(null);
  extLinkImplRef.current = ({ href, icon: Icon, label }) => (
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
  const ExtLink = useMemo(
    () =>
      function ExtLink(props) {
        return extLinkImplRef.current(props);
      },
    [],
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

  // Ref-backed impl + stable useMemo identity — same perf rationale as Link.
  const adsGptImplRef = useRef(null);
  adsGptImplRef.current = ({ icon: Icon = Sparkles, label = "AdsGPT" }) => {
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
  const AdsGptLink = useMemo(
    () =>
      function AdsGptLink(props) {
        return adsGptImplRef.current(props);
      },
    [],
  );

  // SSO-authenticated Callified launcher — generates a signed JWT and opens
  // the Callified dashboard. If SSO fails, shows an error notification.
  const [callifiedLoading, setCallifiedLoading] = useState(false);
  const callifiedImplRef = useRef(null);
  callifiedImplRef.current = ({
    icon: Icon = PhoneCall,
    label = "Callified",
  }) => {
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
  const CallifiedLink = useMemo(
    () =>
      function CallifiedLink(props) {
        return callifiedImplRef.current(props);
      },
    [],
  );

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
            src={logoUrl || "/globussoft-logo.png"}
            alt={brand}
            onError={(e) => {
              if (e.currentTarget.src.indexOf("/globussoft-logo.png") === -1) {
                e.currentTarget.src = "/globussoft-logo.png";
              }
            }}
            style={{
              width: 44,
              height: 44,
              borderRadius: 6,
              // object-fit:cover + object-position:left anchors a wide
              // "icon + wordmark" source by its left edge so only the
              // icon portion sits in the slot; icon-only square sources
              // pass through unchanged.
              objectFit: "cover",
              objectPosition: "left center",
              flexShrink: 0,
              background: "#fff",
            }}
          />
          <h1
            style={{
              fontSize: "0.97rem",
              fontWeight: "bold",
              fontFamily: "var(--font-family)",
              lineHeight: 1.15,
              margin: 0,
            }}
          >
            {brand}
          </h1>
        </div>

        {isTravel &&
          renderTravelSubBrandHeader({
            sectionLabelStyle,
            subBrandAccess,
            activeSubBrand,
            onSubBrandChange: handleSubBrandChange,
            // Branding refactor (2026-07-08): the pinned second logo strip
            // was removed — the single top-of-sidebar logo (driven by
            // effectiveBrand) already reflects the active sub-brand, so a
            // second logo here would just duplicate it. The accent color
            // underline is preserved via accentColor below.
            accentColor: effectiveBrand?.primaryColor || null,
          })}

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
                isCustomerTier,
                hasPermission,
                permissionsReady,
                sectionLabelStyle,
                counts,
                accessiblePages,
              })
            : isTravel
              ? renderTravelNav({
                  Link,
                  Section,
                  isAdmin,
                  isManager,
                  counts,
                  subBrandAccess,
                  activeSubBrand,
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
  "/wellness/my-prescriptions": Pill,
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
  "/wellness/attendance-dashboard": ClipboardList,
  "/wellness/leave": Calendar,
  // Leads & Revenue
  "/inbox": InboxIcon,
  "/wellness/whatsapp": MessageSquare,
  "/wellness/telecaller": PhoneCall,
  "/leads": UserPlus,
  "/converted-leads": UserPlus,
  "/callified-data": PhoneCall,
  "/tasks": CheckSquare,
  "/lead-routing": Send,
  // Sales (generic only, not in wellness sidebar)
  "/dashboard": LayoutDashboard,
  "/contacts": Users,
  "/pipeline": Briefcase,
  // Finance
  "/wellness/pos": Calculator,
  "/invoices": Receipt,
  "/estimates": FileSpreadsheet,
  "/expenses": IndianRupee,
  "/payments": CreditCard,
  "/wellness/wallet": WalletIcon,
  "/wellness/giftcards": Gift,
  "/wellness/buy-giftcards": ShoppingBag,
  "/wellness/my-transactions": Receipt,
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
  "/wellness/my-bookings": Calendar,
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

// Some links want to highlight as active even when on a different path.
// Path → list of additional pathnames to treat as matches.
const PATH_MATCH_ALIASES = {};

function renderWellnessNav({
  Link,
  AdsGptLink,
  CallifiedLink,
  isAdmin,
  isManager,
  isCustomerTier = false,
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
    // customerOnly pages (e.g. Buy Gift Cards storefront) only surface to
    // customer-tier roles (USER / CUSTOMER). Admin / manager / staff don't
    // see them in their nav. Sidebar-only UX rule; direct-URL access and
    // the backend route's own auth are unchanged.
    if (page.customerOnly && !isCustomerTier) continue;
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

  // Render a category whose final list is (catalog items) ⊕ (non-catalog
  // hardcoded `extras`). Used for sections that have one or two pages
  // that aren't (yet) in the page catalog — Leads & Revenue (Blocked
  // Numbers), Finance (Cash Registers), Marketing (Campaigns), Admin
  // (Tenant Settings / AdsGPT Reports / Callified Calls / Wallet Bonus
  // Rules). Without this helper, the hardcoded copies overlapped the
  // catalog-driven copies and the user saw every item twice. Headers
  // collapse if BOTH the catalog list AND extras are empty (e.g. a
  // non-manager whose Marketing extras gate to null).
  const renderMergedCategory = (category, extras) => {
    const items = byCategory[category] || [];
    const hasItems = items.length > 0;
    const hasExtras =
      extras !== null && extras !== undefined && extras !== false;
    if (!hasItems && !hasExtras) return null;
    return (
      <Fragment key={category}>
        <div style={labelStyle}>{category}</div>
        {items.map(renderPage)}
        {extras}
      </Fragment>
    );
  };

  // Non-catalog admin/manager pages that aren't (yet) in the page
  // catalog. Each lives under the relevant catalog section header via
  // renderMergedCategory above so the section reads as one unified
  // block. As routes get catalogued (with proper requiredPermissions),
  // entries here can drop out. `isManager` here is shorthand: literal-
  // ADMIN passes isManager too.
  const categoryExtras = {
    // Cash Registers used to live here as its own sidebar entry, but
    // `/wellness/cash-registers` has no route mounted in App.jsx and the
    // dedicated page 404'd on every click. The CashRegisters component
    // is now embedded inside Point of Sale as an admin/manager
    // "Manage registers" panel, so this slot intentionally has no
    // Finance extras.
    //
    // Campaigns used to render here as a hardcoded managerOnly link;
    // removed by request. Route stays mounted in App.jsx so /campaigns
    // remains reachable via deep-link.
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
          in them) collapse silently. The "User" category holds personal-
          user surfaces (Notification Settings) and is hidden from admin/
          manager — they manage their own notification preferences via the
          Settings surface, not via a dedicated sidebar entry. Mirrors the
          guard on the generic-sidebar fallback below. */}
      {/* Iterate WELLNESS_CATEGORY_ORDER once. Categories with non-catalog
          stragglers (Leads & Revenue, Finance, Marketing) route through
          renderMergedCategory so the catalog items + the hardcoded
          straggler render under ONE shared header. Everything else uses
          plain renderCategory. Admin is rendered explicitly below (last
          section in the sidebar) so management surfaces sit at the bottom. */}
      {WELLNESS_CATEGORY_ORDER.filter(
        (cat) => !WELLNESS_HEADERLESS_CATEGORIES.has(cat),
      )
        .filter((cat) => cat !== "Admin")
        .filter((cat) => !(cat === "User" && isManager))
        .map((cat) => {
          if (Object.prototype.hasOwnProperty.call(categoryExtras, cat)) {
            return renderMergedCategory(cat, categoryExtras[cat]);
          }
          return renderCategory(cat, { showHeader: true });
        })}

      {/* Admin — rendered LAST so management surfaces sit at the bottom of
          the sidebar, below day-to-day operational entries (Leads & Revenue,
          Finance, etc.). Catalog-driven entries pulled from /api/pages/me —
          Locations, Staff, Roles, Commission Profiles, Revenue Goals,
          Channels, Approvals, Audit Log, Privacy, Settings. These are
          gated by the user's RolePermission grants, so a non-literal-ADMIN
          custom role with `roles.read` (etc.) still sees the subset of
          admin pages it can access.

          The Tenant Settings / AdsGPT Reports / Callified Calls / Wallet
          Bonus Rules sidebar shortcuts were removed by request — the
          underlying routes stay mounted in App.jsx and remain reachable
          via deep-link (e.g. CapBanners' "Tenant Settings →" anchor). */}
      {(() => {
        const adminCatalogItems = byCategory["Admin"] || [];
        // Pull Settings out of the catalog admin list — it MUST render
        // last in the sidebar per UX requirement. If the user lacks
        // settings.read, /api/pages/me already filtered Settings out so
        // settingsPage is undefined and nothing renders for it — the
        // matrix-is-authoritative contract stays intact.
        const settingsPage = adminCatalogItems.find(
          (p) => p.path === "/settings",
        );
        const otherAdminItems = adminCatalogItems.filter(
          (p) => p.path !== "/settings",
        );
        if (otherAdminItems.length === 0 && !settingsPage) {
          return null;
        }
        return (
          <>
            <div style={labelStyle}>Admin</div>
            {otherAdminItems.map(renderPage)}
            {/* Settings — pinned LAST in the sidebar per UX requirement.
                Only renders if /api/pages/me granted access (i.e. the
                user has settings.read on at least one assigned role). */}
            {settingsPage && renderPage(settingsPage)}
          </>
        );
      })()}

      {!isAdmin && isManager && (
        <>
          <div style={labelStyle}>Settings</div>
          <Link to="/settings" icon={Settings} label="Settings" />
        </>
      )}

      {/* Notification Settings is rendered via the page-catalog "User"
          category iteration above (WELLNESS_CATEGORY_ORDER loop). The
          previous hardcoded fallback block here caused a duplicate entry
          for non-admin/non-manager users — the catalog version uses the
          Bell icon, this one used Settings (gear). Removed to deduplicate. */}
    </>
  );
}

// Custom (non-native) dropdown for the sub-brand switcher. A real component
// (not a plain render-helper function like the others in this file) because
// it needs its own open/close + keyboard-nav state — hooks require an
// actual component, not a function called mid-render.
//
// Why not the native <select>: switching brands makes downstream pages
// (e.g. the travel Dashboard) re-fetch + re-render against the new brand,
// which is a legitimate, unavoidable reflow. Reopening a NATIVE <select>'s
// OS-rendered popup while that reflow is in flight is a well-known
// Chromium quirk that can blank the popup for a frame. A div-based popup
// rendered entirely by React has no OS-level paint to race against, so the
// same reflow can't cause it to blank — closing the popup on selection is
// already the intended UX (same as a native select), so no disabled/
// loading state is needed to keep it safe.
function TravelSubBrandSwitcher({ activeSubBrand, visibleSubBrands, onChange }) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef(null);
  const listRef = useRef(null);

  const options = useMemo(
    () => [{ value: "", label: `All (${visibleSubBrands.length})` }, ...visibleSubBrands],
    [visibleSubBrands],
  );
  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === (activeSubBrand || "")),
  );
  const currentLabel = options[currentIndex]?.label || "All";

  // Click-outside + Escape close the popup. Only attached while open so
  // idle renders don't pay for a document-level listener.
  useEffect(() => {
    if (!open) return undefined;
    setHighlighted(currentIndex);
    const onDocMouseDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onDocKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onDocKeyDown);
    // Focus the listbox so arrow keys work immediately without a stray
    // Tab press — matches native <select> "opens focused" behavior.
    listRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const commit = (value) => {
    setOpen(false);
    onChange(value || null);
  };

  const onTriggerKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(options[highlighted]?.value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} style={{ position: "relative", flex: 1 }}>
      <button
        type="button"
        id="travel-sub-brand-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch active sub-brand"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          fontSize: 12,
          padding: "4px 6px",
          borderRadius: 4,
          border: "1px solid var(--border-color)",
          background: "var(--surface-color)",
          color: "var(--text-primary)",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span>{currentLabel}</span>
        <ChevronDown size={12} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label="Switch active sub-brand"
          aria-activedescendant={`travel-sub-brand-option-${highlighted}`}
          onKeyDown={onListKeyDown}
          // travel-subbrand-popup forces an opaque background via explicit
          // index.css rules (light/dark) — var(--surface-color) is
          // intentionally translucent in the base glassmorphism scope
          // (rgba, for cards), which bled the sidebar nav through this
          // floating popup. Same fix pattern as .travel-itin-suggest-modal.
          className="travel-subbrand-popup"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 50,
            margin: 0,
            padding: 4,
            listStyle: "none",
            borderRadius: 6,
            border: "1px solid var(--border-color)",
            boxShadow: "var(--shadow-md, 0 4px 12px rgba(0,0,0,0.25))",
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {options.map((opt, idx) => (
            <li
              key={opt.value || "__all__"}
              id={`travel-sub-brand-option-${idx}`}
              role="option"
              aria-selected={idx === currentIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(opt.value)}
              onMouseEnter={() => setHighlighted(idx)}
              style={{
                padding: "6px 8px",
                borderRadius: 4,
                fontSize: 12,
                cursor: "pointer",
                color: "var(--text-primary)",
                background:
                  idx === highlighted ? "var(--subtle-bg, rgba(255,255,255,0.08))" : "transparent",
              }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Travel sidebar — Day 1 scaffolding ────────────────────────────
//
// Slim placeholder nav for the travel vertical. Phase 1 (docs/TRAVEL_CRM_PRD.md
// §7) will fill out the full surface: Diagnostics, Itineraries, Trips (per
// sub-brand: TMC trips / RFU pilgrims), Visa Applications, Suppliers,
// Microsites. For Day 1, only Dashboard is wired — everything else is
// "Coming in Phase 1" so the user can see the planned navigation map
// without dead links.
// Travel "Travel" section label + Q25 sub-brand switcher. Rendered in the
// sidebar's FIXED header zone (outside the scrollable <nav>) so the switcher
// stays reachable without scrolling back to the top. Only render the dropdown
// when the user has full access (subBrandAccess === null, includes admins) or
// access to ≥2 sub-brands — a single-sub-brand user has no choice to make.
// Travel-only; generic/wellness sidebars never call this.
function renderTravelSubBrandHeader({
  sectionLabelStyle,
  subBrandAccess = null,
  activeSubBrand = null,
  onSubBrandChange = () => {},
  accentColor = null,
}) {
  const labelStyle = sectionLabelStyle || sectionLabel;
  const ALL_SUB_BRANDS = [
    { value: "tmc", label: "TMC" },
    { value: "rfu", label: "RFU" },
    { value: "travelstall", label: "Travel Stall" },
    { value: "visasure", label: "Visa Sure" },
  ];
  const visibleSubBrands =
    subBrandAccess === null
      ? ALL_SUB_BRANDS
      : ALL_SUB_BRANDS.filter((s) => subBrandAccess.includes(s.value));
  const showSwitcher = visibleSubBrands.length >= 2;
  // Single-brand scoped user (e.g. a TMC-only manager): there's nothing to
  // switch between, so we don't render the dropdown — but we DO surface a
  // static read-only chip so they can see which sub-brand they're scoped to
  // ("TMC"). Full-access users (subBrandAccess === null) always get the
  // switcher, never this chip.
  const soleBrand =
    !showSwitcher && subBrandAccess !== null && visibleSubBrands.length === 1
      ? visibleSubBrands[0]
      : null;
  return (
    <div style={{ flexShrink: 0 }}>
      {/* Branding refactor (2026-07-08): the pinned sub-brand LOGO strip was
          removed — the single top-of-sidebar logo already reflects the
          active sub-brand (see Sidebar's `logoUrl` const). This thin accent
          strip is the only remaining visual cue for "this is the brand
          you're operating under" when that brand has its own color. */}
      {accentColor && (
        <div
          data-testid="travel-sidebar-accent-strip"
          style={{ height: 2, background: accentColor, marginBottom: 4 }}
        />
      )}
      <div style={labelStyle}>Travel</div>
      {soleBrand && (
        <div
          style={{
            padding: "4px 12px 8px",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Sub-brand
          </span>
          <span
            style={{
              flex: 1,
              fontSize: 12,
              fontWeight: 600,
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--border-color)",
              background: "var(--surface-color)",
              color: "var(--text-primary)",
            }}
            data-testid="travel-sub-brand-sole"
            aria-label={`Sub-brand: ${soleBrand.label}`}
          >
            {soleBrand.label}
          </span>
        </div>
      )}
      {showSwitcher && (
        <div
          style={{
            padding: "4px 12px 8px",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <label
            htmlFor="travel-sub-brand-switcher"
            style={{
              fontSize: 10,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Sub-brand
          </label>
          <TravelSubBrandSwitcher
            activeSubBrand={activeSubBrand}
            visibleSubBrands={visibleSubBrands}
            onChange={onSubBrandChange}
          />
        </div>
      )}
    </div>
  );
}

function renderTravelNav({
  Link,
  Section,
  isAdmin = false,
  isManager = false,
  counts = {},
  subBrandAccess = null,
  activeSubBrand = null,
}) {
  // isAdmin / isManager drive ONE display-only decision below: the
  // personal "You → Notification Settings" entry, which is a
  // self-service surface for end users and is intentionally hidden
  // from admin / manager / owner tenants (OWNER carries role==='ADMIN'
  // so isAdmin already covers it). This mirrors the generic sidebar's
  // `!isAdmin && !isManager` gate around the same Link. Every other
  // entry in this function stays permission-driven via
  // requiredPermission — role-string gates would defeat the
  // "permissions are source of truth" contract for nav visibility.
  // Brand-scoped nav (travel-only). Two layers gate a brand-tagged entry:
  //   1. ACCESS — the user must be entitled to that sub-brand. Full-access
  //      users (subBrandAccess === null, includes admins) see every brand; a
  //      scoped user (e.g. a TMC-only manager with subBrandAccess=["tmc"])
  //      only ever sees their granted brands' entries, regardless of the
  //      switcher. This is why a TMC manager must NOT see the Travel Stall /
  //      RFU / Visa Sure brand sections.
  //   2. SWITCHER — when a specific sub-brand is active, narrow further to
  //      just that brand; "All" (activeSubBrand === null) shows every brand
  //      the user can access.
  // Items with no brand tag are shared cross-brand surfaces (Diagnostics,
  // Itineraries, Cost Master, Reports, …) and always render — their pages
  // filter by the caller's access server-side. Does NOT touch the generic
  // or wellness navs.
  //
  // The "Travel" section label + sub-brand switcher render OUTSIDE this
  // scrollable nav (renderTravelSubBrandHeader, in the sidebar's fixed
  // header zone) so the switcher stays reachable without scrolling up.
  const canAccessBrand = (brand) =>
    subBrandAccess === null || subBrandAccess.includes(brand);
  const inBrand = (brand) =>
    canAccessBrand(brand) &&
    (activeSubBrand === null || activeSubBrand === brand);
  // Travel sidebar — fully permission-driven. Every link below carries a
  // `requiredPermission={{module, action}}` prop; the Link component hides
  // the entry when the signed-in user lacks that grant. There are NO
  // role-name (isAdmin / isManager) gates inside this function anymore.
  //
  // Why the rewrite (2026-06-15): per the "permissions are source of
  // truth, roles are containers" contract, sidebar visibility must
  // dynamically reflect the grants admin assigns to each role. The
  // previous `{isAdmin && <Link ...>}` wraps blocked custom roles from
  // ever seeing an entry even when admin had explicitly granted them
  // the underlying perm. After this refactor, granting `pois.manage`
  // to ANY role makes the POI Approvals link appear for that role —
  // no JSX edit required.
  //
  // Sub-brand `inBrand()` checks are preserved: they're tenant feature
  // toggles (does this tenant subscribe to the RFU / TMC / Visa Sure
  // sub-brand?), not access-control gates. A user with `religious_packets.read`
  // still won't see the Religious Packets link on a tenant whose
  // `subBrandAccess` doesn't include "rfu".
  //
  // Section dividers are wrapped in <Section label="..."> — the
  // component mirrors the Link gating logic against its children and
  // collapses the entire group (label + children) when every child
  // would be filtered out. A custom role with all module reads under
  // "Admin" / "Platform" revoked no longer sees orphan headings.
  return (
    <>
      <Link to="/travel" end icon={Compass} label="Dashboard" requiredPermission={{ module: "reports", action: "read" }} />
      {/* "Leads" lives in the Sales-pipeline section below (next to Contacts +
          Pipeline). The duplicate top-level Leads link was removed — it pointed
          to the same /travel/leads page. */}
      {/* COMMENTED OUT - Inbound Leads hidden from sidebar */}
      {/* <Link to="/travel/inbound-leads" icon={InboxIcon} label="Inbound Leads" requiredPermission={{ module: "inbound_leads", action: "read" }} /> */}
      <Link to="/travel/diagnostics" icon={ClipboardCheck} label="Diagnostics" requiredPermission={{ module: "diagnostics", action: "read" }} />
      <Link to="/travel/itineraries" icon={MapIcon} label="Itineraries" requiredPermission={{ module: "itineraries", action: "read" }} />
      <Link to="/travel/pois/pending" icon={CheckSquare} label="POI Approvals" requiredPermission={{ module: "pois", action: "manage" }} />
      {inBrand("tmc") && (
        <Link to="/travel/trips" icon={Luggage} label="TMC Trips" requiredPermission={{ module: "trips", action: "read" }} />
      )}
      {inBrand("tmc") && (
        <Link to="/travel/tmc/catalogue" icon={Package} label="TMC Catalogue" requiredPermission={{ module: "tmc_catalogue", action: "read" }} />
      )}
      <Link to="/travel/web-checkins" icon={Ticket} label="Web Check-ins" requiredPermission={{ module: "web_checkins", action: "read" }} />
      <Link to="/travel/automation-health" icon={Activity} label="Check-in Automation Health" requiredPermission={{ module: "web_checkins", action: "read" }} />
      <Link to="/travel/passport-verification" icon={BadgeCheck} label="Passport Verification" requiredPermission={{ module: "passport", action: "manage" }} />
      <Link to="/travel/cost-master" icon={IndianRupee} label="Cost Master" requiredPermission={{ module: "cost_master", action: "read" }} />
      <Link to="/travel/sightseeing" icon={Camera} label="Sightseeing Master" requiredPermission={{ module: "sightseeing", action: "read" }} />
      <Link to="/travel/itinerary-templates" icon={LayoutTemplate} label="Itinerary Templates" requiredPermission={{ module: "itinerary_templates", action: "read" }} />
      <Link to="/travel/pricing-rules" icon={BadgePercent} label="Pricing Rules" requiredPermission={{ module: "pricing", action: "manage" }} />
      <Link to="/travel/reports" icon={BarChart3} label="Reports" requiredPermission={{ module: "reports", action: "read" }} />
      <Link to="/travel/reviews" icon={MessageSquare} label="Reviews" requiredPermission={{ module: "reports", action: "read" }} />
      <Link to="/travel/suppliers-admin" icon={Building2} label="Suppliers" requiredPermission={{ module: "suppliers", action: "read" }} />
      {/* COMMENTED OUT - RateHawk Search and Booking/Expedia hidden from sidebar */}
      {/* <Link to="/admin/ratehawk-search" icon={Hotel} label="RateHawk Search" requiredPermission={{ module: "suppliers", action: "read" }} /> */}
      {/* <Link to="/admin/booking-expedia-search" icon={BedDouble} label="Booking / Expedia" requiredPermission={{ module: "suppliers", action: "read" }} /> */}
      <Link to="/travel/commission-profiles" icon={Award} label="Commission Profiles" requiredPermission={{ module: "commission_profiles", action: "read" }} />
      <Link to="/travel/quotes-admin" icon={FileText} label="Quotes" requiredPermission={{ module: "quotes", action: "read" }} />
      <Link to="/travel/flights/quote" icon={Plane} label="Flight quick-quote" requiredPermission={{ module: "flight_quotes", action: "read" }} />
      <Link to="/travel/quotes/builder" icon={Calculator} label="Quote Builder" requiredPermission={{ module: "quotes", action: "write" }} />
      <Link to="/travel/quote-templates" icon={FileStack} label="Quote Templates" requiredPermission={{ module: "quote_templates", action: "read" }} />
      <Link to="/travel/cancellation-policies" icon={Ban} label="Cancellation Policies" requiredPermission={{ module: "cancellation_policies", action: "read" }} />
      <Link to="/travel/suppliers" icon={Key} label="Supplier credentials" requiredPermission={{ module: "suppliers", action: "manage" }} />
      {inBrand("rfu") && (
        <Link to="/travel/religious-packets" icon={BookOpen} label="Religious Packets" requiredPermission={{ module: "religious_packets", action: "read" }} />
      )}
      {inBrand("tmc") && (
        <Link to="/travel/curriculum-mappings" icon={GraduationCap} label="Curriculum Mappings" requiredPermission={{ module: "curriculum", action: "read" }} />
      )}
      {inBrand("tmc") && (
        <Link to="/travel/school-terms" icon={Calendar} label="School Term Calendar" requiredPermission={{ module: "school_terms", action: "read" }} />
      )}
      <Link to="/travel/marketing/flyer-studio" icon={FileImage} label="Marketing Flyer Studio" requiredPermission={{ module: "flyer_studio", action: "read" }} />
      <Link to="/travel/flyer-templates" icon={Palette} label="Flyer Templates" requiredPermission={{ module: "flyer_templates", action: "read" }} />
      <Link to="/travel/flyer-share-admin" icon={Share2} label="Flyer Share Admin" requiredPermission={{ module: "flyer_studio", action: "manage" }} />
      {/* Brochure Engine — agentic-orchcrm integration. AI orchestration
          engine that turns a brief into an A4 travel brochure PDF
          (cover, day-by-day itinerary, route map, inclusions, pricing).
          Gated by marketing.read so it's visible alongside the other
          marketing-output surfaces (Flyer Studio, Landing Pages). */}
      <Link to="/travel/brochures" icon={Sparkles} label="Brochure Engine" requiredPermission={{ module: "marketing", action: "read" }} />
      {/* Destination Landing Pages — backed by the existing LandingPage
          platform (/api/landing-pages). Travel-flavoured sub-section is
          driven by the LandingPage.subBrand column + the
          "travel_destination" template preset. Same admin surface for
          all 4 sub-brands; the LandingPages.jsx list filters by sub-brand
          via the ?subBrand= query param. */}
      <Link to="/landing-pages" icon={PanelTop} label="Landing Pages" requiredPermission={{ module: "marketing", action: "read" }} />

      {/* Visa Sure sub-brand cluster — inBrand() is a tenant feature
          toggle, not an access gate. Per-link requiredPermission still
          decides whether the user inside a Visa Sure tenant can see
          each entry. */}
      {inBrand("visasure") && (
        <Section label="Visa Sure">
          <Link to="/travel/visa" end icon={Stamp} label="Dashboard" requiredPermission={{ module: "visa", action: "read" }} />
          <Link to="/travel/visa/applications" icon={BadgeCheck} label="Applications" requiredPermission={{ module: "visa", action: "read" }} />
          <Link to="/travel/visa/checklists" icon={ClipboardList} label="Checklists" requiredPermission={{ module: "visa", action: "read" }} />
          <Link to="/travel/visa/embassy-rules" icon={Shield} label="Embassy Rules" requiredPermission={{ module: "visa", action: "manage" }} />
        </Section>
      )}

      {inBrand("travelstall") && (
        <Section label="Travel Stall">
          <Link to="/travel-stall" end icon={Sparkles} label="Dashboard" requiredPermission={{ module: "reports", action: "read" }} />
        </Section>
      )}

      <Section label="Sales pipeline">
        <Link to="/leads" icon={UserPlus} label="Travel Leads" requiredPermission={{ module: "leads", action: "read" }} />
        <Link to="/travel/leads" icon={UserPlus} label="Leads" requiredPermission={{ module: "leads", action: "read" }} />
        <Link to="/travel/pipeline" icon={Plane} label="Pipeline" requiredPermission={{ module: "pipeline", action: "read" }} />
        <Link to="/contacts" icon={Users} label="Contacts" requiredPermission={{ module: "contacts", action: "read" }} />
      </Section>

      <Section label="Customer comms">
        <Link to="/inbox" icon={InboxIcon} label="Inbox" count={counts.inbox} requiredPermission={{ module: "communications", action: "read" }} />
        <Link to="/travel/whatsapp" icon={MessageSquare} label="WhatsApp" requiredPermission={{ module: "whatsapp", action: "read" }} />
        <Link to="/sequences" icon={Send} label="Sequences" requiredPermission={{ module: "sequences", action: "read" }} />
        <Link to="/tasks" icon={CheckSquare} label="Tasks" count={counts.tasks} requiredPermission={{ module: "tasks", action: "read" }} />
        <Link to="/calendar-sync" icon={Calendar} label="Calendar" requiredPermission={{ module: "integrations", action: "read" }} />
      </Section>
      {/* Gmail — personal per-user mailbox connection (each staff member links
          their OWN Google account). Intentionally NO requiredPermission: it's a
          personal integration, not a permission-gated module, so every travel
          staff user sees it regardless of role. Placed OUTSIDE the Customer
          comms <Section> so the section can still collapse when the user has
          no comms grants. */}
      <Link to="/gmail" icon={Mail} label="Gmail" />

      <Section label="Financial">
        <Link to="/travel/invoices-admin" icon={Receipt} label="Invoices" requiredPermission={{ module: "invoices", action: "read" }} />
        <Link to="/travel/milestones" icon={Clock} label="Milestones" requiredPermission={{ module: "invoices", action: "read" }} />
        <Link to="/travel/payables" icon={CreditCard} label="Payables" requiredPermission={{ module: "payables", action: "read" }} />
        <Link to="/payments" icon={IndianRupee} label="Payments received" requiredPermission={{ module: "payments", action: "read" }} />
        <Link to="/expenses" icon={WalletIcon} label="Expense Management" requiredPermission={{ module: "expenses", action: "read" }} />
      </Section>

      {/* The generic /reports link was removed here — travel uses its own
          /travel/reports (linked above). The generic deal-stage chart +
          "Globussoft CRM" PDF don't fit the travel verticals, and /reports is
          now GenericOnly-gated anyway. */}

      {/* Admin + Platform — both blocks unwrapped from the legacy
          `{isManager && ...}` / `{isAdmin && ...}` outer guards. Each
          link now gates on its own permission. <Section> hides the
          group label when every child link is filtered out, so a
          custom role with no admin / platform grants no longer sees
          orphan section headings. */}
      <Section label="Admin">
        <Link to="/staff" icon={UsersRound} label="Staff" requiredPermission={{ module: "staff", action: "read" }} />
        <Link to="/settings" icon={Settings} label="Settings" requiredPermission={{ module: "settings", action: "read" }} />
        <Link to="/settings/roles" icon={ShieldCheck} label="Roles" requiredPermission={{ module: "roles", action: "read" }} />
        <Link to="/audit-log" icon={ScrollText} label="Audit Log" requiredPermission={{ module: "audit", action: "read" }} />
      </Section>

      <Section label="Platform">
        <Link to="/developer" icon={Code} label="Developer" requiredPermission={{ module: "developer", action: "read" }} />
        <Link to="/privacy" icon={Shield} label="Privacy" requiredPermission={{ module: "settings", action: "manage" }} />
        <Link to="/admin/brand-kits" icon={Palette} label="Brand Kits" requiredPermission={{ module: "settings", action: "manage" }} />
      </Section>

      {/* Notification Settings is a personal end-user surface — hidden
          from ADMIN / MANAGER (and therefore OWNER, which carries
          role==='ADMIN'). End users manage their own preferences here;
          admins / managers manage tenant-wide notification policy via
          Settings, not via a personal-account sidebar entry. Mirrors
          the generic sidebar's `!isAdmin && !isManager` gate around
          the same Link. */}
      {!isAdmin && !isManager && (
        <Section label="User">
          <Link to="/notification-settings" icon={Settings} label="Notification Settings" />
        </Section>
      )}

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
      {/* Core — Home is the role-aware widget dashboard for non-admins.
          Admins already see /dashboard (Enterprise Overview) which covers
          the same ground, so the Home link is hidden for them to keep
          their nav focused. Mirrors the catalog-level hideForAdminTier
          flag used by the wellness sidebar. */}
      {!isAdmin && <Link to="/home" end icon={LayoutDashboard} label="Home" />}
      <Link to="/dashboard" end icon={LayoutDashboard} label="Dashboard" />
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
        requiredPermission={{ module: "invoices", action: "read" }}
      />
      <Link
        to="/estimates"
        icon={FileSpreadsheet}
        label="Estimates"
        requiredPermission={{ module: "estimates", action: "read" }}
      />
      <Link
        to="/expenses"
        icon={IndianRupee}
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
      {/* Marketplace Leads sidebar link removed by request. Route stays
          mounted in App.jsx so /marketplace-leads is reachable by deep
          link / direct URL. */}

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

      {/* Admin section. Opens for the legacy `ADMIN` role-string AND for any
          custom role granted `roles.read` via RBAC — without the latter,
          custom-admin users would never see the Roles link (the only entry
          in this block gated by permission rather than strict role-string)
          even though /settings/roles route + RolesAdmin page are designed
          to admit them. The inner `adminOnly` links keep gating on the
          legacy role string, so a custom role with only roles.read sees just
          the Roles entry under this divider — which is the correct UX. */}
      {(isAdmin || (permissionsReady && hasPermission("roles", "read"))) && (
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
          {/* #917 slice 5 — CSP Violations admin (consumes GET /api/csp/violations
              shipped slice 3; page shipped slice 4 at /admin/csp-violations). */}
          <Link
            to="/admin/csp-violations"
            icon={ShieldAlert}
            label="CSP Violations"
            adminOnly
          />
          {/* S128 — Embed allowlist admin (Tenant.embedAllowlistJson editor).
              Pairs with CSP Violations: both surface iframe-embed security
              controls in one cluster. */}
          <Link
            to="/admin/embed-allowlist"
            icon={Shield}
            label="Embed Allowlist"
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
            icon={IndianRupee}
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
  // PERF: was `transition: "all 0.2s ease"`. `all` transitions every property
  // change — including layout-affecting ones — and fires on every hover state
  // change. Restrict to the properties the :hover/.active rules actually
  // animate: background-color and color. (Earlier this list included
  // `transform 0.2s ease` to cover a hover `translateX(4px)` effect, but
  // that effect was removed because the visual wave during scroll read as
  // lag. Listing transform here with no rule animating it kept the
  // compositor in "live layer" mode for nav-links — drop it.)
  transition: "background-color 0.2s ease, color 0.2s ease",
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
