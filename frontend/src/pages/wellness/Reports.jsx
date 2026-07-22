import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, TrendingUp, Stethoscope, MapPin, IndianRupee, Download, Loader2 } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { formatMoney } from '../../utils/money';
import { formatPercent } from '../../utils/percent';
import Avatar from '../../components/Avatar';
import { DateRangeFilter, resolveDateRangeYmd } from '../../components/wellness/DateRangeFilter';
import TopScrollSync from '../../components/TopScrollSync';

const TABS = [
  { key: 'pnl', label: 'P&L by Service', icon: BarChart3 },
  { key: 'pro', label: 'Per Professional', icon: Stethoscope },
  { key: 'loc', label: 'Per Location', icon: MapPin },
  { key: 'att', label: 'Marketing Attribution', icon: TrendingUp },
];

const ENDPOINTS = {
  pnl: '/api/wellness/reports/pnl-by-service',
  pro: '/api/wellness/reports/per-professional',
  loc: '/api/wellness/reports/per-location',
  att: '/api/wellness/reports/attribution',
};

// #227: each tab maps to a base export filename and the same backend endpoint
// stem; we just append .csv / .pdf to the JSON endpoint to hit the export
// siblings.
const EXPORT_BASENAMES = {
  pnl: 'pnl-by-service',
  pro: 'per-professional',
  loc: 'per-location',
  att: 'attribution',
};

