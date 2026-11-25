import { formatDateTime, tenantTimezone } from '../utils/date';
import React, { useState, useEffect, useContext, useMemo, useRef } from 'react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../appContexts';
import { ScrollText, Filter, Upload, ChevronDown, User, Search, X, Check } from 'lucide-react';
import TopScrollSync from '../components/TopScrollSync';
import './AuditLog.css';

const ACTION_COLOR = {
  CREATE: '#10b981',
  UPDATE: '#3b82f6',
  DELETE: '#ef4444',
};
const OTHER_COLOR = '#6b7280';

function actionColor(action) {
  if (action === 'HARD_DELETE' || action === 'SOFT_DELETE' || /(?:^|_)DELETE$/.test(String(action || ''))) {
    return ACTION_COLOR.DELETE;
  }
  return ACTION_COLOR[action] || OTHER_COLOR;
}

const ENTITY_OPTIONS = [
  'Contact', 'Deal', 'Invoice', 'Estimate', 'Expense', 'Contract',
  'Project', 'Task', 'Ticket', 'Campaign', 'Sequence', 'User', 'Quote',
];

const FILTER_OPTIONS = [
  { id: 'entity', label: 'Entity', description: 'Choose a record type' },
  { id: 'action', label: 'Action', description: 'Choose an activity type' },
  { id: 'dateTime', label: 'Date & time', description: 'Set a start and end time' },
];

function toApiDateTime(value, timezone, isEnd = false) {
  if (!value) return '';
  const [datePart, timePart = '00:00'] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return '';

  const localClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let date;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(localClockAsUtc));
    const values = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
    const zoneClockAsUtc = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second),
    );
    date = new Date(localClockAsUtc - (zoneClockAsUtc - localClockAsUtc));
  } catch {
    // If the configured zone isn't recognized, fall back to the browser zone.
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) return '';
  if (isEnd) date.setUTCSeconds(date.getUTCSeconds() + 59, 999);
  return date.toISOString();
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
      {actionLabel(action)}
    </span>
  );
}

function OverviewItem({ label, children }) {
  return (
    <div className="audit-overview-item">
      <div className="audit-overview-item__label">{label}</div>
      <div className="audit-overview-item__value">{children || '—'}</div>
    </div>
  );
}

function ActivityOverview({ log, cacheScope }) {
  const actor = log.user?.name || 'System';
  const entity = humanize(log.entity) || 'Record';
  const hideDetails = hasSensitiveAuditDetails(log);
  return (
    <div className="audit-overview">
      <div className="audit-overview__heading">
        <div>
          <div className="audit-overview__eyebrow">Activity overview</div>
          <h2>{activitySummary(log)}</h2>
        </div>
        <ActionBadge action={log.action} />
      </div>
      <div className="audit-overview__facts">
        <OverviewItem label="Performed by">
          <span>{actor}</span>
          {log.user?.email && <small>{log.user.email}</small>}
        </OverviewItem>
        <OverviewItem label="Date and time">
          {formatAuditTimestamp(log.createdAt, log.viewerTimezone)}
        </OverviewItem>
        <OverviewItem label="Record">
          {hideDetails || log.entityId == null ? entity : `${entity} #${log.entityId}`}
        </OverviewItem>
      </div>
      <section className="audit-overview__details">
        <h3>What happened</h3>
        {hideDetails ? (
          <span>Additional details are not shown for this activity.</span>
        ) : (
          <DetailsView raw={log.details} entity={log.entity} cacheScope={cacheScope} />
        )}
      </section>
    </div>
  );
}

