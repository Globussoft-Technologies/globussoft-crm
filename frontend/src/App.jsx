import React, { useState, createContext, useEffect, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Landing from './pages/Landing';
import Layout from './components/Layout';

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
const Tasks = lazy(() => import('./pages/Tasks'));
const Tickets = lazy(() => import('./pages/Tickets'));
const Support = lazy(() => import('./pages/Support'));
const Staff = lazy(() => import('./pages/Staff'));
const Invoices = lazy(() => import('./pages/Invoices'));
const LeadScoring = lazy(() => import('./pages/LeadScoring'));
const Leads = lazy(() => import('./pages/Leads'));
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

export const AuthContext = createContext();
export const ThemeContext = createContext();

export default function App() {
  const [user, setUser] = useState(null);
  const [tenant, setTenant] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tenant') || 'null'); } catch { return null; }
  });
  const [token, setToken] = useState(localStorage.getItem('token') || null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }, [token]);

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

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
    <AuthContext.Provider value={{ user, setUser, token, setToken, tenant, setTenant }}>
      <BrowserRouter>
        <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'var(--text-primary)' }}>Loading...</div>}>
          <Routes>
            <Route path="/login" element={!token ? <Login /> : <Navigate to="/dashboard" />} />
            <Route path="/signup" element={!token ? <Signup /> : <Navigate to="/dashboard" />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/portal" element={<Portal />} />
            <Route path="/" element={!token ? <Landing /> : <Navigate to="/dashboard" />} />
            <Route path="/*" element={token ? <Layout /> : <Navigate to="/login" />}>
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="contacts" element={<Contacts />} />
              <Route path="contacts/:id" element={<ContactDetail />} />
              <Route path="pipeline" element={<Pipeline />} />
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
              <Route path="staff" element={<Staff />} />
              <Route path="profile" element={<Profile />} />
              <Route path="profile/2fa" element={<Profile2FA />} />
              <Route path="audit-log" element={<AuditLog />} />
              <Route path="privacy" element={<Privacy />} />
              <Route path="calendar-sync" element={<CalendarSync />} />
              <Route path="pipelines" element={<Pipelines />} />
              <Route path="forecasting" element={<Forecasting />} />
              <Route path="dashboards" element={<Dashboards />} />
              <Route path="custom-reports" element={<CustomReports />} />
              <Route path="booking-pages" element={<BookingPages />} />
              <Route path="signatures" element={<Signatures />} />
              <Route path="knowledge-base" element={<KnowledgeBase />} />
              <Route path="currencies" element={<Currencies />} />
              <Route path="field-permissions" element={<FieldPermissions />} />
              <Route path="lead-routing" element={<LeadRouting />} />
              <Route path="territories" element={<Territories />} />
              <Route path="quotas" element={<Quotas />} />
              <Route path="win-loss" element={<WinLoss />} />
              <Route path="ab-tests" element={<AbTests />} />
              <Route path="web-visitors" element={<WebVisitors />} />
              <Route path="chatbots" element={<Chatbots />} />
              <Route path="approvals" element={<Approvals />} />
              <Route path="document-templates" element={<DocumentTemplates />} />
              <Route path="surveys" element={<Surveys />} />
              <Route path="payments" element={<Payments />} />
              <Route path="deal-insights" element={<DealInsights />} />
              <Route path="shared-inbox" element={<SharedInbox />} />
              <Route path="sla" element={<SLA />} />
              <Route path="live-chat" element={<LiveChat />} />
              <Route path="playbooks" element={<Playbooks />} />
              <Route path="document-tracking" element={<DocumentTracking />} />
              <Route path="industry-templates" element={<IndustryTemplates />} />
              <Route path="social" element={<Social />} />
              <Route path="sandbox" element={<Sandbox />} />
              <Route path="funnel" element={<Funnel />} />
              <Route path="zapier" element={<Zapier />} />
              {/* Wellness vertical */}
              <Route path="wellness" element={<WellnessOwnerDashboard />} />
              <Route path="wellness/recommendations" element={<WellnessRecommendations />} />
              <Route path="wellness/patients" element={<WellnessPatients />} />
              <Route path="wellness/patients/:id" element={<WellnessPatientDetail />} />
              <Route path="wellness/services" element={<WellnessServices />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
