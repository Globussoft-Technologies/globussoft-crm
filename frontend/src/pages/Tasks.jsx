import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { CheckCircle2, Phone, Calendar, Search, Plus, AlertTriangle, Clock, Flame } from 'lucide-react';

const PRIORITY_CONFIG = {
  Critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: '#ef4444', pulse: true },
  High:     { color: '#f97316', bg: 'rgba(249,115,22,0.08)', border: '#f97316', pulse: false },
  Medium:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.08)', border: '#3b82f6', pulse: false },
  Low:      { color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: '#475569', pulse: false },
};

function PriorityBadge({ priority }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.Medium;
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {priority === 'Critical' && '🔴 '}
      {priority === 'High' && '🟠 '}
      {priority === 'Medium' && '🔵 '}
      {priority === 'Low' && '⚪ '}
      {priority}
    </span>
  );
}

function isOverdue(task) {
  return task.dueDate && task.status === 'Pending' && new Date(task.dueDate) < new Date();
}

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [newTask, setNewTask] = useState({ title: '', dueDate: '', contactId: '', notes: '', priority: 'Medium' });

  useEffect(() => { loadData(); }, []);

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

  const createTask = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/tasks', { method: 'POST', body: JSON.stringify(newTask) });
      setNewTask({ title: '', dueDate: '', contactId: '', notes: '', priority: 'Medium' });
      loadData();
    } catch (err) {
      alert('Failed to enqueue task');
    }
  };

  const markComplete = async (id) => {
    try {
      await fetchApi(`/api/tasks/${id}/complete`, { method: 'PUT' });
      loadData();
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
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Flame size={26} color="var(--accent-color)" /> Agent Task Queue
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Prioritized daily follow-ups and outbound activity directives.
        </p>
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

        {/* Enqueue Panel */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Enqueue Activity
          </h3>
          <form onSubmit={createTask} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Directive Title</label>
              <input id="task-title-input" type="text" required className="input-field" placeholder="e.g. Q3 Renewal Call"
                value={newTask.title} onChange={e => setNewTask({ ...newTask, title: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Priority Level</label>
              <select id="task-priority-select" className="input-field" value={newTask.priority}
                onChange={e => setNewTask({ ...newTask, priority: e.target.value })}
                style={{ background: '#0f172a' }}>
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
                style={{ background: '#0f172a' }}>
                <option value="">-- Unassigned --</option>
                {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Execution Deadline</label>
              <input type="datetime-local" className="input-field" value={newTask.dueDate}
                onChange={e => setNewTask({ ...newTask, dueDate: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Execution Notes</label>
              <textarea className="input-field" rows="3" placeholder="Briefing notes..."
                value={newTask.notes} onChange={e => setNewTask({ ...newTask, notes: e.target.value })} />
            </div>

            <button id="assign-task-btn" type="submit" className="btn-primary" style={{ padding: '1rem' }}>
              Assign Task
            </button>
          </form>
        </div>

        {/* Queue + Completed */}
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
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