function parseDetails(raw) {
  if (isPlainObject(raw) || Array.isArray(raw)) return raw;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { description: String(raw) };
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

const HIDDEN_DETAIL_KEY = /password|secret|token|api.?key|authorization|cookie|credential|otp|aadhaar|pan|ssn|bank|account.?number|diagnos|^jti$/i;

function humanize(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function actionLabel(action) {
  const value = String(action || '').toUpperCase();
  const exact = {
    CREATE: 'Created',
    UPDATE: 'Updated',
    DELETE: 'Deleted',
    HARD_DELETE: 'Permanently deleted',
    SOFT_DELETE: 'Archived',
    LOGIN: 'Signed in',
    LOGOUT: 'Signed out',
    PII_DISCLOSED: 'Viewed',
    READ: 'Viewed',
    VIEW: 'Viewed',
    EXPORT: 'Exported',
  };
  if (exact[value]) return exact[value];
  const suffixes = [
    [/_(?:HARD_DELETE|PERMANENTLY_DELETED)$/, 'Permanently deleted'],
    [/_(?:SOFT_DELETE|ARCHIVED)$/, 'Archived'],
    [/_CREATE(?:D)?$/, 'Created'],
    [/_UPDATE(?:D)?$/, 'Updated'],
    [/_DELETE(?:D)?$/, 'Deleted'],
    [/_LOGIN(?:NED)?$/, 'Signed in'],
    [/_LOGOUT(?:TED)?$/, 'Signed out'],
    [/_VIEW(?:ED)?$/, 'Viewed'],
    [/_READ$/, 'Viewed'],
    [/_EXPORT(?:ED)?$/, 'Exported'],
    [/_DOWNLOAD(?:ED)?$/, 'Downloaded'],
    [/_SEND(?:T)?$/, 'Sent'],
    [/_DISCLOSED$/, 'Viewed'],
  ];
  for (const [pattern, label] of suffixes) {
    if (pattern.test(value)) return label;
  }
  return humanize(value) || 'Recorded activity';
}

function activitySummary(log) {
  const action = actionLabel(log.action);
  if (['Signed in', 'Signed out'].includes(action)) return action;
  const entity = humanize(log.entity) || 'record';
  const details = parseDetails(log.details);
  const hideDetails = hasSensitiveAuditDetails(log);
  const subject = !hideDetails && isPlainObject(details)
    ? details.name || details.title || details.recordName || details.resourceName || details.poNumber
    : null;
  const safeSubject = subject ? String(subject).slice(0, 100) : '';
  const recordId = hideDetails || log.entityId == null ? '' : ` (#${log.entityId})`;
  return `${action} ${entity}${safeSubject ? ` “${safeSubject}”` : ''}${recordId}`;
}

function hasSensitiveAuditDetails(log) {
  const action = String(log?.action || '').toUpperCase();
  if (action.includes('PII_DISCLOSED') || action.includes('SENSITIVE') || action.endsWith('DISCLOSED')) {
    return true;
  }
  const details = parseDetails(log?.details);
  return isPlainObject(details) && (
    Array.isArray(details.disclosedFields) || details.isSensitive === true || details.sensitive === true
  );
}

function detailsPreview(raw, log) {
  if (hasSensitiveAuditDetails(log)) return 'Access activity recorded';
  const details = stripInternalAuditDetails(parseDetails(raw));
  if (!details) return 'No additional details';
  if (isPlainObject(details) && Object.keys(details).length === 0) return 'No additional details';
  if (typeof details === 'string' || typeof details === 'number') return String(details).slice(0, 120);
  if (!isPlainObject(details)) return 'Activity details available';
  for (const key of ['summary', 'description', 'message', 'reason']) {
    if (details[key] != null && !HIDDEN_DETAIL_KEY.test(key)) {
      return String(details[key]).slice(0, 140);
    }
  }
  const changed = details.changedFields || details.fieldsChanged || details.changed;
  if (Array.isArray(changed) && changed.length) {
    return `Changed: ${changed.map(humanize).slice(0, 4).join(', ')}${changed.length > 4 ? ', …' : ''}`;
  }
  const recordCount = Number(details.recordCount) || (Array.isArray(details.recordIds) ? details.recordIds.length : 0);
  if (recordCount > 0) {
    const isView = /VIEW|READ|DISCLOS|ACCESS/i.test(String(log?.action || ''));
    const fields = Array.isArray(details.disclosedFields)
      ? details.disclosedFields.map(humanize).slice(0, 3).join(', ')
      : '';
    return `${isView ? 'Viewed' : 'Affected'} ${recordCount} record${recordCount === 1 ? '' : 's'}${fields ? ` · Fields: ${fields}` : ''}`;
  }
  const readableEntries = Object.entries(details)
    .filter(([key, value]) => !HIDDEN_DETAIL_KEY.test(key) && !key.startsWith('_') && value != null)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 2)
    .map(([key, value]) => `${labelFor(key)}: ${formatScalar(value)}`);
  if (readableEntries.length) return readableEntries.join(' · ').slice(0, 140);
  const visibleCount = Object.keys(details).filter((key) => !HIDDEN_DETAIL_KEY.test(key) && !key.startsWith('_')).length;
  return visibleCount ? `${visibleCount} additional detail${visibleCount === 1 ? '' : 's'}` : 'Sensitive details hidden';
}

function formatAuditTimestamp(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      timeZone: timezone || tenantTimezone() || 'UTC',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

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

function stripInternalAuditDetails(value) {
  if (Array.isArray(value)) return value.map(stripInternalAuditDetails);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/^jti$/i.test(key))
      .map(([key, child]) => [key, stripInternalAuditDetails(child)]),
  );
}

