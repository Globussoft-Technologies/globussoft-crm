import React, { useEffect, useState } from 'react';
import { Send, Plus, Trash2, Edit2, Play, X, ToggleLeft, ToggleRight, Filter } from 'lucide-react';
import { fetchApi } from '../utils/api';

const ASSIGN_TYPES = [
  { value: 'round_robin', label: 'Round Robin (all users)' },
  { value: 'specific_user', label: 'Specific User' },
  { value: 'territory', label: 'By Territory' },
];

const FIELD_OPTIONS = [
  'source', 'status', 'country', 'city', 'state', 'industry',
  'companySize', 'company', 'firstTouchSource', 'lastTouchSource',
];

const OP_OPTIONS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'in (csv)' },
];

const emptyRow = () => ({ field: 'source', op: 'eq', value: '' });

function buildConditionsObject(rows) {
  const out = {};
  rows.forEach(r => {
    if (!r.field || r.value === '') return;
    if (r.op === 'in') {
      out[r.field] = { op: 'in', value: String(r.value).split(',').map(s => s.trim()).filter(Boolean) };
    } else if (r.op === 'eq') {
      out[r.field] = r.value;
    } else {
      out[r.field] = { op: r.op, value: r.value };
    }
  });
  return out;
}

function rowsFromConditions(conds) {
  const rows = [];
  if (!conds || typeof conds !== 'object') return [emptyRow()];
  Object.keys(conds).forEach(field => {
    const v = conds[field];
    if (v && typeof v === 'object' && v.op) {
      rows.push({ field, op: v.op, value: Array.isArray(v.value) ? v.value.join(',') : String(v.value ?? '') });
    } else if (Array.isArray(v)) {
      rows.push({ field, op: 'in', value: v.join(',') });
    } else {
      rows.push({ field, op: 'eq', value: String(v ?? '') });
    }
  });
  return rows.length ? rows : [emptyRow()];
}

function formatConditions(conds) {
  if (!conds || Object.keys(conds).length === 0) return <span style={{ opacity: 0.5 }}>(any)</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
      {Object.keys(conds).map(field => {
        const v = conds[field];
        let label;
        if (v && typeof v === 'object' && v.op) {
          label = `${field} ${v.op} ${Array.isArray(v.value) ? v.value.join('|') : v.value}`;
        } else if (Array.isArray(v)) {
          label = `${field} in ${v.join('|')}`;
        } else {
          label = `${field} = ${v}`;
        }
        return (
          <span key={field} style={{
            background: 'rgba(99,102,241,0.15)',
            color: '#a5b4fc',
            padding: '0.2rem 0.55rem',
            borderRadius: '12px',
            fontSize: '0.72rem',
            border: '1px solid rgba(99,102,241,0.3)',
          }}>{label}</span>
        );
      })}
    </div>
  );
}

