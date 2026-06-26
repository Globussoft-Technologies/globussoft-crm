import React, { useState, useEffect, useContext } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import { accessibleSubBrands, subBrandShortLabel } from '../utils/travelSubBrand';
import { useActiveSubBrand } from '../utils/subBrand';
import { CheckCircle2, Phone, Calendar, Search, Plus, AlertTriangle, Clock, Flame, X } from 'lucide-react';

const PRIORITY_CONFIG = {
  Critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: '#ef4444', pulse: true },
  High:     { color: '#f97316', bg: 'rgba(249,115,22,0.08)', border: '#f97316', pulse: false },
  Medium:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.08)', border: '#3b82f6', pulse: false },
  Low:      { color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: '#475569', pulse: false },
};

// #296: backend (or a stale workflow) can hand us values like CRITICAL_OMG
// that aren't in the canonical enum. Map known cases case-insensitively, then
// fall back to "Other" so the UI never shows a screaming all-caps badge.
const PRIORITY_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };

function normalizePriority(raw) {
  if (!raw) return 'Medium';
  const upper = String(raw).toUpperCase();
  if (PRIORITY_LABELS[upper]) return PRIORITY_LABELS[upper];
  // Common backend variant, e.g. 'CRITICAL_OMG' → "Critical"
  for (const key of Object.keys(PRIORITY_LABELS)) {
    if (upper.startsWith(key)) return PRIORITY_LABELS[key];
  }
  return 'Other';
}

function PriorityBadge({ priority }) {
  const normalized = normalizePriority(priority);
  const cfg = PRIORITY_CONFIG[normalized] || PRIORITY_CONFIG.Medium;
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {normalized === 'Critical' && '🔴 '}
      {normalized === 'High' && '🟠 '}
      {normalized === 'Medium' && '🔵 '}
      {normalized === 'Low' && '⚪ '}
      {normalized}
    </span>
  );
}

function isOverdue(task) {
  return task.dueDate && task.status === 'Pending' && new Date(task.dueDate) < new Date();
}

// #608: warn when the user is creating a task with a due date that is already
// in the past. We don't block — some workflows legitimately back-fill a task
// to record it after the fact — but the form should make it loud so the user
// doesn't accidentally inflate the Overdue counter on the dashboard.
function isPastDate(localDateTimeStr) {
  if (!localDateTimeStr) return false;
  const picked = new Date(localDateTimeStr);
  if (Number.isNaN(picked.getTime())) return false;
  return picked.getTime() < Date.now();
}

const EMPTY_FORM = { title: '', dueDate: '', contactId: '', notes: '', priority: 'Medium', assignedToId: '' };

