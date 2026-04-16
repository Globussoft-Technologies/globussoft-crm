import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchApi } from '../utils/api';
import { ScrollText, Filter, Download, ChevronDown, User } from 'lucide-react';

const ACTION_COLOR = {
  CREATE: '#10b981',
  UPDATE: '#3b82f6',
  DELETE: '#ef4444',
};
const OTHER_COLOR = '#6b7280';

function actionColor(action) {
  return ACTION_COLOR[action] || OTHER_COLOR;
}

const ENTITY_OPTIONS = [
  'Contact', 'Deal', 'Invoice', 'Estimate', 'Expense', 'Contract',
  'Project', 'Task', 'Ticket', 'Campaign', 'Sequence', 'User', 'Quote',
];

function StatCard({ label, value, color }) {
  return (
    <div
      className="card"
      style={{
        padding: '1.25rem 1.5rem',
        borderLeft: `4px solid ${color}`,
        flex: 1,
        minWidth: 180,
      }}
    >
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.85rem', fontWeight: 700, marginTop: '0.4rem', color }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function ActionBadge({ action }) {
  const color = actionColor(action);
  return (
    <span style={{
      padding: '0.2rem 0.65rem',
      borderRadius: 999,
      fontSize: '0.72rem',
      fontWeight: 700,
      letterSpacing: '0.03em',
      background: `${color}1f`,
      color,
      border: `1px solid ${color}55`,
    }}>
      {action}
    </span>
  );
}

function prettyDetails(raw) {
  if (!raw) return '(no details)';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 25;

  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');

  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(false);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', page);
    params.set('limit', limit);
    if (entity) params.set('entity', entity);
    if (action) params.set('action', action);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [page, entity, action, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchApi(`/api/audit-viewer?${queryString}`);
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
      setPages(data?.pages || 1);
      setTotal(data?.total || 0);
    } catch (err) {
      console.error('[AuditLog] load failed', err);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  const loadStats = useCallback(async () => {
    try {
      const s = await fetchApi('/api/audit-viewer/stats');
      setStats(s);
    } catch (err) {
      console.error('[AuditLog] stats failed', err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [entity, action, from, to]);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (entity) params.set('entity', entity);
    if (action) params.set('action', action);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const token = localStorage.getItem('token');
    fetch(`/api/audit-viewer/export.csv?${params.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'audit-log.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      })
      .catch(err => {
        console.error('[AuditLog] export failed', err);
        alert('Failed to export CSV');
      });
  };

  // Client-side search across user name/email + entity + details
  const filteredLogs = useMemo(() => {
    if (!search.trim()) return logs;
    const q = search.toLowerCase();
    return logs.filter(l => {
      return (
        (l.user?.name || '').toLowerCase().includes(q) ||
        (l.user?.email || '').toLowerCase().includes(q) ||
        (l.entity || '').toLowerCase().includes(q) ||
        String(l.entityId || '').includes(q) ||
        (l.details || '').toLowerCase().includes(q)
      );
    });
  }, [logs, search]);

  const inputStyle = {
    background: 'rgba(15,23,42,0.6)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 8,
    padding: '0.5rem 0.75rem',
    fontSize: '0.85rem',
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: '1.5rem',
        gap: '1rem',
        flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
            <ScrollText size={26} color="var(--accent-color)" /> Audit Log
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Tenant-wide change history. Admin/Manager only.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={handleExport}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Download size={16} /> Export CSV
        </button>
      </header>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <StatCard label="Total events (30d)" value={stats?.total ?? 0} color="var(--accent-color)" />
        <StatCard label="CREATEs" value={stats?.byAction?.CREATE ?? 0} color={ACTION_COLOR.CREATE} />
        <StatCard label="UPDATEs" value={stats?.byAction?.UPDATE ?? 0} color={ACTION_COLOR.UPDATE} />
        <StatCard label="DELETEs" value={stats?.byAction?.DELETE ?? 0} color={ACTION_COLOR.DELETE} />
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            <Filter size={16} /> Filter
          </div>
          <select value={entity} onChange={e => setEntity(e.target.value)} style={inputStyle}>
            <option value="">All entities</option>
            {ENTITY_OPTIONS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <select value={action} onChange={e => setAction(e.target.value)} style={inputStyle}>
            <option value="">All actions</option>
            <option value="CREATE">CREATE</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
          </select>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            style={inputStyle}
            title="From"
          />
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            style={inputStyle}
            title="To"
          />
          <input
            type="text"
            placeholder="Search user, entity, or details..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          />
          {(entity || action || from || to || search) && (
            <button
              onClick={() => { setEntity(''); setAction(''); setFrom(''); setTo(''); setSearch(''); }}
              className="btn-secondary"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                <th style={thStyle}></th>
                <th style={thStyle}>Timestamp</th>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Action</th>
                <th style={thStyle}>Entity</th>
                <th style={thStyle}>Entity ID</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</td></tr>
              )}
              {!loading && filteredLogs.length === 0 && (
                <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No audit events match the current filters.</td></tr>
              )}
              {!loading && filteredLogs.map(log => {
                const isOpen = expanded === log.id;
                return (
                  <React.Fragment key={log.id}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : log.id)}
                      style={{
                        cursor: 'pointer',
                        borderTop: '1px solid var(--border-color)',
                        background: isOpen ? 'rgba(59,130,246,0.06)' : 'transparent',
                      }}
                    >
                      <td style={tdStyle}>
                        <ChevronDown
                          size={14}
                          style={{
                            transition: 'transform 0.2s',
                            transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                            color: 'var(--text-secondary)',
                          }}
                        />
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <User size={14} color="var(--text-secondary)" />
                          <div>
                            <div style={{ fontWeight: 600 }}>{log.user?.name || 'System'}</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                              {log.user?.email || '—'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={tdStyle}><ActionBadge action={log.action} /></td>
                      <td style={tdStyle}>{log.entity}</td>
                      <td style={{ ...tdStyle, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                        {log.entityId ?? '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: 'rgba(15,23,42,0.4)' }}>
                        <td></td>
                        <td colSpan={5} style={{ padding: '1rem 1.25rem 1.5rem' }}>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.5rem', letterSpacing: '0.04em' }}>
                            Details
                          </div>
                          <pre style={{
                            background: 'var(--input-bg)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 8,
                            padding: '1rem',
                            margin: 0,
                            fontSize: '0.78rem',
                            color: 'var(--text-secondary)',
                            overflowX: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}>
                            {prettyDetails(log.details)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.85rem 1.25rem',
          borderTop: '1px solid var(--border-color)',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
        }}>
          <div>
            Page <strong style={{ color: 'var(--text-primary)' }}>{page}</strong> of{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{pages}</strong> · {total.toLocaleString()} total events
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className="btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(p - 1, 1))}
              style={{ padding: '0.4rem 0.9rem', fontSize: '0.8rem', opacity: page <= 1 ? 0.4 : 1 }}
            >
              Previous
            </button>
            <button
              className="btn-secondary"
              disabled={page >= pages}
              onClick={() => setPage(p => Math.min(p + 1, pages))}
              style={{ padding: '0.4rem 0.9rem', fontSize: '0.8rem', opacity: page >= pages ? 0.4 : 1 }}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

const thStyle = {
  textAlign: 'left',
  padding: '0.75rem 1rem',
  fontSize: '0.72rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
  fontWeight: 600,
};

const tdStyle = {
  padding: '0.75rem 1rem',
  verticalAlign: 'middle',
};
