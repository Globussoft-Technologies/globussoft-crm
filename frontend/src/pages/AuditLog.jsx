import React, { useState, useEffect, useCallback, useMemo, useContext } from 'react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import { ScrollText, Filter, Download, ChevronDown, User, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';

// StatCard left-border tint + the four stat values still use this hex map
// (the cards are surface-color glass cards whose left border + value text
// reads the per-action accent — fine on both themes since 4px borders +
// large display text both clear AA against both bgs). #878 dark-mode
// refactor: ActionBadge no longer reads this map for its inline bg/border —
// it picks a `.audit-action-pill--<variant>` class instead so travel dark
// mode can override the tinted-pill bg+fg pair without JS.
const ACTION_COLOR = {
  CREATE: '#10b981',
  UPDATE: '#3b82f6',
  DELETE: '#ef4444',
};
// Pre-refactor used an inline `${color}1f` bg + `${color}55` border map; #878
// refactored to a `.audit-action-pill .audit-action-pill--<variant>` class
// pair so travel dark-mode can override the tinted-pill foreground +
// background tokens via CSS-only. Unknown actions fall through to `other`.
const ACTION_VARIANT = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
};

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
  const variant = ACTION_VARIANT[action] || 'other';
  return (
    <span className={`audit-action-pill audit-action-pill--${variant}`}>
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
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';
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

  // #558 — Audit chain integrity. integrity = {
  //   chainLength,    // rows walked (strict semantics: counts the broken row)
  //   totalRows,      // total audit rows for this tenant
  //   unhashedRows,   // rows with null hash (need backfill)
  //   brokenAt,       // id of first row that fails verification, or null
  //   reason,         // human-readable explanation of the break
  //   integrityVerified, lastVerifiedAt,
  // } once /api/audit/verify has run. Auto-verify on mount for admins so the
  // chip shows the current state without requiring the operator to click.
  const [integrity, setIntegrity] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const verifyChain = useCallback(async () => {
    if (!isAdmin) return;
    setVerifying(true);
    try {
      const data = await fetchApi('/api/audit/verify');
      setIntegrity(data);
    } catch (err) {
      console.error('[AuditLog] verify failed', err);
      setIntegrity({ integrityVerified: false, brokenAt: null, chainLength: 0, totalRows: 0, unhashedRows: 0, error: true });
      notify.error('Failed to verify audit chain');
    } finally {
      setVerifying(false);
    }
  }, [isAdmin, notify]);

  // Run the backfill endpoint then immediately re-verify so the chip flips
  // to green if everything got chained successfully. 409 conflict means an
  // already-hashed row's content doesn't match its recomputation — that's
  // suspected tampering, surface the row id so ops can investigate.
  const runBackfill = useCallback(async () => {
    if (!isAdmin) return;
    if (!window.confirm('Backfill writes hashes to every unchained audit row for this tenant. Continue?')) return;
    setBackfilling(true);
    try {
      const data = await fetchApi('/api/audit/backfill', { method: 'POST' });
      notify.success(`Backfill complete — updated ${data.updatedRows} rows, ${data.skippedRows} already chained.`);
      await verifyChain();
    } catch (err) {
      console.error('[AuditLog] backfill failed', err);
      // fetchApi attaches the parsed error body to err.data (see utils/api.js).
      // 409 → body.conflictRowId is populated; surface the row id so ops can
      // open the incident. Other failures get a generic toast — fetchApi
      // already raised one for the user.
      const body = err?.data;
      if (body?.conflictRowId != null) {
        notify.error(`Backfill aborted: conflict at row #${body.conflictRowId}. Suspected tampering — contact security.`);
      }
    } finally {
      setBackfilling(false);
    }
  }, [isAdmin, notify, verifyChain]);

  useEffect(() => { verifyChain(); }, [verifyChain]);

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
    const token = getAuthToken();
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
        notify.error('Failed to export CSV');
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

  // #878 — was `background: 'rgba(15,23,42,0.6)'` hardcoded slate (light-mode
  // looked acceptable, dark-mode crushed contrast vs travel navy body).
  // Switch to `var(--input-bg)` which both index.css (light/dark generic) and
  // travel.css (light/dark travel) define correctly.
  const inputStyle = {
    background: 'var(--input-bg)',
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

        {/* #558 — Hash-chain integrity chip + Verify button. ADMIN-only:
            verifying walks the entire audit chain and recomputes hashes.
            Chip is green when every row's stored hash matches the
            recomputed sha256, red when a row was tampered with, and
            paired with a yellow "Backfill required" banner when one or
            more rows are unchained (null hash) — typically right after
            the v3.7.x hash-chain code first ships against a tenant
            whose audit history pre-dates the chain. */}
        {isAdmin && (
          <div
            data-testid="integrity-row"
            style={{
              display: 'flex',
              gap: '0.75rem',
              alignItems: 'center',
              flexWrap: 'wrap',
              marginTop: '0.85rem',
              paddingTop: '0.85rem',
              borderTop: '1px solid var(--border-color)',
              fontSize: '0.85rem',
            }}
          >
            {integrity?.integrityVerified ? (
              <span
                data-testid="integrity-chip-ok"
                className="audit-integrity-chip audit-integrity-chip--ok"
              >
                <ShieldCheck size={14} />
                {`Integrity verified at ${new Date(integrity.lastVerifiedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`}
                <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '0.78rem' }}>
                  ({integrity.chainLength} rows)
                </span>
              </span>
            ) : integrity && integrity.unhashedRows > 0 && integrity.reason && /null hash/i.test(integrity.reason) ? (
              // First break is a null hash → operator just needs to run
              // backfill, not call security. Yellow chip + dedicated banner
              // below take care of the call to action.
              <span
                data-testid="integrity-chip-needs-backfill"
                className="audit-integrity-chip audit-integrity-chip--warn"
              >
                <ShieldQuestion size={14} />
                Backfill required
                <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '0.78rem' }}>
                  ({integrity.unhashedRows} of {integrity.totalRows} rows unchained)
                </span>
              </span>
            ) : integrity ? (
              <span
                data-testid="integrity-chip-broken"
                className="audit-integrity-chip audit-integrity-chip--danger"
              >
                <ShieldAlert size={14} />
                Chain broken — please contact support
                {integrity.brokenAt != null && (
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '0.78rem' }}>
                    (row #{integrity.brokenAt}{integrity.reason ? ` — ${integrity.reason}` : ''})
                  </span>
                )}
              </span>
            ) : (
              <span style={{ color: 'var(--text-secondary)' }}>Verifying chain...</span>
            )}
            <button
              data-testid="verify-chain-btn"
              onClick={verifyChain}
              disabled={verifying}
              className="btn-secondary"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', opacity: verifying ? 0.5 : 1 }}
            >
              {verifying ? 'Verifying...' : 'Verify chain'}
            </button>
          </div>
        )}
      </div>

      {/* Backfill banner — only when an admin sees a null-hash break.
          Surfaces the count of unchained rows + a Run Backfill action
          that POSTs to /api/audit/backfill (per-tenant, idempotent).
          Distinct from the red-chip "contact support" path: that's for
          a row whose recomputed hash disagrees with the stored one,
          which a backfill MUST NOT silently overwrite. */}
      {isAdmin && integrity && integrity.unhashedRows > 0 && integrity.reason && /null hash/i.test(integrity.reason) && (
        <div
          data-testid="integrity-backfill-banner"
          className="card audit-backfill-banner"
          style={{
            padding: '0.85rem 1.25rem',
            marginBottom: '1.25rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.85rem',
            flexWrap: 'wrap',
          }}
        >
          <ShieldQuestion size={18} className="audit-backfill-icon" />
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="audit-backfill-title" style={{ fontWeight: 600 }}>
              Backfill required — {integrity.unhashedRows} {integrity.unhashedRows === 1 ? 'row is' : 'rows are'} unchained
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              Audit rows added before tamper-evidence hashing was enabled lack
              a {`prevHash`}/{`hash`} pair. Run the backfill to chain them — the
              operation is idempotent and writes nothing if every row already
              has a valid hash.
            </div>
          </div>
          <button
            data-testid="run-backfill-btn"
            onClick={runBackfill}
            disabled={backfilling}
            className="btn-primary audit-backfill-button"
            style={{
              fontSize: '0.8rem',
              padding: '0.5rem 1rem',
              opacity: backfilling ? 0.5 : 1,
            }}
          >
            {backfilling ? 'Running backfill...' : 'Run backfill'}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr className="audit-table-header-row">
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
                      className={isOpen ? 'audit-row audit-row--expanded' : 'audit-row'}
                      style={{
                        cursor: 'pointer',
                        borderTop: '1px solid var(--border-color)',
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
                        {/* #387: forensic timing must be unambiguous. Render
                            in IST with an explicit timezone label so a row
                            reads "29/04/2026, 14:30:00 IST" rather than a
                            naive local-time string. */}
                        {new Date(log.createdAt).toLocaleString('en-IN', {
                          timeZone: 'Asia/Kolkata',
                          timeZoneName: 'short',
                        })}
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
                      <tr className="audit-row-drawer">
                        <td></td>
                        <td colSpan={5} style={{ padding: '1rem 1.25rem 1.5rem' }}>
                          {/* #558 — Display truncated hash + prevHash so an
                              operator can spot-check chain continuity in the
                              UI without dropping to the verify endpoint. The
                              full 64-char hex is rarely useful on screen; the
                              first 12 chars (48 bits) are plenty for a
                              human-eye continuity check. */}
                          {(log.hash || log.prevHash) && (
                            <div style={{
                              display: 'flex',
                              gap: '1.25rem',
                              fontFamily: 'monospace',
                              fontSize: '0.72rem',
                              color: 'var(--text-secondary)',
                              marginBottom: '0.85rem',
                            }}>
                              <span data-testid="row-hash">
                                hash: <span style={{ color: 'var(--text-primary)' }}>
                                  {log.hash ? `${log.hash.slice(0, 12)}…` : '(unchained)'}
                                </span>
                              </span>
                              <span data-testid="row-prevhash">
                                prev: <span style={{ color: 'var(--text-primary)' }}>
                                  {log.prevHash
                                    ? log.prevHash.startsWith('GENESIS_')
                                      ? log.prevHash
                                      : `${log.prevHash.slice(0, 12)}…`
                                    : '(unchained)'}
                                </span>
                              </span>
                            </div>
                          )}
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
