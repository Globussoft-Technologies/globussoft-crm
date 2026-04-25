import React, { useEffect, useState } from 'react';
import { Plus, Trash2, CheckCircle2, Clock, XCircle, UserPlus } from 'lucide-react';
import { fetchApi } from '../../utils/api';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All', icon: null },
  { value: 'waiting', label: 'Waiting', icon: Clock, color: '#f59e0b' },
  { value: 'offered', label: 'Offered', icon: CheckCircle2, color: 'var(--accent-color)' },
  { value: 'booked', label: 'Booked', icon: CheckCircle2, color: 'var(--success-color)' },
  { value: 'expired', label: 'Expired', icon: XCircle, color: 'var(--text-secondary)' },
  { value: 'cancelled', label: 'Cancelled', icon: XCircle, color: '#ef4444' },
];

export default function Waitlist() {
  const [items, setItems] = useState([]);
  const [patients, setPatients] = useState([]);
  const [services, setServices] = useState([]);
  const [filter, setFilter] = useState('waiting');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ patientId: '', serviceId: '', preferredDateRange: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    const url = filter === 'all'
      ? '/api/wellness/waitlist'
      : `/api/wellness/waitlist?status=${encodeURIComponent(filter)}`;
    Promise.all([
      fetchApi(url),
      fetchApi('/api/wellness/patients').catch(() => []),
      fetchApi('/api/wellness/services').catch(() => []),
    ])
      .then(([w, p, s]) => {
        setItems(Array.isArray(w) ? w : []);
        // #126: GET /api/wellness/patients returns { patients, total } (paginated),
        // not a raw array. Pre-fix the dropdown was always empty because Array.isArray(p)
        // was false on the object response.
        setPatients(Array.isArray(p) ? p : Array.isArray(p?.patients) ? p.patients : []);
        setServices(Array.isArray(s) ? s : []);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [filter]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.patientId) {
      alert('Please pick a patient');
      return;
    }
    setSaving(true);
    try {
      await fetchApi('/api/wellness/waitlist', {
        method: 'POST',
        body: JSON.stringify({
          patientId: parseInt(form.patientId),
          serviceId: form.serviceId ? parseInt(form.serviceId) : undefined,
          preferredDateRange: form.preferredDateRange || undefined,
          notes: form.notes || undefined,
        }),
      });
      setShowAdd(false);
      setForm({ patientId: '', serviceId: '', preferredDateRange: '', notes: '' });
      load();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (id, status) => {
    try {
      await fetchApi(`/api/wellness/waitlist/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      load();
    } catch (err) { alert(`Failed: ${err.message}`); }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this waitlist entry?')) return;
    try {
      await fetchApi(`/api/wellness/waitlist/${id}`, { method: 'DELETE' });
      load();
    } catch (err) { alert(`Failed: ${err.message}`); }
  };

  const serviceName = (id) => services.find((s) => s.id === id)?.name || '—';

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock size={22} /> Waitlist
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            Patients waiting for an available slot. When a visit is cancelled, the next matching patient is auto-offered the slot via SMS.
          </p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          style={{ padding: '0.55rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.9rem' }}
        >
          <Plus size={16} /> Add to waitlist
        </button>
      </header>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            style={{
              padding: '0.4rem 0.85rem',
              background: filter === opt.value ? 'var(--accent-color)' : 'transparent',
              color: filter === opt.value ? '#fff' : 'var(--text-primary)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 999,
              cursor: 'pointer',
              fontSize: '0.8rem',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div>
            <label style={labelStyle}>Patient *</label>
            <select value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })} style={inputStyle} required>
              <option value="">Select patient…</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.phone ? ` (${p.phone})` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Service (optional)</label>
            <select value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })} style={inputStyle}>
              <option value="">Any service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Preferred dates</label>
            <input type="text" value={form.preferredDateRange} onChange={(e) => setForm({ ...form, preferredDateRange: e.target.value })} placeholder="e.g. asap or 2026-04-25..2026-05-05" style={inputStyle} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Notes</label>
            <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything the doctor should know" style={inputStyle} />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setShowAdd(false)} style={{ padding: '0.55rem 1rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ padding: '0.55rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}>{saving ? 'Saving…' : 'Add'}</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <UserPlus size={28} style={{ opacity: 0.5, marginBottom: '0.5rem' }} />
          <div>No waitlist entries{filter !== 'all' ? ` with status "${filter}"` : ''}.</div>
        </div>
      ) : (
        <div className="glass" style={{ padding: '0.5rem', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                <th style={thStyle}>Patient</th>
                <th style={thStyle}>Service</th>
                <th style={thStyle}>Preferred</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Added</th>
                <th style={thStyle}>Offered</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((w) => {
                const opt = STATUS_OPTIONS.find((o) => o.value === w.status);
                return (
                  <tr key={w.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 500 }}>{w.patient?.name || '—'}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{w.patient?.phone || ''}</div>
                    </td>
                    <td style={tdStyle}>{w.serviceId ? serviceName(w.serviceId) : <span style={{ color: 'var(--text-secondary)' }}>Any</span>}</td>
                    <td style={tdStyle}>{w.preferredDateRange || '—'}</td>
                    <td style={tdStyle}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.5rem', background: 'rgba(255,255,255,0.05)', borderRadius: 999, fontSize: '0.75rem', color: opt?.color || 'var(--text-primary)' }}>
                        {w.status}
                      </span>
                    </td>
                    <td style={tdStyle}>{new Date(w.createdAt).toLocaleDateString('en-IN')}</td>
                    <td style={tdStyle}>{w.offeredAt ? new Date(w.offeredAt).toLocaleString('en-IN') : '—'}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      {w.status === 'waiting' && (
                        <button onClick={() => setStatus(w.id, 'offered')} style={actionBtn('var(--accent-color)')}>Offer</button>
                      )}
                      {w.status === 'offered' && (
                        <button onClick={() => setStatus(w.id, 'booked')} style={actionBtn('var(--success-color)')}>Mark booked</button>
                      )}
                      {(w.status === 'waiting' || w.status === 'offered') && (
                        <button onClick={() => setStatus(w.id, 'cancelled')} style={actionBtn('transparent', 'var(--text-secondary)')}>Cancel</button>
                      )}
                      <button onClick={() => remove(w.id)} title="Delete" style={{ ...actionBtn('transparent', '#ef4444'), padding: '0.3rem 0.5rem' }}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { width: '100%', padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
const thStyle = { padding: '0.6rem 0.5rem', fontWeight: 500, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' };
const tdStyle = { padding: '0.6rem 0.5rem' };
const actionBtn = (bg, color = '#fff') => ({
  padding: '0.3rem 0.65rem',
  background: bg,
  color,
  border: bg === 'transparent' ? '1px solid rgba(255,255,255,0.1)' : 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: '0.75rem',
  marginRight: '0.3rem',
});
