import React from 'react';
import { NavLink } from 'react-router-dom';
import { Users, LayoutDashboard, Briefcase, Settings, LifeBuoy, Send } from 'lucide-react';

const Sidebar = () => {
  return (
    <aside style={{ width: '250px', backgroundColor: 'var(--surface-color)', borderRight: '1px solid var(--border-color)', height: '100vh', padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{ width: '32px', height: '32px', backgroundColor: 'var(--accent-color)', borderRadius: '8px' }}></div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>Globussoft</h1>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
        <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <LayoutDashboard size={20} /> Dashboard
        </NavLink>
        <NavLink to="/contacts" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Users size={20} /> Contacts
        </NavLink>
        <NavLink to="/pipeline" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Briefcase size={20} /> Pipeline
        </NavLink>
        <NavLink to="/marketing" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Send size={20} /> Marketing
        </NavLink>
        <NavLink to="/support" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <LifeBuoy size={20} /> Support
        </NavLink>
        <div style={{ marginTop: 'auto' }}>
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
            <Settings size={20} /> Settings
          </NavLink>
        </div>
      </nav>
    </aside>
  );
};

const navStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: '0.75rem 1rem',
  gap: '0.75rem',
  borderRadius: '8px',
  color: 'var(--text-secondary)',
  transition: 'all 0.2s ease',
  textDecoration: 'none'
};

export default Sidebar;
