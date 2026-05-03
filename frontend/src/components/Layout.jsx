import React, { useContext, useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { LogOut, ChevronDown, Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import Omnibar from './Omnibar';
import Presence from './Presence';
import Softphone from './Softphone';
import NotificationBell from './NotificationBell';
import { AuthContext } from '../App';
import { setupPush } from '../utils/pushSetup';

const Layout = () => {
  const { user, setUser, setToken, token, tenant } = useContext(AuthContext);
  const navigate = useNavigate();
  // Wellness tenants use Callified.ai for voice — hide the built-in softphone
  const isWellness = tenant?.vertical === 'wellness';
  // #228: drawer state for mobile sidebar (<=768px). Desktop ignores this.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // T1.2: warn admin/manager when SMS provider is not configured. Patient
  // portal OTP login + appointment reminders silently fail without it. The
  // /api/auth/me response includes features.smsConfigured (set in
  // backend/routes/auth.js:331). Hide for regular USERs since they can't
  // do anything about it.
  const role = user?.role;
  const isStaff = role === 'ADMIN' || role === 'MANAGER';
  const showSmsBanner = isStaff && user?.features?.smsConfigured === false;

  // Auto-register push notifications after login (silent failures OK)
  useEffect(() => {
    if (token) setupPush(token).catch(() => {});
  }, [token]);

  const handleLogout = () => {
    // #343: setToken(null) flows through setAuthToken → clears the in-memory
    // holder + sessionStorage. The legacy localStorage.removeItem('token')
    // call is now a defensive no-op against any stale pre-#343 token, kept
    // so users mid-migration don't end up with a ghost bearer hanging around.
    setUser(null);
    setToken(null);
    try { localStorage.removeItem('token'); } catch { /* ignore */ }
    navigate('/login');
  };

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-color)' }}>
      <Sidebar mobileOpen={sidebarOpen} onMobileClose={() => setSidebarOpen(false)} />
      <div className="app-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {showSmsBanner && (
          <div
            role="alert"
            data-testid="sms-not-configured-banner"
            style={{
              background: '#fef3c7',
              borderBottom: '1px solid #f59e0b',
              color: '#92400e',
              padding: '10px 24px',
              fontSize: '0.85rem',
              lineHeight: 1.4,
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              flexShrink: 0,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>⚠️</span>
            <span style={{ flex: 1 }}>
              <strong>SMS provider not configured.</strong> Patient portal OTP login and appointment reminders are not delivering. Configure `MSG91_AUTH_KEY` (or another provider) in the backend `.env` to restore SMS dispatch.
            </span>
          </div>
        )}
        <header style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          padding: '8px 24px',
          gap: '8px',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--surface-color)',
          minHeight: 48,
          flexShrink: 0,
        }}>
          {/* #228: hamburger toggle — hidden on desktop via responsive.css. */}
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={sidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={sidebarOpen}
            aria-controls="app-sidebar"
            style={{
              display: 'none',
              alignItems: 'center', justifyContent: 'center',
              background: 'none', border: '1px solid var(--border-color)',
              color: 'var(--text-primary)', borderRadius: 8,
              width: 36, height: 36, cursor: 'pointer',
              marginRight: 'auto',
            }}
          >
            <Menu size={18} />
          </button>
          <NotificationBell />
          <button
            onClick={() => navigate('/profile')}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-primary)', fontSize: '0.85rem', fontWeight: 500,
              padding: '6px 10px', borderRadius: '6px',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--accent-color), var(--primary-color))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.75rem', fontWeight: 'bold', color: '#fff',
            }}>
              {(user?.name || user?.email || '?').charAt(0).toUpperCase()}
            </div>
            <span>{user?.name || user?.email || 'User'}</span>
            <ChevronDown size={14} style={{ opacity: 0.5 }} />
          </button>
          <button
            onClick={handleLogout}
            title="Logout"
            aria-label="Log out of your account"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', fontSize: '0.8rem',
              padding: '6px 10px', borderRadius: '6px',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; e.currentTarget.style.color = '#ef4444'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <LogOut size={16} />
          </button>
        </header>
        <main className="animate-fade-in" style={{ flex: 1, overflowY: 'auto', padding: '0', backgroundColor: 'transparent' }}>
          <Outlet />
        </main>
      </div>
      <Omnibar />
      {!isWellness && <Softphone />}
      <Presence />
    </div>
  );
};

export default Layout;
