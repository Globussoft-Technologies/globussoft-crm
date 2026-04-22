import React, { useEffect, useState } from 'react';
import { Sparkles, Plus, MapPin, Clock, IndianRupee } from 'lucide-react';
import { fetchApi } from '../../utils/api';

const tierColor = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' };

export default function Services() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'aesthetics', ticketTier: 'medium', basePrice: 0, durationMin: 60, targetRadiusKm: 30, description: '' });

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/services').then(setServices).catch(() => setServices([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/wellness/services', { method: 'POST', body: JSON.stringify(form) });
      setShowAdd(false);
      setForm({ name: '', category: 'aesthetics', ticketTier: 'medium', basePrice: 0, durationMin: 60, targetRadiusKm: 30, description: '' });
      load();
    } catch (err) { alert(`Failed: ${err.message}`); }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={24} /> Service catalog
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Each service has a price, duration, and target marketing radius.</p>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New service'}
        </button>
      </header>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' }}>
          <input placeholder="Service name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inputStyle}>
            {['hair', 'skin', 'aesthetics', 'slimming', 'ayurveda', 'salon'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={form.ticketTier} onChange={(e) => setForm({ ...form, ticketTier: e.target.value })} style={inputStyle}>
            <option value="low">Low tier</option>
            <option value="medium">Medium tier</option>
            <option value="high">High tier</option>
          </select>
          <input type="number" placeholder="Base price ₹" value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: parseFloat(e.target.value) || 0 })} style={inputStyle} />
          <input type="number" placeholder="Duration (min)" value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: parseInt(e.target.value) || 30 })} style={inputStyle} />
          <input type="number" placeholder="Target radius (km, blank = unlimited)" value={form.targetRadiusKm || ''} onChange={(e) => setForm({ ...form, targetRadiusKm: e.target.value ? parseInt(e.target.value) : null })} style={inputStyle} />
          <button type="submit" style={{ padding: '0.5rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', gridColumn: 'span 2' }}>Save</button>
        </form>
      )}

      {loading && <div>Loading…</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {services.map((s) => (
          <div key={s.id} className="glass" style={{ padding: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
              <div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.category}</div>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.15rem' }}>{s.name}</h3>
              </div>
              <span style={{ background: tierColor[s.ticketTier], color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600 }}>
                {s.ticketTier}
              </span>
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              <span><IndianRupee size={12} style={{ verticalAlign: 'middle' }} /> {s.basePrice.toLocaleString('en-IN')}</span>
              <span><Clock size={12} style={{ verticalAlign: 'middle' }} /> {s.durationMin} min</span>
              <span><MapPin size={12} style={{ verticalAlign: 'middle' }} /> {s.targetRadiusKm ? `${s.targetRadiusKm} km` : 'Unlimited'}</span>
            </div>
            {s.description && <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', lineHeight: 1.4 }}>{s.description}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

const inputStyle = { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
