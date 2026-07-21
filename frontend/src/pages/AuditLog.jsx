import React, { useState, useEffect, useCallback, useMemo, useContext } from 'react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import { ScrollText, Filter, Download, ChevronDown, User, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import TopScrollSync from '../components/TopScrollSync';

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

// Human-readable labels for the most common audit-details keys. Anything
// not listed falls back to a title-cased version of the key (handled in
// the renderer). Keep this list in sync with what writeAudit callers
// actually emit so reviewers see plain English, not snake_case.
const DETAIL_LABELS = {
  scope: 'Scope',
  viewerRole: 'Viewer role',
  viewerWellnessRole: 'Viewer wellness role',
  recordCount: 'Records viewed',
  recordIds: 'Record IDs',
  disclosedFields: 'Disclosed fields',
  changedFields: 'Changed fields',
  changed: 'Changed fields',
  targetUserId: 'Target user ID',
  targetEmail: 'Target email',
  name: 'Name',
  parentId: 'Parent ID',
  imageUrl: 'Image URL',
  via: 'Trigger',
  reason: 'Reason',
  fieldsChanged: 'Fields changed',
  applied: 'Applied rules',
  skipped: 'Skipped rules',
  _actorType: 'Actor type',
  _patientActorId: 'Patient actor ID',
  _raw: 'Raw note',
};

// Some keys carry enums we can render more nicely.
const SCOPE_LABELS = {
  location_list: 'Location list view',
  patient_list: 'Patient list view',
  staff_list: 'Staff directory view',
  contact_list: 'Contact list view',
  user_list: 'User list view',
  audit_viewer: 'Audit viewer',
};

