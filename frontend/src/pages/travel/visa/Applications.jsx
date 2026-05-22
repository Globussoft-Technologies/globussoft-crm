/**
 * Visa Sure Applications — Phase 3 list view (cluster B3, V8 SHIPPED).
 *
 * Graduates V8 from 🟡 PARTIAL (SHELL) → ✅ SHIPPED.
 * Backend GET endpoint at ce5f5db (/api/travel/visa/applications) returns
 * { applications, total, limit, offset } scoped to the caller's tenant
 * AND Contact.subBrand="visasure". Each row has the application + a
 * decorated { contact: {id, name, email, phone} } projection.
 *
 * Render:
 *   - Header
 *   - Status filter dropdown (all / intake / docs-pending / filed /
 *     approved / rejected / appeal) — pinned to backend VALID_STATUSES,
 *     NOT the dispatch's prose list (the dispatch said "docs-collected"
 *     + "submitted" which the route validator rejects with 400 INVALID_STATUS).
 *   - Pagination (50 per page, prev/next)
 *   - Row table: ID | Contact | Type | Status badge |
 *     Risk pills (3: readiness / risk-flag / complex) | Updated
 *   - Empty state for tenants with no visa apps yet
 *   - Row-click navigates to /travel/visa/applications/:id (sibling
 *     agent wires the AdvisorDashboard detail page this same tick).
 *
 * Visual shape mirrors pages/travel/Itineraries.jsx (the canonical
 * Travel list page) for consistency with the rest of the vertical.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Filter, AlertTriangle, ShieldAlert, Layers } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';

const PAGE_SIZE = 50;

// Pinned to backend VALID_STATUSES in routes/travel_visa.js (ce5f5db).
const STATUSES = [
  { value: '', label: 'All statuses' },
  { value: 'intake', label: 'Intake' },
  { value: 'docs-pending', label: 'Docs pending' },
  { value: 'filed', label: 'Filed' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'appeal', label: 'Appeal' },
];

const STATUS_COLORS = {
  intake: { bg: 'rgba(120,120,120,0.12)', color: '#5C6E82' },
  'docs-pending': { bg: 'rgba(200,154,78,0.16)', color: '#9A6F2E' },
  filed: { bg: 'rgba(47,122,77,0.14)', color: '#2F7A4D' },
  approved: { bg: 'rgba(38,88,85,0.16)', color: '#265855' },
  rejected: { bg: 'rgba(168,50,63,0.14)', color: '#A8323F' },
  appeal: { bg: 'rgba(120,90,170,0.16)', color: '#6E4FA0' },
};

const READINESS_COLORS = {
  ready: { bg: 'rgba(47,122,77,0.14)', color: '#2F7A4D' },
  'partially-ready': { bg: 'rgba(200,154,78,0.16)', color: '#9A6F2E' },
  'not-ready': { bg: 'rgba(168,50,63,0.14)', color: '#A8323F' },
};

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString();
}

function StatusBadge({ status }) {
  if (!status) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  const sc = STATUS_COLORS[status] || { bg: 'var(--subtle-bg)', color: 'var(--text-secondary)' };
  return (
    <span
      style={{
        background: sc.bg,
        color: sc.color,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {status}
    </span>
  );
}

// 3 risk indicator pills: readinessLevel + advisorRiskFlag + complexCase.
// Each surfaces an independent dimension of operational risk on the row.
function RiskPills({ readinessLevel, advisorRiskFlag, complexCase }) {
  const pills = [];

  if (readinessLevel) {
    const rc = READINESS_COLORS[readinessLevel] || {
      bg: 'var(--subtle-bg)',
      color: 'var(--text-secondary)',
    };
    pills.push(
      <span
        key="readiness"
        title={`Readiness: ${readinessLevel}`}
        style={pillStyle(rc.bg, rc.color)}
      >
        <Layers size={10} /> {readinessLevel}
      </span>,
    );
  }

  if (advisorRiskFlag) {
    pills.push(
      <span
        key="risk"
        title="Advisor flagged as risky"
        style={pillStyle('rgba(168,50,63,0.14)', '#A8323F')}
      >
        <ShieldAlert size={10} /> risk
      </span>,
    );
  }

  if (complexCase) {
    pills.push(
      <span
        key="complex"
        title="Complex case (extra review)"
        style={pillStyle('rgba(120,90,170,0.16)', '#6E4FA0')}
      >
        <AlertTriangle size={10} /> complex
      </span>,
    );
  }

  if (pills.length === 0) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  return <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{pills}</div>;
}

function pillStyle(bg, color) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    background: bg,
    color,
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };
}

export default function VisaApplications() {
  const notify = useNotify();
  const navigate = useNavigate();
  const [applications, setApplications] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));
    fetchApi(`/api/travel/visa/applications?${qs.toString()}`)
      .then((res) => {
        setApplications(Array.isArray(res?.applications) ? res.applications : []);
        setTotal(Number(res?.total) || 0);
      })
      .catch((e) => {
        notify.error(e?.body?.error || 'Failed to load visa applications');
        setApplications([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  };

  // Reload whenever filter or page changes.
  useEffect(load, [status, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset offset to 0 when status filter changes so we don't land on an
  // empty page after a narrowing filter.
  const onStatusChange = (v) => {
    setStatus(v);
    setOffset(0);
  };

  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <header style={{ marginBottom: 4 }}>
        <h1
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: 0,
            marginBottom: 4,
          }}
        >
          <FileText size={28} aria-hidden /> Visa Applications
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
          All Visa Sure applications across your tenant. Click a row to open the
          advisor dashboard with diagnostic answers, document checklist, and risk
          indicators.
        </p>
      </header>

      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          alignItems: 'center',
          background: 'var(--surface-color)',
          padding: 12,
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          marginBottom: 16,
        }}
      >
        <Filter
          size={16}
          aria-hidden
          style={{ color: 'var(--text-secondary)' }}
        />
        <select
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          style={refreshBtn}
          aria-label="Reload list"
        >
          Refresh
        </button>
        <div
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}
        >
          {total > 0
            ? `Showing ${pageStart}–${pageEnd} of ${total}`
            : loading
              ? 'Loading…'
              : 'No results'}
        </div>
      </div>

      <div
        style={{
          background: 'var(--surface-color)',
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          overflow: 'hidden',
        }}
      >
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : applications.length === 0 ? (
          <div style={empty}>
            No visa applications yet. Visa Sure applications appear here once
            contacts (Contact.subBrand=&quot;visasure&quot;) have applications
            created in the system.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>ID</th>
                <th style={th}>Contact</th>
                <th style={th}>Type</th>
                <th style={th}>Status</th>
                <th style={th}>Risk indicators</th>
                <th style={th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => navigate(`/travel/visa/applications/${a.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/travel/visa/applications/${a.id}`);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open visa application ${a.id}`}
                  style={{
                    borderTop: '1px solid var(--border-light)',
                    cursor: 'pointer',
                  }}
                >
                  <td style={td}>
                    <strong>#{a.id}</strong>
                  </td>
                  <td style={td}>
                    {a.contact?.name
                      || a.contact?.email
                      || (a.contactId ? `Contact #${a.contactId}` : '—')}
                    {a.destinationCountry && (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--text-secondary)',
                          marginTop: 2,
                        }}
                      >
                        → {a.destinationCountry}
                      </div>
                    )}
                  </td>
                  <td style={td}>{a.applicationType || '—'}</td>
                  <td style={td}>
                    <StatusBadge status={a.status} />
                  </td>
                  <td style={td}>
                    <RiskPills
                      readinessLevel={a.readinessLevel}
                      advisorRiskFlag={a.advisorRiskFlag}
                      complexCase={a.complexCase}
                    />
                  </td>
                  <td style={td}>{fmt(a.updatedAt || a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 16,
          }}
        >
          <button
            type="button"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={!hasPrev}
            style={hasPrev ? refreshBtn : { ...refreshBtn, opacity: 0.4, cursor: 'not-allowed' }}
            aria-label="Previous page"
          >
            ← Prev
          </button>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </div>
          <button
            type="button"
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={!hasNext}
            style={hasNext ? refreshBtn : { ...refreshBtn, opacity: 0.4, cursor: 'not-allowed' }}
            aria-label="Next page"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

const selectStyle = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  minWidth: 160,
  fontSize: 13,
};

const refreshBtn = {
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  cursor: 'pointer',
};

const empty = {
  padding: 32,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 14,
};

const th = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--subtle-bg)',
};

const td = {
  padding: '10px 12px',
  fontSize: 14,
  color: 'var(--text-primary)',
};
