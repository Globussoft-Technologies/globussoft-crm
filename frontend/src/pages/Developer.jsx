import React, { useState, useEffect } from 'react';
import { Key, Globe, Plus, Trash2, Copy, CheckCircle2 } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function Developer() {
  const [keys, setKeys] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [copiedId, setCopiedId] = useState(null);

  const [newKeyName, setNewKeyName] = useState('');
  const [newHook, setNewHook] = useState({ event: 'deal.created', targetUrl: '' });

  useEffect(() => {
    loadDevData();
  }, []);

  const loadDevData = async () => {
    try {
      const k = await fetchApi('/api/developer/apikeys');
      setKeys(Array.isArray(k) ? k : []);
      
      const h = await fetchApi('/api/developer/webhooks');
      setHooks(Array.isArray(h) ? h : []);
    } catch (err) {
      console.error(err);
    }
  };

  const generateKey = async (e) => {
    e.preventDefault();
    if (!newKeyName) return;
    try {
      const { rawKey } = await fetchApi('/api/developer/apikeys', { method: 'POST', body: JSON.stringify({ name: newKeyName }) });
      alert(`ATTENTION: This is the ONLY time this key will be displayed.\n\nSave this in a secure vault immediately:\n\n${rawKey}`);
      setNewKeyName('');
      loadDevData();
    } catch(err) {
      alert("Failed to create key.");
    }
  };

  const deleteKey = async (id) => {
    if (window.confirm("WARNING: Revoking this API Key will immediately sever all integrations relying upon it. Proceed?")) {
      await fetchApi(`/api/developer/apikeys/${id}`, { method: 'DELETE' });
      loadDevData();
    }
  };

  const registerWebhook = async (e) => {
    e.preventDefault();
    if (!newHook.targetUrl) return;
    try {
      await fetchApi('/api/developer/webhooks', { method: 'POST', body: JSON.stringify(newHook) });
      setNewHook({ event: 'deal.created', targetUrl: '' });
      loadDevData();
    } catch(err) {
      alert("Failed to register webhook");
    }
  };

  const deleteWebhook = async (id) => {
    await fetchApi(`/api/developer/webhooks/${id}`, { method: 'DELETE' });
    loadDevData();
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Developer Ecosystem</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>REST Extensibility, Bearer API Keys, and Outbound Webhook Streams.</p>
        </div>
        <a href="/api-docs" target="_blank" rel="noreferrer" className="btn-primary" style={{ padding: '0.75rem 1.5rem', textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
          View Swagger OpenAPI Docs
        </a>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
        
        {/* API Keys */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Key size={20} color="var(--accent-color)" /> API Credentials
          </h3>
          <form onSubmit={generateKey} style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
            <input type="text" className="input-field" style={{ margin: 0, flex: 1 }} placeholder="Key Name (e.g. Zapier Integration)" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} />
            <button className="btn-primary" type="submit">Generate Key</button>
          </form>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {keys.map(k => (
              <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div>
                  <h4 style={{ fontWeight: '600', fontSize: '1rem' }}>{k.name}</h4>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', fontFamily: 'monospace', letterSpacing: '0.1em', marginTop: '0.25rem' }}>{k.keySecret.substring(0, 10)}****************</p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(k.keySecret);
                      setCopiedId(k.id);
                      setTimeout(() => setCopiedId(null), 2000);
                    }}
                    title="Copy to Clipboard"
                    style={{ background: 'transparent', border: 'none', color: copiedId === k.id ? 'var(--success-color)' : 'var(--accent-color)', cursor: 'pointer' }}
                  >
                    {copiedId === k.id ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                  </button>
                  <button onClick={() => deleteKey(k.id)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer' }}>
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
            {keys.length === 0 && <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '8px', textAlign: 'center' }}>No active API keys located.</p>}
          </div>
        </div>

        {/* Webhooks */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={20} color="var(--success-color)" /> Webhooks
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Configure HTTP POST endpoints to receive real-time JSON payloads when state changes occur.
          </p>

          <form onSubmit={registerWebhook} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <select className="input-field" style={{ margin: 0, width: '200px', background: 'var(--input-bg)' }} value={newHook.event} onChange={e => setNewHook({ ...newHook, event: e.target.value })}>
                <option value="deal.created">Deal Created</option>
                <option value="deal.won">Deal Won</option>
                <option value="contact.created">Contact Created</option>
              </select>
              <input type="url" className="input-field" style={{ margin: 0, flex: 1 }} placeholder="https://endpoint.example.com/webhook" required value={newHook.targetUrl} onChange={e => setNewHook({ ...newHook, targetUrl: e.target.value })} />
            </div>
            <button className="btn-secondary" type="submit" style={{ width: '100%' }}>Register Target Endpoint</button>
          </form>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {hooks.map(h => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div>
                  <h4 style={{ fontWeight: '600', fontSize: '1rem', color: 'var(--success-color)', display: 'inline-block', padding: '0.25rem 0.5rem', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '4px' }}>{h.event}</h4>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.75rem' }}>POST: {h.targetUrl}</p>
                </div>
                <button onClick={() => deleteWebhook(h.id)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer' }}>
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
            {hooks.length === 0 && <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '8px', textAlign: 'center' }}>No registered webhook listeners.</p>}
          </div>
        </div>

      </div>
    </div>
  );
}
