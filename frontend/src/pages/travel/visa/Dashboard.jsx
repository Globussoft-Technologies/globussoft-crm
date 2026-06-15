/**
 * Visa Sure Dashboard — live overview for the Visa Sure sub-brand.
 *
 * Replaces the former Phase-3 SHELL with a real, data-backed landing page.
 * Reads ONLY existing, already-shipped, tenant-scoped + visa-sub-brand-scoped
 * endpoints (no backend changes, no new dependencies):
 *   GET /api/travel/visa/applications/stats   → KPI rollup
 *   GET /api/travel/visa/applications?limit=5 → recent applications
 *
 * Self-contained: imports no shared component beyond fetchApi/useNotify, so
 * it cannot affect any other page or tenant. Backend already scopes both
 * endpoints to req.travelTenant + subBrand='visasure'.
 *
 * Routes mounted in App.jsx:
 *   /travel/visa               → this page
 *   /travel/visa/applications  → Applications.jsx (built)
 *   /travel/visa/checklists    → Checklists.jsx (shell; admin matrix is
 *                                backend + product-call gated)
 *   /travel/visa/reports       → Reports.jsx (built)
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Stamp, FileText, BarChart3, AlertTriangle, ArrowRight,
  CheckCircle2, XCircle, Clock, Layers, ShieldAlert,
} from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';

// Pinned to backend VALID_STATUSES (routes/travel_visa.js) + the palette
// used by Applications.jsx, kept inline so this page stays self-contained.
const STATUS_META = {
  intake: { label: 'Intake', bg: 'rgba(120,120,120,0.14)', color: '#7C8A9C' },
  'docs-pending': { label: 'Docs pending', bg: 'rgba(200,154,78,0.18)', color: '#C89A4E' },
  filed: { label: 'Filed', bg: 'rgba(47,122,77,0.16)', color: '#3FA46A' },
  approved: { label: 'Approved', bg: 'rgba(38,160,120,0.18)', color: '#34C79A' },
  rejected: { label: 'Rejected', bg: 'rgba(168,50,63,0.16)', color: '#E0586A' },
  appeal: { label: 'Appeal', bg: 'rgba(120,90,170,0.18)', color: '#9B7FD4' },
};
const STATUS_ORDER = ['intake', 'docs-pending', 'filed', 'approved', 'rejected', 'appeal'];
const TYPE_LABELS = {
  tourist: 'Tourist', business: 'Business', student: 'Student',
  work: 'Work', umrah: 'Umrah', hajj: 'Hajj',
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return '—'; }
}

const card = {
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 14,
  padding: '1.25rem',
};

function KpiTile({ icon, label, value, accent }) {
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: accent || 'var(--text-secondary)' }}>
        {icon}
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
      </div>
      <span style={{ fontSize: '1.9rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</span>
    </div>
  );
}

export default function VisaDashboard() {
  const notify = useNotify();
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(false);
      try {
        const [s, r] = await Promise.all([
          fetchApi('/api/travel/visa/applications/stats', { silent: true }),
          fetchApi('/api/travel/visa/applications?limit=5', { silent: true }).catch(() => null),
        ]);
        if (!alive) return;
        setStats(s || null);
        const list = Array.isArray(r) ? r : (r && (r.applications || r.rows)) || [];
        setRecent(list.slice(0, 5));
      } catch (e) {
        if (!alive) return;
        setError(true);
        notify.error(e?.message || 'Failed to load the Visa Sure dashboard');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = stats?.total || 0;
  const statusCount = (s) => stats?.byStatus?.[s]?.count || 0;
  const approved = statusCount('approved');
  const rejected = statusCount('rejected');
  const inProgress = statusCount('intake') + statusCount('docs-pending') + statusCount('filed') + statusCount('appeal');
  const decided = approved + rejected;
  const approvalRate = decided > 0 ? Math.round((approved / decided) * 100) : null;
  const flagged = stats?.flaggedCount || 0;
  const complex = stats?.complexCount || 0;

  const destinations = Object.entries(stats?.byDestinationCountry || {})
    .filter(([k]) => k !== '_other')
    .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
    .slice(0, 6);
  const types = Object.entries(stats?.byApplicationType || {})
    .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));

  const quickLinks = [
    { to: '/travel/visa/applications', label: 'Applications', icon: <FileText size={16} /> },
    { to: '/travel/visa/reports', label: 'Reports', icon: <BarChart3 size={16} /> },
    { to: '/travel/visa/embassy-rules', label: 'Embassy Rules', icon: <Stamp size={16} /> },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto', animation: 'fadeIn 0.4s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0, fontSize: '1.75rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            <Stamp size={26} color="var(--primary-color, var(--accent-color))" aria-hidden /> Visa Sure
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: '0.9rem' }}>
            Visa application overview{stats?.lastActivityAt ? ` · last activity ${fmtDate(stats.lastActivityAt)}` : ''}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {quickLinks.map((q) => (
            <Link key={q.to} to={q.to} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.55rem 1rem',
              borderRadius: 8, textDecoration: 'none', fontSize: '0.85rem', fontWeight: 600,
              background: 'var(--surface-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
            }}>
              {q.icon} {q.label}
            </Link>
          ))}
        </div>
      </header>

      {loading ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem' }}>Loading dashboard…</div>
      ) : error ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem' }}>
          Couldn’t load the dashboard. Please refresh to try again.
        </div>
      ) : total === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '3rem' }}>
          <Stamp size={48} color="var(--text-secondary)" style={{ marginBottom: 12, opacity: 0.6 }} />
          <h2 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', margin: '0 0 6px' }}>No visa applications yet</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0 0 1.25rem' }}>
            Create your first Visa Sure application to start tracking it here.
          </p>
          <Link to="/travel/visa/applications" style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0.7rem 1.4rem', borderRadius: 8,
            textDecoration: 'none', fontWeight: 600, background: 'var(--primary-color, var(--accent-color))', color: '#fff',
          }}>
            <FileText size={16} /> Go to Applications <ArrowRight size={16} />
          </Link>
        </div>
      ) : (
        <>
          {/* KPI tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12, marginBottom: 16 }}>
            <KpiTile icon={<FileText size={16} />} label="Total applications" value={total} />
            <KpiTile icon={<CheckCircle2 size={16} />} label="Approved" value={approved} accent="#34C79A" />
            <KpiTile icon={<XCircle size={16} />} label="Rejected" value={rejected} accent="#E0586A" />
            <KpiTile icon={<Clock size={16} />} label="In progress" value={inProgress} accent="#C89A4E" />
            <KpiTile icon={<BarChart3 size={16} />} label="Approval rate" value={approvalRate === null ? '—' : `${approvalRate}%`} accent="var(--primary-color, var(--accent-color))" />
            <KpiTile icon={<ShieldAlert size={16} />} label="Risk-flagged" value={flagged} accent="#E0586A" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 16, marginBottom: 16 }}>
            {/* Status breakdown */}
            <div style={card}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', color: 'var(--text-primary)' }}>By status</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {STATUS_ORDER.map((s) => {
                  const c = statusCount(s);
                  const meta = STATUS_META[s];
                  const pct = total > 0 ? Math.round((c / total) * 100) : 0;
                  return (
                    <div key={s}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: 4 }}>
                        <span style={{ color: 'var(--text-primary)' }}>{meta.label}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{c} · {pct}%</span>
                      </div>
                      <div style={{ height: 8, borderRadius: 999, background: 'var(--input-bg)', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: meta.color, borderRadius: 999 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-color)', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Layers size={14} /> Complex cases: <strong style={{ color: 'var(--text-primary)' }}>{complex}</strong></span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={14} /> Flagged: <strong style={{ color: 'var(--text-primary)' }}>{flagged}</strong></span>
              </div>
            </div>

            {/* Destinations + types */}
            <div style={card}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', color: 'var(--text-primary)' }}>Top destinations</h3>
              {destinations.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>No destination data yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {destinations.map(([country, v]) => (
                    <div key={country} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem' }}>
                      <span style={{ color: 'var(--text-primary)' }}>{country}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{v?.count || 0}</span>
                    </div>
                  ))}
                </div>
              )}
              {types.length > 0 && (
                <>
                  <h3 style={{ margin: '1.25rem 0 0.75rem', fontSize: '1rem', color: 'var(--text-primary)' }}>By application type</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {types.map(([t, v]) => (
                      <span key={t} style={{
                        padding: '0.3rem 0.7rem', borderRadius: 999, fontSize: '0.8rem',
                        background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                      }}>
                        {TYPE_LABELS[t] || t}: <strong>{v?.count || 0}</strong>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Recent applications */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>Recent applications</h3>
              <Link to="/travel/visa/applications" style={{ fontSize: '0.82rem', color: 'var(--primary-color, var(--accent-color))', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                View all <ArrowRight size={14} />
              </Link>
            </div>
            {recent.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>No recent applications.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {recent.map((a) => {
                  const meta = STATUS_META[a.status] || { label: a.status || '—', bg: 'var(--input-bg)', color: 'var(--text-secondary)' };
                  const who = a.contact?.name || a.contact?.email || (a.contactId ? `Contact #${a.contactId}` : '—');
                  return (
                    <Link key={a.id} to={`/travel/visa/applications/${a.id}`} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                      padding: '0.7rem 0', borderBottom: '1px solid var(--border-color)', textDecoration: 'none',
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          #{a.id} · {who}
                        </div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                          {(TYPE_LABELS[a.applicationType] || a.applicationType || '—')}
                          {a.destinationCountry ? ` → ${a.destinationCountry}` : ''} · {fmtDate(a.updatedAt || a.createdAt)}
                        </div>
                      </div>
                      <span style={{ padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.72rem', fontWeight: 600, background: meta.bg, color: meta.color, whiteSpace: 'nowrap' }}>
                        {meta.label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
