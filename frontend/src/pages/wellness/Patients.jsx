import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, Users, Phone, Mail } from 'lucide-react';
import { fetchApi } from '../../utils/api';

export default function Patients() {
  const [patients, setPatients] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [locations, setLocations] = useState([]);
  const [form, setForm] = useState({ name: '', phone: '', email: '', gender: '', source: 'walk-in', locationId: '' });

  const load = () => {
    setLoading(true);
    const url = q ? `/api/wellness/patients?q=${encodeURIComponent(q)}` : '/api/wellness/patients';
    fetchApi(url)
      .then((d) => { setPatients(d.patients); setTotal(d.total); })
      .catch(() => { setPatients([]); setTotal(0); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    fetchApi('/api/wellness/locations').then(setLocations).catch(() => setLocations([]));
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form, locationId: form.locationId ? parseInt(form.locationId) : null };
      await fetchApi('/api/wellness/patients', { method: 'POST', body: JSON.stringify(payload) });
      setForm({ name: '', phone: '', email: '', gender: '', source: 'walk-in', locationId: locations[0]?.id || '' });
      setShowAdd(false);
      load();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users size={24} /> Patients
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{total.toLocaleString()} total</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New patient'}
        </button>
      </header>

      {showAdd && (
        <form onSubmit={handleCreate} className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
          <input placeholder="Name *" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={inputStyle} />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={inputStyle} />
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} style={inputStyle}>
            <option value="">Gender</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="Other">Other</option>
          </select>
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} style={inputStyle}>
            <option value="walk-in">Walk-in</option>
            <option value="meta-ad">Meta ad</option>
            <option value="google-ad">Google ad</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="referral">Referral</option>
            <option value="indiamart">IndiaMART</option>
          </select>
          {locations.length > 1 && (
            <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} style={inputStyle}>
              <option value="">Select clinic</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <button type="submit" style={{ padding: '0.55rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save</button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Search size={16} color="var(--text-secondary)" />
        <input
          placeholder="Search by name, phone, or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '0.9rem' }}
        />
      </div>

      {loading && <div>Loading…</div>}

      {!loading && (
        <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Phone</th>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Gender</th>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Added</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={tdStyle}>
                    <Link to={`/wellness/patients/${p.id}`} style={{ color: 'var(--accent-color)', textDecoration: 'none', fontWeight: 500 }}>
                      {p.name}
                    </Link>
                  </td>
                  <td style={tdStyle}>{p.phone && <span><Phone size={12} style={{ verticalAlign: 'middle' }} /> {p.phone}</span>}</td>
                  <td style={tdStyle}>{p.email && <span><Mail size={12} style={{ verticalAlign: 'middle' }} /> {p.email}</span>}</td>
                  <td style={tdStyle}>{p.gender || '—'}</td>
                  <td style={tdStyle}>{p.source || '—'}</td>
                  <td style={tdStyle}>{new Date(p.createdAt).toLocaleDateString('en-IN')}</td>
                </tr>
              ))}
              {patients.length === 0 && (
                <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No patients match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '0.75rem 1rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' };
const tdStyle = { padding: '0.75rem 1rem', fontSize: '0.9rem' };
const inputStyle = { padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
