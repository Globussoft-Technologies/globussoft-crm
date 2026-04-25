import React, { useState, useEffect, useMemo } from 'react';
import { FolderKanban, Plus, Trash2, DollarSign, CheckCircle2 } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const STATUS_CONFIG = {
  Planning:   { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' },
  Active:     { color: '#10b981', bg: 'rgba(16,185,129,0.15)' },
  'On Hold':  { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  Completed:  { color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
  Cancelled:  { color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
};

const PRIORITY_CONFIG = {
  Low:      { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' },
  Medium:   { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  High:     { color: '#f97316', bg: 'rgba(249,115,22,0.15)' },
  Critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
};

const PROJECT_STATUSES = ['Planning', 'Active', 'On Hold', 'Completed', 'Cancelled'];

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.Planning;
  return (
    <span style={{
      padding: '0.2rem 0.7rem', borderRadius: '999px', fontSize: '0.75rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {status}
    </span>
  );
}

function PriorityBadge({ priority }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.Medium;
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {priority}
    </span>
  );
}

function formatCurrency(value) {
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const INITIAL_FORM = {
  name: '',
  description: '',
  priority: 'Medium',
  startDate: '',
  endDate: '',
  budget: '',
  contactId: '',
  dealId: '',
};

export default function Projects() {
  const notify = useNotify();
  const [projects, setProjects] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [form, setForm] = useState(INITIAL_FORM);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [proj, c, d] = await Promise.all([
        fetchApi('/api/projects'),
        fetchApi('/api/contacts'),
        fetchApi('/api/deals'),
      ]);
      setProjects(Array.isArray(proj) ? proj : []);
      setContacts(Array.isArray(c) ? c : []);
      setDeals(Array.isArray(d) ? d : []);
    } catch {
      // handled by fetchApi
    }
  };

  const stats = useMemo(() => {
    const activeCount = projects.filter(p => p.status === 'Active').length;
    const completedCount = projects.filter(p => p.status === 'Completed').length;
    const totalBudget = projects.reduce((sum, p) => sum + Number(p.budget), 0);
    return { activeCount, completedCount, totalBudget };
  }, [projects]);

  const handleFormChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const createProject = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          priority: form.priority,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          budget: form.budget || undefined,
          contactId: form.contactId || undefined,
          dealId: form.dealId || undefined,
        }),
      });
      setForm(INITIAL_FORM);
      loadData();
    } catch {
      notify.error('Failed to create project');
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await fetchApi(`/api/projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      loadData();
    } catch {
      notify.error('Failed to update project status');
    }
  };

  const deleteProject = async (id) => {
    if (!await notify.confirm('Delete this project? This cannot be undone.')) return;
    try {
      await fetchApi(`/api/projects/${id}`, { method: 'DELETE' });
      loadData();
    } catch {
      notify.error('Failed to delete project');
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <FolderKanban size={26} color="var(--accent-color)" /> Projects
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Plan, track, and manage projects across your organization.
        </p>
      </header>

      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          {stats.activeCount} Active
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(59,130,246,0.1)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <CheckCircle2 size={14} /> {stats.completedCount} Completed
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <DollarSign size={14} /> Total Budget: ${formatCurrency(stats.totalBudget)}
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem',
          background: 'var(--subtle-bg-4)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
        }}>
          {projects.length} total projects
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

        {/* Create Project Panel */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Create Project
          </h3>
          <form onSubmit={createProject} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Name</label>
              <input
                type="text"
                className="input-field"
                required
                placeholder="Project name"
                value={form.name}
                onChange={e => handleFormChange('name', e.target.value)}
                aria-label="Project name"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Description</label>
              <textarea
                className="input-field"
                rows={3}
                placeholder="Project description..."
                value={form.description}
                onChange={e => handleFormChange('description', e.target.value)}
                style={{ resize: 'vertical' }}
                aria-label="Project description"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Priority</label>
              <select
                className="input-field"
                value={form.priority}
                onChange={e => handleFormChange('priority', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
                aria-label="Project priority"
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Critical">Critical</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Start Date</label>
                <input
                  type="date"
                  className="input-field"
                  value={form.startDate}
                  onChange={e => handleFormChange('startDate', e.target.value)}
                  aria-label="Start date"
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>End Date</label>
                <input
                  type="date"
                  className="input-field"
                  value={form.endDate}
                  onChange={e => handleFormChange('endDate', e.target.value)}
                  aria-label="End date"
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Budget ($)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                className="input-field"
                placeholder="0.00"
                value={form.budget}
                onChange={e => handleFormChange('budget', e.target.value)}
                aria-label="Project budget"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Contact</label>
              <select
                className="input-field"
                value={form.contactId}
                onChange={e => handleFormChange('contactId', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
                aria-label="Contact"
              >
                <option value="">-- Select Contact --</option>
                {contacts.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.email})</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Deal (Optional)</label>
              <select
                className="input-field"
                value={form.dealId}
                onChange={e => handleFormChange('dealId', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
                aria-label="Associated deal"
              >
                <option value="">-- No Deal --</option>
                {deals.map(d => (
                  <option key={d.id} value={d.id}>{d.title} - ${Number(d.amount).toLocaleString()}</option>
                ))}
              </select>
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem', marginTop: '0.5rem' }}>
              Create Project
            </button>
          </form>
        </div>

        {/* Projects Table */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FolderKanban size={20} color="var(--success-color)" /> Project Board
          </h3>

          {projects.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              <FolderKanban size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>No projects yet. Create one to get started.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }} role="table" aria-label="Projects table">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    {['Name', 'Owner', 'Status', 'Priority', 'Budget', 'Tasks', 'Dates', 'Actions'].map(h => (
                      <th key={h} style={{
                        padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600',
                        fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                        ...(h === 'Actions' ? { textAlign: 'right' } : {}),
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {projects.map(proj => {
                    const completedTasks = (proj.tasks || []).filter(t => t.status === 'Completed').length;
                    const totalTasks = (proj.tasks || []).length;
                    return (
                      <tr
                        key={proj.id}
                        style={{ borderBottom: '1px solid var(--border-color)', transition: 'background 0.15s' }}
                        onMouseOver={e => e.currentTarget.style.background = 'var(--hover-bg)'}
                        onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '1rem 0.5rem', fontWeight: '600' }}>
                          {proj.name}
                        </td>
                        <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                          {proj.owner?.name || proj.owner?.email || '-'}
                        </td>
                        <td style={{ padding: '1rem 0.5rem' }}>
                          <StatusBadge status={proj.status} />
                        </td>
                        <td style={{ padding: '1rem 0.5rem' }}>
                          <PriorityBadge priority={proj.priority} />
                        </td>
                        <td style={{ padding: '1rem 0.5rem' }}>
                          {Number(proj.budget) > 0 ? (
                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                              <DollarSign size={14} color="var(--success-color)" />
                              {formatCurrency(proj.budget)}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-secondary)' }}>-</span>
                          )}
                        </td>
                        <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <CheckCircle2 size={13} color={completedTasks === totalTasks && totalTasks > 0 ? '#10b981' : 'var(--text-secondary)'} />
                            {completedTasks}/{totalTasks}
                          </span>
                        </td>
                        <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                          {proj.startDate ? new Date(proj.startDate).toLocaleDateString() : '?'}
                          {' - '}
                          {proj.endDate ? new Date(proj.endDate).toLocaleDateString() : '?'}
                        </td>
                        <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', alignItems: 'center' }}>
                            <select
                              value={proj.status}
                              onChange={e => updateStatus(proj.id, e.target.value)}
                              style={{
                                background: 'var(--input-bg)', color: 'var(--text-primary)',
                                border: '1px solid var(--border-color)', borderRadius: '6px',
                                padding: '0.35rem 0.5rem', fontSize: '0.75rem', cursor: 'pointer',
                              }}
                              aria-label={`Change status of ${proj.name}`}
                            >
                              {PROJECT_STATUSES.map(s => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => deleteProject(proj.id)}
                              style={{
                                background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                                color: 'var(--text-secondary)', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: '0.3rem',
                                fontSize: '0.8rem', padding: '0.4rem 0.75rem', borderRadius: '6px',
                              }}
                              onMouseOver={e => e.currentTarget.style.color = '#ef4444'}
                              onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                              aria-label={`Delete project ${proj.name}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