export default function LeadRouting() {
  const [rules, setRules] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState(null);
  const [applying, setApplying] = useState(false);

  const [form, setForm] = useState({
    name: '',
    assignType: 'round_robin',
    assignTo: '',
    priority: 100,
    isActive: true,
    rows: [emptyRow()],
  });

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [r, u] = await Promise.all([
        fetchApi('/api/lead-routing').catch(() => []),
        fetchApi('/api/staff').catch(() => []),
      ]);
      setRules(Array.isArray(r) ? r : []);
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
    setForm({
      name: '',
      assignType: 'round_robin',
      assignTo: '',
      priority: 100,
      isActive: true,
      rows: [emptyRow()],
    });
    setShowModal(true);
  };

  const openEdit = (rule) => {
    setEditing(rule);
    setForm({
      name: rule.name || '',
      assignType: rule.assignType || 'round_robin',
      assignTo: rule.assignTo ? String(rule.assignTo) : '',
      priority: rule.priority ?? 100,
      isActive: !!rule.isActive,
      rows: rowsFromConditions(rule.conditions),
    });
    setShowModal(true);
  };

  const saveRule = async () => {
    if (!form.name.trim()) { showToast('Name is required', 'error'); return; }
    const payload = {
      name: form.name.trim(),
      conditions: buildConditionsObject(form.rows),
      assignType: form.assignType,
      assignTo: form.assignType === 'specific_user' && form.assignTo ? Number(form.assignTo) : null,
      priority: Number(form.priority) || 100,
      isActive: form.isActive,
    };
    try {
      if (editing) {
        await fetchApi(`/api/lead-routing/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Rule updated');
      } else {
        await fetchApi('/api/lead-routing', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Rule created');
      }
      setShowModal(false);
      loadAll();
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    }
  };

  const deleteRule = async (rule) => {
    if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await fetchApi(`/api/lead-routing/${rule.id}`, { method: 'DELETE' });
      showToast('Rule deleted');
      loadAll();
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error');
    }
  };

  const toggleActive = async (rule) => {
    try {
      await fetchApi(`/api/lead-routing/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      loadAll();
    } catch (e) {
      showToast(e.message || 'Toggle failed', 'error');
    }
  };

  const applyAll = async () => {
    setApplying(true);
    try {
      const result = await fetchApi('/api/lead-routing/apply-all', { method: 'POST' });
      showToast(`Processed ${result.processed} contacts, assigned ${result.assigned}`);
    } catch (e) {
      showToast(e.message || 'Apply failed', 'error');
    }
    setApplying(false);
  };

  const updateRow = (idx, key, val) => {
    setForm(f => {
      const rows = [...f.rows];
      rows[idx] = { ...rows[idx], [key]: val };
      return { ...f, rows };
    });
  };

  const addRow = () => setForm(f => ({ ...f, rows: [...f.rows, emptyRow()] }));
  const removeRow = (idx) => setForm(f => ({ ...f, rows: f.rows.filter((_, i) => i !== idx).length ? f.rows.filter((_, i) => i !== idx) : [emptyRow()] }));

  const userName = (id) => {
    if (!id) return '—';
    const u = users.find(x => x.id === Number(id));
    return u ? (u.name || u.email || `User #${id}`) : `User #${id}`;
  };

  const assignLabel = (rule) => {
    if (rule.assignType === 'specific_user') return `User: ${userName(rule.assignTo)}`;
    if (rule.assignType === 'territory') return 'By Territory';
    return 'Round Robin';
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'linear-gradient(135deg, #6366f1, #ec4899)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 8px 20px rgba(99,102,241,0.3)',
          }}>
            <Send size={22} color="white" />
          </div>
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 'bold', margin: 0 }}>Lead Routing Rules</h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem', margin: 0 }}>
              Auto-assign incoming leads using priority-ordered rules with round-robin, specific user, or territory routing.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button onClick={applyAll} disabled={applying} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Play size={16} /> {applying ? 'Applying...' : 'Apply All'}
          </button>
          <button onClick={openNew} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={16} /> Add Rule
          </button>
        </div>
      </header>

      {toast && (
        <div style={{
          position: 'fixed', top: 90, right: 24, zIndex: 300,
          padding: '0.85rem 1.2rem', borderRadius: 10,
          background: toast.type === 'error' ? 'rgba(239,68,68,0.9)' : 'rgba(16,185,129,0.9)',
          color: 'white', fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          backdropFilter: 'blur(8px)',
        }}>{toast.msg}</div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading rules...</div>
        ) : rules.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <Filter size={36} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
            <p style={{ marginBottom: '1rem' }}>No routing rules yet. Create your first rule to auto-assign leads.</p>
            <button onClick={openNew} className="btn-primary"><Plus size={16} /> Create First Rule</button>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)', textAlign: 'left' }}>
                <th style={{ padding: '0.85rem 1rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Priority</th>
                <th style={{ padding: '0.85rem 1rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</th>
                <th style={{ padding: '0.85rem 1rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Conditions</th>
                <th style={{ padding: '0.85rem 1rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Assign To</th>
                <th style={{ padding: '0.85rem 1rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active</th>
                <th style={{ padding: '0.85rem 1rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <span style={{
                      display: 'inline-block', minWidth: 36, textAlign: 'center',
                      padding: '0.2rem 0.5rem', borderRadius: 8,
                      background: 'rgba(99,102,241,0.15)', color: '#a5b4fc',
                      fontWeight: 700, fontSize: '0.85rem',
                    }}>{rule.priority}</span>
                  </td>
                  <td style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>{rule.name}</td>
                  <td style={{ padding: '0.85rem 1rem' }}>{formatConditions(rule.conditions)}</td>
                  <td style={{ padding: '0.85rem 1rem', fontSize: '0.85rem' }}>{assignLabel(rule)}</td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <button onClick={() => toggleActive(rule)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: rule.isActive ? '#10b981' : 'var(--text-secondary)' }}>
                      {rule.isActive ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                    </button>
                  </td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button onClick={() => openEdit(rule)} className="btn-secondary" style={{ padding: '0.4rem 0.6rem' }} title="Edit"><Edit2 size={14} /></button>
                      <button onClick={() => deleteRule(rule)} className="btn-secondary" style={{ padding: '0.4rem 0.6rem', color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }} title="Delete"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
          <div className="card" style={{ padding: '1.75rem', width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ fontWeight: 'bold', fontSize: '1.2rem', margin: 0 }}>{editing ? 'Edit Rule' : 'New Routing Rule'}</h3>
              <button onClick={() => setShowModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={22} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '0.85rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Rule Name</label>
                <input className="input-field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. India Web Leads → Sales Team" style={{ width: '100%', marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Priority</label>
                <input type="number" className="input-field" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} style={{ width: '100%', marginTop: 4 }} />
              </div>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Conditions (all must match)</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {form.rows.map((row, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 1.4fr 36px', gap: '0.4rem' }}>
                    <select className="input-field" value={row.field} onChange={e => updateRow(idx, 'field', e.target.value)}>
                      {FIELD_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <select className="input-field" value={row.op} onChange={e => updateRow(idx, 'op', e.target.value)}>
                      {OP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <input className="input-field" value={row.value} onChange={e => updateRow(idx, 'value', e.target.value)} placeholder={row.op === 'in' ? 'Website,Referral,Ad' : 'value'} />
                    <button onClick={() => removeRow(idx)} className="btn-secondary" style={{ padding: '0.4rem' }} title="Remove"><Trash2 size={14} /></button>
                  </div>
                ))}
                <button onClick={addRow} className="btn-secondary" style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                  <Plus size={14} /> Add Condition
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Assign Type</label>
                <select className="input-field" value={form.assignType} onChange={e => setForm({ ...form, assignType: e.target.value })} style={{ width: '100%', marginTop: 4 }}>
                  {ASSIGN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {form.assignType === 'specific_user' && (
                <div>
                  <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>User</label>
                  <select className="input-field" value={form.assignTo} onChange={e => setForm({ ...form, assignTo: e.target.value })} style={{ width: '100%', marginTop: 4 }}>
                    <option value="">— select —</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                  </select>
                </div>
              )}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />
              <span>Active</span>
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={saveRule} className="btn-primary">{editing ? 'Save Changes' : 'Create Rule'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
