import React, { useState, useEffect } from 'react';
import { Send, BarChart2 } from 'lucide-react';

const Marketing = () => {
  const [campaigns, setCampaigns] = useState([]);

  useEffect(() => {
    fetch('http://localhost:5000/api/marketing')
      .then(res => res.json())
      .then(data => setCampaigns(data));
  }, []);

  return (
    <div style={{ padding: '2rem' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Marketing Automation</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Email sequences and campaign tracking</p>
      </header>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
        {campaigns.length === 0 ? <p>Loading campaigns...</p> : campaigns.map(camp => (
          <div key={camp.id} className="card glass" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 'bold' }}>{camp.name}</h3>
              <span style={{ 
                padding: '0.25rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem',
                backgroundColor: camp.status === 'Running' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(255, 255, 255, 0.1)',
                color: camp.status === 'Running' ? 'var(--success-color)' : 'var(--text-secondary)'
              }}>
                {camp.status}
              </span>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
              <div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Sent</p>
                <p style={{ fontWeight: 'bold' }}>{camp.sent.toLocaleString()}</p>
              </div>
              <div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Opened</p>
                <p style={{ fontWeight: 'bold', color: 'var(--accent-color)' }}>{camp.opened}%</p>
              </div>
              <div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Clicked</p>
                <p style={{ fontWeight: 'bold', color: 'var(--warning-color)' }}>{camp.clicked}%</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Marketing;
