import React, { useState, createContext, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import Pipeline from './pages/Pipeline';
import Workflows from './pages/Workflows';
import Inbox from './pages/Inbox';
import Marketing from './pages/Marketing';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Developer from './pages/Developer';
import Billing from './pages/Billing';
import Portal from './pages/Portal';
import Marketplace from './pages/Marketplace';
import CustomObjects from './pages/CustomObjects';
import CustomObjectView from './pages/CustomObjectView';
import Sequences from './pages/Sequences';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Placeholder from './pages/Placeholder';
import Layout from './components/Layout';

export const AuthContext = createContext();

export default function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token') || null);

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }, [token]);

  return (
    <AuthContext.Provider value={{ user, setUser, token, setToken }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={!token ? <Login /> : <Navigate to="/" />} />
          <Route path="/signup" element={!token ? <Signup /> : <Navigate to="/" />} />
          <Route path="/portal" element={<Portal />} />
          <Route path="/" element={token ? <Layout /> : <Navigate to="/login" />}>
            <Route index element={<Dashboard />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="pipeline" element={<Pipeline />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="marketing" element={<Marketing />} />
            <Route path="reports" element={<Reports />} />
            <Route path="workflows" element={<Workflows />} />
            <Route path="developer" element={<Developer />} />
            <Route path="billing" element={<Billing />} />
            <Route path="marketplace" element={<Marketplace />} />
            <Route path="objects" element={<CustomObjects />} />
            <Route path="objects/:entityName" element={<CustomObjectView />} />
            <Route path="sequences" element={<Sequences />} />
            <Route path="settings" element={<Settings />} />
            {/* Missing Modules Patched by Issue Triage */}
            <Route path="expenses" element={<Placeholder />} />
            <Route path="contracts" element={<Placeholder />} />
            <Route path="estimates" element={<Placeholder />} />
            <Route path="invoices" element={<Placeholder />} />
            <Route path="tickets" element={<Placeholder />} />
            <Route path="tasks" element={<Placeholder />} />
            <Route path="projects" element={<Placeholder />} />
            <Route path="clients" element={<Placeholder />} />
            <Route path="leads" element={<Placeholder />} />
            <Route path="staff" element={<Placeholder />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}