function searchableDetails(raw) {
  const parsed = parseDetails(raw);
  return parsed == null ? '' : JSON.stringify(stripInternalAuditDetails(parsed)).toLowerCase();
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

// Module-level cache: tenant/user/entity → Promise<Map<id, { name, email? }>>.
// Storing the in-flight Promise (not the resolved Map) lets concurrent
// callers de-dupe to a single network fetch.
const _entityNameCache = new Map();

export function __clearEntityCacheForTests() {
  _entityNameCache.clear();
}

async function loadEntityNames(entity, cacheScope) {
  if (!entity || !ENTITY_LOOKUP[entity]) return null;
  const cacheKey = `${cacheScope}:${entity}`;
  if (_entityNameCache.has(cacheKey)) return _entityNameCache.get(cacheKey);
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
      _entityNameCache.delete(cacheKey);
      return null;
    }
  })();
  _entityNameCache.set(cacheKey, promise);
  return promise;
}

// React context — DetailsView wraps its tree in <EntityContext.Provider>
// so the recordIds renderer downstream can read the audit row's `entity`
// without each layer threading the prop through manually.
const EntityContext = React.createContext(null);

function RecordIdChips({ ids }) {
  const { entity, cacheScope } = useContext(EntityContext) || {};
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
    loadEntityNames(entity, cacheScope).then((result) => {
      if (!cancelled) {
        setNameMap(result);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [entity, cacheScope, resolvable]);

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
// objects are rendered as compact, labeled rows.
function renderValue(key, value) {
  if (HIDDEN_DETAIL_KEY.test(String(key))) {
    return <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>Hidden for privacy</span>;
  }
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
    return SCOPE_LABELS[value];
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
      return formatDateTime(v);
    } catch {
      /* fall through */
    }
  }
  return String(v);
}

// Render an object as a 2-column key/value layout. `compact` shrinks the
// row spacing so nested object children read as a sub-block.
function renderObjectAsRows(obj, { compact = false } = {}) {
  if (!isPlainObject(obj)) {
    return <span style={{ color: 'var(--text-primary)' }}>{formatScalar(obj)}</span>;
  }
  const keys = Object.keys(obj).filter((key) => !key.startsWith('_') && !/^jti$/i.test(key));
  if (keys.length === 0) {
    return <span style={{ color: 'var(--text-muted, #6b7280)' }}>No additional details were recorded.</span>;
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
// labeled JSX rows instead of a JSON dump. Legacy unstructured text is
// presented as a description field.
//
// `entity` is the audit row's entity field (e.g. "User", "Patient"). It's
// passed down via EntityContext so the recordIds chip renderer can join
// the numeric IDs against the matching list endpoint and surface names
// instead of bare numbers. Optional — if absent or unresolvable, IDs
// render as `#N`.
function DetailsView({ raw, entity, cacheScope }) {
  const parsed = parseDetails(raw);
  if (!parsed) {
    return <span style={{ color: 'var(--text-muted, #6b7280)' }}>No additional details were recorded.</span>;
  }
  // Primitive / array-at-top JSON — render generically.
  if (!isPlainObject(parsed)) {
    return (
      <EntityContext.Provider value={{ entity, cacheScope }}>
        <div style={{ fontSize: '0.82rem' }}>{renderValue('details', parsed)}</div>
      </EntityContext.Provider>
    );
  }
  return (
    <EntityContext.Provider value={{ entity, cacheScope }}>
    <div className="audit-detail-fields">
      {renderObjectAsRows(parsed)}
    </div>
    </EntityContext.Provider>
  );
}

export default function AuditLogPage() {
  const { user, tenant } = useContext(AuthContext) || {};
  const cacheScope = [
    tenant?.id ?? user?.tenantId ?? 'unknown-tenant',
    tenant?.vertical ?? user?.tenant?.vertical ?? 'unknown-vertical',
    user?.id ?? user?.userId ?? 'unknown-user',
    user?.role ?? 'unknown-role',
  ].join(':');

  // A tenant switch must remount the page so its prior tenant's rows, stats,
  // expanded details, and cached name lookups disappear before new data loads.
  return <AuditLog key={cacheScope} cacheScope={cacheScope} />;
}

function AuditLog({ cacheScope }) {
  const notify = useNotify();
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 25;

  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [viewerTimezone, setViewerTimezone] = useState(
    () => tenantTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const viewerTimezoneRef = useRef(viewerTimezone);
  viewerTimezoneRef.current = viewerTimezone;
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState([]);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef(null);

  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filterMenuOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!filterMenuRef.current?.contains(event.target)) setFilterMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setFilterMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [filterMenuOpen]);

  const addFilter = (filterId) => {
    setActiveFilters((current) => current.includes(filterId) ? current : [...current, filterId]);
    setFilterMenuOpen(false);
  };

  const removeFilter = (filterId) => {
    setActiveFilters((current) => current.filter((id) => id !== filterId));
    if (filterId === 'entity') setEntity('');
    if (filterId === 'action') setAction('');
    if (filterId === 'dateTime') {
      setFrom('');
      setTo('');
    }
  };

  const clearAllFilters = () => {
    setEntity('');
    setAction('');
    setFrom('');
    setTo('');
    setSearch('');
    setActiveFilters([]);
  };

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
      if (from) params.set('from', toApiDateTime(from, viewerTimezoneRef.current));
      if (to) params.set('to', toApiDateTime(to, viewerTimezoneRef.current, true));
      try {
        const data = await fetchApi(`/api/audit-viewer?${params.toString()}`);
        if (cancelled) return;
        if (data?.viewerTimezone) {
          viewerTimezoneRef.current = data.viewerTimezone;
          setViewerTimezone(data.viewerTimezone);
        }
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
    if (from) params.set('from', toApiDateTime(from, viewerTimezone));
    if (to) params.set('to', toApiDateTime(to, viewerTimezone, true));
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
        activitySummary(l).toLowerCase().includes(q) ||
        detailsPreview(l.details, l).toLowerCase().includes(q) ||
        String(l.entityId || '').includes(q) ||
        (!hasSensitiveAuditDetails(l) && searchableDetails(l.details).includes(q))
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
    <div className="travel-admin-page travel-audit-page" style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header className="travel-audit-page__header" style={{
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
            Tenant-wide activity history. Admin only.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={handleExport}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Upload size={16} /> Export CSV
        </button>
      </header>

      {/* Keep search at the left; optional filters are added on demand. */}
      <div className="card audit-log-toolbar">
        <div className="audit-log-toolbar__main">
          <label className="audit-log-search">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search user, entity, or details..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search audit logs"
            />
          </label>
          {(activeFilters.length > 0 || search) && (
            <button type="button" className="audit-filter-clear-button" onClick={clearAllFilters}>
              Clear all
            </button>
          )}
          <div className="audit-filter-picker" ref={filterMenuRef}>
            <button
              type="button"
              className="audit-filter-add-button"
              onClick={() => setFilterMenuOpen((open) => !open)}
              aria-expanded={filterMenuOpen}
              aria-haspopup="menu"
            >
              <Filter size={16} />
              <span>Add filter</span>
              {activeFilters.length > 0 && <span className="audit-filter-count">{activeFilters.length}</span>}
            </button>
            {filterMenuOpen && (
              <div className="audit-filter-menu" role="menu" aria-label="Choose a filter to add">
                <div className="audit-filter-menu__title">Add a filter</div>
                {FILTER_OPTIONS.map((option) => {
                  const isAdded = activeFilters.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitem"
                      disabled={isAdded}
                      className={isAdded ? 'is-added' : ''}
                      onClick={() => addFilter(option.id)}
                    >
                      <span className="audit-filter-menu__copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      {isAdded && <Check size={16} aria-label="Added" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {activeFilters.length > 0 && (
          <div className="audit-filter-controls" aria-label="Active filters">
            {activeFilters.includes('entity') && (
              <div className="audit-filter-control">
                <label htmlFor="audit-entity-filter">Entity</label>
                <select id="audit-entity-filter" value={entity} onChange={e => setEntity(e.target.value)} style={inputStyle}>
                  <option value="">All entities</option>
                  {ENTITY_OPTIONS.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
                <button type="button" onClick={() => removeFilter('entity')} aria-label="Remove entity filter">
                  <X size={15} />
                </button>
              </div>
            )}
            {activeFilters.includes('action') && (
              <div className="audit-filter-control">
                <label htmlFor="audit-action-filter">Action</label>
                <select id="audit-action-filter" value={action} onChange={e => setAction(e.target.value)} style={inputStyle}>
                  <option value="">All actions</option>
                  <option value="CREATE">Created</option>
                  <option value="UPDATE">Updated</option>
                  <option value="DELETE">Deleted</option>
                  <option value="HARD_DELETE">Permanently deleted</option>
                  <option value="SOFT_DELETE">Archived</option>
                </select>
                <button type="button" onClick={() => removeFilter('action')} aria-label="Remove action filter">
                  <X size={15} />
                </button>
              </div>
            )}
            {activeFilters.includes('dateTime') && (
              <div className="audit-filter-control audit-filter-control--range">
                <div className="audit-filter-timezone">Time zone: <strong>{viewerTimezone}</strong></div>
                <div className="audit-filter-range-field">
                  <label htmlFor="audit-from-filter">From</label>
                  <input
                    id="audit-from-filter"
                    type="datetime-local"
                    value={from}
                    max={to || undefined}
                    onChange={e => setFrom(e.target.value)}
                    style={inputStyle}
                    aria-label="From date and time"
                  />
                </div>
                <div className="audit-filter-range-field">
                  <label htmlFor="audit-to-filter">To</label>
                  <input
                    id="audit-to-filter"
                    type="datetime-local"
                    value={to}
                    min={from || undefined}
                    onChange={e => setTo(e.target.value)}
                    style={inputStyle}
                    aria-label="To date and time"
                  />
                </div>
                <button type="button" onClick={() => removeFilter('dateTime')} aria-label="Remove date and time filter">
                  <X size={15} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="card audit-log-table-card" style={{ padding: 0, overflow: 'hidden' }}>
        <TopScrollSync verticalOverflow="auto">
          <table className="audit-log-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <colgroup>
              <col className="audit-log-expand-column" />
              <col className="audit-log-timestamp-column" />
              <col className="audit-log-user-column" />
              <col className="audit-log-activity-column" />
              <col className="audit-log-details-column" />
            </colgroup>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                <th style={thStyle}></th>
                <th style={thStyle}>Date &amp; time</th>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Activity</th>
                <th style={thStyle}>Details</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</td></tr>
              )}
              {!loading && filteredLogs.length === 0 && (
                <tr><td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No audit events match the current filters.</td></tr>
              )}
              {!loading && filteredLogs.map(log => {
                const isOpen = expanded === log.id;
                return (
                  <React.Fragment key={log.id}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : log.id)}
                      aria-expanded={isOpen}
                      aria-label={`${activitySummary(log)} by ${log.user?.name || 'System'}`}
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
                      <td className="audit-log-timestamp" style={{ ...tdStyle, color: 'var(--text-secondary)' }}>
                        {formatAuditTimestamp(log.createdAt, log.viewerTimezone)}
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
                      <td style={tdStyle}>
                        <div className="audit-log-activity">
                          <ActionBadge action={log.action} />
                          <span>{activitySummary(log)}</span>
                        </div>
                      </td>
                      <td className="audit-log-summary" style={tdStyle}>
                        {detailsPreview(log.details, log)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: 'rgba(15,23,42,0.04)' }}>
                        <td></td>
                        <td colSpan={4} style={{ padding: '1rem 1.25rem 1.5rem' }}>
                          <ActivityOverview log={log} cacheScope={cacheScope} />
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