export default function Tasks() {
  const notify = useNotify();
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [staff, setStaff] = useState([]);
  const [newTask, setNewTask] = useState(EMPTY_FORM);

  // Travel vertical only: the "Assign to" dropdown lists STAFF (agents), scoped
  // to the active sub-brand so e.g. an RFU-only operator isn't offered TMC
  // agents. Generic / wellness tenants don't render the staff dropdown at all,
  // so their Tasks form is unchanged.
  const { tenant } = useContext(AuthContext) || {};
  const isTravel = tenant?.vertical === 'travel';
  const { activeSubBrand } = useActiveSubBrand();
  const assignableStaff = !isTravel
    ? staff
    : (activeSubBrand
        ? staff.filter((s) => accessibleSubBrands(s).includes(activeSubBrand))
        : staff);
  // #893: the Enqueue Activity form used to sit inline above the queue,
  // eating vertical real-estate and inviting accidental typing. Mirror the
  // c031ba0 pattern: header "+ Create Task" CTA opens this drawer; close on
  // X / ESC / outside-click; submit handler is preserved verbatim.
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadData(); }, []);

  // Travel-only: load the staff roster for the "Assign to" dropdown. Fail-soft
  // (own catch) so a staff-list permission error never blocks the task queue,
  // and gated to travel so generic / wellness make no extra request.
  useEffect(() => {
    if (!isTravel) return;
    fetchApi('/api/staff')
      .then((d) => setStaff(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [isTravel]);

  // #893: ESC closes the drawer to match the c031ba0 Travel-page convention.
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setCreating(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);

  const loadData = async () => {
    try {
      const [t, c] = await Promise.all([
        fetchApi('/api/tasks'),
        fetchApi('/api/contacts'),
      ]);
      setTasks(Array.isArray(t) ? t : []);
      setContacts(Array.isArray(c) ? c : []);
    } catch (err) {
      console.error(err);
    }
  };

  const openCreate = () => {
    setNewTask(EMPTY_FORM);
    setCreating(true);
  };

  const closeCreate = () => {
    setCreating(false);
  };

  const createTask = async (e) => {
    e.preventDefault();
    try {
      // #313: <input type="datetime-local"> returns a wall-clock string
      // ("2026-05-20T15:30") with no timezone. Sending it bare to the server
      // makes Node `new Date(...)` interpret it as UTC, and the IST display
      // path then adds +5:30, breaking the round-trip. Convert via the
      // browser's local Date so the saved value is a real ISO timestamp.
      const payload = {
        ...newTask,
        dueDate: newTask.dueDate ? new Date(newTask.dueDate).toISOString() : null,
        // Backend reads `targetUserId` → Task.userId (stripDangerous deletes a
        // raw `userId` from the body). Only send when an assignee was picked.
        targetUserId: newTask.assignedToId || undefined,
      };
      delete payload.assignedToId;
      await fetchApi('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      setNewTask(EMPTY_FORM);
      setCreating(false);
      loadData();
      // #625: invalidate sidebar counters so the My Tasks badge bumps.
      window.dispatchEvent(new CustomEvent('sidebar:counts-changed'));
    } catch (err) {
      notify.error('Failed to enqueue task');
    }
  };

  const markComplete = async (id) => {
    try {
      await fetchApi(`/api/tasks/${id}/complete`, { method: 'PUT' });
      loadData();
      // #625: invalidate sidebar counters — backend has no `task_completed`
      // socket emit today, so the polling fallback alone left the badge
      // stale until the next 60s tick.
      window.dispatchEvent(new CustomEvent('sidebar:counts-changed'));
    } catch (err) {
      console.error(err);
    }
  };

  const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const activeTasks = tasks
    .filter(t => t.status !== 'Completed')
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99));
  const completedTasks = tasks.filter(t => t.status === 'Completed');

  const criticalCount = activeTasks.filter(t => t.priority === 'Critical').length;
  const highCount = activeTasks.filter(t => t.priority === 'High').length;
  const overdueCount = activeTasks.filter(isOverdue).length;

  return (
    <div className="tasks-page" style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Flame size={26} color="var(--accent-color)" /> Agent Task Queue
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Prioritized daily follow-ups and outbound activity directives.
          </p>
        </div>
        <button
          id="open-create-task-btn"
          type="button"
          onClick={openCreate}
          aria-label="Create a new task"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '0.65rem 1.1rem', borderRadius: 6, fontWeight: 600, fontSize: '0.875rem',
            background: 'var(--primary-color, var(--accent-color))',
            color: 'var(--accent-text, #fff)',
            border: '1px solid var(--primary-color, var(--accent-color))',
            cursor: 'pointer',
          }}
        >
          <Plus size={14} /> Create Task
        </button>
      </header>

      {/* Stats bar */}
      {activeTasks.length > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
          {criticalCount > 0 && (
            <span style={{ padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(239,68,68,0.3)' }}>
              🔴 {criticalCount} Critical
            </span>
          )}
          {highCount > 0 && (
            <span style={{ padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(249,115,22,0.1)', color: '#f97316', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(249,115,22,0.3)' }}>
              🟠 {highCount} High
            </span>
          )}
          {overdueCount > 0 && (
            <span style={{ padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(239,68,68,0.08)', color: '#f87171', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(239,68,68,0.2)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <AlertTriangle size={12} /> {overdueCount} Overdue
            </span>
          )}
          <span style={{ padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', fontSize: '0.8rem', border: '1px solid var(--border-color)' }}>
            {activeTasks.length} total pending
          </span>
        </div>
      )}

      {/* #893: Queue + Completed are now the full width. The Enqueue Activity
         form lives in the drawer below, opened by the header CTA. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

        {/* Active Queue */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Phone size={20} color="var(--danger-color)" /> Active Priority Queue
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {activeTasks.length === 0 ? (
              <p id="empty-queue-msg" style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                Queue is empty. Excellent work.
              </p>
            ) : activeTasks.map(t => {
              const cfg = PRIORITY_CONFIG[t.priority] || PRIORITY_CONFIG.Medium;
              const overdue = isOverdue(t);
              return (
                <div key={t.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '1.25rem', background: cfg.bg,
                  borderLeft: `4px solid ${cfg.border}`, borderRadius: '0 8px 8px 0',
                  transition: '0.2s', position: 'relative',
                  boxShadow: t.priority === 'Critical' ? `0 0 12px ${cfg.color}22` : 'none',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
                      <h4 style={{ fontWeight: '600', fontSize: '1rem', margin: 0 }}>{t.title}</h4>
                      <PriorityBadge priority={t.priority} />
                      {overdue && (
                        <span style={{ padding: '0.15rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 'bold', background: 'rgba(239,68,68,0.15)', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <AlertTriangle size={10} /> OVERDUE
                        </span>
                      )}
                    </div>
                    {t.contact && (
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0 0 0.2rem' }}>
                        <Search size={12} /> {t.contact.name} • {t.contact.email}
                      </p>
                    )}
                    {t.dueDate && (
                      <p style={{ fontSize: '0.8rem', color: overdue ? '#ef4444' : 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                        <Clock size={12} /> {new Date(t.dueDate).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem', flexShrink: 0 }}>
                    <button
                      onClick={() => markComplete(t.id)}
                      className="btn-secondary"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'var(--success-color)', color: '#fff', border: 'none', padding: '0.5rem 0.9rem', fontSize: '0.8rem', position: 'relative', zIndex: 10, pointerEvents: 'all' }}
                    >
                      <CheckCircle2 size={14} /> Resolve
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Completed Log */}
        <div className="card" style={{ padding: '2rem', opacity: 0.75 }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CheckCircle2 size={20} color="var(--success-color)" /> Completed Log
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {completedTasks.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No completed tasks yet.</p>
            ) : completedTasks.slice(0, 8).map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.65rem 1rem', background: 'rgba(255,255,255,0.01)', borderRadius: '4px' }}>
                <span style={{ textDecoration: 'line-through', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{t.title}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--success-color)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <CheckCircle2 size={10} /> Resolved
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* #893: Create Task modal — opens from header CTA. Close on X, ESC, outside-click. */}
      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeCreate(); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <form
            onSubmit={createTask}
            className="card"
            style={{
              background: 'var(--bg-color)', color: 'var(--text-primary)',
              width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto',
              padding: 24,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Plus size={18} color="var(--accent-color)" /> Enqueue Activity
              </h2>
              <button
                type="button"
                onClick={closeCreate}
                aria-label="Close"
                style={{
                  background: 'transparent', border: 'none', color: 'var(--text-secondary)',
                  cursor: 'pointer', padding: 4,
                }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Directive Title</label>
                <input id="task-title-input" type="text" required className="input-field" placeholder="e.g. Q3 Renewal Call"
                  value={newTask.title} onChange={e => setNewTask({ ...newTask, title: e.target.value })} />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Priority Level</label>
                <select id="task-priority-select" className="input-field" value={newTask.priority}
                  onChange={e => setNewTask({ ...newTask, priority: e.target.value })}
                  style={{ background: 'var(--input-bg)' }}>
                  <option value="Critical">🔴 Critical</option>
                  <option value="High">🟠 High</option>
                  <option value="Medium">🔵 Medium</option>
                  <option value="Low">⚪ Low</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Associated Contact</label>
                <select className="input-field" value={newTask.contactId}
                  onChange={e => setNewTask({ ...newTask, contactId: e.target.value })}
                  style={{ background: 'var(--input-bg)' }}>
                  <option value="">-- Unassigned --</option>
                  {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
                </select>
              </div>

              {isTravel && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Assign to (staff)</label>
                  <select className="input-field" value={newTask.assignedToId}
                    onChange={e => setNewTask({ ...newTask, assignedToId: e.target.value })}
                    style={{ background: 'var(--input-bg)' }}>
                    <option value="">-- Unassigned --</option>
                    {assignableStaff.map(s => {
                      const brands = accessibleSubBrands(s);
                      // Show the agent's brand scope as a hint (only when not all-4).
                      const scope = brands.length && brands.length < 4
                        ? ` · ${brands.map(subBrandShortLabel).join('/')}`
                        : '';
                      return <option key={s.id} value={s.id}>{s.name}{scope}</option>;
                    })}
                  </select>
                  {assignableStaff.length === 0 && (
                    <p style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      No staff available for this sub-brand.
                    </p>
                  )}
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Execution Deadline</label>
                <input
                  type="datetime-local"
                  className="input-field"
                  value={newTask.dueDate}
                  onChange={e => setNewTask({ ...newTask, dueDate: e.target.value })}
                  aria-describedby={isPastDate(newTask.dueDate) ? 'task-duedate-warning' : undefined}
                  style={isPastDate(newTask.dueDate) ? { borderColor: '#f59e0b' } : undefined}
                />
                {isPastDate(newTask.dueDate) && (
                  <p
                    id="task-duedate-warning"
                    data-testid="task-past-date-warning"
                    style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                  >
                    <AlertTriangle size={12} /> This task will be created already overdue.
                  </p>
                )}
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Execution Notes</label>
                <textarea className="input-field" rows="3" placeholder="Briefing notes..."
                  value={newTask.notes} onChange={e => setNewTask({ ...newTask, notes: e.target.value })} />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button
                type="button"
                onClick={closeCreate}
                style={{
                  padding: '0.65rem 1.1rem', borderRadius: 6, fontWeight: 500, fontSize: '0.875rem',
                  background: 'var(--surface-color)', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button id="assign-task-btn" type="submit" className="btn-primary" style={{ padding: '0.65rem 1.1rem' }}>
                Assign Task
              </button>
            </div>
          </form>
        </div>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* #480 / #893: with the form moved to a drawer the main grid is now a single column.
           Keep the mobile padding adjustment in place so the page still breathes on narrow
           viewports; the drawer itself is full-width on mobile via maxWidth: 460 + width: 100%. */
        @media (max-width: 768px) {
          .tasks-page { padding: 1rem !important; }
          .tasks-page .card { padding: 1.25rem !important; }
          .tasks-page h3 { white-space: normal !important; }
        }
      `}</style>
    </div>
  );
}
