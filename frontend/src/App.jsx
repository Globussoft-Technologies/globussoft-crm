import React, {
  useState,
  useContext,
  createContext,
  useEffect,
  useMemo,
  useCallback,
  Suspense,
} from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
} from "react-router-dom";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Landing from "./pages/Landing";
import Layout from "./components/Layout";
import RouteErrorBoundary from "./components/RouteErrorBoundary";
import RoleGuard from "./components/RoleGuard";
import { NotifyProvider } from "./utils/notify";
import { ActiveSubBrandProvider } from "./utils/subBrand";
import { lazyWithRetry as lazy } from "./utils/lazyWithRetry";
import {
  setAuthToken,
  getAuthToken,
  clearAuthToken,
  markAuthReady,
} from "./utils/api";
import "./theme/wellness.css"; // wellness vertical theme overrides (scoped)
import "./theme/travel.css"; // travel vertical theme overrides (scoped, Day 1 placeholder palette)

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Contacts = lazy(() => import("./pages/Contacts"));
const ContactDetail = lazy(() => import("./pages/ContactDetail"));
const Pipeline = lazy(() => import("./pages/Pipeline"));
const Workflows = lazy(() => import("./pages/Workflows"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Marketing = lazy(() => import("./pages/Marketing"));
const Reports = lazy(() => import("./pages/Reports"));
const AgentReports = lazy(() => import("./pages/AgentReports"));
const Settings = lazy(() => import("./pages/Settings"));
const UserSettings = lazy(() => import("./pages/UserSettings"));
const Developer = lazy(() => import("./pages/Developer"));
const Portal = lazy(() => import("./pages/Portal"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const CPQ = lazy(() => import("./pages/CPQ"));
const CustomObjects = lazy(() => import("./pages/CustomObjects"));
const CustomObjectView = lazy(() => import("./pages/CustomObjectView"));
const Sequences = lazy(() => import("./pages/Sequences"));
const SequenceBuilder = lazy(() => import("./pages/SequenceBuilder"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Tickets = lazy(() => import("./pages/Tickets"));
const Support = lazy(() => import("./pages/Support"));
const Staff = lazy(() => import("./pages/Staff"));
const Invoices = lazy(() => import("./pages/Invoices"));
const LeadScoring = lazy(() => import("./pages/LeadScoring"));
const Leads = lazy(() => import("./pages/Leads"));
const ConvertedLeads = lazy(() => import("./pages/ConvertedLeads"));
const Clients = lazy(() => import("./pages/Clients"));
const Expenses = lazy(() => import("./pages/Expenses"));
const Contracts = lazy(() => import("./pages/Contracts"));
const Estimates = lazy(() => import("./pages/Estimates"));
const QuotesComingSoon = lazy(() => import("./pages/QuotesComingSoon"));
const Projects = lazy(() => import("./pages/Projects"));
const Profile = lazy(() => import("./pages/Profile"));
const Pricing = lazy(() => import("./pages/Pricing"));
const MarketplaceLeads = lazy(() => import("./pages/MarketplaceLeads"));
const Channels = lazy(() => import("./pages/Channels"));
const LandingPages = lazy(() => import("./pages/LandingPages"));
const LandingPageBuilder = lazy(() => import("./pages/LandingPageBuilder"));
const AuditLog = lazy(() => import("./pages/AuditLog"));
// Cron PRD Priority A #1 — ADMIN-only LLM spend dashboard. Surfaces
// /api/admin/llm-spend (commit f5c9518) which aggregates LlmCallLog rows
// produced by the 4 router consumers (talking-points / form-vs-call /
// itinerary-draft / religious-guidance).
const LlmSpend = lazy(() => import("./pages/LlmSpend"));
const Privacy = lazy(() => import("./pages/Privacy"));
const CalendarSync = lazy(() => import("./pages/CalendarSync"));
const Profile2FA = lazy(() => import("./pages/Profile2FA"));
const Pipelines = lazy(() => import("./pages/Pipelines"));
const Forecasting = lazy(() => import("./pages/Forecasting"));
const Dashboards = lazy(() => import("./pages/Dashboards"));
const CustomReports = lazy(() => import("./pages/CustomReports"));
const BookingPages = lazy(() => import("./pages/BookingPages"));
const Signatures = lazy(() => import("./pages/Signatures"));
const KnowledgeBase = lazy(() => import("./pages/KnowledgeBase"));
const Currencies = lazy(() => import("./pages/Currencies"));
const FieldPermissions = lazy(() => import("./pages/FieldPermissions"));
// PRD Gap §1.5 / §1.6 — admin pages for commission profiles + per-staff
// revenue goals.
const CommissionProfiles = lazy(() => import("./pages/CommissionProfiles"));
const RevenueGoals = lazy(() => import("./pages/RevenueGoals"));
const LeadRouting = lazy(() => import("./pages/LeadRouting"));
const Territories = lazy(() => import("./pages/Territories"));
const Quotas = lazy(() => import("./pages/Quotas"));
const WinLoss = lazy(() => import("./pages/WinLoss"));
const AbTests = lazy(() => import("./pages/AbTests"));
const WebVisitors = lazy(() => import("./pages/WebVisitors"));
const Chatbots = lazy(() => import("./pages/Chatbots"));
const Approvals = lazy(() => import("./pages/Approvals"));
const DocumentTemplates = lazy(() => import("./pages/DocumentTemplates"));
const Surveys = lazy(() => import("./pages/Surveys"));
const Payments = lazy(() => import("./pages/Payments"));
const DealInsights = lazy(() => import("./pages/DealInsights"));
const SharedInbox = lazy(() => import("./pages/SharedInbox"));
const SLA = lazy(() => import("./pages/SLA"));
const LiveChat = lazy(() => import("./pages/LiveChat"));
const Playbooks = lazy(() => import("./pages/Playbooks"));
const DocumentTracking = lazy(() => import("./pages/DocumentTracking"));
const IndustryTemplates = lazy(() => import("./pages/IndustryTemplates"));
const Social = lazy(() => import("./pages/Social"));
const Sandbox = lazy(() => import("./pages/Sandbox"));
const Funnel = lazy(() => import("./pages/Funnel"));
const Zapier = lazy(() => import("./pages/Zapier"));
// Public pages
const SsoReturn = lazy(() => import("./pages/SsoReturn"));
const PaymentSuccess = lazy(() => import("./pages/PaymentSuccess"));
const PaymentFailed = lazy(() => import("./pages/PaymentFailed"));
// Travel vertical (Day 1 scaffolding — Phase 1 pages land per docs/TRAVEL_CRM_PRD.md §7)
const TravelDashboard = lazy(() => import("./pages/travel/Dashboard"));
const TravelDiagnostics = lazy(() => import("./pages/travel/Diagnostics"));
const TravelDiagnosticWizard = lazy(() => import("./pages/travel/DiagnosticWizard"));
const TravelDiagnosticBuilder = lazy(() => import("./pages/travel/DiagnosticBuilder"));
const TravelDiagnosticDetail = lazy(() => import("./pages/travel/DiagnosticDetail"));
const TravelItineraries = lazy(() => import("./pages/travel/Itineraries"));
const TravelTrips = lazy(() => import("./pages/travel/Trips"));
const TravelTripDetail = lazy(() => import("./pages/travel/TripDetail"));
const TravelWebCheckinQueue = lazy(() => import("./pages/travel/WebCheckinQueue"));
const TravelCostMaster = lazy(() => import("./pages/travel/CostMaster"));
const TravelLeads = lazy(() => import("./pages/travel/Leads"));
const TravelPricingRules = lazy(() => import("./pages/travel/PricingRules"));
const TravelReports = lazy(() => import("./pages/travel/Reports"));
const TravelRfuCustomerProfile = lazy(() => import("./pages/travel/RfuCustomerProfile"));
const TravelSuppliers = lazy(() => import("./pages/travel/Suppliers"));
const TravelReligiousPackets = lazy(() => import("./pages/travel/ReligiousPackets"));
const TravelItineraryDetail = lazy(() => import("./pages/travel/ItineraryDetail"));
const TravelLeadDetail = lazy(() => import("./pages/travel/LeadDetail"));
// Wellness vertical
const WellnessOwnerDashboard = lazy(
  () => import("./pages/wellness/OwnerDashboard"),
);
const WellnessRecommendations = lazy(
  () => import("./pages/wellness/Recommendations"),
);
const WellnessPatients = lazy(() => import("./pages/wellness/Patients"));
const WellnessPatientDetail = lazy(
  () => import("./pages/wellness/PatientDetail"),
);
const WellnessServices = lazy(() => import("./pages/wellness/Services"));
const WellnessLocations = lazy(() => import("./pages/wellness/Locations"));
const WellnessMemberships = lazy(() => import("./pages/wellness/Memberships"));
// Wave 7 Agent A — ServiceCategory + Drug catalogue (PRD Gap §10 #1 + #2)
const WellnessServiceCategories = lazy(() => import("./pages/wellness/ServiceCategories"));
const WellnessDrugs = lazy(() => import("./pages/wellness/Drugs"));
// Wave 11 Agent FF — Wallet + Gift Cards + Coupons + Cashback rules
// (4 admin/manager-gated pages under /wellness/* — see RoleGuard wrap below).
const WellnessWallet = lazy(() => import("./pages/wellness/Wallet"));
const WellnessGiftCards = lazy(() => import("./pages/wellness/GiftCards"));
const WellnessCoupons = lazy(() => import("./pages/wellness/Coupons"));
const WellnessCashbackRules = lazy(() => import("./pages/wellness/CashbackRules"));
const WellnessCalendar = lazy(() => import("./pages/wellness/Calendar"));
const WellnessReports = lazy(() => import("./pages/wellness/Reports"));
const WellnessVisits = lazy(() => import("./pages/wellness/Visits"));
const WellnessPublicBooking = lazy(
  () => import("./pages/wellness/PublicBooking"),
);
const TravelStallQuiz = lazy(
  () => import("./pages/public/TravelStallQuiz"),
);
const TripBooking = lazy(
  () => import("./pages/public/TripBooking"),
);
const WellnessTelecallerQueue = lazy(
  () => import("./pages/wellness/TelecallerQueue"),
);
const WellnessPatientPortal = lazy(
  () => import("./pages/wellness/PatientPortal"),
);
const WellnessPerLocation = lazy(
  () => import("./pages/wellness/PerLocationDashboard"),
);
const WellnessLoyalty = lazy(() => import("./pages/wellness/Loyalty"));
const WellnessWaitlist = lazy(() => import("./pages/wellness/Waitlist"));
// #305: /wellness/inventory used to render a blank page (no route element).
// Inventory is implemented as a tab inside PatientDetail; this stub explains
// that and links to the patient list.
const WellnessInventory = lazy(() => import("./pages/wellness/Inventory"));
// Wave 11 Agent HH — Inventory backbone admin pages (categories, vendors,
// receipts, adjustments, auto-consumption rules). All ADMIN/MANAGER-only.
const WellnessProductCategories = lazy(() => import("./pages/wellness/ProductCategories"));
const WellnessVendors = lazy(() => import("./pages/wellness/Vendors"));
const WellnessInventoryReceipts = lazy(() => import("./pages/wellness/InventoryReceipts"));
const WellnessInventoryAdjustments = lazy(() => import("./pages/wellness/InventoryAdjustments"));
const WellnessAutoConsumptionRules = lazy(() => import("./pages/wellness/AutoConsumptionRules"));
// Wave 11 Agent GG — Resource availability admin pages (rooms / machines /
// holidays / per-doctor working hours). All ADMIN/MANAGER-only.
const WellnessResources = lazy(() => import("./pages/wellness/Resources"));
const WellnessHolidays = lazy(() => import("./pages/wellness/Holidays"));
const WellnessWorkingHours = lazy(() => import("./pages/wellness/WorkingHoursEditor"));
// Wave 2 Agent KK - WhatsApp 2-way threads (agent inbox).
const WellnessWhatsAppThreads = lazy(() => import("./pages/wellness/WhatsAppThreads"));
// Zylu-Gap #800 (WA-005) — Blocked Numbers admin page. Manages
// /api/whatsapp/opt-outs rows with Add + Unblock affordances. Paired
// with the All/Unread/Blocked tab strip on WhatsAppThreads (#796).
const WellnessBlockedNumbers = lazy(() => import("./pages/wellness/BlockedNumbers"));
// Wave 2 Agent JJ — Staff Attendance + Leave Management. Open to all roles
// (everyone needs to clock in/out + manage their own leave); manager+
// surfaces appear inline based on AuthContext.role.
const WellnessAttendance = lazy(() => import("./pages/wellness/Attendance"));
const WellnessLeave = lazy(() => import("./pages/wellness/Leave"));
// Wave 2 Agent II — POS / Cash Register / Shift / Sale MVP UI.
const WellnessPointOfSale = lazy(() => import("./pages/wellness/PointOfSale"));
// Zylu-Gap Cash Register admin page — closes #770/#779/#780/#781.
// Lists registers (admin+ create/edit), drills into per-register shift +
// transactions panel. Without this surface POS is permanently gated since
// the backend requires an OPEN shift on a Register before /pos/sales accepts.
const WellnessCashRegisters = lazy(() => import("./pages/wellness/CashRegisters"));
// Public customer-facing survey page (no admin chrome — see /survey/:id route below)
const SurveyPublic = lazy(() => import("./pages/SurveyPublic"));
// Public customer-facing knowledge-base article view (no auth, no admin chrome).
// Replaces the raw-JSON backend response that the KB "View" button used to open.
const KbArticleView = lazy(() => import("./pages/KbArticleView"));
// #341: global catch-all 404. Previously unmapped or wrong-prefix URLs
// (e.g. /loyalty without /wellness/) rendered a blank <main> with HTTP 200
// because the SPA layout served but nothing inside it matched.
const NotFound = lazy(() => import("./pages/NotFound"));

export const AuthContext = createContext();
export const ThemeContext = createContext();

// Issue #207/#214/#216: wellness staff carry RBAC role=USER + an orthogonal
// `wellnessRole` (doctor/professional/telecaller/helper/stylist). The Owner
// Dashboard at /wellness exposes org-wide P&L (₹12L) and is for ADMIN/MANAGER
// only — clinical and operational staff need their own landing page so they
// don't see financial KPIs they shouldn't see. Login.jsx routes correctly on
// fresh login; this helper covers refresh / `/` / GenericOnly bounces where
// the URL would otherwise resolve to /wellness Owner Dashboard for everyone.
function wellnessLandingFor(user) {
  if (!user) return '/wellness';
  if (user.role === 'ADMIN' || user.role === 'MANAGER') return '/wellness';
  switch (user.wellnessRole) {
    case 'owner':
    case 'manager':
    case 'admin':
      return '/wellness';
    case 'doctor':
    case 'professional':
      return '/wellness/calendar';
    case 'telecaller':
      return '/wellness/telecaller';
    case 'helper':
    case 'stylist':
      return '/wellness/calendar';
    default:
      // No wellnessRole + not ADMIN/MANAGER — read-only fallback to calendar
      // so we never silently drop them on the org-wide dashboard.
      return '/wellness/calendar';
  }
}

// Route guard: bounces wellness tenants away from generic-CRM-only pages.
// The generic Enterprise Overview, deal pipeline, forecasting, etc. don't apply
// to a clinic — wellness has its own /wellness Owner Dashboard. Without this
// guard, typing /dashboard in the URL bar (or following a stale bookmark) would
// surface "Pipeline Analytics" + "Recent Deals" panels that confuse the user.
// #207/#214: route to a role-aware wellness landing rather than the org-wide
// Owner Dashboard so doctors / telecallers / helpers don't see ₹12L P&L.
function GenericOnly({ children }) {
  const { tenant, user } = useContext(AuthContext);
  if (tenant?.vertical === 'wellness') {
    return <Navigate to={wellnessLandingFor(user)} replace />;
  }
  if (tenant?.vertical === 'travel') {
    // Travel vertical's landing route is /travel (no role-aware landing yet —
    // Phase 1 will add per-sub-brand landings: TMC ops vs RFU advisor vs ...).
    return <Navigate to="/travel" replace />;
  }
  return children;
}

// #207/#214: doctor/telecaller landing on /wellness directly (e.g. clicking
// the sidebar logo, typing the URL, or refreshing) would still see the Owner
// Dashboard with org-wide P&L. Gate the Owner Dashboard route to ADMIN/MANAGER
// (or `wellnessRole === owner|manager|admin`) and redirect everyone else to
// their role-appropriate landing.
function WellnessOwnerOnly({ children }) {
  const { user } = useContext(AuthContext);
  const target = wellnessLandingFor(user);
  if (target !== '/wellness') {
    return <Navigate to={target} replace />;
  }
  return children;
}

// #325: mirror of GenericOnly for the wellness vertical. Generic CRM tenants
// (e.g. admin@globussoft.com on the Default Org) were able to navigate to
// /wellness URLs even though wellness is a separate tenant — the pages would
// load but show empty/cross-tenant data. Bounce them to the generic dashboard.
// A stricter RBAC check at the API level still applies; this guard is just to
// stop the URL bar from rendering a misleading wellness UI on non-wellness
// tenants.
function WellnessOnly({ children }) {
  const { tenant } = useContext(AuthContext);
  if (tenant && tenant.vertical !== "wellness") {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

// Mirror of WellnessOnly for the travel vertical (Day 1 scaffolding). Non-
// travel tenants get bounced to /dashboard rather than rendering empty
// travel UI. API-level guard requireTravelTenant in backend/routes/travel.js
// is the load-bearing check; this is just URL-bar hygiene.
function TravelOnly({ children }) {
  const { tenant } = useContext(AuthContext);
  if (tenant && tenant.vertical !== "travel") {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

// #303: bare /calendar used to render a blank <main> because the route table
// had no entry for it. Wellness tenants are bounced to their themed calendar
// (/wellness/calendar); generic tenants land on /calendar-sync which is the
// closest analog (Google/Outlook calendar binding management).
function CalendarRedirect() {
  const { tenant } = useContext(AuthContext);
  if (tenant?.vertical === "wellness") {
    return <Navigate to="/wellness/calendar" replace />;
  }
  return <Navigate to="/calendar-sync" replace />;
}

export default function App() {
  // #116: persist user across reloads. Pre-fix, user started as null on every
  // page load (token + tenant were restored, but not user), so the header showed
  // "User" / "?" even though login had succeeded.
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  });
  const [tenant, setTenant] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("tenant") || "null");
    } catch {
      return null;
    }
  });
  // #343 [SECURITY]: token no longer lives in localStorage. It's held in
  // memory inside utils/api.js with sessionStorage as the rehydrate source on
  // hard refresh, so it doesn't survive a browser restart and isn't readable
  // from a stolen disk image. We do a one-time migration of any legacy
  // localStorage token from a pre-fix build so users don't get punted to
  // /login on first deploy. The XSS-can-still-read-it caveat is documented
  // in utils/api.js — the real fix is httpOnly cookies (TODOS.md wishlist).
  const [token, setTokenState] = useState(() => {
    let initial = getAuthToken();
    if (!initial) {
      try {
        const legacy = localStorage.getItem("token");
        if (legacy) {
          initial = legacy;
          setAuthToken(legacy);
          localStorage.removeItem("token");
        }
      } catch {
        /* ignore */
      }
    }
    return initial || null;
  });
  const setToken = (next) => {
    setAuthToken(next);
    setTokenState(next || null);
  };
  // #347: gate initial mount until we've finished rehydrating the token
  // from sessionStorage. Without this, child pages fire fetches in their
  // own useEffect before AuthContext finishes mounting, racing the token
  // and getting 403s. We render a splash until `loading` flips false on
  // first effect tick (synchronous-after-mount).
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored) return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [subscription, setSubscription] = useState(null);
  const [daysRemaining, setDaysRemaining] = useState(null);

  useEffect(() => {
    // Token storage is owned by setAuthToken/clearAuthToken in utils/api.js
    // (in-memory + sessionStorage). Nothing to mirror to localStorage anymore.
    if (!token) {
      // Defensive: if some legacy code path nulled `token` directly via
      // setTokenState, make sure the api-side state is in sync.
      clearAuthToken();
    }
  }, [token]);

  // Mark auth as ready after the very first render so any fetch helpers
  // that wait on whenAuthReady() unblock once we've had a chance to read
  // sessionStorage. This runs synchronously after mount.
  useEffect(() => {
    setLoading(false);
    markAuthReady();
  }, []);

  useEffect(() => {
    if (user) {
      localStorage.setItem("user", JSON.stringify(user));
    } else {
      localStorage.removeItem("user");
    }
  }, [user]);

  useEffect(() => {
    if (tenant) {
      localStorage.setItem("tenant", JSON.stringify(tenant));
    } else {
      localStorage.removeItem("tenant");
    }
  }, [tenant]);

  // Fetch subscription status after login
  useEffect(() => {
    if (token) {
      const fetchSubscriptionStatus = async () => {
        try {
          const data = await fetch("/api/subscriptions/status", {
            headers: { "Authorization": `Bearer ${token}` }
          }).then((res) => res.json());
          setSubscription(data);
          setDaysRemaining(data.daysRemaining || 0);
        } catch (err) {
          console.error("[Subscription] Fetch status error:", err);
        }
      };
      fetchSubscriptionStatus();
    }
  }, [token]);

  useEffect(() => {
    let effectiveTheme = theme;
    if (theme === "system") {
      effectiveTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    console.log('[Theme] Applying theme:', { selectedTheme: theme, effectiveTheme });
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e) => {
      const effectiveTheme = e.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", effectiveTheme);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  // Apply vertical-specific theme overrides (e.g. wellness gets Dr. Haror palette)
  useEffect(() => {
    const v = tenant?.vertical || "generic";
    document.documentElement.setAttribute("data-vertical", v);
    document.body.setAttribute("data-vertical", v);
  }, [tenant]);

  const toggleTheme = () =>
    setTheme((t) => {
      if (t === "light") return "dark";
      if (t === "dark") return "system";
      return "light";
    });

  // #529 / #530: stable callback reference. Prior shape created a new fn
  // on every App render, which (combined with the inline AuthContext
  // value object below) made every consumer's useEffect re-run on every
  // App render — Sidebar's count-fetcher fired a flurry of duplicate HTTP
  // calls + a fresh socket on each cycle. Hoisted ABOVE the `loading`
  // early-return so the hook count stays consistent across renders
  // (rules-of-hooks).
  const loginWithToken = useCallback(async (tokenArg, tenantArg) => {
    // #343 [SECURITY] follow-up: setToken routes the token through
    // setAuthToken (utils/api.js) which puts it in the in-memory holder +
    // sessionStorage. A previous explicit localStorage write of the token key
    // sat here from before the #343 migration and silently re-introduced the
    // XSS-readable credential the migration removed. Deleted; the
    // sessionStorage write inside setToken is the only canonical storage now.
    // Regression-guarded by frontend/src/__tests__/security-token-storage.test.js.
    setToken(tokenArg);
    if (tenantArg) {
      setTenant(tenantArg);
      localStorage.setItem("tenant", JSON.stringify(tenantArg));
    }
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${tokenArg}` },
    });
    if (!res.ok) {
      setToken(null);
      localStorage.removeItem("token");
      throw new Error("SSO token rejected");
    }
    const profile = await res.json();
    setUser(profile);
    localStorage.setItem("user", JSON.stringify(profile));
    return profile;
  }, []);

  // #529 / #530: memoise the AuthContext value so consumers don't re-render
  // (and re-fire mount effects) on every App render. State setters from
  // useState are stable by React contract; loginWithToken is now a stable
  // useCallback. The remaining inputs (user/token/tenant/loading) are real
  // state — when one genuinely changes, all consumers SHOULD update.
  const authValue = useMemo(
    () => ({
      user,
      setUser,
      token,
      setToken,
      tenant,
      setTenant,
      loading,
      loginWithToken,
      subscription,
    }),
    [user, token, tenant, loading, loginWithToken, subscription],
  );

  // #347: while AuthContext is still rehydrating the token from sessionStorage
  // we render a single splash. Pages mount their own fetches in useEffect, and
  // before this gate they raced the token and 403'd. Since `loading` flips
  // false on the first effect tick (synchronous after mount), this is a one-
  // frame splash on cold-start, invisible in normal nav. Lives BELOW the
  // hooks so the hook count is consistent across renders (rules-of-hooks).
  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
          color: "var(--text-primary, #888)",
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      <AuthContext.Provider value={authValue}>
        <NotifyProvider>
          <ActiveSubBrandProvider>
          <BrowserRouter>
            <RouteErrorBoundary>
              <Suspense
                fallback={
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      height: "100vh",
                      color: "var(--text-primary)",
                    }}
                  >
                    Loading...
                  </div>
                }
              >
                <Routes>
                  <Route
                    path="/login"
                    element={!token ? <Login /> : <Navigate to="/dashboard" />}
                  />
                  <Route
                    path="/signup"
                    element={!token ? <Signup /> : <Navigate to="/dashboard" />}
                  />
                  <Route path="/sso/return" element={<SsoReturn />} />
                  <Route path="/pricing" element={<Pricing />} />
                  <Route path="/payment-success" element={<PaymentSuccess />} />
                  <Route path="/payment-failed" element={<PaymentFailed />} />
                  <Route path="/portal" element={<Portal />} />
                  <Route
                    path="/book/:slug"
                    element={<WellnessPublicBooking />}
                  />
                  {/* PRD §4.7 — Travel Stall public Family Travel Quiz wizard.
                      Unauthenticated; calls /api/travel/diagnostics/public/*.
                      Tenant slug optional via ?tenant=<slug>; defaults to
                      "travel-stall" inside the page. */}
                  <Route
                    path="/travel-stall/quiz"
                    element={<TravelStallQuiz />}
                  />
                  {/* PRD §4.7 — Travel Stall trip booking page. Customer
                      receives the shareToken URL from advisor (WhatsApp /
                      email), reviews the itinerary, pays the 50% advance.
                      Backed by /api/travel/itineraries/public/* (commit
                      8abf6f3). */}
                  <Route
                    path="/trip/:shareToken"
                    element={<TripBooking />}
                  />
                  {/* #208: wellness patient portal lives under /wellness/portal so it
                inherits the wellness theme + namespace. The generic /portal route
                above stays as the Knowledge Base / customer portal for non-wellness
                tenants. /patient-portal kept as a back-compat alias. */}
                  <Route
                    path="/wellness/portal"
                    element={<WellnessPatientPortal />}
                  />
                  <Route
                    path="/wellness/portal/login"
                    element={<WellnessPatientPortal />}
                  />
                  <Route
                    path="/patient-portal"
                    element={<WellnessPatientPortal />}
                  />
                  {/* #184: customer-facing survey landing page from SMS — no auth, no admin chrome */}
                  <Route path="/survey/:id" element={<SurveyPublic />} />
                  {/* Public knowledge-base article view (no auth). Replaces the raw
                      backend JSON URL that the KB "View" button used to open. */}
                  <Route
                    path="/kb/:tenantSlug/:slug"
                    element={<KbArticleView />}
                  />
                  {/* #240: unauthenticated visitors to `/` should land on /login, not the
                marketing Landing page. The Landing component is still importable
                for any explicit /landing CTA but is no longer the implicit root. */}
                  <Route
                    path="/"
                    element={
                      !token ? (
                        <Navigate to="/login" replace />
                      ) : (
                        <Navigate to="/dashboard" replace />
                      )
                    }
                  />
                  <Route
                    path="/*"
                    element={token ? <Layout /> : <Navigate to="/login" />}
                  >
                    <Route
                      path="dashboard"
                      element={
                        <GenericOnly>
                          <Dashboard />
                        </GenericOnly>
                      }
                    />
                    <Route path="contacts" element={<Contacts />} />
                    <Route path="contacts/:id" element={<ContactDetail />} />
                    <Route
                      path="pipeline"
                      element={
                        <GenericOnly>
                          <Pipeline />
                        </GenericOnly>
                      }
                    />
                    <Route path="inbox" element={<Inbox />} />
                    <Route
                      path="marketing"
                      element={
                        <RoleGuard
                          allow={["ADMIN", "MANAGER"]}
                          feature="Marketing"
                          roles="manager (or admin)"
                        >
                          <Marketing />
                        </RoleGuard>
                      }
                    />
                    <Route path="reports" element={<Reports />} />
                    <Route path="agent-reports" element={<AgentReports />} />
                    <Route path="workflows" element={<Workflows />} />
                    <Route path="developer" element={<Developer />} />
                    <Route
                      path="billing"
                      element={<Navigate to="/invoices" />}
                    />
                    <Route path="cpq" element={<CPQ />} />
                    <Route path="marketplace" element={<Marketplace />} />
                    <Route
                      path="marketplace-leads"
                      element={<MarketplaceLeads />}
                    />
                    <Route
                      path="channels"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Channels requires admin access.">
                          <Channels />
                        </RoleGuard>
                      }
                    />
                    <Route path="landing-pages" element={<LandingPages />} />
                    <Route
                      path="landing-pages/builder/:id"
                      element={<LandingPageBuilder />}
                    />
                    <Route path="objects" element={<CustomObjects />} />
                    <Route
                      path="objects/:entityName"
                      element={<CustomObjectView />}
                    />
                    <Route path="sequences" element={<Sequences />} />
                    <Route
                      path="sequences/:id/builder"
                      element={<SequenceBuilder />}
                    />
                    <Route path="support" element={<Support />} />
                    <Route
                      path="settings"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Settings requires admin access.">
                          <Settings />
                        </RoleGuard>
                      }
                    />
                    <Route path="expenses" element={<Expenses />} />
                    <Route path="contracts" element={<Contracts />} />
                    <Route path="estimates" element={<Estimates />} />
                    <Route path="invoices" element={<Invoices />} />
                    {/* #886 / BUG-T24: /quotes used to 404 because no Route
                        was registered. Full Quotes module is multi-day work
                        (cluster B2 in docs/MANUAL_CODING_BACKLOG.md). Until
                        then, render a coming-soon stub that points users at
                        Estimates (the existing Draft→Accepted→Converted
                        analog) and the Pipeline. */}
                    <Route path="quotes" element={<QuotesComingSoon />} />
                    <Route path="tickets" element={<Tickets />} />
                    <Route path="tasks" element={<Tasks />} />
                    <Route path="lead-scoring" element={<LeadScoring />} />
                    <Route path="projects" element={<Projects />} />
                    <Route path="clients" element={<Clients />} />
                    <Route path="leads" element={<Leads />} />
                    <Route
                      path="converted-leads"
                      element={<ConvertedLeads />}
                    />
                    <Route
                      path="staff"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Staff requires admin access.">
                          <Staff />
                        </RoleGuard>
                      }
                    />
                    <Route path="profile" element={<Profile />} />
                    <Route path="profile/2fa" element={<Profile2FA />} />
                    <Route path="notification-settings" element={<UserSettings />} />
                    {/* #589: Audit Log is ADMIN-only (mirrors Sidebar's
                        adminOnly visibility + the "System Admin Required"
                        toast text). Pre-fix, USER + MANAGER navigation to
                        /audit-log rendered the full Audit Log shell (KPI
                        cards, entity/action/user/date filters) before a
                        toast surfaced — leaking the existence of the audit
                        pipeline, tracked entities, and the role-name. The
                        backend route at /api/audit-viewer allows MANAGER too,
                        but the more-restrictive frontend gate prevents the
                        info-disclosure render. */}
                    <Route
                      path="audit-log"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Audit Log requires admin access.">
                          <AuditLog />
                        </RoleGuard>
                      }
                    />
                    {/* Cron PRD Priority A #1 — LLM observability surface
                        for the /api/admin/llm-spend endpoint (commit
                        f5c9518). ADMIN-only mirrors the backend gate
                        (verifyRole(['ADMIN']) on the route). */}
                    <Route
                      path="llm-spend"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="LLM Spend requires admin access.">
                          <LlmSpend />
                        </RoleGuard>
                      }
                    />
                    <Route path="privacy" element={<Privacy />} />
                    <Route path="calendar-sync" element={<CalendarSync />} />
                    <Route
                      path="pipelines"
                      element={
                        <GenericOnly>
                          <Pipelines />
                        </GenericOnly>
                      }
                    />
                    <Route
                      path="forecasting"
                      element={
                        <GenericOnly>
                          <Forecasting />
                        </GenericOnly>
                      }
                    />
                    <Route path="dashboards" element={<Dashboards />} />
                    <Route path="custom-reports" element={<CustomReports />} />
                    <Route path="booking-pages" element={<BookingPages />} />
                    <Route path="signatures" element={<Signatures />} />
                    <Route path="knowledge-base" element={<KnowledgeBase />} />
                    <Route path="currencies" element={<Currencies />} />
                    <Route
                      path="field-permissions"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Field Permissions requires admin access.">
                          <FieldPermissions />
                        </RoleGuard>
                      }
                    />
                    {/* PRD Gap §1.5 / §1.6 */}
                    <Route
                      path="commission-profiles"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Commission Profiles requires admin access.">
                          <CommissionProfiles />
                        </RoleGuard>
                      }
                    />
                    <Route
                      path="revenue-goals"
                      element={
                        <RoleGuard allow={["ADMIN", "MANAGER", "USER"]} message="Revenue Goals requires staff access.">
                          <RevenueGoals />
                        </RoleGuard>
                      }
                    />
                    <Route path="lead-routing" element={<LeadRouting />} />
                    <Route path="territories" element={<Territories />} />
                    <Route
                      path="quotas"
                      element={
                        <GenericOnly>
                          <Quotas />
                        </GenericOnly>
                      }
                    />
                    <Route
                      path="win-loss"
                      element={
                        <GenericOnly>
                          <WinLoss />
                        </GenericOnly>
                      }
                    />
                    <Route path="ab-tests" element={<AbTests />} />
                    <Route path="web-visitors" element={<WebVisitors />} />
                    <Route path="chatbots" element={<Chatbots />} />
                    <Route path="approvals" element={<Approvals />} />
                    <Route
                      path="document-templates"
                      element={<DocumentTemplates />}
                    />
                    <Route path="surveys" element={<Surveys />} />
                    <Route path="payments" element={<Payments />} />
                    <Route
                      path="deal-insights"
                      element={
                        <GenericOnly>
                          <DealInsights />
                        </GenericOnly>
                      }
                    />
                    <Route path="shared-inbox" element={<SharedInbox />} />
                    <Route path="sla" element={<SLA />} />
                    <Route path="live-chat" element={<LiveChat />} />
                    <Route path="playbooks" element={<Playbooks />} />
                    <Route
                      path="document-tracking"
                      element={<DocumentTracking />}
                    />
                    <Route
                      path="industry-templates"
                      element={<IndustryTemplates />}
                    />
                    <Route path="social" element={<Social />} />
                    <Route path="sandbox" element={<Sandbox />} />
                    <Route
                      path="funnel"
                      element={
                        <GenericOnly>
                          <Funnel />
                        </GenericOnly>
                      }
                    />
                    <Route path="zapier" element={<Zapier />} />
                    {/* #522: Live Call Monitor removed — live-call surfaces are owned
                        by sister product Callified.ai (CRM ingests calls via
                        /api/v1/external/calls but does not render live-monitoring UI). */}
                    {/* #303: bare /calendar previously rendered a blank <main>. Wellness
                  tenants get bounced to their themed calendar; everyone else sees
                  the calendar-sync page (which is the closest generic equivalent). */}
                    <Route path="calendar" element={<CalendarRedirect />} />
                    {/* Travel vertical — Day 1 scaffolding. Gated by TravelOnly
                  so generic + wellness tenants get bounced to /dashboard
                  rather than rendering empty travel UI. Phase 1 sub-pages
                  (diagnostics, itineraries, trips, visa, suppliers) mount
                  under /travel/* per docs/TRAVEL_CRM_PRD.md §7. */}
              <Route path="travel" element={<TravelOnly><TravelDashboard /></TravelOnly>} />
              <Route path="travel/diagnostics" element={<TravelOnly><TravelDiagnostics /></TravelOnly>} />
              <Route path="travel/diagnostics/new" element={<TravelOnly><TravelDiagnosticWizard /></TravelOnly>} />
              <Route path="travel/diagnostics/banks/new" element={<TravelOnly><TravelDiagnosticBuilder /></TravelOnly>} />
              <Route path="travel/diagnostics/:id" element={<TravelOnly><TravelDiagnosticDetail /></TravelOnly>} />
              <Route path="travel/itineraries" element={<TravelOnly><TravelItineraries /></TravelOnly>} />
              <Route path="travel/trips" element={<TravelOnly><TravelTrips /></TravelOnly>} />
              <Route path="travel/trips/:id" element={<TravelOnly><TravelTripDetail /></TravelOnly>} />
              {/* #912 — canonical kebab-case path matches sibling travel routes
                  (cost-master, pricing-rules, religious-packets). The unhyphenated
                  alias stays registered so existing bookmarks / sidebar links keep working. */}
              <Route path="travel/web-checkins" element={<TravelOnly><TravelWebCheckinQueue /></TravelOnly>} />
              <Route path="travel/webcheckins" element={<TravelOnly><TravelWebCheckinQueue /></TravelOnly>} />
              <Route path="travel/cost-master" element={<TravelOnly><TravelCostMaster /></TravelOnly>} />
              <Route path="travel/leads" element={<TravelOnly><TravelLeads /></TravelOnly>} />
              <Route path="travel/rfu/customers/:contactId" element={<TravelOnly><TravelRfuCustomerProfile /></TravelOnly>} />
              <Route path="travel/pricing-rules" element={<TravelOnly><TravelPricingRules /></TravelOnly>} />
              <Route path="travel/reports" element={<TravelOnly><TravelReports /></TravelOnly>} />
              <Route path="travel/suppliers" element={<TravelOnly><TravelSuppliers /></TravelOnly>} />
              <Route path="travel/religious-packets" element={<TravelOnly><TravelReligiousPackets /></TravelOnly>} />
              <Route path="travel/itineraries/:id" element={<TravelOnly><TravelItineraryDetail /></TravelOnly>} />
              <Route path="travel/leads/:contactId" element={<TravelOnly><TravelLeadDetail /></TravelOnly>} />
                    {/* Wellness vertical — gated by WellnessOnly so generic-CRM
                  tenants can't surface wellness pages by URL (#325). */}
              <Route path="wellness" element={<WellnessOnly><WellnessOwnerOnly><WellnessOwnerDashboard /></WellnessOwnerOnly></WellnessOnly>} />
              <Route path="wellness/recommendations" element={<WellnessOnly><WellnessRecommendations /></WellnessOnly>} />
              <Route path="wellness/patients" element={<WellnessOnly><WellnessPatients /></WellnessOnly>} />
              <Route path="wellness/patients/:id" element={<WellnessOnly><WellnessPatientDetail /></WellnessOnly>} />
              <Route path="wellness/services" element={<WellnessOnly><WellnessServices /></WellnessOnly>} />
              {/* Wave 7 Agent A — ServiceCategory + Drug admin pages (admin/manager) */}
              <Route path="wellness/service-categories" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Service Categories requires manager access.">
                    <WellnessServiceCategories />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/drugs" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Drug catalogue requires manager access.">
                    <WellnessDrugs />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/visits" element={<WellnessOnly><WellnessVisits /></WellnessOnly>} />
              <Route path="wellness/locations" element={<WellnessOnly><WellnessLocations /></WellnessOnly>} />
              {/* Wave 11 Agent EE: Memberships catalog — admin/manager only */}
              <Route path="wellness/memberships" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Memberships requires manager access.">
                    <WellnessMemberships />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Wave 11 Agent FF: Wallet + Gift Cards + Coupons + Cashback (admin/manager) */}
              <Route path="wellness/wallet" element={
                <WellnessOnly>
                  <RoleGuard
                    allow={["ADMIN", "MANAGER"]}
                    feature="Wallet ledger"
                    roles="manager (or admin)"
                  >
                    <WellnessWallet />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/giftcards" element={
                <WellnessOnly>
                  <RoleGuard
                    allow={["ADMIN", "MANAGER"]}
                    feature="Gift Cards"
                    roles="manager (or admin)"
                  >
                    <WellnessGiftCards />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/coupons" element={
                <WellnessOnly>
                  <RoleGuard
                    allow={["ADMIN", "MANAGER"]}
                    feature="Coupons"
                    roles="manager (or admin)"
                  >
                    <WellnessCoupons />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/cashback-rules" element={
                <WellnessOnly>
                  <RoleGuard
                    allow={["ADMIN", "MANAGER"]}
                    feature="Cashback rules"
                    roles="manager (or admin)"
                  >
                    <WellnessCashbackRules />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/calendar" element={<WellnessOnly><WellnessCalendar /></WellnessOnly>} />
              {/* Wave 2 Agent KK - WhatsApp 2-way threads (agent inbox). */}
              <Route path="wellness/whatsapp" element={<WellnessOnly><WellnessWhatsAppThreads /></WellnessOnly>} />
              {/* Zylu-Gap #800 — Blocked Numbers admin (manages /opt-outs).
                  Add is ADMIN+MANAGER (backend gate), Unblock is ADMIN-only
                  (DPDP §11). The page hides the Unblock button for
                  non-admins so the modal never fires a 403 round-trip. */}
              <Route path="wellness/whatsapp/blocked-numbers" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Blocked Numbers requires admin or manager access.">
                    <WellnessBlockedNumbers />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/reports" element={<WellnessOnly><WellnessReports /></WellnessOnly>} />
              <Route path="wellness/telecaller" element={<WellnessOnly><WellnessTelecallerQueue /></WellnessOnly>} />
              {/* #183: alias for users who land on /telecaller (no /wellness prefix). */}
              <Route path="telecaller" element={<Navigate to="/wellness/telecaller" replace />} />
              {/* #406: stale-URL aliases. Older docs / QA prompts reference
                  /wellness/service-catalog + /wellness/telecaller-queue;
                  canonical routes are /wellness/services + /wellness/telecaller.
                  Mirrors the #183 alias pattern above so deep links from old
                  docs / bookmarks still land on the right page. */}
              <Route path="wellness/service-catalog" element={<Navigate to="/wellness/services" replace />} />
              <Route path="wellness/telecaller-queue" element={<Navigate to="/wellness/telecaller" replace />} />
              <Route path="wellness/per-location" element={<WellnessOnly><WellnessPerLocation /></WellnessOnly>} />
              <Route path="wellness/loyalty" element={<WellnessOnly><WellnessLoyalty /></WellnessOnly>} />
              <Route path="wellness/waitlist" element={<WellnessOnly><WellnessWaitlist /></WellnessOnly>} />
              <Route path="wellness/inventory" element={<WellnessOnly><WellnessInventory /></WellnessOnly>} />
              {/* Wave 11 Agent HH — Inventory backbone admin pages (5 routes).
                  All ADMIN/MANAGER-only via RoleGuard wrap. */}
              <Route path="wellness/product-categories" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Product categories require manager access.">
                    <WellnessProductCategories />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/vendors" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Vendors require manager access.">
                    <WellnessVendors />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/inventory-receipts" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Inventory receipts require manager access.">
                    <WellnessInventoryReceipts />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/inventory-adjustments" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Inventory adjustments require manager access.">
                    <WellnessInventoryAdjustments />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/auto-consumption-rules" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Auto-consumption rules require manager access.">
                    <WellnessAutoConsumptionRules />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Wave 11 Agent GG — Resource availability admin pages (3 routes).
                  All ADMIN/MANAGER-only. The booking-conflict gate runs on
                  every POST/PUT visit. */}
              <Route path="wellness/resources" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Resources require manager access.">
                    <WellnessResources />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/holidays" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Holidays require manager access.">
                    <WellnessHolidays />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/working-hours" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Working hours require manager access.">
                    <WellnessWorkingHours />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Wave 2 Agent JJ — Staff Attendance + Leave Management. */}
              <Route path="wellness/attendance" element={<WellnessOnly><WellnessAttendance /></WellnessOnly>} />
              <Route path="wellness/leave" element={<WellnessOnly><WellnessLeave /></WellnessOnly>} />
              {/* Wave 2 Agent II — POS / Cash Register / Shift / Sale.
                  Backend is wellness-vertical-gated + role
                  ADMIN/MANAGER/doctor/professional/telecaller/helper.
                  Frontend allows the wider operational bucket (everyone
                  except plain USER) so a cashier user can ring sales. */}
              <Route path="wellness/pos" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER", "USER"]} message="POS requires staff access.">
                    <WellnessPointOfSale />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Zylu-Gap #770/#779/#780/#781 — Cash Register admin page.
                  Lists registers, drills into per-register shift detail
                  (status header + open/close/deposit/withdraw + transactions).
                  Same role envelope as POS so a cashier can open their own
                  shift here without leaving the staff role bucket. */}
              <Route path="wellness/cash-registers" element={
                <WellnessOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER", "USER"]} message="Cash Registers requires staff access.">
                    <WellnessCashRegisters />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* #309: /wellness/invoices used to render a blank page (no
                  route binding). Wellness shares the generic CRM Invoices
                  UI — alias the prefixed URL to the canonical /invoices
                  route so the sidebar link, deep links from emails, and
                  bookmarks all resolve. Mirrors the /wellness/inventory
                  fix from #305. */}
                    <Route
                      path="wellness/invoices"
                      element={<Navigate to="/invoices" replace />}
                    />
                    {/* #341: catch-all for unmapped or wrong-prefix URLs. Renders
                  inside the layout chrome so the user keeps the sidebar +
                  header. Pre-fix the SPA returned a blank <main>; now we
                  show a real 404 with a path suggestion when applicable. */}
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </BrowserRouter>
          </ActiveSubBrandProvider>
        </NotifyProvider>
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
