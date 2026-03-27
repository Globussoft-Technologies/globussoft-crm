import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Omnibar from './Omnibar';
import Presence from './Presence';
import Softphone from './Softphone';

const Layout = () => {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-color)' }}>
      <Sidebar />
      <main className="animate-fade-in" style={{ flex: 1, overflowY: 'auto', padding: '0', backgroundColor: 'transparent' }}>
        <Outlet />
      </main>
      <Omnibar />
      <Softphone />
      <Presence />
    </div>
  );
};

export default Layout;
