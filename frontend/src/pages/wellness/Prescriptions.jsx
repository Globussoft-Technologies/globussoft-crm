import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PenTool,
  Search,
  Download,
  Loader2,
  X,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { formatDate } from '../../utils/date';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import TopScrollSync from '../../components/TopScrollSync';

/**
 * Prescriptions — tenant-wide list of every prescription the signed-in
 * user can see, with a patient filter, a row-level PDF download, and a
 * deep-link to /wellness/patients/:id when the user wants the full
 * chart context. Wraps GET /api/wellness/prescriptions for the list
 * and GET /api/wellness/prescriptions/:id/pdf for the download.
 *
 * Visibility: gated on prescriptions.read via the page catalog. The
 * PDF download endpoint inherits the same RBAC + tenant scope as the
 * list endpoint on the backend, so any role with read access here can
 * pull a PDF for any prescription returned in the list.
 */
export default function Prescriptions() {
  const notify = useNotify();
  const { hasPermission, isReady: permsReady } = usePermissions();
  // A prescription PDF is a RENDERING of data the user can already see on
  // screen — not a bulk data export. So we gate the Download button on
  // `prescriptions.read` (every role that reaches this page has it),
  // not on `prescriptions.export` (which is reserved for bulk extraction
  // flows like patient-history CSV). Doctor, Nurse, and the patient-portal
  // CUSTOMER role all carry prescriptions.read and can download.
  const canDownload = !permsReady || hasPermission('prescriptions', 'read');

  // ── Patient picker (optional filter) ────────────────────────────
  const [patientQuery, setPatientQuery] = useState('');
  const [patientOptions, setPatientOptions] = useState([]);
  const [patientSearchOpen, setPatientSearchOpen] = useState(false);
  const [patientSearchLoading, setPatientSearchLoading] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState(null); // {id, name}
  const searchDebounceRef = useRef(null);

  useEffect(() => {
    if (!patientSearchOpen) return undefined;
    const q = patientQuery.trim();
    // Empty query = show recent patients (server returns ordered list).
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setPatientSearchLoading(true);
      // Patients list endpoint uses `?q=` (substring match across name /
      // phone / email — see GET /api/wellness/patients in routes/wellness.js).
      const url = q
        ? `/api/wellness/patients?q=${encodeURIComponent(q)}&limit=15`
        : '/api/wellness/patients?limit=15';
      fetchApi(url, { silent: true })
        .then((res) => {
          // GET /api/wellness/patients returns { patients, total }; older
          // generic shapes returned a bare array or { items: [...] }.
          const list = Array.isArray(res)
            ? res
            : Array.isArray(res?.patients)
              ? res.patients
              : Array.isArray(res?.items)
                ? res.items
                : [];
          setPatientOptions(list);
        })
        .catch(() => setPatientOptions([]))
        .finally(() => setPatientSearchLoading(false));
    }, 200);
    return () => clearTimeout(searchDebounceRef.current);
  }, [patientQuery, patientSearchOpen]);

  // ── Prescription list ───────────────────────────────────────────
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [limit, setLimit] = useState(50);
  const [skip, setSkip] = useState(0);
  const [downloadingId, setDownloadingId] = useState(null);

  const loadPrescriptions = () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('skip', String(skip));
    if (selectedPatient?.id) params.set('patientId', String(selectedPatient.id));
    fetchApi(`/api/wellness/prescriptions?${params.toString()}`, { silent: true })
      .then((res) => {
        // Envelope: { items, total }. Older deploys returned a bare array;
        // fall back so the page stays usable during a deploy roll.
        if (Array.isArray(res)) {
          setItems(res);
          setTotal(res.length);
        } else {
          setItems(Array.isArray(res?.items) ? res.items : []);
          setTotal(Number.isFinite(res?.total) ? res.total : 0);
        }
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load prescriptions');
        setItems([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  };

  useEffect(loadPrescriptions, [selectedPatient?.id, limit, skip]);

  // Reset to page 1 whenever the filter or page-size changes so we don't
  // strand the user on a page that no longer exists in the new window.
  useEffect(() => { setSkip(0); }, [selectedPatient?.id, limit]);

  // ── Per-row PDF download ────────────────────────────────────────
  const downloadPdf = async (rx) => {
    if (downloadingId) return;
    setDownloadingId(rx.id);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/prescriptions/${rx.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `PDF download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // Trigger an actual file download rather than window.open() (which only
      // opens the blob in the browser's PDF viewer instead of saving it).
      const a = document.createElement('a');
      a.href = url;
      a.download = `prescription-${rx.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after 60s to avoid keeping a blob URL pinned to the page.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      notify.error(err.message || 'Failed to download prescription PDF.');
    } finally {
      setDownloadingId(null);
    }
  };

  // ── Drug summary (first 2 drugs, then "+N more") ────────────────
  const summariseDrugs = (rx) => {
    let drugs = rx?.drugs;
    if (typeof drugs === 'string') {
      try { drugs = JSON.parse(drugs); } catch { drugs = []; }
    }
    if (!Array.isArray(drugs) || drugs.length === 0) return '—';
    const head = drugs.slice(0, 2).map((d) => d?.name || d?.drugName || '').filter(Boolean);
    const more = drugs.length - head.length;
    return more > 0 ? `${head.join(', ')} + ${more} more` : head.join(', ');
  };

  const pageStart = total === 0 ? 0 : skip + 1;
  const pageEnd = Math.min(skip + items.length, total);
  const canPrev = skip > 0 && !loading;
  const canNext = skip + limit < total && !loading;
  const headingSuffix = useMemo(
    () => (selectedPatient ? ` for ${selectedPatient.name}` : ''),
    [selectedPatient],
  );

  return (
    <div style={{ padding: '1.5rem 2rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <h1
          style={{
            fontSize: '1.6rem',
            fontWeight: 700,
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <PenTool size={22} /> Prescriptions{headingSuffix}
        </h1>
        <button
          type="button"
          onClick={loadPrescriptions}
          className="btn-secondary"
          title="Refresh"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.4rem 0.75rem',
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            background: 'var(--subtle-bg-2)',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', fontSize: '0.9rem' }}>
        Review issued prescriptions across the clinic and download each as a PDF.
      </div>

      {/* Filters */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: 360 }}>
          <Search
            size={16}
            style={{
              position: 'absolute',
              left: '0.65rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-secondary)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            placeholder={selectedPatient ? selectedPatient.name : 'Filter by patient…'}
            value={patientQuery}
            onChange={(e) => {
              setPatientQuery(e.target.value);
              setPatientSearchOpen(true);
            }}
            onFocus={() => setPatientSearchOpen(true)}
            // Defer blur so the click on a result is registered first.
            onBlur={() => setTimeout(() => setPatientSearchOpen(false), 150)}
            style={{
              width: '100%',
              padding: '0.5rem 2.1rem 0.5rem 2.1rem',
              borderRadius: 8,
              border: '1px solid var(--border-color)',
              background: 'var(--subtle-bg-2)',
              color: 'inherit',
              fontSize: '0.9rem',
            }}
          />
          {selectedPatient && (
            <button
              type="button"
              onClick={() => {
                setSelectedPatient(null);
                setPatientQuery('');
              }}
              title="Clear patient filter"
              style={{
                position: 'absolute',
                right: '0.4rem',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '0.2rem',
                lineHeight: 0,
              }}
            >
              <X size={14} />
            </button>
          )}
          {patientSearchOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                maxHeight: 260,
                overflowY: 'auto',
                background: 'var(--bg-color, #fff)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.25))',
                zIndex: 20,
              }}
            >
              {patientSearchLoading && (
                <div
                  style={{
                    padding: '0.6rem 0.85rem',
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Searching…
                </div>
              )}
              {!patientSearchLoading && patientOptions.length === 0 && (
                <div
                  style={{
                    padding: '0.6rem 0.85rem',
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  No matching patients.
                </div>
              )}
              {patientOptions.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  // onMouseDown fires BEFORE the input's blur — using
                  // onClick would let the dropdown close before this
                  // handler ran. Same trick as combobox best-practice.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSelectedPatient({ id: p.id, name: p.name });
                    setPatientQuery('');
                    setPatientSearchOpen(false);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.55rem 0.85rem',
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: '0.88rem',
                    borderBottom: '1px solid var(--border-color)',
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = 'var(--subtle-bg-3)')
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = 'transparent')
                  }
                >
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  {p.phone && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                      {p.phone}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Show
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            style={{
              marginLeft: '0.5rem',
              padding: '0.4rem 0.6rem',
              borderRadius: 6,
              border: '1px solid var(--border-color)',
              background: 'var(--subtle-bg-2)',
              color: 'inherit',
              fontSize: '0.85rem',
            }}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </label>
      </div>

      {/* Table */}
      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 10,
          overflow: 'visible',
          background: 'var(--subtle-bg-2)',
        }}
      >
        <TopScrollSync>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ background: 'var(--subtle-bg-3)' }}>
              <Th>Rx #</Th>
              <Th>Issued</Th>
              <Th>Patient</Th>
              <Th>Doctor</Th>
              <Th>Drugs</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} style={emptyCell}>
                  <Loader2 size={16} className="spin" /> Loading prescriptions…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={6} style={{ ...emptyCell, color: 'var(--danger-color, #e57373)' }}>
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && items.length === 0 && (
              <tr>
                <td colSpan={6} style={emptyCell}>
                  {selectedPatient
                    ? `No prescriptions yet for ${selectedPatient.name}.`
                    : 'No prescriptions found in the selected window.'}
                </td>
              </tr>
            )}
            {!loading && !error && items.map((rx) => (
              <tr
                key={rx.id}
                style={{ borderTop: '1px solid var(--border-color)' }}
              >
                <Td><code style={{ fontSize: '0.82rem' }}>#{rx.id}</code></Td>
                <Td>{formatDate(rx.createdAt)}</Td>
                <Td>
                  {rx.patient?.name ? (
                    <a
                      href={`/wellness/patients/${rx.patient.id}`}
                      style={{
                        color: 'var(--primary-color, var(--accent-color))',
                        textDecoration: 'none',
                      }}
                    >
                      {rx.patient.name}
                    </a>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)' }}>—</span>
                  )}
                </Td>
                <Td>{rx.doctor?.name || <span style={{ color: 'var(--text-secondary)' }}>—</span>}</Td>
                <Td>{summariseDrugs(rx)}</Td>
                <Td align="right">
                  <button
                    type="button"
                    onClick={() => downloadPdf(rx)}
                    disabled={downloadingId === rx.id || !canDownload}
                    title={
                      !canDownload
                        ? 'You don’t have permission to download prescriptions.'
                        : 'Download as PDF'
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.7rem',
                      borderRadius: 6,
                      border: '1px solid var(--border-color)',
                      background: 'var(--primary-color, var(--accent-color))',
                      color: '#fff',
                      cursor:
                        downloadingId === rx.id || !canDownload
                          ? 'not-allowed'
                          : 'pointer',
                      opacity: !canDownload ? 0.5 : 1,
                      fontSize: '0.82rem',
                    }}
                  >
                    {downloadingId === rx.id ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <Download size={13} />
                    )}
                    PDF
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        </TopScrollSync>
      </div>

      {!loading && !error && total > 0 && (
        <div
          style={{
            marginTop: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            fontSize: '0.82rem',
            color: 'var(--text-secondary)',
          }}
        >
          <div>
            Showing {pageStart}–{pageEnd} of {total} prescription
            {total === 1 ? '' : 's'}
            {selectedPatient ? ` for ${selectedPatient.name}` : ''}.
          </div>
          {total > limit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <button
                type="button"
                onClick={() => setSkip((s) => Math.max(0, s - limit))}
                disabled={!canPrev}
                style={pagerButton(!canPrev)}
              >
                <ChevronLeft size={14} /> Previous
              </button>
              <button
                type="button"
                onClick={() => setSkip((s) => s + limit)}
                disabled={!canNext}
                style={pagerButton(!canNext)}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const pagerButton = (disabled) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.4rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: disabled ? 'transparent' : 'var(--subtle-bg-2)',
  color: 'inherit',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  fontSize: '0.82rem',
});

const thStyle = {
  textAlign: 'left',
  padding: '0.65rem 0.85rem',
  fontWeight: 600,
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-secondary)',
};
const tdStyle = { padding: '0.7rem 0.85rem', verticalAlign: 'top' };
const emptyCell = {
  padding: '1.5rem 0.85rem',
  textAlign: 'center',
  color: 'var(--text-secondary)',
};

function Th({ children, align = 'left' }) {
  return <th style={{ ...thStyle, textAlign: align }}>{children}</th>;
}
function Td({ children, align = 'left' }) {
  return <td style={{ ...tdStyle, textAlign: align }}>{children}</td>;
}
