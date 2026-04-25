import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { Ticket, Plus, Trash2, AlertTriangle } from 'lucide-react';

const PRIORITY_CONFIG = {
  Urgent:  { color: '#ef4444', bg: 'rgba(239,68,68,0.08)' },
  High:    { color: '#f97316', bg: 'rgba(249,115,22,0.08)' },
  Medium:  { color: '#3b82f6', bg: 'rgba(59,130,246,0.08)' },
  Low:     { color: '#64748b', bg: 'rgba(100,116,139,0.08)' },
};

const STATUS_CONFIG = {
  Open:     { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  Pending:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  Resolved: { color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
  Closed:   { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

function Badge({ label, config }) {
  const cfg = config[label] || { color: '#6b7280', bg: 'rgba(107,114,128,0.08)' };
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

const EMPTY_FORM = { subject: '', description: '', priority: 'Medium', assigneeId: '' };

export default function Tickets() {
  const notify = useNotify();
  const [tickets, setTickets] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [t, u] = await Promise.all([
        fetchApi('/api/tickets'),
        fetchApi('/api/auth/users').catch(() => []),
      ]);
      setTickets(Array.isArray(t) ? t : []);
      setUsers(Array.isArray(u) ? u : []);
    } catch (err) {
      console.error('Failed to load tickets:', err);
    } finally {
      setLoading(false);
    }
  };

  const createTicket = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        subject: form.subject,
        description: form.description || null,
        priority: form.priority,
      };
      if (form.assigneeId) {
        payload.assigneeId = parseInt(form.assigneeId, 10);
      }
      await fetchApi('/api/tickets', { method: 'POST', body: JSON.stringify(payload) });
      setForm(EMPTY_FORM);
      loadData();
    } catch (err) {
      notify.error('Failed to create ticket.');
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await fetchApi(`/api/tickets/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
      loadData();
    } catch (err) {
      console.error('Failed to update ticket status:', err);
    }
  };

  const deleteTicket = async (id) => {
    if (!await notify.confirm({
      title: 'Delete ticket',
      message: 'Delete this ticket?',
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/tickets/${id}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      console.error('Failed to delete ticket:', err);
    }
  };

  const updateField = (field, value) => {
    setForm({ ...form, [field]: value });
  };

  const openCount = tickets.filter(t => t.status === 'Open').length;
  const urgentCount = tickets.filter(t => t.priority === 'Urgent' && t.status !== 'Closed').length;

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Ticket size={26} color="var(--accent-color)" /> Support Tickets
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Track and resolve customer support requests.
        </p>
      </header>

      {/* Stats bar */}
      {tickets.length > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
          {urgentCount > 0 && (
            <span style={{
              padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(239,68,68,0.1)',
              color: '#ef4444', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(239,68,68,0.3)',
              display: 'flex', alignItems: 'center', gap: '0.3rem',
            }}>
              <AlertTriangle size={12} /> {urgentCount} Urgent
            </span>
          )}
          <span style={{
            padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(59,130,246,0.1)',
            color: '#3b82f6', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(59,130,246,0.3)',
          }}>
            {openCount} Open
          </span>
          <span style={{
            padding: '0.4rem 1rem', borderRadius: '999px', background: 'var(--subtle-bg-4)',
            color: 'var(--text-secondary)', fontSize: '0.8rem', border: '1px solid var(--border-color)',
          }}>
            {tickets.length} total
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

        {/* Create Ticket Panel */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Create Ticket
          </h3>
          <form onSubmit={createTicket} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Subject</label>
              <input
                type="text" required className="input-field" placeholder="e.g. Login page not loading"
                value={form.subject} onChange={e => updateField('subject', e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Description</label>
              <textarea
                className="input-field" rows="4" placeholder="Describe the issue..."
                value={form.description} onChange={e => updateField('description', e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Priority</label>
              <select
                className="input-field" value={form.priority}
                onChange={e => updateField('priority', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Assignee</label>
              <select
                className="input-field" value={form.assigneeId}
                onChange={e => updateField('assigneeId', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="">-- Unassigned --</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name || u.email} ({u.email})</option>
                ))}
              </select>
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem' }}>
              Submit Ticket
            </button>
          </form>
        </div>

        {/* Tickets Table */}
        <div className="card" style={{ padding: '2rem', overflow: 'auto' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Ticket size={20} color="var(--accent-color)" /> All Tickets
          </h3>

          {loading ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Loading...</p>
          ) : tickets.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
              No tickets found. Create one to get started.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    {['ID', 'Subject', 'Status', 'Priority', 'Assignee', 'Created', 'Actions'].map(h => (
                      <th key={h} style={{
                        padding: '0.75rem 0.5rem', textAlign: 'left', color: 'var(--text-secondary)',
                        fontSize: '0.75rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tickets.map(ticket => (
                    <tr key={ticket.id} style={{ borderBottom: '1px solid var(--border-color)', transition: '0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>#{ticket.id}</td>
                      <td style={{ padding: '0.75rem 0.5rem', fontWeight: '500' }}>{ticket.subject}</td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <select
                          value={ticket.status}
                          onChange={e => updateStatus(ticket.id, e.target.value)}
                          style={{
                            background: STATUS_CONFIG[ticket.status]?.bg || 'transparent',
                            color: STATUS_CONFIG[ticket.status]?.color || 'inherit',
                            border: `1px solid ${STATUS_CONFIG[ticket.status]?.color || 'var(--border-color)'}33`,
                            borderRadius: '999px', padding: '0.2rem 0.5rem', fontSize: '0.75rem',
                            fontWeight: 'bold', cursor: 'pointer', outline: 'none',
                          }}
                        >
                          <option value="Open">Open</option>
                          <option value="Pending">Pending</option>
                          <option value="Resolved">Resolved</option>
                          <option value="Closed">Closed</option>
                        </select>
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <Badge label={ticket.priority} config={PRIORITY_CONFIG} />
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {ticket.assignee ? (ticket.assignee.name || ticket.assignee.email) : '—'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(ticket.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <button
                          onClick={() => deleteTicket(ticket.id)}
                          title="Delete ticket"
                          style={{
                            background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)',
                            borderRadius: '6px', padding: '0.35rem 0.5rem', cursor: 'pointer', display: 'flex',
                            alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem',
                          }}
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      </td>
                    </tr>
                  ))}
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
