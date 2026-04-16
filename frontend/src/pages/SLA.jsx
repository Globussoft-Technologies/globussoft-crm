import React, { useState, useEffect } from 'react';
import { Target, Clock, AlertTriangle, MessageSquare, Plus, Edit, Trash2, X, RefreshCw, Play } from 'lucide-react';
import { fetchApi } from '../utils/api';

const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const PRIORITY_COLORS = {
  Low: '#10b981',
  Medium: '#3b82f6',
  High: '#f59e0b',
  Urgent: '#ef4444',
};

const emptyPolicy = { name: '', priority: 'Medium', responseMinutes: 60, resolveMinutes: 1440, isActive: true };
const emptyCanned = { name: '', content: '', category: 'General' };

const formatMinutes = (m) => {
  if (m === null || m === undefined || isNaN(m)) return '—';
  const abs = Math.abs(m);
  if (abs < 60) return `${abs}m`;
  if (abs < 1440) return `${Math.floor(abs / 60)}h ${abs % 60}m`;
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  return `${days}d ${hours}h`;
};

const SLA = () => {
  const [tab, setTab] = useState('policies');
  const [stats, setStats] = useState({ activePolicies: 0, breachesToday: 0, avgResponseMinutes: 0, avgResolveMinutes: 0 });

  // policies
  const [policies, setPolicies] = useState([]);
  const [policyModal, setPolicyModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState(null);
  const [policyForm, setPolicyForm] = useState(emptyPolicy);

  // breaches
  const [breaches, setBreaches] = useState([]);
  const [now, setNow] = useState(new Date());

  // canned
  const [canned, setCanned] = useState([]);
  const [cannedModal, setCannedModal] = useState(false);
  const [editingCanned, setEditingCanned] = useState(null);
  const [cannedForm, setCannedForm] = useState(emptyCanned);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadStats = () => {
    fetchApi('/api/sla/stats')
      .then((d) => setStats(d || stats))
      .catch(() => {});
  };
  const loadPolicies = () => {
    setLoading(true);
    fetchApi('/api/sla/policies')
      .then((d) => setPolicies(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message || 'Failed to load policies'))
      .finally(() => setLoading(false));
  };
  const loadBreaches = () => {
    setLoading(true);
    fetchApi('/api/sla/breaches')
      .then((d) => setBreaches(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message || 'Failed to load breaches'))
      .finally(() => setLoading(false));
  };
  const loadCanned = () => {
    setLoading(true);
    fetchApi('/api/canned-responses')
      .then((d) => setCanned(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message || 'Failed to load canned responses'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadStats();
    loadPolicies();
    loadBreaches();
    loadCanned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick every 30s for breach countdown freshness
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  // ─── Policies handlers ─────────────────────────────────────────────────
  const openCreatePolicy = () => {
    setEditingPolicy(null);
    setPolicyForm(emptyPolicy);
    setError('');
    setPolicyModal(true);
  };
  const openEditPolicy = (p) => {
    setEditingPolicy(p);
    setPolicyForm({
      name: p.name || '',
      priority: p.priority || 'Medium',
      responseMinutes: p.responseMinutes || 60,
      resolveMinutes: p.resolveMinutes || 1440,
      isActive: !!p.isActive,
    });
    setError('');
    setPolicyModal(true);
  };
  const savePolicy = async () => {
    if (!policyForm.name.trim()) { setError('Policy name is required'); return; }
    try {
      const body = {
        ...policyForm,
        responseMinutes: parseInt(policyForm.responseMinutes) || 60,
        resolveMinutes: parseInt(policyForm.resolveMinutes) || 1440,
      };
      if (editingPolicy) {
        await fetchApi(`/api/sla/policies/${editingPolicy.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await fetchApi('/api/sla/policies', { method: 'POST', body: JSON.stringify(body) });
      }
      setPolicyModal(false);
      loadPolicies();
      loadStats();
    } catch (e) { setError(e.message || 'Save failed'); }
  };
  const togglePolicyActive = async (p) => {
    try {
      await fetchApi(`/api/sla/policies/${p.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !p.isActive }) });
      loadPolicies();
      loadStats();
    } catch (e) { alert(e.message || 'Toggle failed'); }
  };
  const deletePolicy = async (p) => {
    if (!window.confirm(`Delete policy "${p.name}"?`)) return;
    try {
      await fetchApi(`/api/sla/policies/${p.id}`, { method: 'DELETE' });
      loadPolicies();
      loadStats();
    } catch (e) { alert(e.message || 'Delete failed'); }
  };
  const applyAll = async () => {
    try {
      const r = await fetchApi('/api/sla/apply-all', { method: 'POST' });
      alert(`Applied to ${r.applied || 0} ticket(s). Skipped ${r.skipped || 0}.`);
      loadBreaches();
      loadStats();
    } catch (e) { alert(e.message || 'Apply-all failed'); }
  };

  // ─── Canned handlers ───────────────────────────────────────────────────
  const openCreateCanned = () => {
    setEditingCanned(null);
    setCannedForm(emptyCanned);
    setError('');
    setCannedModal(true);
  };
  const openEditCanned = (c) => {
    setEditingCanned(c);
    setCannedForm({ name: c.name || '', content: c.content || '', category: c.category || 'General' });
    setError('');
    setCannedModal(true);
  };
  const saveCanned = async () => {
    if (!cannedForm.name.trim() || !cannedForm.content.trim()) {
      setError('Name and content are required');
      return;
    }
    try {
      if (editingCanned) {
        await fetchApi(`/api/canned-responses/${editingCanned.id}`, { method: 'PUT', body: JSON.stringify(cannedForm) });
      } else {
        await fetchApi('/api/canned-responses', { method: 'POST', body: JSON.stringify(cannedForm) });
      }
      setCannedModal(false);
      loadCanned();
    } catch (e) { setError(e.message || 'Save failed'); }
  };
  const deleteCanned = async (c) => {
    if (!window.confirm(`Delete "${c.name}"?`)) return;
    try {
      await fetchApi(`/api/canned-responses/${c.id}`, { method: 'DELETE' });
      loadCanned();
    } catch (e) { alert(e.message || 'Delete failed'); }
  };

  // ─── Render helpers ────────────────────────────────────────────────────
  const StatCard = ({ icon: Icon, label, value, color }) => (
    <div className="card" style={{ padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem', flex: 1, minWidth: 0 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: `${color}1a`, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={22} style={{ color }} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
        <div style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      </div>
    </div>
  );

  const PriorityBadge = ({ priority }) => {
    const c = PRIORITY_COLORS[priority] || '#94a3b8';
    return (
      <span style={{
        padding: '0.2rem 0.55rem', borderRadius: 999,
        background: `${c}1f`, color: c, border: `1px solid ${c}55`,
        fontSize: '0.72rem', fontWeight: 600,
      }}>{priority}</span>
    );
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Target size={26} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', margin: 0 }}>SLA Policies & Breaches</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
              Define service-level targets and monitor ticket breaches in real time.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => { loadStats(); loadPolicies(); loadBreaches(); loadCanned(); }} style={ghostBtn}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={applyAll} style={ghostBtn} title="Apply active SLA policies to all unscored tickets">
            <Play size={14} /> Apply to Tickets
          </button>
        </div>
      </header>

      {/* Stats */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <StatCard icon={Target} label="Active Policies" value={stats.activePolicies} color="#3b82f6" />
        <StatCard icon={AlertTriangle} label="Breaches Today" value={stats.breachesToday} color="#ef4444" />
        <StatCard icon={Clock} label="Avg Response" value={formatMinutes(stats.avgResponseMinutes)} color="#10b981" />
        <StatCard icon={Clock} label="Avg Resolve" value={formatMinutes(stats.avgResolveMinutes)} color="#a855f7" />
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: '0.25rem', marginBottom: '1.25rem',
        borderBottom: '1px solid var(--border-color)', paddingBottom: '0.25rem',
      }}>
        {[
          { id: 'policies', label: 'Policies', icon: Target, count: policies.length },
          { id: 'breaches', label: 'Breaches', icon: AlertTriangle, count: breaches.length },
          { id: 'canned', label: 'Canned Responses', icon: MessageSquare, count: canned.length },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '0.6rem 1rem', border: 'none', cursor: 'pointer',
              background: tab === t.id ? 'var(--subtle-bg)' : 'transparent',
              color: tab === t.id ? 'var(--accent-color)' : 'var(--text-secondary)',
              fontWeight: tab === t.id ? 600 : 500,
              borderBottom: tab === t.id ? '2px solid var(--accent-color)' : '2px solid transparent',
              borderRadius: '6px 6px 0 0', fontSize: '0.875rem',
              display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
            }}
          >
            <t.icon size={15} /> {t.label}
            <span style={{
              padding: '0.05rem 0.45rem', borderRadius: 999,
              background: 'var(--subtle-bg)', color: 'var(--text-secondary)',
              fontSize: '0.7rem',
            }}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* Body */}
      {loading && <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading...</div>}

      {/* ── POLICIES TAB ── */}
      {tab === 'policies' && (
        <div className="card" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>SLA Policies</h3>
            <button className="btn-primary" onClick={openCreatePolicy} style={primaryBtn}>
              <Plus size={14} /> New Policy
            </button>
          </div>
          {policies.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
              <Target size={36} style={{ opacity: 0.3, marginBottom: '0.5rem' }} />
              <div>No SLA policies yet. Create one to start tracking.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Priority</th>
                    <th style={thStyle}>Response Target</th>
                    <th style={thStyle}>Resolve Target</th>
                    <th style={thStyle}>Active</th>
                    <th style={thStyle}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr key={p.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                      <td style={tdStyle}><strong>{p.name}</strong></td>
                      <td style={tdStyle}><PriorityBadge priority={p.priority} /></td>
                      <td style={tdStyle}>{formatMinutes(p.responseMinutes)} <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({p.responseMinutes}m)</span></td>
                      <td style={tdStyle}>{formatMinutes(p.resolveMinutes)} <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({p.resolveMinutes}m)</span></td>
                      <td style={tdStyle}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={!!p.isActive}
                            onChange={() => togglePolicyActive(p)}
                          />
                          <span style={{
                            color: p.isActive ? '#10b981' : 'var(--text-secondary)',
                            fontSize: '0.8rem', fontWeight: 500,
                          }}>{p.isActive ? 'Active' : 'Inactive'}</span>
                        </label>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button onClick={() => openEditPolicy(p)} style={iconBtn}><Edit size={13} /></button>
                          <button onClick={() => deletePolicy(p)} style={{ ...iconBtn, color: '#ef4444' }}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── BREACHES TAB ── */}
      {tab === 'breaches' && (
        <div className="card" style={{ padding: '1.25rem' }}>
          <h3 style={{ margin: '0 0 1rem 0', fontSize: '1.05rem', fontWeight: 600 }}>Tickets In Breach</h3>
          {breaches.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
              <AlertTriangle size={36} style={{ opacity: 0.3, marginBottom: '0.5rem' }} />
              <div>No tickets currently in breach. Great work!</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {breaches.map((t) => {
                const respMin = t.responseOverdueMinutes || 0;
                const resoMin = t.resolveOverdueMinutes || 0;
                const worstMin = Math.max(respMin, resoMin);
                // Color: > 4h red, otherwise amber
                const sev = worstMin > 240 ? '#ef4444' : '#f59e0b';
                return (
                  <div
                    key={t.id}
                    style={{
                      padding: '0.875rem 1rem',
                      borderRadius: 8,
                      border: `1px solid ${sev}55`,
                      background: `${sev}10`,
                      display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
                    }}
                  >
                    <AlertTriangle size={20} style={{ color: sev, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                        #{t.id} — {t.subject}
                      </div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        Status: {t.status} · Assignee: {t.assignee?.name || 'Unassigned'}
                      </div>
                    </div>
                    <PriorityBadge priority={t.priority} />
                    {t.responseBreach && (
                      <span style={{
                        padding: '0.3rem 0.6rem', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600,
                        background: `${sev}20`, color: sev, border: `1px solid ${sev}66`,
                      }}>
                        Response {formatMinutes(respMin)} overdue
                      </span>
                    )}
                    {t.resolveBreach && (
                      <span style={{
                        padding: '0.3rem 0.6rem', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600,
                        background: `${sev}20`, color: sev, border: `1px solid ${sev}66`,
                      }}>
                        Resolve {formatMinutes(resoMin)} overdue
                      </span>
                    )}
                  </div>
                );
              })}
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                Last refreshed: {now.toLocaleTimeString()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CANNED RESPONSES TAB ── */}
      {tab === 'canned' && (
        <div className="card" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>Canned Responses</h3>
            <button className="btn-primary" onClick={openCreateCanned} style={primaryBtn}>
              <Plus size={14} /> New
            </button>
          </div>
          {canned.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
              <MessageSquare size={36} style={{ opacity: 0.3, marginBottom: '0.5rem' }} />
              <div>No canned responses yet. Create reusable reply templates.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.875rem' }}>
              {canned.map((c) => (
                <div key={c.id} style={{
                  padding: '0.875rem 1rem',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  background: 'var(--subtle-bg)',
                  display: 'flex', flexDirection: 'column', gap: '0.5rem',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <MessageSquare size={15} style={{ color: 'var(--accent-color)' }} />
                    <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</strong>
                    <span style={{
                      fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: 999,
                      background: 'var(--bg-primary)', color: 'var(--text-secondary)',
                      border: '1px solid var(--border-color)',
                    }}>{c.category}</span>
                  </div>
                  <div style={{
                    fontSize: '0.8rem', color: 'var(--text-secondary)',
                    maxHeight: 70, overflow: 'hidden', textOverflow: 'ellipsis',
                    lineHeight: 1.4, whiteSpace: 'pre-wrap',
                  }}>
                    {c.content}
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.5rem' }}>
                    <button onClick={() => openEditCanned(c)} style={iconBtn}><Edit size={13} /> Edit</button>
                    <button onClick={() => deleteCanned(c)} style={{ ...iconBtn, color: '#ef4444' }}><Trash2 size={13} /> Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── POLICY MODAL ── */}
      {policyModal && (
        <Modal onClose={() => setPolicyModal(false)} title={editingPolicy ? 'Edit SLA Policy' : 'New SLA Policy'} icon={Target}>
          <div>
            <label style={labelStyle}>Policy Name *</label>
            <input className="input-field" style={inputStyle} value={policyForm.name}
              onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })} autoFocus />
          </div>
          <div>
            <label style={labelStyle}>Priority *</label>
            <select className="input-field" style={inputStyle} value={policyForm.priority}
              onChange={(e) => setPolicyForm({ ...policyForm, priority: e.target.value })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Response Target (minutes)</label>
              <input className="input-field" style={inputStyle} type="number" min={1}
                value={policyForm.responseMinutes}
                onChange={(e) => setPolicyForm({ ...policyForm, responseMinutes: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Resolve Target (minutes)</label>
              <input className="input-field" style={inputStyle} type="number" min={1}
                value={policyForm.resolveMinutes}
                onChange={(e) => setPolicyForm({ ...policyForm, resolveMinutes: e.target.value })} />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem' }}>
            <input type="checkbox" checked={!!policyForm.isActive}
              onChange={(e) => setPolicyForm({ ...policyForm, isActive: e.target.checked })} />
            <span>Active</span>
          </label>
          {error && <ErrorBox msg={error} />}
          <ModalActions onCancel={() => setPolicyModal(false)} onSave={savePolicy}
            saveLabel={editingPolicy ? 'Save Changes' : 'Create Policy'} />
        </Modal>
      )}

      {/* ── CANNED MODAL ── */}
      {cannedModal && (
        <Modal onClose={() => setCannedModal(false)} title={editingCanned ? 'Edit Canned Response' : 'New Canned Response'} icon={MessageSquare}>
          <div>
            <label style={labelStyle}>Name *</label>
            <input className="input-field" style={inputStyle} value={cannedForm.name}
              onChange={(e) => setCannedForm({ ...cannedForm, name: e.target.value })} autoFocus />
          </div>
          <div>
            <label style={labelStyle}>Category</label>
            <input className="input-field" style={inputStyle} value={cannedForm.category}
              placeholder="General"
              onChange={(e) => setCannedForm({ ...cannedForm, category: e.target.value })} />
          </div>
          <div>
            <label style={labelStyle}>Content *</label>
            <textarea className="input-field" style={{ ...inputStyle, minHeight: 140, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Hi {{contact.name}}, thank you for reaching out…"
              value={cannedForm.content}
              onChange={(e) => setCannedForm({ ...cannedForm, content: e.target.value })} />
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
              Merge tags: <code>{'{{contact.name}}'}</code>, <code>{'{{ticket.id}}'}</code>, <code>{'{{user.name}}'}</code>
            </div>
          </div>
          {error && <ErrorBox msg={error} />}
          <ModalActions onCancel={() => setCannedModal(false)} onSave={saveCanned}
            saveLabel={editingCanned ? 'Save Changes' : 'Create'} />
        </Modal>
      )}
    </div>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────────

const Modal = ({ onClose, title, icon: Icon, children }) => (
  <div onClick={onClose} style={{
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, backdropFilter: 'blur(4px)',
  }}>
    <div onClick={(e) => e.stopPropagation()} className="card"
      style={{ width: '90%', maxWidth: 520, padding: '1.75rem', maxHeight: '90vh', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {Icon && <Icon size={20} style={{ color: 'var(--accent-color)' }} />}
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>{title}</h3>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <X size={18} />
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        {children}
      </div>
    </div>
  </div>
);

const ModalActions = ({ onCancel, onSave, saveLabel }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
    <button onClick={onCancel} style={{
      padding: '0.5rem 1rem', borderRadius: 6,
      border: '1px solid var(--border-color)', background: 'transparent',
      color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.875rem',
    }}>Cancel</button>
    <button className="btn-primary" onClick={onSave} style={{ padding: '0.5rem 1.25rem', fontSize: '0.875rem' }}>
      {saveLabel}
    </button>
  </div>
);

const ErrorBox = ({ msg }) => (
  <div style={{
    padding: '0.55rem 0.75rem', borderRadius: 6,
    background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444',
    fontSize: '0.82rem', border: '1px solid rgba(239, 68, 68, 0.3)',
  }}>{msg}</div>
);

// ─── Styles ────────────────────────────────────────────────────────────────

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' };
const thStyle = {
  textAlign: 'left', padding: '0.6rem 0.5rem',
  color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem',
  textTransform: 'uppercase', letterSpacing: 0.5,
  borderBottom: '1px solid var(--border-color)',
};
const tdStyle = { padding: '0.7rem 0.5rem', verticalAlign: 'middle', color: 'var(--text-primary)' };
const labelStyle = {
  display: 'block', fontSize: '0.78rem', fontWeight: 500,
  marginBottom: '0.3rem', color: 'var(--text-secondary)',
};
const inputStyle = { width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.875rem' };
const iconBtn = {
  padding: '0.35rem 0.55rem', borderRadius: 6,
  border: '1px solid var(--border-color)', background: 'transparent',
  color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.78rem',
  display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
};
const ghostBtn = {
  ...iconBtn,
  padding: '0.45rem 0.75rem', fontSize: '0.82rem',
};
const primaryBtn = {
  padding: '0.45rem 0.9rem', fontSize: '0.82rem',
  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
};

export default SLA;
