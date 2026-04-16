import React, { useState, useEffect } from 'react';
import { Code, Plug, Zap, ChevronRight, Trash2, ExternalLink, Eye, X } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function Zapier() {
  const [triggers, setTriggers] = useState([]);
  const [actions, setActions] = useState([]);
  const [subs, setSubs] = useState([]);
  const [sample, setSample] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [t, a, s] = await Promise.all([
        fetchApi('/api/zapier/triggers').catch(() => []),
        fetchApi('/api/zapier/actions').catch(() => []),
        fetchApi('/api/zapier/subscriptions').catch(() => []),
      ]);
      setTriggers(Array.isArray(t) ? t : []);
      setActions(Array.isArray(a) ? a : []);
      setSubs(Array.isArray(s) ? s : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const viewSample = async (key) => {
    try {
      const data = await fetchApi(`/api/zapier/test/${key}`);
      setSample({ key, data });
    } catch (err) {
      alert('Failed to load sample data');
    }
  };

  const removeSubscription = async (id) => {
    if (!window.confirm('Disconnect this Zap subscription?')) return;
    try {
      await fetchApi(`/api/zapier/subscribe/${id}`, { method: 'DELETE' });
      loadAll();
    } catch (err) {
      alert('Failed to remove subscription');
    }
  };

  const cardStyle = {
    padding: '2rem',
    marginBottom: '2rem',
  };

  const tableHeaderStyle = {
    textAlign: 'left',
    padding: '0.75rem 1rem',
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-secondary)',
    borderBottom: '1px solid var(--border-color)',
  };

  const tableCellStyle = {
    padding: '1rem',
    borderBottom: '1px solid var(--border-color)',
    verticalAlign: 'top',
    fontSize: '0.9rem',
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(255,79,0,0.2), rgba(255,79,0,0.05))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid rgba(255,79,0,0.3)'
          }}>
            <Code size={28} color="#FF4F00" />
          </div>
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Zapier Integration</h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              Connect Globussoft CRM to 6,000+ apps via Zapier triggers and actions.
            </p>
          </div>
        </div>
        <a
          href="https://zapier.com/developer"
          target="_blank"
          rel="noreferrer"
          className="btn-primary"
          style={{ padding: '0.75rem 1.5rem', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          Zapier Developer <ExternalLink size={16} />
        </a>
      </header>

      {/* Section 1: Connect Instructions */}
      <div className="card" style={cardStyle}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plug size={20} color="var(--accent-color)" /> Connect to Zapier
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem' }}>
          {[
            {
              n: 1,
              title: 'Generate API Key',
              body: <>Create a personal API key from the <a href="/developer" style={{ color: 'var(--accent-color)' }}>Developer Portal</a>. Copy it once — you won't see it again.</>
            },
            {
              n: 2,
              title: 'Find Our App',
              body: <>In Zapier, click "Create Zap" and search for <strong>Globussoft CRM</strong> as your trigger or action app.</>
            },
            {
              n: 3,
              title: 'Authenticate',
              body: <>Paste the API key when Zapier prompts. Your Zap will then map any of the triggers / actions below.</>
            }
          ].map(s => (
            <div key={s.n} style={{
              padding: '1.5rem',
              background: 'var(--subtle-bg-2)',
              border: '1px solid var(--border-color)',
              borderRadius: 8
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: '50%',
                background: 'var(--accent-color)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, marginBottom: '0.75rem'
              }}>{s.n}</div>
              <h4 style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{s.title}</h4>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{s.body}</p>
            </div>
          ))}
        </div>
        <div style={{
          marginTop: '1.5rem', padding: '1rem',
          background: 'rgba(255, 191, 0, 0.08)',
          border: '1px solid rgba(255, 191, 0, 0.3)',
          borderRadius: 8, fontSize: '0.875rem', color: 'var(--text-secondary)'
        }}>
          <strong style={{ color: 'var(--text-primary)' }}>Marketplace status:</strong> Our Zapier app is currently in private beta.
          Apply for public marketplace listing at <a href="https://zapier.com/developer" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-color)' }}>zapier.com/developer</a>.
        </div>
      </div>

      {/* Section 2: Triggers */}
      <div className="card" style={cardStyle}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Zap size={20} color="var(--success-color)" /> Available Triggers
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
            ({triggers.length}) — events that start a Zap
          </span>
        </h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={tableHeaderStyle}>Key</th>
              <th style={tableHeaderStyle}>Name</th>
              <th style={tableHeaderStyle}>Description</th>
              <th style={{ ...tableHeaderStyle, textAlign: 'right' }}>Sample</th>
            </tr>
          </thead>
          <tbody>
            {triggers.map(t => (
              <tr key={t.key}>
                <td style={{ ...tableCellStyle, fontFamily: 'monospace', color: 'var(--accent-color)' }}>{t.key}</td>
                <td style={{ ...tableCellStyle, fontWeight: 600 }}>{t.name}</td>
                <td style={{ ...tableCellStyle, color: 'var(--text-secondary)' }}>{t.description}</td>
                <td style={{ ...tableCellStyle, textAlign: 'right' }}>
                  <button
                    onClick={() => viewSample(t.key)}
                    style={{
                      background: 'transparent', border: '1px solid var(--border-color)',
                      borderRadius: 6, padding: '0.4rem 0.75rem', color: 'var(--text-primary)',
                      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem'
                    }}
                  >
                    <Eye size={14} /> Sample Data
                  </button>
                </td>
              </tr>
            ))}
            {triggers.length === 0 && !loading && (
              <tr><td colSpan={4} style={{ ...tableCellStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No triggers available.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Section 3: Actions */}
      <div className="card" style={cardStyle}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ChevronRight size={20} color="#a855f7" /> Available Actions
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
            ({actions.length}) — operations Zapier can perform in your CRM
          </span>
        </h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={tableHeaderStyle}>Key</th>
              <th style={tableHeaderStyle}>Name</th>
              <th style={tableHeaderStyle}>Description</th>
              <th style={tableHeaderStyle}>Required Fields</th>
            </tr>
          </thead>
          <tbody>
            {actions.map(a => {
              const required = (a.fields || []).filter(f => f.required).map(f => f.key);
              return (
                <tr key={a.key}>
                  <td style={{ ...tableCellStyle, fontFamily: 'monospace', color: '#a855f7' }}>{a.key}</td>
                  <td style={{ ...tableCellStyle, fontWeight: 600 }}>{a.name}</td>
                  <td style={{ ...tableCellStyle, color: 'var(--text-secondary)' }}>{a.description}</td>
                  <td style={tableCellStyle}>
                    {required.length === 0
                      ? <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>none</span>
                      : required.map(r => (
                          <span key={r} style={{
                            display: 'inline-block', padding: '0.15rem 0.5rem', marginRight: '0.4rem', marginBottom: '0.25rem',
                            background: 'rgba(168, 85, 247, 0.12)', color: '#a855f7',
                            borderRadius: 4, fontSize: '0.75rem', fontFamily: 'monospace'
                          }}>{r}</span>
                        ))}
                  </td>
                </tr>
              );
            })}
            {actions.length === 0 && !loading && (
              <tr><td colSpan={4} style={{ ...tableCellStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No actions available.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Section 4: Active Subscriptions */}
      <div className="card" style={cardStyle}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plug size={20} color="var(--success-color)" /> Active Subscriptions
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
            ({subs.length}) — webhooks Zapier registered for your account
          </span>
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {subs.map(s => (
            <div key={s.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '1rem 1.25rem',
              background: 'var(--subtle-bg-2)',
              border: '1px solid var(--border-color)',
              borderRadius: 8
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: 'inline-block', padding: '0.2rem 0.6rem',
                  background: 'rgba(16, 185, 129, 0.12)', color: 'var(--success-color)',
                  borderRadius: 4, fontSize: '0.75rem', fontFamily: 'monospace', marginBottom: '0.5rem'
                }}>{s.event}</div>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: 0, wordBreak: 'break-all' }}>
                  POST {s.targetUrl}
                </p>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                  Created {new Date(s.createdAt).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => removeSubscription(s.id)}
                style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer' }}
                title="Disconnect"
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
          {subs.length === 0 && (
            <p style={{
              color: 'var(--text-secondary)', fontSize: '0.875rem',
              padding: '1.5rem', background: 'var(--subtle-bg)', borderRadius: 8, textAlign: 'center'
            }}>
              No active Zap subscriptions. Once a user enables a Zap, the subscription will appear here.
            </p>
          )}
        </div>
      </div>

      {/* Sample Data Modal */}
      {sample && (
        <div
          onClick={() => setSample(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '2rem'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{ padding: '2rem', maxWidth: 600, width: '100%', maxHeight: '80vh', overflowY: 'auto' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, fontFamily: 'monospace' }}>{sample.key} — sample</h3>
              <button
                onClick={() => setSample(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <pre style={{
              background: 'var(--subtle-bg-2)', padding: '1rem', borderRadius: 6,
              fontSize: '0.85rem', overflowX: 'auto', color: 'var(--text-primary)'
            }}>
              {JSON.stringify(sample.data, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
