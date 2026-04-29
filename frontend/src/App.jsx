import React, { useState, useContext, createContext, useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Landing from './pages/Landing';
import Layout from './components/Layout';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import { NotifyProvider } from './utils/notify';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { setAuthToken, getAuthToken, clearAuthToken, markAuthReady } from './utils/api';
import './theme/wellness.css'; // wellness vertical theme overrides (scoped)

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Contacts = lazy(() => import('./pages/Contacts'));
const ContactDetail = lazy(() => import('./pages/ContactDetail'));
const Pipeline = lazy(() => import('./pages/Pipeline'));
const Workflows = lazy(() => import('./pages/Workflows'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Marketing = lazy(() => import('./pages/Marketing'));
const Reports = lazy(() => import('./pages/Reports'));
const AgentReports = lazy(() => import('./pages/AgentReports'));
const Settings = lazy(() => import('./pages/Settings'));
const Developer = lazy(() => import('./pages/Developer'));
const Portal = lazy(() => import('./pages/Portal'));
const Marketplace = lazy(() => import('./pages/Marketplace'));
const CPQ = lazy(() => import('./pages/CPQ'));
const CustomObjects = lazy(() => import('./pages/CustomObjects'));
const CustomObjectView = lazy(() => import('./pages/CustomObjectView'));
const Sequences = lazy(() => import('./pages/Sequences'));
const SequenceBuilder = lazy(() => import('./pages/SequenceBuilder'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Tickets = lazy(() => import('./pages/Tickets'));
const Support = lazy(() => import('./pages/Support'));
const Staff = lazy(() => import('./pages/Staff'));
const Invoices = lazy(() => import('./pages/Invoices'));
const LeadScoring = lazy(() => import('./pages/LeadScoring'));
const Leads = lazy(() => import('./pages/Leads'));
const ConvertedLeads = lazy(() => import('./pages/ConvertedLeads'));
const Clients = lazy(() => import('./pages/Clients'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Contracts = lazy(() => import('./pages/Contracts'));
const Estimates = lazy(() => import('./pages/Estimates'));
const Projects = lazy(() => import('./pages/Projects'));
const Profile = lazy(() => import('./pages/Profile'));
const Pricing = lazy(() => import('./pages/Pricing'));
const MarketplaceLeads = lazy(() => import('./pages/MarketplaceLeads'));
const Channels = lazy(() => import('./pages/Channels'));
const LandingPages = lazy(() => import('./pages/LandingPages'));
const LandingPageBuilder = lazy(() => import('./pages/LandingPageBuilder'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const Privacy = lazy(() => import('./pages/Privacy'));
const CalendarSync = lazy(() => import('./pages/CalendarSync'));
const Profile2FA = lazy(() => import('./pages/Profile2FA'));
const Pipelines = lazy(() => import('./pages/Pipelines'));
const Forecasting = lazy(() => import('./pages/Forecasting'));
const Dashboards = lazy(() => import('./pages/Dashboards'));
const CustomReports = lazy(() => import('./pages/CustomReports'));
const BookingPages = lazy(() => import('./pages/BookingPages'));
const Signatures = lazy(() => import('./pages/Signatures'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));
const Currencies = lazy(() => import('./pages/Currencies'));
const FieldPermissions = lazy(() => import('./pages/FieldPermissions'));
const LeadRouting = lazy(() => import('./pages/LeadRouting'));
const Territories = lazy(() => import('./pages/Territories'));
const Quotas = lazy(() => import('./pages/Quotas'));
const WinLoss = lazy(() => import('./pages/WinLoss'));
const AbTests = lazy(() => import('./pages/AbTests'));
const WebVisitors = lazy(() => import('./pages/WebVisitors'));
const Chatbots = lazy(() => import('./pages/Chatbots'));
const Approvals = lazy(() => import('./pages/Approvals'));
const DocumentTemplates = lazy(() => import('./pages/DocumentTemplates'));
const Surveys = lazy(() => import('./pages/Surveys'));
const Payments = lazy(() => import('./pages/Payments'));
const DealInsights = lazy(() => import('./pages/DealInsights'));
const SharedInbox = lazy(() => import('./pages/SharedInbox'));
const SLA = lazy(() => import('./pages/SLA'));
const LiveChat = lazy(() => import('./pages/LiveChat'));
const Playbooks = lazy(() => import('./pages/Playbooks'));
const DocumentTracking = lazy(() => import('./pages/DocumentTracking'));
const IndustryTemplates = lazy(() => import('./pages/IndustryTemplates'));
const Social = lazy(() => import('./pages/Social'));
const Sandbox = lazy(() => import('./pages/Sandbox'));
const Funnel = lazy(() => import('./pages/Funnel'));
const Zapier = lazy(() => import('./pages/Zapier'));
// Wellness vertical
const WellnessOwnerDashboard = lazy(() => import('./pages/wellness/OwnerDashboard'));
const WellnessRecommendations = lazy(() => import('./pages/wellness/Recommendations'));
const WellnessPatients = lazy(() => import('./pages/wellness/Patients'));
const WellnessPatientDetail = lazy(() => import('./pages/wellness/PatientDetail'));
const WellnessServices = lazy(() => import('./pages/wellness/Services'));
const WellnessLocations = lazy(() => import('./pages/wellness/Locations'));
const WellnessCalendar = lazy(() => import('./pages/wellness/Calendar'));
const WellnessReports = lazy(() => import('./pages/wellness/Reports'));
const WellnessPublicBooking = lazy(() => import('./pages/wellness/PublicBooking'));
const WellnessTelecallerQueue = lazy(() => import('./pages/wellness/TelecallerQueue'));
const WellnessPatientPortal = lazy(() => import('./pages/wellness/PatientPortal'));
const WellnessPerLocation = lazy(() => import('./pages/wellness/PerLocationDashboard'));
const WellnessLoyalty = lazy(() => import('./pages/wellness/Loyalty'));
const WellnessWaitlist = lazy(() => import('./pages/wellness/Waitlist'));
// #305: /wellness/inventory used to render a blank page (no route element).
// Inventory is implemented as a tab inside PatientDetail; this stub explains
// that and links to the patient list.
const WellnessInventory = lazy(() => import('./pages/wellness/Inventory'));
// Public customer-facing survey page (no admin chrome — see /survey/:id route below)
const SurveyPublic = lazy(() => import('./pages/SurveyPublic'));
// #341: global catch-all 404. Previously unmapped or wrong-prefix URLs
// (e.g. /loyalty without /wellness/) rendered a blank <main> with HTTP 200
// because the SPA layout served but nothing inside it matched.
const NotFound = lazy(() => import('./pages/NotFound'));

export const AuthContext = createContext();
export const ThemeContext = createContext();

// Route guard: bounces wellness tenants away from generic-CRM-only pages.
// The generic Enterprise Overview, deal pipeline, forecasting, etc. don't apply
// to a clinic — wellness has its own /wellness Owner Dashboard. Without this
// guard, typing /dashboard in the URL bar (or following a stale bookmark) would
// surface "Pipeline Analytics" + "Recent Deals" panels that confuse the user.
function GenericOnly({ children }) {
  const { tenant } = useContext(AuthContext);
  if (tenant?.vertical === 'wellness') {
    return <Navigate to="/wellness" replace />;
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
  if (tenant && tenant.vertical !== 'wellness') {
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
  if (tenant?.vertical === 'wellness') {
    return <Navigate to="/wellness/calendar" replace />;
  }
  return <Navigate to="/calendar-sync" replace />;
}

export default function App() {
  // #116: persist user across reloads. Pre-fix, user started as null on every
  // page load (token + tenant were restored, but not user), so the header showed
  // "User" / "?" even though login had succeeded.
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  });
  const [tenant, setTenant] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tenant') || 'null'); } catch { return null; }
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
        const legacy = localStorage.getItem('token');
        if (legacy) {
          initial = legacy;
          setAuthToken(legacy);
          localStorage.removeItem('token');
        }
      } catch { /* ignore */ }
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
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');

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
      localStorage.setItem('user', JSON.stringify(user));
    } else {
      localStorage.removeItem('user');
    }
  }, [user]);

  useEffect(() => {
    if (tenant) {
      localStorage.setItem('tenant', JSON.stringify(tenant));
    } else {
      localStorage.removeItem('tenant');
    }
  }, [tenant]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Apply vertical-specific theme overrides (e.g. wellness gets Dr. Haror palette)
  useEffect(() => {
    const v = tenant?.vertical || 'generic';
    document.documentElement.setAttribute('data-vertical', v);
    document.body.setAttribute('data-vertical', v);
  }, [tenant]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  // #347: while AuthContext is still rehydrating the token from sessionStorage
  // we render a single splash. Pages mount their own fetches in useEffect, and
  // before this gate they raced the token and 403'd. Since `loading` flips
  // false on the first effect tick (synchronous after mount), this is a one-
  // frame splash on cold-start, invisible in normal nav.
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'var(--text-primary, #888)' }}>
        Loading...
      </div>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
    <AuthContext.Provider value={{ user, setUser, token, setToken, tenant, setTenant, loading }}>
    <NotifyProvider>
      <BrowserRouter>
        <RouteErrorBoundary>
        <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'var(--text-primary)' }}>Loading...</div>}>
          <Routes>
            <Route path="/login" element={!token ? <Login /> : <Navigate to="/dashboard" />} />
            <Route path="/signup" element={!token ? <Signup /> : <Navigate to="/dashboard" />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/portal" element={<Portal />} />
            <Route path="/book/:slug" element={<WellnessPublicBooking />} />
            {/* #208: wellness patient portal lives under /wellness/portal so it
                inherits the wellness theme + namespace. The generic /portal route
                above stays as the Knowledge Base / customer portal for non-wellness
                tenants. /patient-portal kept as a back-compat alias. */}
            <Route path="/wellness/portal" element={<WellnessPatientPortal />} />
            <Route path="/wellness/portal/login" element={<WellnessPatientPortal />} />
            <Route path="/patient-portal" element={<WellnessPatientPortal />} />
            {/* #184: customer-facing survey landing page from SMS — no auth, no admin chrome */}
            <Route path="/survey/:id" element={<SurveyPublic />} />
            {/* #240: unauthenticated visitors to `/` should land on /login, not the
                marketing Landing page. The Landing component is still importable
                for any explicit /landing CTA but is no longer the implicit root. */}
            <Route path="/" element={!token ? <Navigate to="/login" replace /> : <Navigate to="/dashboard" replace />} />
            <Route path="/*" element={token ? <Layout /> : <Navigate to="/login" />}>
              <Route path="dashboard" element={<GenericOnly><Dashboard /></GenericOnly>} />
              <Route path="contacts" element={<Contacts />} />
              <Route path="contacts/:id" element={<ContactDetail />} />
              <Route path="pipeline" element={<GenericOnly><Pipeline /></GenericOnly>} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="marketing" element={<Marketing />} />
              <Route path="reports" element={<Reports />} />
              <Route path="agent-reports" element={<AgentReports />} />
              <Route path="workflows" element={<Workflows />} />
              <Route path="developer" element={<Developer />} />
              <Route path="billing" element={<Navigate to="/invoices" />} />
              <Route path="cpq" element={<CPQ />} />
              <Route path="marketplace" element={<Marketplace />} />
              <Route path="marketplace-leads" element={<MarketplaceLeads />} />
              <Route path="channels" element={<Channels />} />
              <Route path="landing-pages" element={<LandingPages />} />
              <Route path="landing-pages/builder/:id" element={<LandingPageBuilder />} />
              <Route path="objects" element={<CustomObjects />} />
              <Route path="objects/:entityName" element={<CustomObjectView />} />
              <Route path="sequences" element={<Sequences />} />
              <Route path="sequences/:id/builder" element={<SequenceBuilder />} />
              <Route path="support" element={<Support />} />
              <Route path="settings" element={<Settings />} />
              <Route path="expenses" element={<Expenses />} />
              <Route path="contracts" element={<Contracts />} />
              <Route path="estimates" element={<Estimates />} />
              <Route path="invoices" element={<Invoices />} />
              <Route path="tickets" element={<Tickets />} />
              <Route path="tasks" element={<Tasks />} />
              <Route path="lead-scoring" element={<LeadScoring />} />
              <Route path="projects" element={<Projects />} />
              <Route path="clients" element={<Clients />} />
              <Route path="leads" element={<Leads />} />
              <Route path="converted-leads" element={<ConvertedLeads />} />
              <Route path="staff" element={<Staff />} />
              <Route path="profile" element={<Profile />} />
              <Route path="profile/2fa" element={<Profile2FA />} />
              <Route path="audit-log" element={<AuditLog />} />
              <Route path="privacy" element={<Privacy />} />
              <Route path="calendar-sync" element={<CalendarSync />} />
              <Route path="pipelines" element={<GenericOnly><Pipelines /></GenericOnly>} />
              <Route path="forecasting" element={<GenericOnly><Forecasting /></GenericOnly>} />
              <Route path="dashboards" element={<Dashboards />} />
              <Route path="custom-reports" element={<CustomReports />} />
              <Route path="booking-pages" element={<BookingPages />} />
              <Route path="signatures" element={<Signatures />} />
              <Route path="knowledge-base" element={<KnowledgeBase />} />
              <Route path="currencies" element={<Currencies />} />
              <Route path="field-permissions" element={<FieldPermissions />} />
              <Route path="lead-routing" element={<LeadRouting />} />
              <Route path="territories" element={<Territories />} />
              <Route path="quotas" element={<GenericOnly><Quotas /></GenericOnly>} />
              <Route path="win-loss" element={<GenericOnly><WinLoss /></GenericOnly>} />
              <Route path="ab-tests" element={<AbTests />} />
              <Route path="web-visitors" element={<WebVisitors />} />
              <Route path="chatbots" element={<Chatbots />} />
              <Route path="approvals" element={<Approvals />} />
              <Route path="document-templates" element={<DocumentTemplates />} />
              <Route path="surveys" element={<Surveys />} />
              <Route path="payments" element={<Payments />} />
              <Route path="deal-insights" element={<GenericOnly><DealInsights /></GenericOnly>} />
              <Route path="shared-inbox" element={<SharedInbox />} />
              <Route path="sla" element={<SLA />} />
              <Route path="live-chat" element={<LiveChat />} />
              <Route path="playbooks" element={<Playbooks />} />
              <Route path="document-tracking" element={<DocumentTracking />} />
              <Route path="industry-templates" element={<IndustryTemplates />} />
              <Route path="social" element={<Social />} />
              <Route path="sandbox" element={<Sandbox />} />
              <Route path="funnel" element={<GenericOnly><Funnel /></GenericOnly>} />
              <Route path="zapier" element={<Zapier />} />
              {/* #303: bare /calendar previously rendered a blank <main>. Wellness
                  tenants get bounced to their themed calendar; everyone else sees
                  the calendar-sync page (which is the closest generic equivalent). */}
              <Route path="calendar" element={<CalendarRedirect />} />
              {/* Wellness vertical — gated by WellnessOnly so generic-CRM
                  tenants can't surface wellness pages by URL (#325). */}
              <Route path="wellness" element={<WellnessOnly><WellnessOwnerDashboard /></WellnessOnly>} />
              <Route path="wellness/recommendations" element={<WellnessOnly><WellnessRecommendations /></WellnessOnly>} />
              <Route path="wellness/patients" element={<WellnessOnly><WellnessPatients /></WellnessOnly>} />
              <Route path="wellness/patients/:id" element={<WellnessOnly><WellnessPatientDetail /></WellnessOnly>} />
              <Route path="wellness/services" element={<WellnessOnly><WellnessServices /></WellnessOnly>} />
              <Route path="wellness/locations" element={<WellnessOnly><WellnessLocations /></WellnessOnly>} />
              <Route path="wellness/calendar" element={<WellnessOnly><WellnessCalendar /></WellnessOnly>} />
              <Route path="wellness/reports" element={<WellnessOnly><WellnessReports /></WellnessOnly>} />
              <Route path="wellness/telecaller" element={<WellnessOnly><WellnessTelecallerQueue /></WellnessOnly>} />
              {/* #183: alias for users who land on /telecaller (no /wellness prefix). */}
              <Route path="telecaller" element={<Navigate to="/wellness/telecaller" replace />} />
              <Route path="wellness/per-location" element={<WellnessOnly><WellnessPerLocation /></WellnessOnly>} />
              <Route path="wellness/loyalty" element={<WellnessOnly><WellnessLoyalty /></WellnessOnly>} />
              <Route path="wellness/waitlist" element={<WellnessOnly><WellnessWaitlist /></WellnessOnly>} />
              <Route path="wellness/inventory" element={<WellnessOnly><WellnessInventory /></WellnessOnly>} />
              {/* #309: /wellness/invoices used to render a blank page (no
                  route binding). Wellness shares the generic CRM Invoices
                  UI — alias the prefixed URL to the canonical /invoices
                  route so the sidebar link, deep links from emails, and
                  bookmarks all resolve. Mirrors the /wellness/inventory
                  fix from #305. */}
              <Route path="wellness/invoices" element={<Navigate to="/invoices" replace />} />
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
    </NotifyProvider>
    </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
