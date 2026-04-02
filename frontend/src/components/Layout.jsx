import React, { useContext } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { LogOut, ChevronDown } from 'lucide-react';
import Sidebar from './Sidebar';
import Omnibar from './Omnibar';
import Presence from './Presence';
import Softphone from './Softphone';
import NotificationBell from './NotificationBell';
import { AuthContext } from '../App';

const Layout = () => {
  const { user, setUser, setToken } = useContext(AuthContext);
  const navigate = useNavigate();

  const handleLogout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('token');
    navigate('/login');
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-color)' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
      <Softphone />
      <Presence />
    </div>
  );
};

export default Layout;
