import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FolderKanban, Plus, Trash2, IndianRupee, CheckCircle2, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney } from '../utils/money';
import { formatDate } from '../utils/date';
import './Projects.css';

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

// #626: was a bare `Number().toLocaleString()` (no symbol) called from a
// JSX expression that hardcoded `$` outside the call — rendered "$ 1,000.00"
// on USD tenants and lost the rupee on INR tenants. formatMoney handles
// both the symbol and the locale-grouping in one call.
function formatCurrency(value) {
  return formatMoney(value || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function ProjectCreateModal({ form, contacts, deals, nameInputRef, onChange, onSubmit, onClose }) {
  return createPortal(
    <div
      className="projects-modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="projects-create-modal" role="dialog" aria-modal="true" aria-labelledby="projects-modal-title">
        <header className="projects-modal-header">
          <h2 id="projects-modal-title"><Plus size={19} color="var(--accent-color)" /> Create Project</h2>
          <button type="button" className="projects-modal-close" onClick={onClose} aria-label="Close create project dialog">
            <X size={18} />
          </button>
        </header>
        <form className="projects-form" onSubmit={onSubmit}>
          <div>
            <label htmlFor="project-name">Name</label>
            <input ref={nameInputRef} id="project-name" type="text" className="input-field" required placeholder="Project name" value={form.name} onChange={event => onChange('name', event.target.value)} />
          </div>
          <div>
            <label htmlFor="project-description">Description</label>
            <textarea id="project-description" className="input-field" rows={3} placeholder="Project description..." value={form.description} onChange={event => onChange('description', event.target.value)} />
          </div>
          <div>
            <label htmlFor="project-priority">Priority</label>
            <select id="project-priority" className="input-field" value={form.priority} onChange={event => onChange('priority', event.target.value)}>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
            </select>
          </div>
          <div className="projects-date-fields">
            <div>
              <label htmlFor="project-start-date">Start Date</label>
              <input id="project-start-date" type="date" className="input-field" value={form.startDate} onChange={event => onChange('startDate', event.target.value)} />
            </div>
            <div>
              <label htmlFor="project-end-date">End Date</label>
              <input id="project-end-date" type="date" className="input-field" value={form.endDate} onChange={event => onChange('endDate', event.target.value)} />
            </div>
          </div>
          <div>
            <label htmlFor="project-budget">Budget ($)</label>
            <input id="project-budget" type="number" step="0.01" min="0" className="input-field" placeholder="0.00" value={form.budget} onChange={event => onChange('budget', event.target.value)} />
          </div>
          <div>
            <label htmlFor="project-contact">Contact</label>
            <select id="project-contact" className="input-field" value={form.contactId} onChange={event => onChange('contactId', event.target.value)}>
              <option value="">-- Select Contact --</option>
              {contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name} ({contact.email})</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="project-deal">Deal (Optional)</label>
            <select id="project-deal" className="input-field" value={form.dealId} onChange={event => onChange('dealId', event.target.value)}>
              <option value="">-- No Deal --</option>
              {deals.map(deal => <option key={deal.id} value={deal.id}>{deal.title} - {formatCurrency(deal.amount)}</option>)}
            </select>
          </div>
          <button type="submit" className="btn-primary projects-modal-submit">Create Project</button>
        </form>
      </section>
    </div>,
    document.body,
  );
}

export default function Projects() {
  const notify = useNotify();
  const [projects, setProjects] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [form, setForm] = useState(INITIAL_FORM);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const projectNameInputRef = useRef(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // Server-driven paging: `projects` holds ONLY the current page (full
  // shape with owner/contact/deal/tasks for the table), `statsProjects` is
  // the lightweight ?fields=summary full list (status/priority/budget —
  // enough for the stats chips), and `countTotal` (?count=1) is the
  // authoritative footer/total-chip count. Stale rows stay visible across
  // page turns (never cleared before the next page lands).
  const [statsProjects, setStatsProjects] = useState([]);
  const [countTotal, setCountTotal] = useState(null);
  const pageRequestId = useRef(0);

  useEffect(() => {
    if (!isCreateModalOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = event => {
      if (event.key === 'Escape') setIsCreateModalOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const focusFrame = window.requestAnimationFrame(() => projectNameInputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isCreateModalOpen]);

  // Form dropdowns + stats-bar source. Runs on mount and after mutations.
  const loadStatic = async () => {
    try {
      const [c, d, sc] = await Promise.all([
        fetchApi('/api/contacts'),
        fetchApi('/api/deals'),
        fetchApi('/api/projects?fields=summary').catch(() => null),
      ]);
      setContacts(Array.isArray(c) ? c : []);
      setDeals(Array.isArray(d) ? d : []);
      setStatsProjects(Array.isArray(sc) ? sc : []);
    } catch {
      // handled by fetchApi
    }
  };

  // Current table page + authoritative total. Runs on mount, page turns,
  // page-size changes, and after mutations.
  const loadPage = async () => {
    const myId = ++pageRequestId.current;
    const isCurrent = () => myId === pageRequestId.current;
    try {
      const offset = (Math.max(1, currentPage) - 1) * pageSize;
      const [proj, cn] = await Promise.all([
        fetchApi(`/api/projects?limit=${pageSize}&offset=${offset}`),
        fetchApi('/api/projects?count=1').catch(() => null),
      ]);
      if (!isCurrent()) return;
      setProjects(Array.isArray(proj) ? proj : []);
      setCountTotal(cn && typeof cn.total === 'number' ? cn.total : null);
    } catch {
      // handled by fetchApi
      if (!isCurrent()) return;
      setProjects([]);
      setCountTotal(0);
    }
  };

  const loadData = async () => {
    await Promise.all([loadStatic(), loadPage()]);
  };

  useEffect(() => { loadStatic(); }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadPage(); }, [currentPage, pageSize]);

  // Stats chips stay full-population: they read the lightweight summary
  // list, NOT the single table page.
  const stats = useMemo(() => {
    const activeCount = statsProjects.filter(p => p.status === 'Active').length;
    const completedCount = statsProjects.filter(p => p.status === 'Completed').length;
    const totalBudget = statsProjects.reduce((sum, p) => sum + Number(p.budget), 0);
    return { activeCount, completedCount, totalBudget };
  }, [statsProjects]);

  // Footer/total-chip count is backend-synced (?count=1), falling back to
  // the summary-list length so it never reads 0 with rows on screen.
  const total = countTotal != null ? countTotal : statsProjects.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const startItem = total === 0 ? 0 : startIndex + 1;
  const endItem = Math.min(startIndex + pageSize, total);

  // Step back when the backend total shrinks under the current page
  // (deletes). Converges: totalPages >= 1 always.
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

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
      setIsCreateModalOpen(false);
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
    <div className="projects-page" style={{ padding: '2rem', minWidth: 0, maxWidth: '100%', animation: 'fadeIn 0.5s ease-out' }}>
      <header className="projects-header" style={{ marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <FolderKanban size={26} color="var(--accent-color)" /> Projects
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Plan, track, and manage projects across your organization.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary projects-create-shortcut"
          onClick={() => setIsCreateModalOpen(true)}
        >
          <Plus size={16} /> New Project
        </button>
      </header>

      {/* Summary Stats */}
      <div className="projects-summary" style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
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
          <IndianRupee size={14} /> Total Budget: {formatCurrency(stats.totalBudget)}
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem',
          background: 'var(--subtle-bg-4)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
        }}>
          {total} total projects
        </span>
      </div>

      <div className="projects-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1rem' }}>
        {/* Projects Table */}
        <div className="card projects-board-card" style={{ padding: '1rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FolderKanban size={20} color="var(--success-color)" /> Project Board
          </h3>

          {projects.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              <FolderKanban size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>No projects yet. Create one to get started.</p>
            </div>
          ) : (
            <div className="projects-table-scroll" style={{ overflowX: 'auto' }}>
              <table className="projects-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }} role="table" aria-label="Projects table">
                <colgroup>
                  {Array.from({ length: 8 }, (_, index) => <col key={index} />)}
                </colgroup>
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
                              <IndianRupee size={14} color="var(--success-color)" />
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
                          {proj.startDate ? formatDate(proj.startDate) : '?'}
                          {' - '}
                          {proj.endDate ? formatDate(proj.endDate) : '?'}
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
          {projects.length > 0 && (
            <div className="projects-pagination" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
                Showing {startItem}-{endItem} of {total} project{total !== 1 ? 's' : ''}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  <span>Rows per page</span>
                  <select
                    aria-label="Rows per page"
                    value={String(pageSize)}
                    onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                    style={{ padding: '0.5rem 0.6rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--input-bg, var(--surface-hover))', color: 'var(--text-primary)' }}
                  >
                    {[10, 15, 25, 50].map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setCurrentPage(prev => Math.max(1, Math.min(prev, totalPages) - 1))}
                  disabled={safePage <= 1}
                  aria-label="Previous page"
                  style={{ padding: '0.6rem 1rem', opacity: safePage <= 1 ? 0.6 : 1, cursor: safePage <= 1 ? 'not-allowed' : 'pointer' }}
                >
                  Previous
                </button>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  Page {safePage} of {totalPages}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, Math.min(prev, totalPages) + 1))}
                  disabled={safePage >= totalPages}
                  aria-label="Next page"
                  style={{ padding: '0.6rem 1rem', opacity: safePage >= totalPages ? 0.6 : 1, cursor: safePage >= totalPages ? 'not-allowed' : 'pointer' }}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {isCreateModalOpen && (
        <ProjectCreateModal
          form={form}
          contacts={contacts}
          deals={deals}
          nameInputRef={projectNameInputRef}
          onChange={handleFormChange}
          onSubmit={createProject}
          onClose={() => setIsCreateModalOpen(false)}
        />
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* #513: collapse the 1fr 2fr two-column layout to a single stack on mobile.
           Same pattern as #478 (Tickets) and #480 (Tasks). minmax(0, ...) on the
           desktop grid prevents form-field min-content from forcing the column
           wider than 1fr would allow. */
        @media (max-width: 768px) {
          .projects-page { padding: 1rem !important; }
          .projects-grid { grid-template-columns: 1fr !important; gap: 1.25rem !important; }
          .projects-page .card { padding: 1.25rem !important; }
        }
      `}</style>
    </div>
  );
}