export default function Reports() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('pnl');
  // Reports require a window — opt out of "All time" and default to last30
  // (matches the prior 30-day default).
  const [filter, setFilter] = useState({ preset: 'last30', start: '', end: '' });
  const [from, to] = resolveDateRangeYmd(filter);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // #227: a single in-flight flag covers all export buttons — clicking one
  // disables the others for the same tab while we wait, mirroring the UX of
  // the prescription-PDF button in PatientDetail.jsx.
  const [exporting, setExporting] = useState(null); // 'csv' | 'xlsx' | 'pdf' | null
  const [exportError, setExportError] = useState(null);

  const load = () => {
    if (!from || !to) return; // 'custom' preset with no dates yet — skip fetch
    setLoading(true);
    const url = `${ENDPOINTS[tab]}?from=${from}T00:00:00&to=${to}T23:59:59`;
    fetchApi(url).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  // #433: debounce the date-range driven re-fetch. Pre-fix every keystroke
  // in the From/To input (`type=date`) refired `load()`; typing a full
  // ISO date `2026-04-01` produced ~10 in-flight requests, log spam, and
  // racy state transitions. tab changes still fire immediately (debounce
  // only the date side); the cleanup function cancels the timer so a new
  // keystroke restarts the wait.
  useEffect(() => {
    // tab changes have no debounce-worthy spam pattern (single click)
    const t = setTimeout(load, 350);
    return () => clearTimeout(t);
  }, [tab, from, to]);

  // #227: export downloader. We use raw fetch so we can stream the binary
  // body into a blob URL — fetchApi assumes JSON. Same pattern used by the
  // RxDetailModal "Download PDF" button in PatientDetail.jsx.
  const downloadExport = async (format) => {
    if (!from || !to) {
      setExportError('Pick a date range before exporting.');
      return;
    }
    setExporting(format);
    setExportError(null);
    try {
      const token = getAuthToken();
      const url = `${ENDPOINTS[tab]}.${format}?from=${from}T00:00:00&to=${to}T23:59:59`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
          const err = await res.json();
          if (err?.error) msg = err.error;
        } catch { /* binary body, leave default */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${EXPORT_BASENAMES[tab]}-${from}-to-${to}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Same 60s revoke as the Rx download — gives the browser time to
      // actually persist the file before we drop the reference.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      setExportError(err.message || 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <BarChart3 size={24} /> Reports
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Profit, contribution, and team performance — filterable by date.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem',
                background: tab === t.key ? 'var(--accent-color)' : 'transparent',
                color: tab === t.key ? '#fff' : 'var(--text-primary)',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <DateRangeFilter value={filter} onChange={setFilter} label={null} includeAllOption={false} />
      </div>

      {/* #227: export bar — both buttons disabled while either is in flight, and
          while the JSON load is still in flight (no point exporting an empty
          tab the user hasn't seen yet). */}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginBottom: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {exportError && (
          <div role="alert" style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginRight: 'auto' }}>
            {exportError}
          </div>
        )}
        <button
          type="button"
          onClick={() => downloadExport('csv')}
          disabled={loading || !!exporting}
          aria-label="Export this report as CSV"
          style={exportBtn(exporting === 'csv')}
        >
          {exporting === 'csv'
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Download size={14} />}
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => downloadExport('xlsx')}
          disabled={loading || !!exporting}
          aria-label="Export this report as Excel"
          style={exportBtn(exporting === 'xlsx')}
        >
          {exporting === 'xlsx'
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Download size={14} />}
          Export Excel
        </button>
        <button
          type="button"
          onClick={() => downloadExport('pdf')}
          disabled={loading || !!exporting}
          aria-label="Export this report as PDF"
          style={exportBtn(exporting === 'pdf')}
        >
          {exporting === 'pdf'
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Download size={14} />}
          Export PDF
        </button>
      </div>

      {loading && <div>Loading…</div>}
      {!loading && data && tab === 'pnl' && <PnlTable data={data} onNavigate={navigate} />}
      {!loading && data && tab === 'pro' && <ProTable data={data} />}
      {!loading && data && tab === 'loc' && <LocTable data={data} />}
      {!loading && data && tab === 'att' && <AttTable data={data} />}
      {!loading && !data && <div className="glass" style={{ padding: '2rem', textAlign: 'center' }}>No data.</div>}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Totals({ items, onVisitsClick }) {
  // #523: className-based responsive hook (was
  // [style*="repeat("][style*=", 1fr)"] attribute selector). Mobile
  // collapses the N-col strip to 2-up at <=899px, 1-up at <=380px.
  return (
    <div className="reports-totals-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: '0.75rem', marginBottom: '1rem' }}>
      {items.map((it) => (
        <div key={it.label} className="glass" style={{ padding: '1rem', cursor: it.label === 'Visits' && onVisitsClick ? 'pointer' : 'default', transition: 'background 0.2s' }} onClick={() => it.label === 'Visits' && onVisitsClick && onVisitsClick()}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{it.label}</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600, marginTop: '0.25rem' }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function PnlTable({ data, onNavigate }) {
  const colWidths = ['25%', '18%', '10%', '10%', '12%', '12%', '13%'];
  const headers = ['Service', 'Category', 'Tier', 'Visits', 'Revenue', 'Product cost', 'Contribution'];
  const totals = data?.totals || { visits: 0, revenue: 0, productCost: 0, contribution: 0 };
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const servicesSummary = Array.isArray(data?.servicesSummary) ? data.servicesSummary : [];
  const servicesCount = servicesSummary.length;

  return (
    <>
      <Totals items={[
        { label: 'Visits', value: (totals.visits || 0).toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(totals.revenue || 0) },
        { label: 'Product cost', value: formatMoney(totals.productCost || 0) },
        { label: 'Contribution', value: formatMoney(totals.contribution || 0) },
        { label: 'Services', value: (servicesCount || 0).toLocaleString('en-IN') },
      ]} onVisitsClick={() => onNavigate && onNavigate('/wellness/visits')} />
      <div className="glass" style={{ padding: 0, overflow: 'visible' }}>
        <TopScrollSync>
        <table style={tableStyle}>
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead><tr>{headers.map((h, i) => <th key={h} style={{ ...th, width: colWidths[i], textAlign: i > 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, width: colWidths[0] }}>{r.name}</td>
                <td style={{ ...td, width: colWidths[1] }}>{r.category}</td>
                <td style={{ ...td, width: colWidths[2] }}>
                  <span style={{ background: tierBg(r.ticketTier), padding: '0.15rem 0.45rem', borderRadius: 4, fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: 600 }}>
                    {r.ticketTier}
                  </span>
                </td>
                <td style={{ ...tdR, width: colWidths[3] }}>{r.count}</td>
                <td style={{ ...tdR, width: colWidths[4] }}>{formatMoney(r.revenue)}</td>
                <td style={{ ...tdR, width: colWidths[5] }}>{formatMoney(r.productCost)}</td>
                <td style={{ ...tdR, width: colWidths[6], color: r.contribution > 0 ? 'var(--success-color)' : 'var(--danger-color)', fontWeight: 600 }}>
                  {formatMoney(r.contribution)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)' }}>No services with revenue in this window.</td></tr>}
          </tbody>
        </table>
        </TopScrollSync>
      </div>
    </>
  );
}

function ProTable({ data }) {
  const colWidths = ['40%', '20%', '20%', '20%'];
  const headers = ['Staff', 'Role', 'Visits', 'Revenue'];
  const totals = data?.totals || { visits: 0, revenue: 0 };
  const rows = Array.isArray(data?.rows) ? data.rows : [];

  return (
    <>
      <Totals items={[
        { label: 'Visits', value: (totals.visits || 0).toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(totals.revenue || 0) },
      ]} />
      <div className="glass" style={{ padding: 0, overflow: 'visible' }}>
        <TopScrollSync>
        <table style={tableStyle}>
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          {/* #236: drop the orthogonal RBAC role column (it always says USER for
              doctors/professionals/etc) and surface wellnessRole as the primary
              "Role" instead — that's the meaningful one for clinics. */}
          <thead><tr>{headers.map((h, i) => <th key={h} style={{ ...th, width: colWidths[i], textAlign: i > 1 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {/* #637: per-practitioner avatar with hashed colour so each name
                is visually distinct in the staff column. The colour is
                deterministic — same name → same swatch across pages. */}
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, width: colWidths[0] }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
                    <Avatar name={r.name || ''} size={28} />
                    <span>{r.name}</span>
                  </span>
                </td>
                <td style={{ ...td, width: colWidths[1], textTransform: 'capitalize' }}>{r.wellnessRole || r.role || '—'}</td>
                <td style={{ ...tdR, width: colWidths[2] }}>{r.visits}</td>
                <td style={{ ...tdR, width: colWidths[3] }}>{formatMoney(r.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TopScrollSync>
      </div>
    </>
  );
}

function LocTable({ data }) {
  const colWidths = ['20%', '18%', '13%', '13%', '18%', '18%'];
  const headers = ['Location', 'City', 'Patients', 'Visits', 'Revenue', 'Status'];
  const totals = data?.totals || { visits: 0, revenue: 0 };
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const activeCount = rows.filter((r) => r.isActive).length;
  const inactiveCount = rows.filter((r) => !r.isActive).length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>
          {activeCount} active location{activeCount === 1 ? '' : 's'}
        </h2>
        {inactiveCount > 0 && (
          <span
            title="Inactive locations are listed below for completeness but are excluded from operational counts."
            style={{
              background: 'rgba(100,116,139,0.18)',
              color: 'var(--text-secondary)',
              padding: '0.15rem 0.5rem',
              borderRadius: 999,
              fontSize: '0.7rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            inactive: {inactiveCount}
          </span>
        )}
      </div>
      <Totals items={[
        { label: 'Visits', value: (totals.visits || 0).toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(totals.revenue || 0) },
      ]} />
      <div className="glass" style={{ padding: 0, overflow: 'visible' }}>
        <TopScrollSync>
        <table style={tableStyle}>
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead><tr>{headers.map((h, i) => <th key={h} style={{ ...th, width: colWidths[i], textAlign: (i > 1 && i < 5) ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, width: colWidths[0] }}>{r.name}</td>
                <td style={{ ...td, width: colWidths[1] }}>{r.city}{r.state ? `, ${r.state}` : ''}</td>
                <td style={{ ...tdR, width: colWidths[2] }}>{r.patients}</td>
                <td style={{ ...tdR, width: colWidths[3] }}>{r.visits}</td>
                <td style={{ ...tdR, width: colWidths[4] }}>{formatMoney(r.revenue)}</td>
                <td style={{ ...td, width: colWidths[5] }}>{r.isActive ? '🟢 Active' : '⚪ Inactive'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TopScrollSync>
      </div>
    </>
  );
}

function AttTable({ data }) {
  // #156: defensive defaults — if the API ever returns a partial response (e.g.
  // missing totals or rows), render "No data" instead of crashing the whole page
  // on `undefined.toLocaleString()`. Reproducer wasn't found in dry-runs, but
  // the cost of guarding is zero.
  const totals = data?.totals || { leads: 0, junk: 0, qualified: 0, revenue: 0 };
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const colWidths = ['20%', '15%', '15%', '15%', '18%', '17%'];
  const headers = ['Source', 'Leads', 'Junk %', 'Conv %', 'Revenue', 'Rev / Lead'];

  return (
    <>
      <Totals items={[
        { label: 'Total leads', value: (totals.leads || 0).toLocaleString('en-IN') },
        { label: 'Junk', value: (totals.junk || 0).toLocaleString('en-IN') },
        { label: 'Qualified', value: (totals.qualified || 0).toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(totals.revenue || 0) },
      ]} />
      <div className="glass" style={{ padding: 0, overflow: 'visible' }}>
        <TopScrollSync>
        <table style={tableStyle}>
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead><tr>{headers.map((h, i) => <th key={h} style={{ ...th, width: colWidths[i], textAlign: i > 0 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source}>
                <td style={{ ...td, width: colWidths[0] }}><strong>{r.source}</strong></td>
                <td style={{ ...tdR, width: colWidths[1] }}>{r.leads}</td>
                <td style={{ ...tdR, width: colWidths[2], color: r.junkRate > 70 ? 'var(--danger-color)' : 'var(--text-secondary)' }}>{formatPercent(r.junkRate)}</td>
                <td style={{ ...tdR, width: colWidths[3], color: r.conversionRate > 10 ? 'var(--success-color)' : 'var(--text-secondary)', fontWeight: r.conversionRate > 10 ? 600 : 400 }}>{formatPercent(r.conversionRate)}</td>
                <td style={{ ...tdR, width: colWidths[4] }}>{formatMoney(r.revenue)}</td>
                <td style={{ ...tdR, width: colWidths[5] }}>{formatMoney(r.revenuePerLead)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)' }}>No leads in this window.</td></tr>}
          </tbody>
        </table>
        </TopScrollSync>
      </div>
    </>
  );
}

const tierBg = (t) => ({ high: 'rgba(239,68,68,0.2)', medium: 'rgba(245,158,11,0.2)', low: 'rgba(100,116,139,0.2)' }[t] || 'rgba(100,116,139,0.2)');
const tableStyle = { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' };
const th = { textAlign: 'left', padding: '0.65rem 1rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden', textOverflow: 'ellipsis' };
const td = { padding: '0.65rem 1rem', fontSize: '0.85rem', borderBottom: '1px solid rgba(255,255,255,0.04)', overflow: 'hidden', textOverflow: 'ellipsis', wordBreak: 'break-word' };
// #602: right-aligned cells are always numeric / currency / count in this
// page's report tables. Forbid mid-number wrap (`₹1,2\n34,567` breaks
// copy-paste + CSV alignment) and use tabular-nums so digit columns line up.
// wordBreak overrides the inherited break-word from `td`.
const tdR = { ...td, textAlign: 'right', whiteSpace: 'nowrap', wordBreak: 'normal', fontVariantNumeric: 'tabular-nums' };
// #227: export buttons sit next to the date picker — wait state shows a
// spinner and dims the button without removing it from the layout.
const exportBtn = (busy) => ({
  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
  padding: '0.45rem 0.85rem',
  background: busy ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.8rem',
  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
});
