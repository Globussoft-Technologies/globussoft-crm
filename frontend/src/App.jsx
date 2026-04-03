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

export const AuthContext = createContext();
export const ThemeContext = createContext();

export default function App() {
  const [user, setUser] = useState(null);
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
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
    <AuthContext.Provider value={{ user, setUser, token, setToken }}>
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
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
