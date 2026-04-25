import React, { useEffect, useState } from 'react';
import { Network, Plus, Trash2, Edit2, X, MapPin, Users, Eye, ArrowLeft } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function Territories() {
  const notify = useNotify();
  const [territories, setTerritories] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [viewContacts, setViewContacts] = useState([]);
  const [viewLoading, setViewLoading] = useState(false);

  const [form, setForm] = useState({
    name: '',
    regionsText: '',
    selectedUserIds: [],
  });

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [t, u] = await Promise.all([
        fetchApi('/api/territories').catch(() => []),
        fetchApi('/api/staff').catch(() => []),
      ]);
      setTerritories(Array.isArray(t) ? t : []);
      setUsers(Array.isArray(u) ? u : []);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const openNew = () => {
    setEditing(null);
    setForm({ name: '', regionsText: '', selectedUserIds: [] });
    setShowModal(true);
  };

  const openEdit = (t) => {
    setEditing(t);
    setForm({
      name: t.name || '',
      regionsText: Array.isArray(t.regions) ? t.regions.join(', ') : '',
      selectedUserIds: Array.isArray(t.assignedUserIds) ? t.assignedUserIds.map(Number) : [],
    });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) { showToast('Name is required', 'error'); return; }
    const payload = {
      name: form.name.trim(),
      regions: form.regionsText.split(',').map(s => s.trim()).filter(Boolean),
      assignedUserIds: form.selectedUserIds,
    };
    try {
      if (editing) {
        await fetchApi(`/api/territories/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Territory updated');
      } else {
        await fetchApi('/api/territories', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Territory created');
      }
      setShowModal(false);
      loadAll();
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    }
  };

  const remove = async (t) => {
    if (!await notify.confirm(`Delete territory "${t.name}"? Contacts will be unassigned.`)) return;
    try {
      await fetchApi(`/api/territories/${t.id}`, { method: 'DELETE' });
      showToast('Territory deleted');
      loadAll();
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error');
    }
  };

  const view = async (t) => {
    setViewing(t);
    setViewLoading(true);
    setViewContacts([]);
    try {
      const data = await fetchApi(`/api/territories/${t.id}/contacts`);
      setViewContacts(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Load contacts failed', 'error');
    }
    setViewLoading(false);
  };

  const toggleUser = (uid) => {
    setForm(f => {
      const has = f.selectedUserIds.includes(uid);
      return { ...f, selectedUserIds: has ? f.selectedUserIds.filter(x => x !== uid) : [...f.selectedUserIds, uid] };
    });
  };

  const userName = (id) => {
    const u = users.find(x => x.id === Number(id));
    return u ? (u.name || u.email || `User #${id}`) : `User #${id}`;
  };

  // Detail view
  if (viewing) {
    return (
      <div style={{ padding: '2rem', animation: 'fadeIn 0.4s ease-out' }}>
        <button onClick={() => { setViewing(null); setViewContacts([]); }} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <ArrowLeft size={16} /> Back to Territories
        </button>
        <header style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'linear-gradient(135deg, #10b981, #06b6d4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Network size={22} color="white" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.7rem', fontWeight: 'bold', margin: 0 }}>{viewing.name}</h1>
            <p style={{ color: 'var(--text-secondary)', margin: 0, marginTop: 4, fontSize: '0.9rem' }}>
              {viewing.regions?.length || 0} regions · {viewing.assignedUserIds?.length || 0} users
            </p>
          </div>
        </header>

        <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MapPin size={16} color="#10b981" /> Regions
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {(viewing.regions || []).map(r => (
              <span key={r} style={{ background: 'rgba(16,185,129,0.15)', color: '#6ee7b7', padding: '0.25rem 0.6rem', borderRadius: 12, fontSize: '0.8rem', border: '1px solid rgba(16,185,129,0.3)' }}>{r}</span>
            ))}
            {(!viewing.regions || viewing.regions.length === 0) && <span style={{ opacity: 0.5 }}>No regions defined</span>}
          </div>
        </div>

        <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users size={16} color="#6366f1" /> Assigned Users
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {(viewing.assignedUserIds || []).map(uid => (
              <span key={uid} style={{ background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', padding: '0.25rem 0.6rem', borderRadius: 12, fontSize: '0.8rem', border: '1px solid rgba(99,102,241,0.3)' }}>{userName(uid)}</span>
            ))}
            {(!viewing.assignedUserIds || viewing.assignedUserIds.length === 0) && <span style={{ opacity: 0.5 }}>No users assigned</span>}
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Contacts in this Territory ({viewContacts.length})</h3>
          </div>
          {viewLoading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>
          ) : viewContacts.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No contacts assigned to this territory yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', textAlign: 'left' }}>
                  <th style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Name</th>
                  <th style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Email</th>
                  <th style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Company</th>
                  <th style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Status</th>
                  <th style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Owner</th>
                </tr>
              </thead>
              <tbody>
                {viewContacts.map(c => (
                  <tr key={c.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>{c.name}</td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{c.email}</td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem' }}>{c.company || '—'}</td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.8rem' }}>{c.status}</td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem' }}>{c.assignedToId ? userName(c.assignedToId) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {toast && (
          <div style={{
            position: 'fixed', top: 90, right: 24, zIndex: 300,
            padding: '0.85rem 1.2rem', borderRadius: 10,
            background: toast.type === 'error' ? 'rgba(239,68,68,0.9)' : 'rgba(16,185,129,0.9)',
            color: 'white', fontWeight: 600,
          }}>{toast.msg}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'linear-gradient(135deg, #10b981, #06b6d4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 8px 20px rgba(16,185,129,0.3)',
          }}>
            <Network size={22} color="white" />
          </div>
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 'bold', margin: 0 }}>Territories</h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem', margin: 0 }}>
              Define geographic territories and assign sales teams. Used by routing rules with assignType "territory".
            </p>
          </div>
        </div>
        <button onClick={openNew} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={16} /> Add Territory
        </button>
      </header>

      {toast && (
        <div style={{
          position: 'fixed', top: 90, right: 24, zIndex: 300,
          padding: '0.85rem 1.2rem', borderRadius: 10,
          background: toast.type === 'error' ? 'rgba(239,68,68,0.9)' : 'rgba(16,185,129,0.9)',
          color: 'white', fontWeight: 600,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>{toast.msg}</div>
      )}

      {loading ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading territories...</div>
      ) : territories.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <Network size={36} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
          <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>No territories yet. Create one to start grouping leads geographically.</p>
          <button onClick={openNew} className="btn-primary"><Plus size={16} /> Create First Territory</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
          {territories.map(t => (
            <div key={t.id} className="card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, lineHeight: 1.3 }}>{t.name}</h3>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <button onClick={() => openEdit(t)} title="Edit" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><Edit2 size={15} /></button>
                  <button onClick={() => remove(t)} title="Delete" style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={15} /></button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 80, background: 'rgba(16,185,129,0.1)', borderRadius: 8, padding: '0.6rem', border: '1px solid rgba(16,185,129,0.2)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Regions</div>
                  <div style={{ fontWeight: 700, fontSize: '1.3rem', color: '#6ee7b7' }}>{t.regions?.length || 0}</div>
                </div>
                <div style={{ flex: 1, minWidth: 80, background: 'rgba(99,102,241,0.1)', borderRadius: 8, padding: '0.6rem', border: '1px solid rgba(99,102,241,0.2)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Users</div>
                  <div style={{ fontWeight: 700, fontSize: '1.3rem', color: '#a5b4fc' }}>{t.assignedUserIds?.length || 0}</div>
                </div>
                <div style={{ flex: 1, minWidth: 80, background: 'rgba(236,72,153,0.1)', borderRadius: 8, padding: '0.6rem', border: '1px solid rgba(236,72,153,0.2)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Contacts</div>
                  <div style={{ fontWeight: 700, fontSize: '1.3rem', color: '#f9a8d4' }}>{t.contactCount || 0}</div>
                </div>
              </div>

              {t.regions?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {t.regions.slice(0, 4).map(r => (
                    <span key={r} style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.05)', padding: '0.15rem 0.5rem', borderRadius: 8, color: 'var(--text-secondary)' }}>{r}</span>
                  ))}
                  {t.regions.length > 4 && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>+{t.regions.length - 4} more</span>}
                </div>
              )}

              <button onClick={() => view(t)} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                <Eye size={14} /> View Details
              </button>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
          <div className="card" style={{ padding: '1.75rem', width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ fontWeight: 'bold', fontSize: '1.2rem', margin: 0 }}>{editing ? 'Edit Territory' : 'New Territory'}</h3>
              <button onClick={() => setShowModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={22} /></button>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</label>
              <input className="input-field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. North America West" style={{ width: '100%', marginTop: 4 }} />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Regions (comma-separated)</label>
              <input className="input-field" value={form.regionsText} onChange={e => setForm({ ...form, regionsText: e.target.value })} placeholder="US-CA, US-NY, US-WA" style={{ width: '100%', marginTop: 4 }} />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                Matched against contact city/state/country (case-insensitive substring).
              </div>
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Assigned Users</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', maxHeight: 180, overflowY: 'auto', padding: '0.4rem', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8 }}>
                {users.length === 0 && <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '0.4rem' }}>No users available</span>}
                {users.map(u => {
                  const selected = form.selectedUserIds.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => toggleUser(u.id)}
                      style={{
                        background: selected ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.03)',
                        color: selected ? '#a5b4fc' : 'var(--text-primary)',
                        border: `1px solid ${selected ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.08)'}`,
                        padding: '0.35rem 0.7rem',
                        borderRadius: 16,
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        fontWeight: selected ? 600 : 400,
                      }}
                    >
                      {u.name || u.email}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={save} className="btn-primary">{editing ? 'Save Changes' : 'Create Territory'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
