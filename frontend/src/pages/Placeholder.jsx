import React from 'react';
import { Construction } from 'lucide-react';
import { useLocation } from 'react-router-dom';

const Placeholder = () => {
  const location = useLocation();
  const pathName = location.pathname.replace('/', '');
  const moduleName = pathName.charAt(0).toUpperCase() + pathName.slice(1);

  return (
    <div className="dashboard-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80vh', textAlign: 'center' }}>
      <div style={{ padding: '3rem', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.05)', borderRadius: '16px', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)' }}>
        <Construction size={64} color="var(--accent-color)" style={{ marginBottom: '1.5rem', filter: 'drop-shadow(0 0 10px var(--accent-glow))' }} />
        <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', fontWeight: 'bold' }}>{moduleName} Module</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1.2rem', maxWidth: '400px', margin: '0 auto' }}>
          This enterprise feature is currently under active development and will be available in the upcoming release.
        </p>
      </div>
    </div>
  );
};

export default Placeholder;
