import {
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
  // Wave 2 Agent II — POS / Cash Register / Shift / Sale
  Calculator,
  // Zylu-Gap #770/#779/#780/#781 — Cash Register admin
  Banknote,
  // Zylu-Gap #800 (WA-005) — Blocked WhatsApp numbers admin entry
  Ban,
  // Cron PRD Priority A #1 — LLM Spend admin dashboard
  Activity,
  // #898 — Campaigns sidebar surfacing (Email / SMS / Push)
  Megaphone,
  // Travel CRM vertical (Day 1 scaffolding — Phase 1 per docs/TRAVEL_CRM_PRD.md §7)
  Compass,
  ClipboardCheck,
  Map as MapIcon,
  Luggage,
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
  // Zylu-Gap #933 — Products admin entry (precursor for #816 CSV slice).
  Package,
} from "lucide-react";
import { AuthContext } from "../App";
import { fetchApi } from "../utils/api";
import { launchAdsGptAs, ADSGPT_DASHBOARD, ADSGPT_DEMO_LOGIN } from '../utils/adsgpt';
// #832 — Callified link is now an internal NavLink to /wellness/callified
// (the embedded iframe page). The launchCallifiedSSO util is still imported
// by that page + by OwnerDashboard's "Open Callified" card (which now
// navigates internally too), so the import is no longer needed in Sidebar.
import { useNotify } from '../utils/notify';
import { useActiveSubBrand } from '../utils/subBrand';

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
  const { activeSubBrand, setActiveSubBrand } = useActiveSubBrand();
  const role = user?.role || "USER";
  const isAdmin = role === "ADMIN";
  const isManager = role === "ADMIN" || role === "MANAGER";
  const wellnessRole = user?.wellnessRole || null;

  // Parse User.subBrandAccess (stored as JSON-string array on the User row).
  // null/empty/garbage => null = "no restriction" = all sub-brands visible.
  // Admins always see all sub-brands regardless of this column.
  const subBrandAccess = (() => {
    if (isAdmin) return null;
    const raw = user?.subBrandAccess;
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr;
    } catch { return null; }
  })();
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

  useEffect(() => {
    if (!user) return;
    refreshCounts();
    // 60s safety-net polling — covers cases where the socket can't connect
    // (nginx without /socket.io proxy) or events are missed during reconnects.
    const intervalId = setInterval(refreshCounts, 60000);

    // Live socket bumps — using the same single-namespace io('/') pattern as
    // NotificationBell. Failures are silent so the polling fallback owns
    // correctness.
    const socket = io("/", { reconnection: false, timeout: 5000 });
    socket.on("connect_error", () => {});
    socket.on("error", () => {});
    socket.on("marketplace_lead_imported", () =>
      setCounts((c) => ({ ...c, leads: c.leads + 1 })),
    );
    socket.on("marketplace_lead_new", (p) =>
      setCounts((c) => ({ ...c, leads: c.leads + (p?.count || 1) })),
    );
    socket.on("email_received", () =>
      setCounts((c) => ({ ...c, inbox: c.inbox + 1 })),
    );
    socket.on("lead_created", () =>
      setCounts((c) => ({ ...c, leads: c.leads + 1 })),
    );
    socket.on("task_created", () =>
      setCounts((c) => ({ ...c, tasks: c.tasks + 1 })),
    );
    socket.on("ticket_created", () =>
      setCounts((c) => ({ ...c, tickets: c.tickets + 1 })),
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

  // #625: re-fetch sidebar counters when the route changes. Without this,
  // a user who marks a task complete on /tasks navigates to /contacts and
  // sees the stale pre-mutation count in the sidebar (the original mount
  // fetch + 60s polling alone aren't enough for cross-page mutations that
  // don't have a backend socket emit). Cheap — one fetch per navigation,
  // and refreshCounts itself is a stable useCallback so it won't loop.
  useEffect(() => {
    if (!user) return;
    refreshCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

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
  });
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
  const Link = ({ to, icon: Icon, label, adminOnly, managerOnly, wellnessRoles, count, matchPaths = [] }) => {
    if (adminOnly && !isAdmin) return null;
    if (managerOnly && !isManager) return null;
    // wellnessRoles gates a link to specific wellnessRole values. Managers
    // and admins always pass through (mirrors the server's verifyWellnessRole
    // gate which whitelists admin/manager alongside the named clinical roles).
    if (wellnessRoles && !isManager && !wellnessRoles.includes(wellnessRole)) return null;
    return (
      <NavLink
        to={to}
        className={({ isActive }) => {
          const isPathMatch = matchPaths.some(path => location.pathname === path);
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

  // SSO-authenticated AdsGPT launcher — does the same token + Redis-key
  // handoff as the wellness OwnerDashboard card. If the SSO flow fails
  // (network / provider down), degrade to opening the plain dashboard URL
  // so the link is never dead.
  const [adsLoading, setAdsLoading] = useState(false);
  const AdsGptLink = ({ icon: Icon = Sparkles, label = "AdsGPT" }) => {
    const handleClick = async (e) => {
      e.preventDefault();
      if (adsLoading) return;
      setAdsLoading(true);
      try {
        await launchAdsGptAs(ADSGPT_DEMO_LOGIN);
      } catch (err) {
        console.error("[Sidebar] AdsGPT SSO error:", err.message);
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
        aria-label={`Open AdsGPT as ${ADSGPT_DEMO_LOGIN}`}
        title={`Open AdsGPT (${ADSGPT_DEMO_LOGIN}) in a new tab`}
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

  // #832 — Callified link now navigates to the embedded `/wellness/callified`
  // panel (iframe inside the CRM shell) instead of opening a new browser tab
  // via launchCallifiedSSO. The pen-test framing was "external-link icon +
  // new-tab launch reads as second-class compared with Unified Inbox /
  // WhatsApp Threads which render inline." Keeps the SSO contract — the
  // embed page fetches the same auth URL we used to call here. The
  // launchCallifiedSSO util stays available for anywhere a true new-tab
  // launch is still needed (e.g. an "Open in new tab" fallback CTA inside
  // the embed page itself when iframe load fails).
  const CallifiedLink = ({ icon: Icon = PhoneCall, label = "Callified" }) => (
    <Link to="/wellness/callified" icon={Icon} label={label} />
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
            gap: "0.75rem",
            flexShrink: 0,
          }}
        >
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={brand}
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                width: "32px",
                height: "32px",
                backgroundColor: brandColor || "var(--accent-color)",
                borderRadius: "8px",
                boxShadow: "0 0 15px var(--accent-glow)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
              }}
            >
              {isWellness ? <HeartPulse size={18} /> : null}
            </div>
          )}
          <h1
            style={{
              fontSize: "1.1rem",
              fontWeight: "bold",
              fontFamily: "var(--font-family)",
              lineHeight: 1.1,
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
                ExtLink,
                AdsGptLink,
                CallifiedLink,
                isAdmin,
                isManager,
                sectionLabelStyle,
                counts,
              })
            : isTravel
            ? renderTravelNav({
                Link,
                isAdmin,
                isManager,
                sectionLabelStyle,
                counts,
                subBrandAccess,
                activeSubBrand,
                setActiveSubBrand,
              })
            : renderGenericNav({
                Link,
                ExtLink,
                AdsGptLink,
                CallifiedLink,
                isAdmin,
                isManager,
                counts,
              })}
        </nav>
      </aside>
    </>
  );
};

// ── Wellness sidebar — slim, clinic-focused ───────────────────────

function renderWellnessNav({
  Link,
  ExtLink,
  AdsGptLink,
  CallifiedLink,
  isAdmin,
  isManager,
  sectionLabelStyle,
  counts = {},
}) {
  const labelStyle = sectionLabelStyle || sectionLabel;
  return (
    <>
      {/* Daily essentials — Owner Dashboard + Recommendations are management
          views over org-wide P&L / pending recommendation cards (#207/#216).
          Clinical staff (doctor/professional/telecaller/helper) should not see
          them in the nav. AdsGPT and Callified are external tools the whole
          team uses, so they stay visible for everyone.
          #833: the nav label was hard-coded "Owner Dashboard" for both ADMIN
          and MANAGER, which read as a role-mismatch for Demo Admin (the avatar
          said "Demo Admin" but the nav said "Owner"). Now label tracks the
          role: ADMIN → "Admin Dashboard", MANAGER → "Manager Dashboard",
          falls back to "Owner Dashboard" (true owner/superuser path). */}
      <Link
        to="/wellness"
        icon={LayoutDashboard}
        label={isAdmin ? 'Admin Dashboard' : isManager ? 'Manager Dashboard' : 'Owner Dashboard'}
        managerOnly
      />
      <Link
        to="/wellness/recommendations"
        icon={Sparkles}
        label="Recommendations"
        managerOnly
      />
      <AdsGptLink icon={Sparkles} label="AdsGPT" />
      <CallifiedLink icon={PhoneCall} label="Callified" />

      {/* #756 — Clinical nav (Patients / Calendar / Waitlist) is gated to
          clinical wellnessRoles. The backend PHI-read gate
          (verifyWellnessRole(["doctor","professional","telecaller","admin",
          "manager"])) rejects a USER with no wellnessRole — pre-fix these
          links rendered for the Demo User account and only revealed the
          denial on click. The Link helper's `wellnessRoles` prop hides them
          for non-clinical roles; managers/admins auto-pass (isManager check
          inside Link). Service Catalog stays managerOnly — clinical staff
          read it via the API but only managers get the nav link. */}
      <div style={labelStyle}>Clinical</div>
      <Link to="/wellness/patients" icon={HeartPulse} label="Patients" wellnessRoles={["doctor", "professional", "telecaller"]} />
      <Link to="/wellness/calendar" icon={Calendar} label="Calendar" wellnessRoles={["doctor", "professional", "telecaller"]} />
      <Link to="/wellness/waitlist" icon={Clock} label="Waitlist" wellnessRoles={["doctor", "professional", "telecaller"]} />
      <Link
        to="/wellness/services"
        icon={Stethoscope}
        label="Service Catalog"
        managerOnly
      />
      {/* Wave 7 Agent A — ServiceCategory hierarchical taxonomy (PRD Gap §10 #1) */}
      <Link
        to="/wellness/service-categories"
        icon={Stethoscope}
        label="Service Categories"
        managerOnly
      />
      {/* Wave 7 Agent A — Drug catalogue for prescription writing (PRD Gap §10 #2) */}
      <Link
        to="/wellness/drugs"
        icon={Stethoscope}
        label="Drug Catalogue"
        managerOnly
      />
      {/* Wave 11 Agent EE: Memberships catalog — manager+ only (mirrors Service Catalog) */}
      <Link
        to="/wellness/memberships"
        icon={Crown}
        label="Memberships"
        managerOnly
      />
      <Link
        to="/wellness/visits"
        icon={HeartPulse}
        label="Visits"
        managerOnly
      />
      {/* Wave 11 Agent GG — Resource availability (rooms / holidays /
          working hours). Manager+ only. */}
      <Link
        to="/wellness/resources"
        icon={Building2}
        label="Resources"
        managerOnly
      />
      <Link
        to="/wellness/holidays"
        icon={Calendar}
        label="Holidays"
        managerOnly
      />
      <Link
        to="/wellness/working-hours"
        icon={Clock}
        label="Working Hours"
        managerOnly
      />

      {/* Wave 2 Agent JJ — Staff Attendance + Leave Management. */}
      <div style={labelStyle}>Staff</div>
      <Link to="/wellness/attendance" icon={Clock} label="Attendance" />
      <Link to="/wellness/leave" icon={Calendar} label="Leave" />

      {/* Lead-to-revenue */}
      <div style={labelStyle}>Leads & Revenue</div>
      <Link
        to="/inbox"
        icon={InboxIcon}
        label="Unified Inbox"
        count={counts.inbox}
      />
      {/* Wave 2 Agent KK - WhatsApp 2-way threads (agent inbox). */}
      <Link
        to="/wellness/whatsapp"
        icon={MessageSquare}
        label="WhatsApp Threads"
      />
      {/* Zylu-Gap #800 — Blocked WhatsApp numbers admin (opt-outs).
          managerOnly because /opt-outs POST is ADMIN+MANAGER (DELETE is
          ADMIN-only; the page hides Unblock for non-admins inside). */}
      <Link
        to="/wellness/whatsapp/blocked-numbers"
        icon={Ban}
        label="Blocked Numbers"
        managerOnly
      />
      {/* Telecaller Queue: visible to wellnessRole=telecaller and to
          managers/admins for oversight. Plain users (and clinical staff
          without the telecaller wellnessRole) saw a 403 toast on every
          load, so the link is hidden for them — matches the server's
          verifyWellnessRole(["telecaller","admin","manager"]) gate on
          /api/wellness/telecaller/queue + /telecaller/dispose. */}
      <Link
        to="/wellness/telecaller"
        icon={PhoneCall}
        label="Telecaller Queue"
        wellnessRoles={["telecaller"]}
      />
      <Link
        to="/leads"
        icon={UserPlus}
        label="All Leads"
        managerOnly
        count={counts.leads}
      />
      <Link
        to="/converted-leads"
        icon={UserPlus}
        label="Converted Leads"
        managerOnly
      />
      <Link to="/tasks" icon={CheckSquare} label="Tasks" count={counts.tasks} />
      <Link
        to="/marketplace-leads"
        icon={ShoppingBag}
        label="Marketplace Leads"
        managerOnly
        matchPaths={["/marketplace"]}
      />
      <Link to="/lead-routing" icon={Send} label="Routing Rules" managerOnly />

      {/* Money — clinic-side, in INR for Indian wellness tenants */}
      <div style={labelStyle}>Finance</div>
      {/* Wave 2 Agent II: POS / "New Sale" — open shifts, ring up cash-and-
          carry sales, close shifts. All staff can use it (backend gates
          to wellnessRole admin/manager/doctor/professional/telecaller/helper). */}
      <Link to="/wellness/pos" icon={Calculator} label="Point of Sale" />
      {/* Zylu-Gap #770/#779/#780/#781 — Cash Register admin (list + shift
          lifecycle + status header + recent transactions). Without this
          surface POS is permanently gated: /pos/sales needs an OPEN shift
          on a Register, and the only place to create that Register is here. */}
      <Link to="/wellness/cash-registers" icon={Banknote} label="Cash Registers" />
      <Link to="/invoices" icon={Receipt} label="Invoices" />
      <Link to="/estimates" icon={FileSpreadsheet} label="Estimates" />
      <Link to="/expenses" icon={DollarSign} label="Expenses" />
      <Link to="/payments" icon={CreditCard} label="Payments" managerOnly />
      {/* Wave 11 Agent FF: Wallet + Gift Cards + Coupons + Cashback (manager+) */}
      <Link to="/wellness/wallet" icon={WalletIcon} label="Patient Wallets" managerOnly />
      <Link to="/wellness/giftcards" icon={Gift} label="Gift Cards" managerOnly />
      <Link to="/wellness/coupons" icon={TicketPercent} label="Coupons" managerOnly />
      <Link to="/wellness/cashback-rules" icon={Coins} label="Cashback Rules" managerOnly />

      {/* Marketing — clinic-side comms (ad campaigns live in AdsGPT). All items are
          managerOnly, so the whole section is hidden for plain users — otherwise the
          header rendered as an orphan with no children (#107). */}
      {isManager && (
        <>
          <div style={labelStyle}>Marketing</div>
          {/* #898: Campaigns sidebar surfacing. Deep-links to the existing
              Marketing page (Email / SMS / Push Campaigns tab is the default).
              Backed by Campaign rows via GET /api/marketing/campaigns. */}
          <Link
            to="/campaigns"
            icon={Megaphone}
            label="Campaigns"
            managerOnly
          />
          <Link
            to="/marketing"
            icon={Send}
            label="SMS / Email Blasts"
            managerOnly
          />
          <Link
            to="/sequences"
            icon={Network}
            label="Drip Sequences"
            managerOnly
          />
          <Link
            to="/landing-pages"
            icon={PanelTop}
            label="Landing Pages"
            managerOnly
          />
        </>
      )}

      {/* Reports — wellness-tuned, generic CRM reports removed. Same orphan-header
          fix as Marketing above. */}
      {isManager && (
        <>
          <div style={labelStyle}>Reports</div>
          <Link
            to="/wellness/reports"
            icon={BarChart3}
            label="P&L + Attribution"
            managerOnly
          />
          <Link
            to="/wellness/per-location"
            icon={Building2}
            label="Per-Location"
            managerOnly
          />
          <Link
            to="/wellness/loyalty"
            icon={Award}
            label="Loyalty + Referrals"
            managerOnly
          />
          <Link
            to="/surveys"
            icon={ClipboardList}
            label="Patient Surveys"
            managerOnly
          />
          <Link
            to="/knowledge-base"
            icon={BookOpen}
            label="Knowledge Base"
            managerOnly
          />
        </>
      )}

      {/* Admin */}
      {isAdmin && (
        <>
          <div style={labelStyle}>Admin</div>
          <Link
            to="/wellness/locations"
            icon={Building2}
            label="Locations"
            adminOnly
          />
          {/* Wave 11 Agent HH — Inventory backbone admin entries.
              Categories + Vendors are config; Receipts/Adjustments are the
              operational ledger surfaces; Auto-consumption is the rules engine. */}
          <div style={labelStyle}>Inventory</div>
          {/* Zylu-Gap #933 — Products admin list (precursor for #816 CSV slice). */}
          <Link to="/wellness/products" icon={Package} label="Products" managerOnly />
          <Link to="/wellness/product-categories" icon={Layers} label="Categories" managerOnly />
          <Link to="/wellness/vendors" icon={Truck} label="Vendors" managerOnly />
          <Link to="/wellness/inventory-receipts" icon={ArrowDownToLine} label="Receipts" managerOnly />
          <Link to="/wellness/inventory-adjustments" icon={Receipt} label="Adjustments" managerOnly />
          <Link to="/wellness/auto-consumption-rules" icon={Recycle} label="Auto-consumption" managerOnly />
          <Link to="/staff" icon={UsersRound} label="Staff" adminOnly />
          {/* PRD Gap §1.5 / §1.6 — wellness admins also manage payroll. */}
          <Link
            to="/commission-profiles"
            icon={Award}
            label="Commission Profiles"
            adminOnly
          />
          <Link
            to="/revenue-goals"
            icon={Target}
            label="Revenue Goals"
            adminOnly
          />
          <Link to="/channels" icon={Radio} label="Channels" adminOnly />
          <Link to="/audit-log" icon={ScrollText} label="Audit Log" adminOnly />
          <Link to="/privacy" icon={Shield} label="Privacy" adminOnly />
          {/* Per-tenant cap-override admin UI. Surfaces /api/tenant-settings
              CRUD (backend commit 1542b8e) so ADMINs can configure budget caps
              for AdsGPT / AI calling / RateHawk / LLM without DB access. */}
          <Link
            to="/admin/tenant-settings"
            icon={DollarSign}
            label="Tenant Settings"
            adminOnly
          />
          {/* Per-sub-brand BrandKit admin UI. Surfaces /api/brand-kits CRUD
              (backend commit e4783e0) so ADMINs can manage logo / colors /
              font / tagline per sub-brand without DB access. */}
          <Link
            to="/admin/brand-kits"
            icon={Palette}
            label="Brand Kits"
            adminOnly
          />
          {/* AdsGPT Reports admin UI. Surfaces /api/adsgpt (backend commit
              0d66a74) — per-platform ad performance + cap utilisation.
              managerOnly so MANAGERs see it too (analytics, not config). */}
          <Link
            to="/admin/adsgpt-reports"
            icon={TrendingUp}
            label="AdsGPT Reports"
            managerOnly
          />
          {/* RateHawk hotel-search admin UI. Surfaces /api/ratehawk (backend
              commit be67789) — hotel inventory search + cap utilisation.
              managerOnly so MANAGERs see it too (operator search, not config).
              Stub-mode banner surfaces while Q19 cred-blocked. */}
          <Link
            to="/admin/ratehawk-search"
            icon={Hotel}
            label="RateHawk Search"
            managerOnly
          />
          {/* Callified AI calls admin UI. Surfaces /api/callified (backend
              commit cdad62d) — outbound AI call initiation + cap utilisation
              + feature-flag check. managerOnly so MANAGERs see it too
              (operator action, not config). Stub-mode banner surfaces while
              Q1 cred-blocked (Yasin's Callified.ai handover). */}
          <Link
            to="/admin/callified-calls"
            icon={PhoneCall}
            label="Callified Calls"
            managerOnly
          />
          {/* Booking.com / Expedia hotel-search admin UI. Surfaces
              /api/booking-expedia (backend commit bb33cbe, tick #105) —
              direct-API hotel inventory search + shared cap utilisation.
              managerOnly so MANAGERs see it too (operator search, not
              config). Phase 2 deferred-by-design: Expedia returns 503
              EXPEDIA_NOT_YET_ENABLED until DC-4 flips + Q11 lands. */}
          <Link
            to="/admin/booking-expedia-search"
            icon={BedDouble}
            label="Booking / Expedia"
            managerOnly
          />
          {/* Wallet bonus rule CRUD admin UI. Surfaces /api/wallet/rules
              (Agent B ships next tick, slice 3 of PRD_WALLET_TOPUP). ADMIN-only
              per PRD §3.9 RBAC matrix. Page is robust to backend absence. */}
          <Link
            to="/admin/wallet-rules"
            icon={WalletIcon}
            label="Wallet Bonus Rules"
            adminOnly
          />
          <Link to="/settings" icon={Settings} label="Settings" adminOnly />
        </>
      )}

      {!isAdmin && isManager && (
        <>
          <div style={labelStyle}>Settings</div>
          <Link to="/settings" icon={Settings} label="Settings" />
        </>
      )}

      {/* User Notification Settings — only for regular users, not admin/manager */}
      {!isAdmin && !isManager && (
        <>
          <div style={labelStyle}>User</div>
          <Link to="/notification-settings" icon={Settings} label="Notification Settings" />
        </>
      )}
    </>
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
function renderTravelNav({
  Link,
  isAdmin,
  isManager,
  sectionLabelStyle,
  counts = {},
  subBrandAccess = null,
  activeSubBrand = null,
  setActiveSubBrand = () => {},
}) {
  const labelStyle = sectionLabelStyle || sectionLabel;
  // Q25 sub-brand switcher. Only render the dropdown when the user
  // either has full access (subBrandAccess === null, includes admins)
  // or has access to ≥2 sub-brands — a single-sub-brand user has no
  // choice to make, so the dropdown would be noise. Selecting "All"
  // clears the active filter back to null.
  const ALL_SUB_BRANDS = [
    { value: "tmc", label: "TMC" },
    { value: "rfu", label: "RFU" },
    { value: "travelstall", label: "Travel Stall" },
    { value: "visasure", label: "Visa Sure" },
  ];
  const visibleSubBrands = subBrandAccess === null
    ? ALL_SUB_BRANDS
    : ALL_SUB_BRANDS.filter((s) => subBrandAccess.includes(s.value));
  const showSwitcher = visibleSubBrands.length >= 2;
  return (
    <>
      <div style={labelStyle}>Travel</div>
      {showSwitcher && (
        <div style={{ padding: "4px 12px 8px", display: "flex", alignItems: "center", gap: 6 }}>
          <label htmlFor="travel-sub-brand-switcher" style={{ fontSize: 10, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Sub-brand
          </label>
          <select
            id="travel-sub-brand-switcher"
            value={activeSubBrand || ""}
            onChange={(e) => setActiveSubBrand(e.target.value || null)}
            style={{
              flex: 1, fontSize: 12, padding: "4px 6px", borderRadius: 4,
              border: "1px solid var(--border-color)",
              background: "var(--surface-color)", color: "var(--text-primary)",
            }}
            aria-label="Switch active sub-brand"
          >
            <option value="">All ({visibleSubBrands.length})</option>
            {visibleSubBrands.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      )}
      <Link to="/travel" icon={Compass} label="Dashboard" />
      <Link to="/travel/leads" icon={UserPlus} label="Leads" />
      <Link to="/travel/diagnostics" icon={ClipboardCheck} label="Diagnostics" />
      <Link to="/travel/itineraries" icon={MapIcon} label="Itineraries" />
      <Link to="/travel/trips" icon={Luggage} label="TMC Trips" />
      <Link to="/travel/web-checkins" icon={Ticket} label="Web Check-ins" />
      <Link to="/travel/cost-master" icon={DollarSign} label="Cost Master" />
      {isAdmin && <Link to="/travel/pricing-rules" icon={BadgePercent} label="Pricing Rules" />}
      <Link to="/travel/reports" icon={BarChart3} label="Reports" />
      <Link to="/travel/suppliers-admin" icon={Building2} label="Suppliers" />
      <Link to="/travel/quotes-admin" icon={FileText} label="Quotes" />
      {/* Arc 2 #900 slice 2 — operator-facing Quote Builder (line items +
          totals + action cluster). Distinct from the CRUD list above.
          MANAGER+ per RoleGuard on the route element. */}
      {isManager && <Link to="/travel/quotes/builder" icon={Calculator} label="Quote Builder" />}
      <Link to="/travel/invoices-admin" icon={Receipt} label="Invoices" />
      {isAdmin && <Link to="/travel/suppliers" icon={Key} label="Supplier credentials" />}
      {isAdmin && <Link to="/travel/religious-packets" icon={BookOpen} label="Religious Packets" />}
      {/* tick #181 — curriculum-mappings CRUD admin (consumes
          /api/travel-curriculum). TMC vertical school-trip pitch deck.
          ADMIN-only per backend RBAC + RoleGuard on the route element. */}
      {isAdmin && <Link to="/travel/curriculum-mappings" icon={GraduationCap} label="Curriculum Mappings" />}
      {/* tick #186 — Marketing Flyer Studio Phase 2 SHELL (#908).
          MANAGER+ operator-facing surface; real impl per PRD §8 build
          order in docs/PRD_TRAVEL_MARKETING_FLYER.md. */}
      {isManager && <Link to="/travel/marketing/flyer-studio" icon={FileImage} label="Marketing Flyer Studio" />}

      {/* Phase 3 Visa Sure scaffolding (cluster B3) — placeholder shells, admin-only.
          Real implementation gated on product calls in docs/PRD_VISA_SURE_PHASE_3.md §5 + §9. */}
      {isAdmin && (
        <>
          <div style={labelStyle}>Visa Sure</div>
          <Link to="/travel/visa" icon={Stamp} label="Dashboard" />
          <Link to="/travel/visa/applications" icon={BadgeCheck} label="Applications" />
          <Link to="/travel/visa/checklists" icon={ClipboardList} label="Checklists" />
          {/* tick #178 — embassy-rules CRUD admin (consumes /api/embassy-rules).
              ADMIN-only per backend RBAC + RoleGuard on the route element. */}
          <Link to="/travel/visa/embassy-rules" icon={Shield} label="Embassy Rules" />
        </>
      )}

      {/* Phase 2 Travel Stall operator landing (TS21) — scaffold shell.
          Operator-facing surface, visible to admin + manager. */}
      {isManager && (
        <>
          <div style={labelStyle}>Travel Stall</div>
          <Link to="/travel-stall" icon={Sparkles} label="Dashboard" />
        </>
      )}

      <div style={labelStyle}>Sales pipeline</div>
      <Link to="/leads" icon={UserPlus} label="Leads" />
      <Link to="/contacts" icon={Users} label="Contacts" />
      <Link to="/pipeline" icon={Briefcase} label="Pipeline" />

      <div style={labelStyle}>Customer comms</div>
      <Link to="/inbox" icon={InboxIcon} label="Inbox" badge={counts.inbox} />
      <Link to="/sequences" icon={Send} label="Sequences" />
      <Link to="/tasks" icon={CheckSquare} label="Tasks" badge={counts.tasks} />

      <div style={labelStyle}>Financial</div>
      <Link to="/invoices" icon={Receipt} label="Invoices" />
      <Link to="/payments" icon={DollarSign} label="Payments" />
      <Link to="/quotes" icon={FileText} label="Quotes" />

      <div style={labelStyle}>Reports</div>
      <Link to="/reports" icon={BarChart3} label="Reports" />

      {isManager && (
        <>
          <div style={labelStyle}>Admin</div>
          <Link to="/staff" icon={UsersRound} label="Staff" />
          <Link to="/settings" icon={Settings} label="Settings" />
          <Link to="/audit-log" icon={ScrollText} label="Audit Log" />
        </>
      )}

      {isAdmin && (
        <>
          <div style={labelStyle}>Platform</div>
          <Link to="/developer" icon={Code} label="Developer" />
          <Link to="/privacy" icon={Shield} label="Privacy" />
        </>
      )}

      {!isAdmin && !isManager && (
        <>
          <div style={labelStyle}>User</div>
          <Link to="/notification-settings" icon={Settings} label="Notification Settings" />
        </>
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
  counts = {},
}) {
  return (
    <>
      {/* Core — visible to ALL roles */}
      <Link to="/dashboard" icon={LayoutDashboard} label="Dashboard" />
      <AdsGptLink icon={Sparkles} label="AdsGPT" />
      <CallifiedLink icon={PhoneCall} label="Callified" />
      <Link to="/inbox" icon={InboxIcon} label="Inbox" count={counts.inbox} />
      <Link to="/contacts" icon={Users} label="Contacts" />
      <Link to="/pipeline" icon={Briefcase} label="Pipeline" />
      <Link to="/leads" icon={UserPlus} label="Leads" count={counts.leads} />
      <Link to="/converted-leads" icon={UserPlus} label="Converted Leads" />
      <Link to="/clients" icon={Building2} label="Clients" />
      <Link to="/tasks" icon={CheckSquare} label="Task Queue" count={counts.tasks} />
      <Link to="/tickets" icon={Ticket} label="Tickets" count={counts.tickets} />
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

      <Link to="/invoices" icon={Receipt} label="Invoices" />
      <Link to="/estimates" icon={FileSpreadsheet} label="Estimates" />
      <Link to="/expenses" icon={DollarSign} label="Expenses" />
      <Link to="/contracts" icon={FileText} label="Contracts" />
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

      {/* #898: Campaigns alias for the generic sidebar (deep-links to /marketing
          which defaults to the Email Campaigns tab). */}
      <Link to="/campaigns" icon={Megaphone} label="Campaigns" managerOnly />
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
          <Link to="/audit-log" icon={ScrollText} label="Audit Log" adminOnly />
          {/* Cron PRD Priority A #1 — LLM observability dashboard. ADMIN-only;
              surfaces /api/admin/llm-spend rollups. */}
          <Link to="/llm-spend" icon={Activity} label="LLM Spend" adminOnly />
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
          {/* Per-tenant cap-override admin UI. Surfaces /api/tenant-settings
              CRUD (backend commit 1542b8e) so ADMINs can configure budget caps
              for AdsGPT / AI calling / RateHawk / LLM without DB access. */}
          <Link
            to="/admin/tenant-settings"
            icon={DollarSign}
            label="Tenant Settings"
            adminOnly
          />
          {/* Per-sub-brand BrandKit admin UI. Surfaces /api/brand-kits CRUD
              (backend commit e4783e0) so ADMINs can manage logo / colors /
              font / tagline per sub-brand without DB access. */}
          <Link
            to="/admin/brand-kits"
            icon={Palette}
            label="Brand Kits"
            adminOnly
          />
          {/* AdsGPT Reports admin UI. Surfaces /api/adsgpt (backend commit
              0d66a74) — per-platform ad performance + cap utilisation.
              managerOnly so MANAGERs see it too (analytics, not config). */}
          <Link
            to="/admin/adsgpt-reports"
            icon={TrendingUp}
            label="AdsGPT Reports"
            managerOnly
          />
          {/* RateHawk hotel-search admin UI. Surfaces /api/ratehawk (backend
              commit be67789) — hotel inventory search + cap utilisation.
              managerOnly so MANAGERs see it too (operator search, not config).
              Stub-mode banner surfaces while Q19 cred-blocked. */}
          <Link
            to="/admin/ratehawk-search"
            icon={Hotel}
            label="RateHawk Search"
            managerOnly
          />
          {/* Callified AI calls admin UI. Surfaces /api/callified (backend
              commit cdad62d) — outbound AI call initiation + cap utilisation
              + feature-flag check. managerOnly so MANAGERs see it too
              (operator action, not config). Stub-mode banner surfaces while
              Q1 cred-blocked (Yasin's Callified.ai handover). */}
          <Link
            to="/admin/callified-calls"
            icon={PhoneCall}
            label="Callified Calls"
            managerOnly
          />
          {/* Booking.com / Expedia hotel-search admin UI. Surfaces
              /api/booking-expedia (backend commit bb33cbe, tick #105) —
              direct-API hotel inventory search + shared cap utilisation.
              managerOnly so MANAGERs see it too (operator search, not
              config). Phase 2 deferred-by-design: Expedia returns 503
              EXPEDIA_NOT_YET_ENABLED until DC-4 flips + Q11 lands. */}
          <Link
            to="/admin/booking-expedia-search"
            icon={BedDouble}
            label="Booking / Expedia"
            managerOnly
          />
          {/* Wallet bonus rule CRUD admin UI. Surfaces /api/wallet/rules
              (Agent B ships next tick, slice 3 of PRD_WALLET_TOPUP). ADMIN-only
              per PRD §3.9 RBAC matrix. Page is robust to backend absence. */}
          <Link
            to="/admin/wallet-rules"
            icon={WalletIcon}
            label="Wallet Bonus Rules"
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
          <Link to="/notification-settings" icon={Settings} label="Notification Settings" />
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