function labelFor(key) {
  if (DETAIL_LABELS[key]) return DETAIL_LABELS[key];
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// ── Entity-name resolver for `recordIds` chips ─────────────────────
//
// Audit details payloads often carry `recordIds: [24, 23, 22, …]` —
// useful for ops triage but illegible to a non-engineer. Look up the
// actual rows via the appropriate list endpoint and surface the row's
// display name (with the numeric id kept as a subtitle so a Ctrl-F still
// finds it). Lookups are cached at module level — opening another audit
// row that references the same entity reuses the previous fetch.
//
// Only the entities below are resolvable. Anything else falls back to
// bare ID chips. Each row of this table maps the audit `entity` field
// (the canonical writeAudit argument — "User", "Patient", …) to:
//   endpoint    a tenant-scoped GET that returns a list of rows
//   nameField   which row field carries the human-readable label
//   emailField  optional — surfaced underneath the name if present
const ENTITY_LOOKUP = {
  User:     { endpoint: '/api/staff',              nameField: 'name', emailField: 'email' },
  Patient:  { endpoint: '/api/wellness/patients',  nameField: 'name', emailField: 'phone' },
  Location: { endpoint: '/api/wellness/locations', nameField: 'name' },
  Contact:  { endpoint: '/api/contacts',           nameField: 'name', emailField: 'email' },
};

// Module-level cache: entity → Promise<Map<id, { name, email? }>>.
// Storing the in-flight Promise (not the resolved Map) lets concurrent
// callers de-dupe to a single network fetch.
const _entityNameCache = new Map();

export function __clearEntityCacheForTests() {
  _entityNameCache.clear();
}

async function loadEntityNames(entity) {
  if (!entity || !ENTITY_LOOKUP[entity]) return null;
  if (_entityNameCache.has(entity)) return _entityNameCache.get(entity);
  const { endpoint, nameField, emailField } = ENTITY_LOOKUP[entity];
  const promise = (async () => {
    try {
      const rows = await fetchApi(endpoint);
      // Some endpoints return a bare array; others wrap as { items, total }
      // or { logs, … }. Accept any field that's a plain array of rows.
      const list = Array.isArray(rows)
        ? rows
        : Array.isArray(rows?.items) ? rows.items
        : Array.isArray(rows?.rows) ? rows.rows
        : [];
      const map = new Map();
      for (const r of list) {
        if (r && r.id != null) {
          map.set(r.id, {
            name: r[nameField] || `#${r.id}`,
            email: emailField ? r[emailField] : undefined,
          });
        }
      }
      return map;
    } catch {
      // Lookup failed — clear the cache so a subsequent open can retry,
      // then return null so the caller falls back to bare ID chips.
      _entityNameCache.delete(entity);
      return null;
    }
  })();
  _entityNameCache.set(entity, promise);
  return promise;
}

// React context — DetailsView wraps its tree in <EntityContext.Provider>
// so the recordIds renderer downstream can read the audit row's `entity`
// without each layer threading the prop through manually.
const EntityContext = React.createContext(null);

function RecordIdChips({ ids }) {
  const entity = useContext(EntityContext);
  const resolvable = entity && ENTITY_LOOKUP[entity];
  const [nameMap, setNameMap] = useState(null);
  const [loading, setLoading] = useState(Boolean(resolvable));

  useEffect(() => {
    if (!resolvable) {
      setLoading(false);
      setNameMap(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    loadEntityNames(entity).then((result) => {
      if (!cancelled) {
        setNameMap(result);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [entity, resolvable]);

  return (
    <div
      data-testid="record-id-chips"
      style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}
    >
      {ids.map((id, i) => {
        const meta = nameMap?.get(id);
        const showName = Boolean(meta?.name);
        return (
          <span
            key={i}
            data-testid="record-id-chip"
            title={showName ? `ID #${id}` : undefined}
            style={{
              padding: '0.2rem 0.6rem',
              borderRadius: 999,
              background: 'var(--input-bg)',
              border: '1px solid var(--border-color)',
              fontSize: showName ? '0.78rem' : '0.75rem',
              fontFamily: showName ? 'inherit' : 'monospace',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              lineHeight: 1.3,
            }}
          >
            {loading ? (
              <span style={{ color: 'var(--text-secondary)' }}>#{id}…</span>
            ) : showName ? (
              <>
                <span>{meta.name}</span>
                <span style={{
                  fontFamily: 'monospace',
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                }}>
                  #{id}
                </span>
              </>
            ) : (
              <span>#{id}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// Render a single value cell. Arrays become inline chips; objects with a
// {from, to} shape (Prisma-diff style) become "old → new"; nested
// objects fall back to a compact inline JSON serialization at one level
// deep.
function renderValue(key, value) {
  if (value === null || value === undefined) {
    return <span style={{ color: 'var(--text-muted, #6b7280)' }}>—</span>;
  }
  // {from, to} diff payload (changedFields / changed entries).
  if (isPlainObject(value) && ('from' in value || 'to' in value)) {
    return (
      <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
        <span style={{ color: '#ef4444' }}>{formatScalar(value.from)}</span>
        <span style={{ margin: '0 0.4rem', color: 'var(--text-secondary)' }}>→</span>
        <span style={{ color: '#10b981' }}>{formatScalar(value.to)}</span>
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span style={{ color: 'var(--text-muted, #6b7280)' }}>(none)</span>;
    }
    // recordIds gets the enriched lookup — pulls name/email from the
    // matching list endpoint (see ENTITY_LOOKUP above) and renders the
    // chips with the human label + numeric id subtitle.
    if (key === 'recordIds' && value.every((v) => typeof v === 'number')) {
      return <RecordIdChips ids={value} />;
    }
    // Primitive arrays → chips.
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
          {value.map((v, i) => (
            <span
              key={i}
              style={{
                padding: '0.15rem 0.55rem',
                borderRadius: 999,
                background: 'var(--input-bg)',
                border: '1px solid var(--border-color)',
                fontSize: '0.75rem',
                fontFamily: 'monospace',
              }}
            >
              {formatScalar(v)}
            </span>
          ))}
        </div>
      );
    }
    // Array of objects — render each as a small block.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {value.map((v, i) => (
          <div key={i} style={{ paddingLeft: '0.75rem', borderLeft: '2px solid var(--border-color)' }}>
            {renderObjectAsRows(v, { compact: true })}
          </div>
        ))}
      </div>
    );
  }
  if (isPlainObject(value)) {
    return (
      <div style={{ paddingLeft: '0.5rem' }}>
        {renderObjectAsRows(value, { compact: true })}
      </div>
    );
  }
  // Special-case scope enum.
  if (key === 'scope' && typeof value === 'string' && SCOPE_LABELS[value]) {
    return (
      <span>
        {SCOPE_LABELS[value]}
        <span style={{
          marginLeft: '0.5rem',
          color: 'var(--text-secondary)',
          fontSize: '0.72rem',
          fontFamily: 'monospace',
        }}>
          ({value})
        </span>
      </span>
    );
  }
  return formatScalar(value);
}

function formatScalar(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  // ISO date detection (very loose — only matches the actual timestamps
  // we tend to stamp into details).
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    try {
      return new Date(v).toLocaleString();
    } catch {
      /* fall through */
    }
  }
  return String(v);
}

// Render an object as a 2-column key/value layout. `compact` shrinks the
// row spacing so nested object children read as a sub-block.
function renderObjectAsRows(obj, { compact = false } = {}) {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return <span style={{ color: 'var(--text-muted, #6b7280)' }}>(empty)</span>;
  }
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(140px, max-content) 1fr',
      columnGap: '1rem',
      rowGap: compact ? '0.25rem' : '0.5rem',
    }}>
      {keys.map((k) => (
        <React.Fragment key={k}>
          <div style={{
            color: 'var(--text-secondary)',
            fontSize: '0.78rem',
            fontWeight: 500,
            paddingTop: '0.05rem',
          }}>
            {labelFor(k)}
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-primary)' }}>
            {renderValue(k, obj[k])}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// Top-level details renderer used inside the expanded audit row. Returns
// JSX (NOT a string) so the caller renders it as a real layout instead of
// dumping the JSON. Falls back to the raw blob when the details payload
// can't be parsed (e.g. legacy unstructured "plain string" details).
//
// `entity` is the audit row's entity field (e.g. "User", "Patient"). It's
// passed down via EntityContext so the recordIds chip renderer can join
// the numeric IDs against the matching list endpoint and surface names
// instead of bare numbers. Optional — if absent or unresolvable, IDs
// render as `#N`.
function DetailsView({ raw, entity }) {
  const [showJson, setShowJson] = useState(false);
  if (!raw) {
    return <span style={{ color: 'var(--text-muted, #6b7280)' }}>(no details)</span>;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — surface the raw note inline.
    return (
      <pre style={{
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text-secondary)',
        fontSize: '0.82rem',
      }}>
        {raw}
      </pre>
    );
  }
  // Primitive / array-at-top JSON — render generically.
  if (!isPlainObject(parsed)) {
    return (
      <EntityContext.Provider value={entity || null}>
        <div style={{ fontSize: '0.82rem' }}>{renderValue('details', parsed)}</div>
      </EntityContext.Provider>
    );
  }
  return (
    <EntityContext.Provider value={entity || null}>
    <div>
      {renderObjectAsRows(parsed)}
      <button
        type="button"
        onClick={() => setShowJson((s) => !s)}
        style={{
          marginTop: '0.85rem',
          background: 'transparent',
          border: '1px solid var(--border-color)',
          borderRadius: 6,
          padding: '0.3rem 0.65rem',
          fontSize: '0.7rem',
          letterSpacing: '0.03em',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
      >
        {showJson ? 'Hide raw JSON' : 'Show raw JSON'}
      </button>
      {showJson && (
        <pre style={{
          marginTop: '0.5rem',
          background: 'var(--input-bg)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          padding: '0.85rem',
          fontSize: '0.74rem',
          color: 'var(--text-secondary)',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {JSON.stringify(parsed, null, 2)}
        </pre>
      )}
    </div>
    </EntityContext.Provider>
  );
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
    const ok = await notify.confirm({
      title: 'Repair audit chain',
      message:
        'Re-stamp the link/hash on any row that has the wrong anchor. ' +
        'Row content is never modified. If a row was actually tampered with, the repair will ' +
        'abort and show the affected row ID. Continue?',
      confirmText: 'Repair',
    });
    if (!ok) return;
    setBackfilling(true);
    try {
      const data = await fetchApi('/api/audit/backfill', { method: 'POST' });
      notify.success(
        `Chain repair complete — re-linked ${data.updatedRows} ${data.updatedRows === 1 ? 'row' : 'rows'}` +
        (data.skippedRows ? `, ${data.skippedRows} already valid.` : '.')
      );
      await verifyChain();
    } catch (err) {
      console.error('[AuditLog] backfill failed', err);
      // fetchApi attaches the parsed error body to err.data (see utils/api.js).
      // 409 → body.conflictRowId is populated; surface the row id so ops can
      // open the incident. Other failures get a generic toast — fetchApi
      // already raised one for the user.
      const body = err?.data;
      if (body?.conflictRowId != null) {
        notify.error(
          `Repair aborted: row #${body.conflictRowId} appears to have been tampered with ` +
          `(its content doesn't match its stored hash). Please investigate this row before retrying.`
        );
      }
    } finally {
      setBackfilling(false);
    }
  }, [isAdmin, notify, verifyChain]);

  useEffect(() => { verifyChain(); }, [verifyChain]);

  const loadStats = useCallback(async () => {
    try {
      const s = await fetchApi('/api/audit-viewer/stats');
      setStats(s);
    } catch (err) {
      console.error('[AuditLog] stats failed', err);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [entity, action, from, to]);

  // Flattened fetch effect — builds the query string inline and fetches
  // whenever page or any filter changes. Replaces the previous cascade of
  // useMemo(queryString) → useCallback(load) → useEffect(load).
  useEffect(() => {
    let cancelled = false;
    const doLoad = async () => {
      setLoading(true);
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (entity) params.set('entity', entity);
      if (action) params.set('action', action);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      try {
        const data = await fetchApi(`/api/audit-viewer?${params.toString()}`);
        if (cancelled) return;
        setLogs(Array.isArray(data?.logs) ? data.logs : []);
        setPages(data?.pages || 1);
        setTotal(data?.total || 0);
      } catch (err) {
        if (cancelled) return;
        console.error('[AuditLog] load failed', err);
        setLogs([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    doLoad();
    return () => { cancelled = true; };
  }, [page, entity, action, from, to, limit]);

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
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.3rem 0.7rem',
                  borderRadius: 999,
                  background: 'rgba(16, 185, 129, 0.12)',
                  color: '#10b981',
                  border: '1px solid rgba(16, 185, 129, 0.4)',
                  fontWeight: 600,
                }}
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
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.3rem 0.7rem',
                  borderRadius: 999,
                  background: 'rgba(234, 179, 8, 0.12)',
                  color: '#eab308',
                  border: '1px solid rgba(234, 179, 8, 0.4)',
                  fontWeight: 600,
                }}
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
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.3rem 0.7rem',
                  borderRadius: 999,
                  background: 'rgba(239, 68, 68, 0.12)',
                  color: '#ef4444',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  fontWeight: 600,
                }}
              >
                <ShieldAlert size={14} />
                Chain anomaly detected
                {integrity.brokenAt != null && (
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '0.78rem' }}>
                    (row #{integrity.brokenAt})
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

      {/* Repair banner — shown for any broken chain an admin can see.
          Two flavours of break:
            1. Unhashed rows (legacy / pre-tamper-evidence rows that
               were never chained). Backfill writes their hash + link.
            2. prevHash mismatch where the row's CONTENT recomputes
               correctly under its STORED prevHash — a "forked anchor"
               race (writeAudit raced against a still-unbacklfilled tail
               or two writers wrote in the same millisecond). Backfill
               re-stamps the anchor + hash for these rows so the chain
               re-validates.
          Backfill is idempotent and safe in both cases: if a row's
          content has been tampered with, the endpoint 409s with the
          conflict row id rather than silently overwriting. That 409 is
          the ONLY signal that warrants escalation. The toast in
          runBackfill surfaces the row id when this happens. */}
      {isAdmin && integrity && !integrity.integrityVerified && integrity.reason && (
        <div
          data-testid="integrity-backfill-banner"
          className="card"
          style={{
            padding: '0.85rem 1.25rem',
            marginBottom: '1.25rem',
            background: 'rgba(234, 179, 8, 0.06)',
            border: '1px solid rgba(234, 179, 8, 0.4)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.85rem',
            flexWrap: 'wrap',
          }}
        >
          <ShieldQuestion size={18} color="#eab308" />
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, color: '#eab308' }}>
              {integrity.unhashedRows > 0
                ? `Repair needed — ${integrity.unhashedRows} ${integrity.unhashedRows === 1 ? 'row is' : 'rows are'} unchained`
                : `Repair needed — chain link broken at row #${integrity.brokenAt}`}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              {integrity.unhashedRows > 0 ? (
                <>
                  Some audit rows lack a hash/prev-hash pair — usually rows
                  written before tamper-evidence was turned on. Run the repair
                  to chain them. The operation is idempotent and writes nothing
                  if every row already has a valid hash.
                </>
              ) : (
                <>
                  An audit row's link to its predecessor doesn't match — almost
                  always a write-race where two audit writers stamped against a
                  stale tail. The repair tool re-stamps the anchor for any row
                  whose content recomputes correctly; if a row was actually
                  tampered with, the repair aborts and surfaces the row ID so
                  you can investigate (your data stays untouched).
                </>
              )}
            </div>
          </div>
          <button
            data-testid="run-backfill-btn"
            onClick={runBackfill}
            disabled={backfilling}
            className="btn-primary"
            style={{
              fontSize: '0.8rem',
              padding: '0.5rem 1rem',
              background: '#eab308',
              borderColor: '#eab308',
              opacity: backfilling ? 0.5 : 1,
            }}
          >
            {backfilling ? 'Repairing…' : 'Repair chain'}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <TopScrollSync>
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
                      <tr style={{ background: 'rgba(15,23,42,0.4)' }}>
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
                          <div style={{
                            background: 'var(--input-bg)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 8,
                            padding: '1rem',
                          }}>
                            {/* v3.7.17 — pass log.entity so RecordIdChips can
                                resolve numeric IDs to display names via the
                                matching list endpoint (ENTITY_LOOKUP). */}
                            <DetailsView raw={log.details} entity={log.entity} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </TopScrollSync>

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
