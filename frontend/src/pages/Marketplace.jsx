import React, { useState, useEffect } from 'react';
import { Blocks, CheckCircle2, CloudLightning, MessageSquare, CreditCard, Mail } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const apps = [
  { id: 'slack', name: 'Slack Native', icon: <MessageSquare size={32} color="#ec4899" />, desc: 'Post push telemetry into #sales-wins instantly when Deals migrate to Won states.' },
  { id: 'google', name: 'Google Workspace', icon: <CloudLightning size={32} color="#3b82f6" />, desc: 'Bi-directional synchronization for address books and Calendar endpoints.' },
  { id: 'stripe', name: 'Stripe Billing', icon: <CreditCard size={32} color="#8b5cf6" />, desc: 'Reconcile generated CRM PDF invoices directly into Stripe subscription webhooks.' },
  { id: 'mailchimp', name: 'Mailchimp', icon: <Mail size={32} color="#f59e0b" />, desc: 'Pump inbound autonomous Web Leads directly into marketing drip matrices.' }
];

export default function Marketplace() {
  const notify = useNotify();
  const [integrations, setIntegrations] = useState([]);

  useEffect(() => {
    loadIntegrations();
  }, []);

  const loadIntegrations = async () => {
    try {
      const data = await fetchApi('/api/integrations');
      setIntegrations(Array.isArray(data) ? data : []);
    } catch(err) {
      console.error(err);
    }
  };

  const toggleApp = async (provider, currentState) => {
    // Simulated one-click OAuth flow
    try {
      await fetchApi('/api/integrations/toggle', {
        method: 'POST',
        body: JSON.stringify({ provider, isActive: !currentState })
      });
      loadIntegrations();
    } catch(err) {
      notify.error("Encountered OAuth Handshake constraint.");
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Enterprise App Marketplace</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Extend Globussoft CRM functionality via one-click encrypted third-party handshakes.</p>
      </header>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
        {apps.map(app => {
          const installed = integrations.find(i => i.provider === app.id && i.isActive);
          
          return (
            <div key={app.id} className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', height: '100%', border: installed ? '1px solid var(--accent-color)' : '1px solid var(--border-color)', position: 'relative', overflow: 'hidden' }}>
              {installed && <div style={{ position: 'absolute', top: 0, right: 0, padding: '0.25rem 1rem', background: 'var(--accent-color)', color: '#fff', fontSize: '0.75rem', fontWeight: 'bold', borderBottomLeftRadius: '8px', zIndex: 1 }}>Authenticated</div>}
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                <div style={{ background: 'var(--subtle-bg)', padding: '0.75rem', borderRadius: '12px' }}>
                  {app.icon}
                </div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{app.name}</h3>
              </div>
              
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: '1.5', flex: 1, marginBottom: '1.5rem' }}>
                {app.desc}
              </p>
              
              <button 
                onClick={() => toggleApp(app.id, installed)}
                style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', border: 'none', fontWeight: '600', cursor: 'pointer', transition: 'all 0.2s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                background: installed ? 'rgba(59, 130, 246, 0.1)' : 'var(--accent-color)', color: installed ? 'var(--accent-color)' : '#fff' }}
              >
                {installed ? <><CheckCircle2 size={18} /> Integrated securely</> : 'Initiate OAuth Handshake'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
