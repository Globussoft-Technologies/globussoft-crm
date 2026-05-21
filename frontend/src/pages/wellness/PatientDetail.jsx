import { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Calendar, Stethoscope, FileText, FileSignature, ClipboardList, Plus, Camera, Package, Trash2, Video, Copy, Award, X, Minus, Download, ChevronDown, ChevronUp, Wallet as WalletIcon, Crown, ZoomIn, ZoomOut, Maximize, Minimize } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { useFormAutosave } from '../../utils/useFormAutosave';
import { formatDate } from '../../utils/date';
import { currencySymbol, formatMoney } from '../../utils/money';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../components/wellness/DateRangeFilter';

const tabStyle = (active) => ({
  // Primary CTA uses --primary-color (teal #265855 in wellness) with a fallback to
  // --accent-color (blush) so generic theme — which has no --primary-color — still
  // gets its blue accent. See CLAUDE.md "Primary CTAs use var(--primary-color,...)".
  padding: '0.5rem 1rem', border: 'none', background: active ? 'var(--primary-color, var(--accent-color))' : 'transparent',
  color: active ? '#fff' : 'var(--text-primary)', cursor: 'pointer', borderRadius: 8, fontSize: '0.85rem',
  display: 'flex', alignItems: 'center', gap: '0.35rem',
});

// #638: schema stores M/F/Other; expand to a clinician-friendly label.
function genderLabel(g) {
  if (!g) return '';
  if (g === 'M') return 'Male';
  if (g === 'F') return 'Female';
  return g;
}

function PatientSummaryDownloadButton({ patientId, patientName }) {
  const [downloading, setDownloading] = useState(false);
  const notify = useNotify();

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/patients/${patientId}/summary.pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = String(patientName || `patient-${patientId}`).replace(/[^a-z0-9_-]+/gi, '_');
      a.download = `${safe}-summary.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      notify.error(e.message || 'Failed to download patient summary.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      onClick={handleDownload}
      disabled={downloading}
      title="Download full patient record (case history, visits, prescriptions, wallet, memberships) as PDF"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.5rem 0.9rem', borderRadius: 6, border: '1px solid var(--border-color)',
        background: 'var(--primary-color, var(--accent-color))', color: '#fff',
        cursor: downloading ? 'wait' : 'pointer', fontSize: '0.85rem', fontWeight: 500,
      }}
    >
      <Download size={14} />
      {downloading ? 'Preparing PDF…' : 'Download PDF'}
    </button>
  );
}

export default function PatientDetail() {
  const { id } = useParams();
  const [patient, setPatient] = useState(null);
  const [services, setServices] = useState([]);
  const [doctors, setDoctors] = useState([]);
  // #344 [SECURITY]: sessionStorage was being polluted with attacker-controlled
  // URL segments (e.g. `gbs.tab.patient.1' OR '1'='1`) because we interpolated
  // useParams().id directly into the storage key. Patient ids in this app are
  // always numeric (Prisma BIGINT primary key), so we validate against that
  // shape and refuse to read/write the key for anything else. We also URL-
  // encode as defense-in-depth so a slipped-through value can't break out of
  // the key namespace via control characters. A non-numeric id likely means
  // the patient route was hit with garbage — log a warning and fall back to
  // the in-memory default so the tab still works for this session without
  // persisting a malformed key.
  const isSafeId = typeof id === 'string' && /^\d+$/.test(id);
  const tabStorageKey = isSafeId ? `gbs.tab.patient.${encodeURIComponent(id)}` : null;
  if (!isSafeId && id != null) {
     
    console.warn('[PatientDetail] refusing to persist tab state for non-numeric id:', id);
  }
  const [tab, setTab] = useState(() => {
    if (!tabStorageKey) return 'history';
    try {
      return sessionStorage.getItem(tabStorageKey) || 'history';
    } catch {
      return 'history';
    }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tabStorageKey) return;
    try {
      sessionStorage.setItem(tabStorageKey, tab);
    } catch {
      /* ignore */
    }
  }, [tab, tabStorageKey]);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/wellness/patients/${id}`),
      fetchApi('/api/wellness/services'),
      fetchApi('/api/staff').catch(() => []),
    ]).then(([p, s, staff]) => {
      setPatient(p);
      setServices(s);
      setDoctors((Array.isArray(staff) ? staff : []).filter((u) => u.wellnessRole === 'doctor'));
    }).catch(() => setPatient(null)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (!patient) return <div style={{ padding: '2rem' }}>Patient not found.</div>;

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem' }}>
        <Link to="/wellness/patients" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.85rem' }}>
          <ArrowLeft size={14} /> Back to patients
        </Link>
        <PatientSummaryDownloadButton patientId={patient.id} patientName={patient.name} />
      </div>

      {/* Patient header — #638: surface DOB + computed age + gender + phone
          inline so clinically-relevant identifiers are visible without
          digging into the Profile tab. Age is computed client-side because
          the tenant timezone matters (an Asia/Kolkata patient born just past
          midnight IST should not appear a day younger to a UTC test clock). */}
      <div className="glass" style={{ padding: '1.5rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 600, color: '#fff' }}>
          {patient.name[0]}
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>{patient.name}</h1>
          <div data-testid="patient-header-subline" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            {(() => {
              const parts = [];
              if (patient.dob) {
                const dobDate = new Date(patient.dob);
                if (!Number.isNaN(dobDate.getTime())) {
                  const age = Math.floor((Date.now() - dobDate.getTime()) / (365.25 * 86400000));
                  parts.push(`${formatDate(patient.dob)} (${age}y)`);
                }
              }
              if (patient.gender) parts.push(genderLabel(patient.gender));
              if (patient.phone) parts.push(patient.phone);
              if (patient.email) parts.push(patient.email);
              if (patient.bloodGroup) parts.push(`Blood ${patient.bloodGroup}`);
              return parts.length ? parts.join(' · ') : '—';
            })()}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <span>Source: <strong style={{ color: 'var(--text-primary)' }}>{patient.source || '—'}</strong></span>
          <span>{patient.visits.length} visits • {patient.prescriptions.length} Rx • {patient.treatmentPlans.length} treatment plans</span>
        </div>
      </div>

      {/* Agent D: loyalty card — sits above the tab list, NOT inside it. */}
      <LoyaltyCard patientId={patient.id} />

      {/* Tabs.
          #523: className-based responsive hook (was [style*="flex-wrap"]
          attribute selector). Mobile rule allows the strip to scroll
          horizontally when too many tabs survive the wrap. */}
      <div className="wellness-tab-strip" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button style={tabStyle(tab === 'history')} onClick={() => setTab('history')}><Calendar size={14} /> Case history</button>
        <button style={tabStyle(tab === 'prescribe')} onClick={() => setTab('prescribe')}><FileText size={14} /> New prescription</button>
        <button style={tabStyle(tab === 'consent')} onClick={() => setTab('consent')}><FileSignature size={14} /> Consent form</button>
        <button style={tabStyle(tab === 'plans')} onClick={() => setTab('plans')}><ClipboardList size={14} /> Treatment plans</button>
        <button style={tabStyle(tab === 'visit')} onClick={() => setTab('visit')}><Plus size={14} /> Log visit</button>
        <button style={tabStyle(tab === 'photos')} onClick={() => setTab('photos')}><Camera size={14} /> Photos</button>
        <button style={tabStyle(tab === 'inventory')} onClick={() => setTab('inventory')}><Package size={14} /> Inventory used</button>
        {/* Agent B: telehealth tab */}
        <button style={tabStyle(tab === 'telehealth')} onClick={() => setTab('telehealth')}><Video size={14} /> Telehealth</button>
        {/* Wave 11 Agent FF: wallet tab */}
        <button style={tabStyle(tab === 'wallet')} onClick={() => setTab('wallet')}><WalletIcon size={14} /> Wallet</button>
        {/* Wave 11 Agent EE: Memberships tab — patient's purchased plans + balances */}
        <button style={tabStyle(tab === 'memberships')} onClick={() => setTab('memberships')}><Crown size={14} /> Memberships</button>
      </div>

      {tab === 'history' && <CaseHistoryTab patient={patient} />}
      {tab === 'prescribe' && <PrescribeTab patient={patient} onSaved={load} />}
      {tab === 'consent' && <ConsentTab patient={patient} services={services} onSaved={load} />}
      {tab === 'plans' && <PlansTab patient={patient} services={services} onSaved={load} />}
      {tab === 'visit' && <LogVisitTab patient={patient} services={services} doctors={doctors} onSaved={load} />}
      {tab === 'photos' && <PhotosTab patient={patient} onSaved={load} />}
      {tab === 'inventory' && <InventoryTab patient={patient} onSaved={load} />}
      {tab === 'telehealth' && <TelehealthTab patient={patient} onSaved={load} />}
      {tab === 'wallet' && <WalletTab patient={patient} />}
      {tab === 'memberships' && <MembershipsTab patient={patient} services={services} />}
    </div>
  );
}

// ── Wallet tab — balance + recent transactions + redeem-giftcard ──
// Wave 11 Agent FF. Read-only history; redeem flow lets staff paste a gift
// code that the patient handed in (the credit lands in this patient's
// wallet). For larger flows (admin manual credit/debit, full ledger view)
// see /wellness/wallet at the admin sidebar entry.
function WalletTab({ patient }) {
  const [data, setData] = useState(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const notify = useNotify();

  const load = async () => {
    setLoading(true);
    try {
      const j = await fetchApi(`/api/wellness/patients/${patient.id}/wallet`);
      setData(j);
    } catch (e) {
      notify.error(e.message || 'Failed to load wallet');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line */ }, [patient.id]);

  const redeem = async () => {
    if (!code.trim()) return notify.error('Enter a gift card code.');
    setSubmitting(true);
    try {
      await fetchApi('/api/wellness/giftcards/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim().toUpperCase(), patientId: patient.id }),
      });
      notify.success('Gift card redeemed');
      setCode('');
      load();
    } catch (e) {
      notify.error(e.message || 'Failed to redeem gift card');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !data) return <div>Loading wallet…</div>;
  const { wallet, transactions } = data;

  return (
    <div className="glass" style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Wallet balance</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 600 }}>
            {formatMoney(wallet.balance, { currency: wallet.currency })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Gift card code"
            style={{ padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', textTransform: 'uppercase' }}
          />
          <button
            onClick={redeem}
            disabled={submitting}
            style={{ padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            {submitting ? 'Redeeming…' : 'Redeem'}
          </button>
        </div>
      </div>

      <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Recent transactions</h4>
      {transactions.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No transactions yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Date</th>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Type</th>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Amount</th>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>{formatDate(tx.createdAt)}</td>
                <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>{tx.type.replace('_', ' ')}</td>
                <td style={{ padding: '0.5rem', fontSize: '0.85rem', color: tx.amount >= 0 ? 'var(--success-color, #10b981)' : 'var(--danger-color, #ef4444)' }}>
                  {tx.amount >= 0 ? '+' : ''}{formatMoney(tx.amount, { currency: wallet.currency })}
                </td>
                <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>{tx.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Case history tab ──────────────────────────────────────────────

function CaseHistoryTab({ patient }) {
  // #278: clicking an Rx card pops a detail modal with all fields + PDF download.
  const [openRx, setOpenRx] = useState(null);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);

  const allEvents = [
    ...patient.visits.map((v) => ({ kind: 'visit', date: v.visitDate, data: v })),
    ...patient.prescriptions.map((p) => ({ kind: 'rx', date: p.createdAt, data: p })),
    ...patient.consents.map((c) => ({ kind: 'consent', date: c.signedAt, data: c })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const events = (rangeStart && rangeEnd)
    ? allEvents.filter((e) => {
        const ts = new Date(e.date).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : allEvents;

  const filterBar = (
    <div
      className="glass"
      style={{
        padding: '0.6rem 0.85rem', display: 'flex', flexWrap: 'wrap',
        alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem',
      }}
    >
      <DateRangeFilter value={filter} onChange={setFilter} />
      <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        {events.length === allEvents.length
          ? `${allEvents.length} event${allEvents.length === 1 ? '' : 's'}`
          : `${events.length} of ${allEvents.length} events`}
      </span>
    </div>
  );

  if (allEvents.length === 0) {
    return (
      <>
        {filterBar}
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No case history yet.</div>
      </>
    );
  }

  if (events.length === 0) {
    return (
      <>
        {filterBar}
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No case history in the selected range.</div>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {filterBar}
      {events.map((e, i) => {
        const clickable = e.kind === 'rx';
        return (
          <div
            key={i}
            className="glass"
            onClick={clickable ? () => setOpenRx(e.data) : undefined}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpenRx(e.data); } } : undefined}
            title={clickable ? 'Click to view full prescription details' : undefined}
            style={{ padding: '1rem', display: 'flex', gap: '0.75rem', cursor: clickable ? 'pointer' : 'default' }}
          >
            <div style={{ width: 8, background: kindColor(e.kind), borderRadius: 4, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  {kindIcon(e.kind)}
                  <strong style={{ textTransform: 'capitalize' }}>{kindLabel(e.kind)}</strong>
                  {e.kind === 'visit' && e.data.service?.name && <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>— {e.data.service.name}</span>}
                  {e.kind === 'consent' && <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>— {e.data.templateName}</span>}
                </div>
                {/* #244: pin Asia/Kolkata so test browsers / users in non-IST
                    zones still see the visit's IST calendar day + time. Without
                    an explicit timeZone, toLocaleString uses the browser's local
                    zone and a UTC-clocked test browser pushed late-evening IST
                    visits to the next calendar day. */}
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(e.date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
              </div>
              {e.kind === 'visit' && (
                <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                  {e.data.notes || 'No notes'}
                  {e.data.amountCharged && <> • <strong style={{ color: 'var(--success-color)' }}>₹{Math.round(e.data.amountCharged).toLocaleString('en-IN')}</strong></>}
                </div>
              )}
              {e.kind === 'rx' && (
                // #278 (sub-issue 1): the timeline summary now also surfaces
                // Instructions inline (collapsible if long). Sub-issue 2's
                // modal still shows the full record on click.
                <RxSummary drugs={e.data.drugs} instructions={e.data.instructions} />
              )}
            </div>
          </div>
        );
      })}
      {openRx && (
        <RxDetailModal
          rx={openRx}
          patient={patient}
          onClose={() => setOpenRx(null)}
        />
      )}
    </div>
  );
}

const kindColor = (k) => ({ visit: 'var(--accent-color)', rx: '#a855f7', consent: '#10b981' })[k] || '#64748b';
const kindLabel = (k) => ({ visit: 'Visit', rx: 'Prescription', consent: 'Consent signed' })[k] || k;
const kindIcon = (k) => {
  const size = 14;
  if (k === 'visit') return <Stethoscope size={size} />;
  if (k === 'rx') return <FileText size={size} />;
  if (k === 'consent') return <FileSignature size={size} />;
  return null;
};

// #278 sub-issue 1: previously this only rendered the drug rows and silently
// dropped Instructions, which is clinically unsafe (e.g. "take after food",
// "stop if rash appears"). We now surface instructions below the drugs and
// truncate long bodies behind an expand/collapse toggle.
function RxSummary({ drugs, instructions }) {
  const [expanded, setExpanded] = useState(false);
  let parsed = [];
  try { parsed = typeof drugs === 'string' ? JSON.parse(drugs) : drugs; } catch { return <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{String(drugs).slice(0, 120)}</div>; }
  if (!Array.isArray(parsed)) return null;

  const instr = (instructions || '').trim();
  const longInstr = instr.length > 140;
  const shownInstr = !longInstr || expanded ? instr : `${instr.slice(0, 140)}…`;

  return (
    <>
      <ul style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, paddingLeft: '1rem' }}>
        {parsed.slice(0, 3).map((d, i) => (
          <li key={i}>{d.name} — {d.dosage}, {d.frequency}{d.duration ? `, ${d.duration}` : ''}</li>
        ))}
        {parsed.length > 3 && <li>+ {parsed.length - 3} more</li>}
      </ul>
      {instr && (
        <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Instructions:</strong> {shownInstr}
          {longInstr && (
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); setExpanded((v) => !v); }}
              style={{
                marginLeft: '0.4rem', background: 'transparent', border: 'none',
                color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.78rem',
                display: 'inline-flex', alignItems: 'center', gap: '0.15rem', padding: 0,
              }}
            >
              {expanded ? <>Show less <ChevronUp size={11} /></> : <>Show more <ChevronDown size={11} /></>}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// Parse the prescription's free-text `instructions` field into the structured
// clinical sections shown in the detail modal (and the PDF). Zylu-imported
// prescriptions store the text as labeled lines:
//   [ZYLU-#260]
//   Chief complaint: Dark circle
//   Advice: Under eye peel
//   Under eye Filler
//   Status: Issued
// Anything not matched by a known label falls through as `notes` so legacy
// free-text Rx still displays everything.
function parseRxInstructions(raw) {
  const out = { zyluId: '', chiefComplaint: '', diagnosis: '', investigations: '', advice: '', status: '', notes: '' };
  if (!raw || typeof raw !== 'string') return out;
  const lines = raw.split(/\r?\n/);
  const leftover = [];
  let bucket = null; // currently-collecting multi-line section
  for (const line of lines) {
    const z = line.match(/^\s*\[ZYLU-#?(\d+)\]\s*$/i);
    if (z) { out.zyluId = z[1]; bucket = null; continue; }
    const m = line.match(/^\s*(chief complaint|diagnosis|investigations?|advice|advice\/referrals?|status|notes?)\s*:\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key.startsWith('chief')) { out.chiefComplaint = val; bucket = 'chiefComplaint'; }
      else if (key.startsWith('diagnosis')) { out.diagnosis = val; bucket = 'diagnosis'; }
      else if (key.startsWith('invest')) { out.investigations = val; bucket = 'investigations'; }
      else if (key.startsWith('advice')) { out.advice = val; bucket = 'advice'; }
      else if (key.startsWith('status')) { out.status = val; bucket = null; }
      else if (key.startsWith('note')) { out.notes = val; bucket = 'notes'; }
      continue;
    }
    // Continuation line for the currently-collecting section.
    if (bucket && line.trim()) {
      out[bucket] = (out[bucket] ? out[bucket] + '\n' : '') + line.trim();
    } else if (line.trim()) {
      leftover.push(line.trim());
    }
  }
  if (!out.notes && leftover.length) out.notes = leftover.join('\n');
  return out;
}

function computeAgeFromDob(dob) {
  if (!dob) return '';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? String(age) : '';
}

function sexLabel(g) {
  if (!g) return '';
  if (g === 'M') return 'Male';
  if (g === 'F') return 'Female';
  return g;
}

// Clinical-format Rx detail modal. Matches the Zylu-style prescription layout
// (Patient demographics → Chief complaint / Diagnosis / Investigations / Advice
// → Prescriptions table → Notes). Free-text Rx without zylu-style labels still
// display fine — every unmatched section just shows "—".
function RxDetailModal({ rx, patient, onClose }) {
  const notify = useNotify();
  const [downloading, setDownloading] = useState(false);
  let drugs = [];
  try { drugs = typeof rx.drugs === 'string' ? JSON.parse(rx.drugs) : rx.drugs; } catch { drugs = []; }
  if (!Array.isArray(drugs)) drugs = [];

  const parsed = parseRxInstructions(rx.instructions);
  const status = parsed.status || 'Issued';
  const age = computeAgeFromDob(patient?.dob);

  const downloadPdf = async () => {
    setDownloading(true);
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
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      notify.error(err.message || 'Failed to download prescription PDF.');
    } finally {
      setDownloading(false);
    }
  };

  const headerRowStyle = {
    background: 'rgba(255,255,255,0.03)',
    padding: '0.6rem 0.85rem',
    borderRadius: 6,
    marginBottom: '0.5rem',
    fontSize: '0.85rem',
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          width: '95%', maxWidth: 1080, maxHeight: '90vh', overflow: 'auto',
          padding: '1.5rem',
        }}
      >
        {/* Title strip with close button */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <FileText size={18} /> Prescription #{rx.id}
            {parsed.zyluId && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 400 }}>(ZYLU-#{parsed.zyluId})</span>}
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        {/* Patient + prescriber two-column header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: '0.4rem', marginBottom: '1rem', padding: '0.85rem', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
          <div style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            <div><strong>Patient Name:</strong> {patient?.name || '—'}</div>
            <div><strong>Age:</strong> {age || '—'}</div>
            <div><strong>Sex:</strong> {sexLabel(patient?.gender) || '—'}</div>
            <div><strong>Status:</strong> <span style={{ color: 'var(--success-color, #10b981)' }}>{status}</span></div>
          </div>
          <div style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            <div><strong>Patient ID:</strong> {patient?.id || '—'}</div>
            <div><strong>Prescriber:</strong> {rx.doctor?.name || '—'}</div>
            {rx.doctor?.registrationNumber && (
              <div><strong>Registration Number:</strong> {rx.doctor.registrationNumber}</div>
            )}
            <div><strong>Date:</strong> {new Date(rx.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
          </div>
        </div>

        {/* Clinical sections */}
        <div style={headerRowStyle}><strong>Chief Complaint:</strong> {parsed.chiefComplaint || '—'}</div>
        <div style={headerRowStyle}><strong>Diagnosis:</strong> {parsed.diagnosis || '—'}</div>
        <div style={headerRowStyle}><strong>Investigations:</strong> {parsed.investigations || '—'}</div>
        <div style={{ ...headerRowStyle, whiteSpace: 'pre-wrap' }}><strong>Advice/Referrals:</strong> {parsed.advice || '—'}</div>

        {/* Medications table */}
        <h3 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '1rem 0 0.4rem' }}>Prescriptions</h3>
        <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 720 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={th}>No.</th>
                <th style={th}>Drug Name</th>
                <th style={th}>Strength</th>
                <th style={th}>Preparation</th>
                <th style={th}>Route</th>
                <th style={th}>Dosage</th>
                <th style={th}>Direction</th>
                <th style={th}>Frequency</th>
                <th style={th}>Instructions</th>
                <th style={th}>Start Date</th>
              </tr>
            </thead>
            <tbody>
              {drugs.length === 0 ? (
                <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)' }}>(no medications listed)</td></tr>
              ) : drugs.map((d, i) => {
                const strength = [d.strengthValue, d.strengthUnit].filter(Boolean).join('') || d.strength || '—';
                const startDate = d.startDate ? new Date(d.startDate).toLocaleDateString('en-IN') : '—';
                return (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={td}>{i + 1}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{d.name || d.drug || '—'}</td>
                    <td style={td}>{strength}</td>
                    <td style={td}>{d.preparation || d.dosageForm || '—'}</td>
                    <td style={td}>{d.route || '—'}</td>
                    <td style={td}>{d.dosage || '—'}</td>
                    <td style={td}>{d.direction || '—'}</td>
                    <td style={td}>{d.frequency || '—'}</td>
                    <td style={td}>{d.instructions || '—'}</td>
                    <td style={td}>{startDate}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={headerRowStyle}><strong>Notes:</strong> {parsed.notes || '—'}</div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '0.55rem 1rem', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={downloadPdf}
            disabled={downloading}
            style={{
              padding: '0.55rem 1rem', background: 'var(--accent-color)', color: '#fff',
              border: 'none', borderRadius: 8, cursor: downloading ? 'wait' : 'pointer',
              fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              opacity: downloading ? 0.7 : 1,
            }}
          >
            <Download size={14} /> {downloading ? 'Preparing…' : 'Download PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}

const th = { textAlign: 'left', padding: '0.5rem 0.6rem', color: 'var(--text-secondary)', fontWeight: 500, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.03em' };
const td = { padding: '0.5rem 0.6rem', verticalAlign: 'top' };

// ── Prescribe tab ─────────────────────────────────────────────────

const INITIAL_RX = {
  visitId: '',
  drugs: [{ name: '', dosage: '', frequency: '', duration: '' }],
  instructions: '',
};

// Typeahead over the tenant's Drug catalogue (GET /api/wellness/drugs?q=…).
// Free-text entry still works — selecting a row just auto-fills the sibling
// dosage/frequency/duration inputs from the drug's stored defaults.
function DrugAutocomplete({ value, onChange, onPick }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  const blurTimerRef = useRef(null);

  const search = (q) => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Empty q → backend returns first 20 drugs alphabetically (no filter applied).
    const trimmed = (q || '').trim();
    const url = trimmed
      ? `/api/wellness/drugs?q=${encodeURIComponent(trimmed)}&isActive=true&limit=20`
      : `/api/wellness/drugs?isActive=true&limit=20`;
    fetchApi(url, { signal: ac.signal, silent: true })
      .then((data) => {
        if (ac.signal.aborted) return;
        setResults(Array.isArray(data) ? data : []);
      })
      .catch(() => { /* typeahead is best-effort; ignore failures */ });
  };

  const handleChange = (e) => {
    const next = e.target.value;
    onChange(next);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(next), 200);
  };

  const handleFocus = () => {
    if (blurTimerRef.current) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null; }
    setOpen(true);
    // Show the top of the catalogue on focus even before the user types,
    // so they see "this is a dropdown, not just a text box."
    search(value || '');
  };

  // Delay close so an onMouseDown on a suggestion still fires.
  const handleBlur = () => {
    blurTimerRef.current = setTimeout(() => setOpen(false), 150);
  };

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);

  return (
    <div style={{ position: 'relative' }}>
      <input
        placeholder="Drug name — start typing to search the catalogue"
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        autoComplete="off"
        style={inputStyle}
      />
      {open && results.length > 0 && (
        <ul
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            maxHeight: 240,
            overflowY: 'auto',
            background: 'var(--surface-color, #1f2937)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            listStyle: 'none',
            padding: 4,
            margin: 0,
            zIndex: 20,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          }}
        >
          {results.map((d) => (
            <li
              key={d.id}
              role="option"
              onMouseDown={(e) => { e.preventDefault(); onPick(d); setOpen(false); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                padding: '0.45rem 0.6rem',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: '0.85rem',
                color: 'var(--text-primary)',
              }}
            >
              <div style={{ fontWeight: 500 }}>
                {d.name}
                {d.strengthValue && d.strengthUnit && (
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                    {d.strengthValue}{d.strengthUnit}
                  </span>
                )}
              </div>
              {(d.genericName || d.dosageForm) && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {[d.genericName, d.dosageForm].filter(Boolean).join(' • ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrescribeTab({ patient, onSaved }) {
  const notify = useNotify();
  // #226: persist Rx draft to sessionStorage so a browser refresh doesn't
  // wipe drug/dosage/frequency/duration/instructions.
  const initial = { ...INITIAL_RX, visitId: patient.visits[0]?.id || '' };
  const [draft, setDraft, isDirty, clearDraft] = useFormAutosave(`rx-${patient.id}`, initial);
  const { visitId, drugs, instructions } = draft;
  const [saving, setSaving] = useState(false);
  const [openRx, setOpenRx] = useState(null);
  const [showAllPastRx, setShowAllPastRx] = useState(false);

  // Past prescriptions for this patient — already loaded with the patient
  // payload (GET /api/wellness/patients/:id includes `prescriptions`). Newest
  // first. The dedicated GET /api/wellness/patients/:id/prescriptions endpoint
  // returns the same data; we use the pre-loaded copy to avoid an extra round
  // trip.
  const pastRx = [...(patient.prescriptions || [])].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
  const visiblePastRx = showAllPastRx ? pastRx : pastRx.slice(0, 5);

  const setVisitId = (v) => setDraft((s) => ({ ...s, visitId: v }));
  const setInstructions = (v) => setDraft((s) => ({ ...s, instructions: v }));
  const setDrug = (i, k, v) => {
    setDraft((s) => {
      const next = [...s.drugs];
      next[i] = { ...next[i], [k]: v };
      return { ...s, drugs: next };
    });
  };
  const addDrug = () => setDraft((s) => ({
    ...s,
    drugs: [...s.drugs, { name: '', dosage: '', frequency: '', duration: '' }],
  }));

  // #114: at least one drug must have a name. Empty Rx rows previously saved as
  // a phantom prescription (Rx counter incremented but no medication recorded).
  const validDrugs = drugs.filter((d) => d.name && d.name.trim());
  const canSave = !!visitId && validDrugs.length > 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!visitId) { notify.error('Pick a visit this prescription belongs to (or log a visit first).'); return; }
    if (validDrugs.length === 0) {
      notify.error('At least one drug name is required to save a prescription.');
      return;
    }
    setSaving(true);
    try {
      await fetchApi('/api/wellness/prescriptions', {
        method: 'POST',
        body: JSON.stringify({
          visitId, patientId: patient.id,
          drugs: validDrugs,
          instructions,
        }),
      });
      clearDraft();
      onSaved();
      notify.success('Prescription saved.');
    } catch (_err) { /* fetchApi already toasted */ } finally { setSaving(false); }
  };

  return (
    <>
      {pastRx.length > 0 && (
        <div className="glass" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <FileText size={16} /> Past prescriptions ({pastRx.length})
            </h3>
            {pastRx.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllPastRx((v) => !v)}
                style={{ background: 'transparent', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                {showAllPastRx ? 'Show recent only' : `Show all ${pastRx.length}`}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {visiblePastRx.map((rx) => {
              let drugList = [];
              try {
                const parsed = typeof rx.drugs === 'string' ? JSON.parse(rx.drugs) : rx.drugs;
                if (Array.isArray(parsed)) drugList = parsed;
              } catch { /* fall through to empty */ }
              const summary = drugList.length === 0
                ? '(no medications)'
                : drugList.slice(0, 3).map((d) => d.name).filter(Boolean).join(', ')
                  + (drugList.length > 3 ? ` + ${drugList.length - 3} more` : '');
              return (
                <button
                  key={rx.id}
                  type="button"
                  onClick={() => setOpenRx(rx)}
                  style={{
                    textAlign: 'left',
                    padding: '0.6rem 0.75rem',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '0.5rem',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {summary}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                      {new Date(rx.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      {rx.doctor?.name && <> • {rx.doctor.name}</>}
                    </div>
                  </div>
                  <FileText size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {openRx && (
        <RxDetailModal
          rx={openRx}
          patient={patient}
          onClose={() => setOpenRx(null)}
        />
      )}

    <form onSubmit={submit} className="glass" style={{ padding: '1.5rem' }}>
      <h3 style={{ marginBottom: '1rem' }}>New prescription</h3>

      {isDirty && <RestoredBanner onDiscard={clearDraft} />}

      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Tied to visit</label>
        <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle} required>
          <option value="">— select visit —</option>
          {patient.visits.map((v) => (
            <option key={v.id} value={v.id}>
              {formatDate(v.visitDate)} — {v.service?.name || 'Consultation'}
            </option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: '0.5rem' }}><label style={labelStyle}>Drugs</label></div>
      {drugs.map((d, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <DrugAutocomplete
            value={d.name}
            onChange={(v) => setDrug(i, 'name', v)}
            onPick={(drug) => setDraft((s) => {
              const next = [...s.drugs];
              // Don't clobber dosage/frequency/duration the clinician already typed.
              next[i] = {
                ...next[i],
                name: drug.name,
                dosage: next[i].dosage || drug.defaultDosage || '',
                frequency: next[i].frequency || drug.defaultFrequency || '',
                duration: next[i].duration || drug.defaultDuration || '',
              };
              return { ...s, drugs: next };
            })}
          />
          <input placeholder="Dosage" value={d.dosage} onChange={(e) => setDrug(i, 'dosage', e.target.value)} style={inputStyle} />
          <input placeholder="Frequency" value={d.frequency} onChange={(e) => setDrug(i, 'frequency', e.target.value)} style={inputStyle} />
          <input placeholder="Duration" value={d.duration} onChange={(e) => setDrug(i, 'duration', e.target.value)} style={inputStyle} />
        </div>
      ))}
      <button type="button" onClick={addDrug} style={{ background: 'transparent', border: '1px dashed rgba(255,255,255,0.15)', color: 'var(--text-secondary)', padding: '0.4rem 0.75rem', borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem', marginBottom: '1rem' }}>
        + Add drug
      </button>

      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Instructions</label>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
      </div>

      <button
        type="submit"
        disabled={saving || !canSave}
        title={!canSave ? 'Pick a visit and enter at least one drug name' : ''}
        style={{
          padding: '0.55rem 1.25rem',
          background: canSave ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
          color: '#fff', border: 'none', borderRadius: 8,
          cursor: canSave && !saving ? 'pointer' : 'not-allowed',
          opacity: canSave ? 1 : 0.6,
        }}
      >
        {saving ? 'Saving…' : 'Save prescription'}
      </button>
    </form>
    </>
  );
}

// ── Consent tab with signature canvas ─────────────────────────────

function ConsentTab({ patient, services, onSaved }) {
  const notify = useNotify();
  const canvasRef = useRef(null);
  const [templateName, setTemplateName] = useState('hair-transplant');
  const [serviceId, setServiceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  // #612: tenant-configurable consent templates. Pre-fix the dropdown was
  // hardcoded to 5 options; now it loads from /api/wellness/consent-templates
  // and falls back to the seeded list if the endpoint is unreachable.
  const [templates, setTemplates] = useState([]);
  useEffect(() => {
    fetchApi('/api/wellness/consent-templates')
      .then((res) => {
        const list = Array.isArray(res) ? res.filter((t) => t.isActive !== false) : [];
        setTemplates(list);
        if (list.length > 0 && !list.some((t) => t.key === templateName)) {
          setTemplateName(list[0].key);
        }
      })
      .catch(() => { /* fall back to legacy hardcoded options below */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // #564: DPDP §15 — surface the template body to the signer AT POINT OF
  // CAPTURE so the patient sees the wording they're agreeing to. Pre-fix
  // the page rendered only the dropdown + signature canvas; the QA retest
  // 2026-05-07 flagged this as the residual gap. The body is also what gets
  // server-snapshot'd into ConsentForm.contentSnapshot at POST time.
  const selectedTemplate = templates.find((t) => t.key === templateName) || null;
  // Track whether the patient has actually drawn anything on the canvas. Without
  // this guard, canvas.toDataURL() always returns a valid (but empty) PNG and the
  // server stores a blank "signature" — a legal/compliance issue (#118).
  const [hasStrokes, setHasStrokes] = useState(false);

  const [downloadingId, setDownloadingId] = useState(null);

  const downloadConsentPdf = async (c) => {
    setDownloadingId(c.id);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/consents/${c.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      console.log(`[PDF Download] Status: ${res.status}, Content-Type: ${res.headers.get('content-type')}`);
      if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
      const blob = await res.blob();
      console.log(`[PDF Download] Blob size: ${blob.size} bytes, type: ${blob.type}`);
      if (blob.size === 0) throw new Error('PDF blob is empty');
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('[PDF Download Error]', err);
      notify.error(err.message || 'Failed to download consent PDF.');
    } finally {
      setDownloadingId(null);
    }
  };

  const startDraw = (e) => {
    setIsDrawing(true);
    setHasStrokes(true);
    const ctx = canvasRef.current.getContext('2d');
    // #231: previous code hardcoded strokeStyle = '#fff' which made signatures
    // invisible on the wellness cream background (#204 fixed the canvas bg
    // but missed the stroke color). Resolve the theme's text color from
    // CSS variables at draw time so strokes contrast on both dark and cream.
    const cssColor = getComputedStyle(canvasRef.current).getPropertyValue('--text-primary').trim();
    ctx.strokeStyle = cssColor || '#1f2937';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const draw = (e) => {
    if (!isDrawing) return;
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = getCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const endDraw = () => setIsDrawing(false);
  const getCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };
  const clearSig = () => {
    const c = canvasRef.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setHasStrokes(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!hasStrokes) {
      notify.error('Please capture the patient signature before saving the consent.');
      return;
    }
    setSaving(true);
    try {
      const signatureSvg = canvasRef.current.toDataURL('image/png');
      // #564 v3.7.3 — staff-tablet-handoff workflow. The PatientDetail
      // consent canvas is operated by the staff member during patient
      // intake (staff opens the form, hands tablet to patient, patient
      // signs, staff submits). captureMethod pins this in the audit log;
      // the patient-portal path (when it ships) will send 'portal-self-serve'.
      await fetchApi('/api/wellness/consents', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          serviceId: serviceId || null,
          templateName,
          signatureSvg,
          captureMethod: 'tablet-handoff',
        }),
      });
      clearSig();
      onSaved();
      notify.success('Consent captured.');
    } catch (_err) { /* fetchApi already toasted */ } finally { setSaving(false); }
  };

  // #583: prior-consents list — clinician needs to verify whether a consent
  // has already been captured for this patient/template/service before
  // recapturing. patient.consents already arrives ordered desc by signedAt
  // from the parent fetch (see routes/wellness.js GET /patients/:id include).
  const allPriorConsents = Array.isArray(patient?.consents) ? patient.consents : [];
  const [consentFilter, setConsentFilter] = useState(EMPTY_DATE_FILTER);
  const [consentRangeStart, consentRangeEnd] = resolveDateRange(consentFilter);
  const priorConsents = (consentRangeStart && consentRangeEnd)
    ? allPriorConsents.filter((c) => {
        const ts = new Date(c.signedAt).getTime();
        return ts >= consentRangeStart.getTime() && ts <= consentRangeEnd.getTime();
      })
    : allPriorConsents;
  const formatPriorDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <form onSubmit={submit} className="glass" style={{ padding: '1.5rem' }}>
      {/* #583: Recent consents — visible above the capture surface so the
          clinician can verify before re-capturing. */}
      <section
        data-testid="prior-consents"
        style={{
          marginBottom: '1.5rem',
          padding: '1rem',
          background: 'var(--card-bg, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: 8,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Recent consents</h3>
          {allPriorConsents.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <DateRangeFilter value={consentFilter} onChange={setConsentFilter} label={null} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {priorConsents.length === allPriorConsents.length
                  ? `${allPriorConsents.length}`
                  : `${priorConsents.length} of ${allPriorConsents.length}`}
              </span>
            </div>
          )}
        </div>
        {allPriorConsents.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No prior consents on file.
          </p>
        ) : priorConsents.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No consents in the selected range.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {priorConsents.map((c) => (
              <li
                key={c.id}
                style={{
                  padding: '0.4rem 0',
                  borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.06))',
                  fontSize: '0.875rem',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  alignItems: 'baseline',
                }}
              >
                <strong>{c.templateName}</strong>
                <span style={{ color: 'var(--text-secondary)' }}>·</span>
                <span style={{ color: 'var(--text-secondary)' }}>{formatPriorDate(c.signedAt)} IST</span>
                {c.service?.name && (
                  <>
                    <span style={{ color: 'var(--text-secondary)' }}>·</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{c.service.name}</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => downloadConsentPdf(c)}
                  disabled={downloadingId === c.id}
                  title="Download signed consent PDF"
                  style={{
                    marginLeft: 'auto', background: 'transparent',
                    border: '1px solid var(--primary-color, var(--accent-color))',
                    color: 'var(--primary-color, var(--accent-color))',
                    padding: '0.2rem 0.6rem', borderRadius: 6, fontSize: '0.75rem',
                    cursor: downloadingId === c.id ? 'wait' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: '0.3rem',
                  }}
                >
                  <Download size={12} />
                  {downloadingId === c.id ? 'Downloading...' : 'PDF'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h3 style={{ marginBottom: '1rem' }}>Capture consent</h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
        <div>
          <label style={labelStyle}>Template</label>
          <select value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle}>
            {/* #612: tenant-configurable templates from /api/wellness/consent-templates.
                Falls back to the legacy hardcoded 5 when the endpoint returns nothing
                (e.g. pre-seed call on a brand-new tenant before the GET fires). */}
            {templates.length > 0 ? (
              templates.map((t) => <option key={t.id} value={t.key}>{t.label}</option>)
            ) : (
              <>
                <option value="hair-transplant">Hair Transplant</option>
                <option value="botox-fillers">Botox / Fillers</option>
                <option value="laser">Laser Treatment</option>
                <option value="chemical-peel">Chemical Peel</option>
                <option value="general">General Procedure</option>
              </>
            )}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Service (optional)</label>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputStyle}>
            <option value="">— none —</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {/* #564: DPDP §15 — render the selected template's body inline so the
          signer can read what they're agreeing to before signing. Falls back
          to a notice if the template carries no body (legacy seed rows had
          empty bodies; admin can add wording via /api/wellness/consent-templates). */}
      <section
        data-testid="consent-template-body"
        style={{
          marginBottom: '1rem',
          padding: '0.85rem 1rem',
          maxHeight: 240,
          overflowY: 'auto',
          background: 'var(--card-bg, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: 8,
          fontSize: '0.85rem',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>
          {selectedTemplate?.label || templateName}
        </div>
        {selectedTemplate?.body ? (
          <div>{selectedTemplate.body}</div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            This template has no body text on file. Ask your administrator to
            add the consent wording (purpose, data categories, retention, jurisdiction)
            via Settings → Consent templates so DPDP §15 disclosures appear here.
          </div>
        )}
      </section>

      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Patient signature (sign below)</label>
        <canvas
          ref={canvasRef}
          width={600}
          height={180}
          // #204: previous styles used white alpha (rgba(255,255,255,0.04)
          // bg + 0.15 border) leftover from the dark theme; on the wellness
          // cream background the canvas was effectively invisible. Use the
          // theme variables for the surface + border so it adapts to either
          // theme, with a dashed border that contrasts on cream/teal too.
          style={{ width: '100%', maxWidth: 600, height: 180, background: 'var(--card-bg, rgba(0,0,0,0.04))', border: '2px dashed var(--accent-color, #265855)', borderRadius: 8, touchAction: 'none', cursor: 'crosshair' }}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={endDraw}
        />
        <button type="button" onClick={clearSig} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-secondary)', padding: '0.3rem 0.75rem', borderRadius: 8, cursor: 'pointer', fontSize: '0.75rem', marginTop: '0.5rem' }}>
          Clear signature
        </button>
      </div>

      <button
        type="submit"
        disabled={saving || !hasStrokes}
        title={!hasStrokes ? 'Patient must sign before saving' : ''}
        style={{
          padding: '0.55rem 1.25rem',
          background: hasStrokes ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
          color: '#fff', border: 'none', borderRadius: 8,
          cursor: hasStrokes && !saving ? 'pointer' : 'not-allowed',
          opacity: hasStrokes ? 1 : 0.6,
        }}
      >
        {saving ? 'Saving…' : 'Save consent'}
      </button>
    </form>
  );
}

// ── Treatment plans tab ───────────────────────────────────────────

const INITIAL_PLAN = {
  name: '',
  totalSessions: 4,
  totalPrice: 0,
  serviceId: '',
};

function PlansTab({ patient, services, onSaved }) {
  const notify = useNotify();
  // #226: persist treatment-plan draft so refresh doesn't wipe input.
  const [draft, setDraft, isDirty, clearDraft] = useFormAutosave(`plan-${patient.id}`, INITIAL_PLAN);
  const { name, totalSessions, totalPrice, serviceId } = draft;
  const setName = (v) => setDraft((s) => ({ ...s, name: v }));
  const setTotalSessions = (v) => setDraft((s) => ({ ...s, totalSessions: v }));
  const setTotalPrice = (v) => setDraft((s) => ({ ...s, totalPrice: v }));
  const setServiceId = (v) => setDraft((s) => ({ ...s, serviceId: v }));
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const allPlans = patient.treatmentPlans || [];
  const plans = (rangeStart && rangeEnd)
    ? allPlans.filter((tp) => {
        const ts = new Date(tp.createdAt).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : allPlans;
  // #225: rapid double-clicks on Add were creating duplicate treatment plans.
  // Guard the submit with a `submitting` flag and disable the button while
  // the POST is in flight.
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      // #420: canonical path is /wellness/treatment-plans (was /treatments).
      // Legacy /treatments now returns 410 Gone with `canonical` pointer.
      await fetchApi('/api/wellness/treatment-plans', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          name, totalSessions, totalPrice, serviceId: serviceId || null,
        }),
      });
      notify.success(`Treatment plan "${name}" created`);
      clearDraft();
      onSaved();
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {allPlans.length > 0 && (
        <div
          className="glass"
          style={{
            padding: '0.6rem 0.85rem', display: 'flex', flexWrap: 'wrap',
            alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem',
          }}
        >
          <DateRangeFilter value={filter} onChange={setFilter} label="Filter by created date" />
          <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {plans.length === allPlans.length
              ? `${allPlans.length} plan${allPlans.length === 1 ? '' : 's'}`
              : `${plans.length} of ${allPlans.length} plans`}
          </span>
        </div>
      )}
      <div style={{ marginBottom: '1rem', display: 'grid', gap: '0.5rem' }}>
        {allPlans.length === 0 && (
          <div className="glass" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No treatment plans yet.</div>
        )}
        {allPlans.length > 0 && plans.length === 0 && (
          <div className="glass" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No plans in the selected range.</div>
        )}
        {plans.map((tp) => (
          <div key={tp.id} className="glass" style={{ padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{tp.name}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {tp.service?.name && <>{tp.service.name} • </>}
                Session {tp.completedSessions}/{tp.totalSessions}
                {tp.totalPrice > 0 && <> • ₹{Math.round(tp.totalPrice).toLocaleString('en-IN')}</>}
                {tp.createdAt && <> • Started {formatDate(tp.createdAt)}</>}
              </div>
            </div>
            <div style={{ width: 100, background: 'rgba(255,255,255,0.05)', borderRadius: 20, height: 6, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round((tp.completedSessions / tp.totalSessions) * 100)}%`, background: 'var(--success-color)', height: '100%' }} />
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="glass" style={{ padding: '1.25rem' }}>
        <h4 style={{ marginBottom: '0.75rem', fontSize: '0.95rem' }}>New treatment plan</h4>
        {isDirty && <RestoredBanner onDiscard={clearDraft} />}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '0.5rem' }}>
          <input placeholder="Plan name (e.g. PRP 6-session package)" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputStyle}>
            <option value="">Service</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input type="number" placeholder="Sessions" min={1} value={totalSessions} onChange={(e) => setTotalSessions(parseInt(e.target.value) || 1)} style={inputStyle} />
          <input type="number" placeholder="Total price ₹" value={totalPrice} onChange={(e) => setTotalPrice(parseFloat(e.target.value) || 0)} style={inputStyle} />
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '0.5rem 1rem',
              background: submitting ? 'rgba(107,114,128,0.3)' : 'var(--accent-color)',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Log visit tab ──────────────────────────────────────────────────
// Shows booked appointments; clicking one lets you mark it as visited (completed)
// and optionally add notes/amount. Marking as visited triggers auto-consumption.

function LogVisitTab({ patient, services, doctors, onSaved }) {
  const notify = useNotify();
  const [selectedVisitId, setSelectedVisitId] = useState(null);
  const [notes, setNotes] = useState('');
  const [consumptionRules, setConsumptionRules] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // Filter booked/pending appointments and completed visits
  const bookedAppointments = patient.visits.filter((v) =>
    v.status && ['booked', 'confirmed', 'arrived', 'in-treatment'].includes(v.status)
  );
  const completedVisits = patient.visits.filter((v) => v.status === 'completed');

  const selectedVisit = selectedVisitId ? patient.visits.find((v) => v.id === parseInt(selectedVisitId)) : null;
  const selectedService = selectedVisit ? services.find((s) => s.id === selectedVisit.serviceId) : null;

  // Fetch auto-consumption rules when visit is selected
  const handleSelectVisit = async (apt) => {
    setSelectedVisitId(apt.id);
    setNotes(apt.notes || '');
    // Fetch consumption rules for this service
    try {
      const rules = await fetchApi('/api/wellness/auto-consumption-rules');
      const serviceRules = Array.isArray(rules) ? rules.filter((r) => r.serviceId === apt.serviceId) : [];
      setConsumptionRules(serviceRules);
    } catch (e) {
      setConsumptionRules([]);
    }
  };

  const markAsVisited = async (e) => {
    e.preventDefault();
    if (!selectedVisit || !selectedService) {
      notify.error('Please select an appointment to mark as visited.');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetchApi(`/api/wellness/visits/${selectedVisit.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: 'completed',
          notes,
          amountCharged: selectedService.basePrice || 0,
        }),
      });
      setSelectedVisitId(null);
      setNotes('');
      setConsumptionRules([]);
      onSaved();
      notify.success('Appointment marked as visited & auto-consumption triggered.');
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '1.5rem' }}>
      {/* Left: List of booked appointments & visit history */}
      <div className="glass" style={{ flex: 1, padding: '1.5rem', overflow: 'auto', maxHeight: '600px' }}>
        {/* Booked Appointments */}
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            📅 Pending Appointments
            {bookedAppointments.length > 0 && <span style={{ fontSize: '0.85rem', color: 'var(--accent-color)', fontWeight: 400 }}>({bookedAppointments.length})</span>}
          </h3>
          {bookedAppointments.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No pending appointments.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {bookedAppointments.map((apt) => (
                <div
                  key={apt.id}
                  onClick={() => handleSelectVisit(apt)}
                  style={{
                    padding: '0.75rem',
                    border: selectedVisitId === apt.id ? '2px solid var(--accent-color)' : '1px solid var(--border-color)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: selectedVisitId === apt.id ? 'rgba(205, 148, 129, 0.1)' : 'rgba(255,255,255,0.02)',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>
                    {formatDate(apt.visitDate)} · {apt.service?.name || 'Consultation'}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Doctor: {apt.doctor?.name || '—'} · Status: <span style={{ textTransform: 'capitalize', color: 'var(--accent-color)' }}>{apt.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Completed Visits History */}
        {completedVisits.length > 0 && (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <h3 style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              ✓ Completed Visits
              <span style={{ fontSize: '0.85rem', color: 'var(--success-color)', fontWeight: 400 }}>({completedVisits.length})</span>
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {completedVisits.map((visit) => (
                <div
                  key={visit.id}
                  style={{
                    padding: '0.75rem',
                    border: '1px solid rgba(16, 185, 129, 0.2)',
                    borderRadius: 8,
                    background: 'rgba(16, 185, 129, 0.05)',
                  }}
                >
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem', color: 'var(--text-primary)' }}>
                    {formatDate(visit.visitDate)} · {visit.service?.name || 'Consultation'}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Doctor: {visit.doctor?.name || '—'}
                    {visit.amountCharged > 0 && <> · Amount: ₹{visit.amountCharged.toLocaleString('en-IN')}</>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right: Mark as visited form */}
      {selectedVisit && (
        <form onSubmit={markAsVisited} className="glass" style={{ flex: 1, padding: '1.5rem', overflow: 'auto', maxHeight: '600px' }}>
          <h3 style={{ marginBottom: '1rem' }}>Mark as visited</h3>

          {/* Service Details */}
          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Service:</div>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{selectedService?.name}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.9rem' }}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Amount: </span>
                <strong>₹{selectedService?.basePrice || 0}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Duration: </span>
                <strong>{selectedService?.durationMin || 30} min</strong>
              </div>
            </div>
          </div>

          {/* Auto-Consumption Preview */}
          {consumptionRules.length > 0 && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>
                ✓ Auto-Consumption Preview
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {consumptionRules.map((rule) => (
                  <div key={rule.id} style={{ fontSize: '0.85rem', padding: '0.4rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{rule.product?.name}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      Will deduct: {rule.quantityPerVisit} {rule.product?.unit || 'units'}
                      {rule.product?.volume && ` (÷ ${rule.product.volume}ml = ${(rule.quantityPerVisit / rule.product.volume).toFixed(2)} units)`}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      Current stock: {rule.product?.currentStock || 0} units
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {consumptionRules.length === 0 && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(107,114,128,0.1)', borderRadius: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              No auto-consumption rules configured for this service.
            </div>
          )}

          {/* Notes */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>Clinical notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Add any clinical observations..."
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            style={{
              width: '100%',
              padding: '0.55rem 1.25rem',
              background: submitting ? 'rgba(107,114,128,0.3)' : 'var(--success-color)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontWeight: 500,
            }}
          >
            {submitting ? 'Marking as visited…' : '✓ Mark as visited & consume products'}
          </button>
        </form>
      )}
    </div>
  );
}

// ── Photos tab — before/after upload per visit ────────────────────

function PhotosTab({ patient, onSaved }) {
  const notify = useNotify();
  const [visitId, setVisitId] = useState(patient.visits[0]?.id || '');
  const [kind, setKind] = useState('before');
  const [uploading, setUploading] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const visibleVisits = (rangeStart && rangeEnd)
    ? patient.visits.filter((v) => {
        const ts = new Date(v.visitDate).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : patient.visits;

  const visit = patient.visits.find((v) => v.id === parseInt(visitId));
  const before = visit?.photosBefore ? JSON.parse(visit.photosBefore) : [];
  const after  = visit?.photosAfter  ? JSON.parse(visit.photosAfter)  : [];

  const upload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !visitId) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('photos', f);
      fd.append('kind', kind);
      const token = getAuthToken();
      const r = await fetch(`/api/wellness/visits/${visitId}/photos`, {
        method: 'POST', body: fd,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      e.target.value = '';
      onSaved();
    } catch (err) { notify.error(`Upload failed: ${err.message}`); }
    setUploading(false);
  };

  const remove = async (url, k) => {
    if (!await notify.confirm('Delete this photo?')) return;
    await fetchApi(`/api/wellness/visits/${visitId}/photos`, {
      method: 'DELETE', body: JSON.stringify({ url, kind: k }),
    });
    onSaved();
  };

  return (
    <div className="glass" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0 }}>Visit photos</h3>
        {patient.visits.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <DateRangeFilter value={filter} onChange={setFilter} label={null} />
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '0.5rem', marginBottom: '1rem', alignItems: 'end' }}>
        <div>
          <label style={labelStyle}>Visit</label>
          <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle}>
            <option value="">— select visit —</option>
            {visibleVisits.map((v) => (
              <option key={v.id} value={v.id}>
                {formatDate(v.visitDate)} — {v.service?.name || 'Consultation'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle}>
            <option value="before">Before</option>
            <option value="after">After</option>
          </select>
        </div>
        <label style={{ padding: '0.55rem 1rem', background: 'var(--accent-color)', color: '#fff', borderRadius: 8, cursor: 'pointer', display: 'inline-block' }}>
          {uploading ? 'Uploading…' : 'Upload photos'}
          <input type="file" multiple accept="image/*" onChange={upload} style={{ display: 'none' }} disabled={!visitId || uploading} />
        </label>
      </div>

      {visit && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <PhotoColumn title="Before" urls={before} onRemove={(u) => remove(u, 'before')} onView={setLightboxUrl} />
          <PhotoColumn title="After"  urls={after}  onRemove={(u) => remove(u, 'after')}  onView={setLightboxUrl} />
        </div>
      )}

      {lightboxUrl && (
        <Lightbox url={displayPhotoSrc(lightboxUrl)} onClose={() => setLightboxUrl(null)} />
      )}
    </div>
  );
}

// Image preview overlay — no chrome around the image, close button on the
// image itself, zoom controls in a bottom pill, and a fullscreen toggle
// that uses the browser Fullscreen API on the wrapper. Backdrop click +
// ESC dismiss; clicks on the image / controls / close stay open
// (stopPropagation).
function Lightbox({ url, onClose }) {
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 5;
  const ZOOM_STEP = 0.25;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const draggingRef = useRef(null);
  const wrapperRef = useRef(null);

  // Reset zoom + pan whenever a new image is shown.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [url]);

  // Keep isFullscreen in sync with the browser — covers the case where the
  // user presses F11 / ESCapes fullscreen via the native UI.
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      // While the wrapper is fullscreen, ESC exits fullscreen (browser
      // default); only close the lightbox when not fullscreen.
      if (e.key === 'Escape' && !document.fullscreenElement) onClose();
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
      else if (e.key === '-' || e.key === '_') setZoom((z) => {
        const next = Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
      else if (e.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (wrapperRef.current?.requestFullscreen) {
        await wrapperRef.current.requestFullscreen();
      }
    } catch (_e) {
      // Fullscreen API can reject for permissions / unsupported browsers;
      // swallow silently — the rest of the lightbox still works.
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    setZoom((z) => {
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + dir * ZOOM_STEP).toFixed(2)));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const onMouseDown = (e) => {
    if (zoom <= 1) return;
    e.preventDefault();
    draggingRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onMouseMove = (e) => {
    if (!draggingRef.current) return;
    const { startX, startY, panX, panY } = draggingRef.current;
    setPan({ x: panX + (e.clientX - startX), y: panY + (e.clientY - startY) });
  };
  const onMouseUp = () => { draggingRef.current = null; };

  return (
    <div
      onClick={onClose}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      role="dialog"
      aria-modal="true"
      aria-label="Photo preview"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: '1rem', cursor: 'zoom-out',
      }}
    >
      <div
        ref={wrapperRef}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        style={{
          // Wrapper auto-sizes to the image's rendered dimensions (no
          // letterbox strips around the picture) so the close button +
          // controls anchored to wrapper corners sit on the IMAGE'S
          // corners, not in empty space beside the image.
          //
          // overflow: hidden + transform-based zoom on the inner <img>
          // means the image scales WITHIN the wrapper — the wrapper
          // (and its anchored chrome) stays put while pixels overflow
          // get clipped. Pan moves the inner image around inside the
          // unchanged wrapper.
          //
          // In fullscreen we expand the wrapper to 100vw × 100vh so the
          // image has room to grow to screen size; close + controls
          // anchor to screen corners which is the conventional fullscreen
          // viewer feel.
          position: 'relative',
          display: isFullscreen ? 'flex' : 'inline-block',
          alignItems: isFullscreen ? 'center' : undefined,
          justifyContent: isFullscreen ? 'center' : undefined,
          background: isFullscreen ? '#000' : 'transparent',
          width: isFullscreen ? '100vw' : 'auto',
          height: isFullscreen ? '100vh' : 'auto',
          overflow: 'hidden',
          cursor: zoom > 1 ? 'grab' : 'default',
          userSelect: 'none',
          lineHeight: 0, // kill the inline-block baseline gap below the img
        }}
      >
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            display: 'block',
            // Natural-size sizing: the <img>'s rendered dimensions are
            // bounded by these caps and the image's intrinsic aspect
            // ratio. The wrapper inherits exactly those dimensions
            // (inline-block + content-sized), so wrapper corners ==
            // image corners == where the close button and controls
            // pill should anchor.
            maxWidth: isFullscreen ? '100vw' : 'min(85vw, 1000px)',
            maxHeight: isFullscreen ? '100vh' : '80vh',
            width: isFullscreen ? '100%' : 'auto',
            height: isFullscreen ? '100%' : 'auto',
            objectFit: 'contain',
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: draggingRef.current ? 'none' : 'transform 120ms ease-out',
            pointerEvents: 'none',
          }}
        />

        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close preview"
          style={lightboxIconBtn({ top: 12, right: 12 })}
        >
          <X size={18} />
        </button>

        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', gap: '0.4rem', alignItems: 'center',
            background: 'rgba(0,0,0,0.65)', borderRadius: 999, padding: '0.35rem 0.6rem',
            border: '1px solid rgba(255,255,255,0.15)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <button
            onClick={() => setZoom((z) => {
              const next = Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2));
              if (next === 1) setPan({ x: 0, y: 0 });
              return next;
            })}
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_MIN}
            style={lightboxControlBtn(zoom <= ZOOM_MIN)}
          >
            <ZoomOut size={16} />
          </button>
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            aria-label="Reset zoom"
            title="Reset zoom (0)"
            style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '0.78rem', minWidth: 44, textAlign: 'center', fontVariantNumeric: 'tabular-nums', cursor: 'pointer', padding: 0 }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_MAX}
            style={lightboxControlBtn(zoom >= ZOOM_MAX)}
          >
            <ZoomIn size={16} />
          </button>
          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.2)', margin: '0 0.2rem' }} />
          <button
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            style={lightboxControlBtn(false)}
          >
            {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function lightboxIconBtn(pos) {
  return {
    position: 'absolute', ...pos, background: 'rgba(0,0,0,0.65)',
    border: '1px solid rgba(255,255,255,0.2)', color: '#fff', borderRadius: 999,
    width: 36, height: 36, display: 'flex', alignItems: 'center',
    justifyContent: 'center', cursor: 'pointer',
    backdropFilter: 'blur(4px)',
  };
}
function lightboxControlBtn(disabled) {
  return {
    background: 'transparent', border: 'none', color: '#fff',
    width: 28, height: 28, borderRadius: 6, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
  };
}

// Photos uploaded before the /api/uploads mount landed are stored as bare
// `/uploads/...` URLs. Nginx + Vite only proxy `/api/*` to the backend, so
// the bare path falls through the SPA catch-all and the <img> renders as
// broken. Rewrite for display only — the original URL is what the DELETE
// endpoint matches against in the stored JSON array, so onRemove still
// receives the raw value.
function displayPhotoSrc(u) {
  if (typeof u !== 'string') return u;
  if (u.startsWith('/uploads/')) return `/api${u}`;
  return u;
}

function PhotoColumn({ title, urls, onRemove, onView }) {
  return (
    <div>
      <h4 style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title} ({urls.length})</h4>
      {urls.length === 0 && <div style={{ padding: '1rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No photos yet.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.5rem' }}>
        {urls.map((u) => (
          <div key={u} style={{ position: 'relative' }}>
            <img
              src={displayPhotoSrc(u)}
              alt=""
              onClick={() => onView && onView(u)}
              title="Click to view"
              style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)', cursor: onView ? 'zoom-in' : 'default' }}
            />
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(u); }}
              aria-label="Delete photo"
              style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.7)', border: 'none', color: '#fff', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Inventory consumption tab ─────────────────────────────────────

function InventoryTab({ patient, onSaved }) {
  const notify = useNotify();
  const [visitId, setVisitId] = useState(patient.visits[0]?.id || '');
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ productName: '', qty: 1, unitCost: 0 });
  const [loading, setLoading] = useState(false);
  // #225: debounce guard so rapid clicks don't create duplicate consumption rows.
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const visibleVisits = (rangeStart && rangeEnd)
    ? patient.visits.filter((v) => {
        const ts = new Date(v.visitDate).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : patient.visits;

  useEffect(() => {
    if (!visitId) { setItems([]); return; }
    setLoading(true);
    fetchApi(`/api/wellness/visits/${visitId}/consumptions`)
      .then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, [visitId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!visitId || !form.productName) return;
    // #125: surface validation errors instead of silently failing on negatives.
    if (Number(form.qty) <= 0) {
      notify.error('Quantity must be at least 1.');
      return;
    }
    if (Number(form.unitCost) < 0) {
      notify.error('Unit cost cannot be negative.');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetchApi(`/api/wellness/visits/${visitId}/consumptions`, {
        method: 'POST', body: JSON.stringify(form),
      });
      notify.success(`Logged ${form.qty}× ${form.productName}`);
      setForm({ productName: '', qty: 1, unitCost: 0 });
      const next = await fetchApi(`/api/wellness/visits/${visitId}/consumptions`);
      setItems(next);
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSubmitting(false);
    }
  };

  const totalCost = items.reduce((s, i) => s + i.qty * i.unitCost, 0);

  return (
    <div className="glass" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0 }}>Inventory used</h3>
        {patient.visits.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <DateRangeFilter value={filter} onChange={setFilter} label={null} />
          </div>
        )}
      </div>
      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Visit</label>
        <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle}>
          <option value="">— select visit —</option>
          {visibleVisits.map((v) => (
            <option key={v.id} value={v.id}>
              {formatDate(v.visitDate)} — {v.service?.name || 'Consultation'}
            </option>
          ))}
        </select>
      </div>

      {visitId && (
        <>
          {loading && <div>Loading…</div>}
          {!loading && (
            <div className="glass" style={{ padding: 0, marginBottom: '1rem', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    {/* #125: labelStyle has `display: block` (it's meant for <label>),
                        which made every <th> stack vertically. Force table-cell here. */}
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'left' }}>Product</th>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'right' }}>Qty</th>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'right' }}>Unit cost</th>
                    <th style={{ ...labelStyle, display: 'table-cell', padding: '0.6rem 1rem', textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem' }}>{i.productName}</td>
                      <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem', textAlign: 'right' }}>{i.qty}</td>
                      <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem', textAlign: 'right' }}>₹{i.unitCost.toLocaleString('en-IN')}</td>
                      <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem', textAlign: 'right', fontWeight: 500 }}>₹{(i.qty * i.unitCost).toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                  {items.length === 0 && <tr><td colSpan={4} style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No products logged for this visit.</td></tr>}
                  {items.length > 0 && (
                    <tr style={{ borderTop: '2px solid rgba(255,255,255,0.08)' }}>
                      <td colSpan={3} style={{ padding: '0.6rem 1rem', fontWeight: 600, textAlign: 'right' }}>Total cost</td>
                      <td style={{ padding: '0.6rem 1rem', fontWeight: 600, textAlign: 'right' }}>₹{totalCost.toLocaleString('en-IN')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* #338: Add button must be disabled until both product name and a
              positive quantity are filled in. Empty rows had been making it
              into the consumption ledger as `qty=0, productName=""`, which
              corrupted stock-deduction reports. */}
          {(() => {
            const productNameOk = !!form.productName && form.productName.trim().length > 0;
            const qtyNum = Number(form.qty);
            const qtyOk = Number.isFinite(qtyNum) && qtyNum >= 1;
            const canAdd = productNameOk && qtyOk && !submitting;
            const disabledReason = !productNameOk
              ? 'Enter a product name first'
              : !qtyOk
                ? 'Quantity must be at least 1'
                : '';
            return (
              <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '0.5rem', alignItems: 'end' }}>
                <input placeholder="Product name (e.g. Botox vial 100u)" required value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} style={inputStyle} />
                <input type="number" min={1} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value === '' ? '' : (parseInt(e.target.value) || 1) })} style={inputStyle} placeholder="Qty" />
                <input type="number" min={0} step={0.01} value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value === '' ? '' : (parseFloat(e.target.value) || 0) })} style={inputStyle} placeholder="Unit cost ₹" />
                <button
                  type="submit"
                  disabled={!canAdd}
                  title={disabledReason}
                  style={{
                    padding: '0.55rem 1rem',
                    background: canAdd ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
                    color: '#fff', border: 'none', borderRadius: 8,
                    cursor: canAdd ? 'pointer' : 'not-allowed',
                    opacity: canAdd ? 1 : 0.6,
                  }}
                >
                  {submitting ? 'Adding…' : 'Add'}
                </button>
              </form>
            );
          })()}
        </>
      )}
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { width: '100%', padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };

// #226: shown above autosaved forms when a draft has been rehydrated from
// sessionStorage. Lets the user discard the restored input in one click.
function RestoredBanner({ onDiscard }) {
  return (
    <div style={{
      marginBottom: '0.75rem', padding: '0.5rem 0.75rem',
      background: 'rgba(205,148,129,0.10)', border: '1px solid rgba(205,148,129,0.25)',
      borderRadius: 8, fontSize: '0.8rem', color: 'var(--text-primary)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
    }}>
      <span>Restored from your previous session.</span>
      <button type="button" onClick={onDiscard} style={{
        background: 'transparent', border: '1px solid rgba(205,148,129,0.4)',
        color: 'var(--text-primary)', padding: '0.25rem 0.6rem', borderRadius: 6,
        cursor: 'pointer', fontSize: '0.75rem',
      }}>
        Discard
      </button>
    </div>
  );
}

// ── Agent D: Loyalty card + modal ─────────────────────────────────

function LoyaltyCard({ patientId }) {
  const [data, setData] = useState(null);
  const [showModal, setShowModal] = useState(false);

  const refresh = () => {
    fetchApi(`/api/wellness/loyalty/${patientId}`)
      .then(setData)
      .catch(() => setData(null));
  };

  useEffect(() => { refresh(); }, [patientId]);

  if (!data) return null;

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="glass"
        style={{
          width: '100%',
          padding: '0.85rem 1.25rem',
          marginBottom: '1rem',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'linear-gradient(90deg, rgba(205,148,129,0.10), rgba(205,148,129,0.04))',
          border: '1px solid rgba(205,148,129,0.25)',
          borderRadius: 10,
          cursor: 'pointer',
          color: 'var(--text-primary)',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Award size={20} color="var(--accent-color)" />
          <div>
            <strong style={{ fontSize: '0.95rem' }}>Loyalty: {data.balance} points</strong>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
              · {data.earnedThisMonth} earned this month
            </span>
          </div>
        </div>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>View history →</span>
      </button>

      {showModal && (
        <LoyaltyModal patientId={patientId} data={data} onClose={() => setShowModal(false)} onChange={refresh} />
      )}
    </>
  );
}

function LoyaltyModal({ patientId, data, onClose, onChange }) {
  const notify = useNotify();
  const [redeemPoints, setRedeemPoints] = useState(50);
  const [redeemReason, setRedeemReason] = useState('');
  const [busy, setBusy] = useState(false);

  const redeem = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await fetchApi(`/api/wellness/loyalty/${patientId}/redeem`, {
        method: 'POST',
        body: JSON.stringify({ points: redeemPoints, reason: redeemReason || 'Redemption' }),
      });
      setRedeemReason('');
      onChange();
    } catch (err) { notify.error(`Redeem failed: ${err.message}`); }
    setBusy(false);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          width: '90%', maxWidth: 600, maxHeight: '85vh', overflow: 'auto',
          padding: '1.5rem', background: 'var(--surface-color, #fff)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Award size={18} /> Loyalty history
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Current balance</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent-color)' }}>{data.balance} pts</div>
        </div>

        <form onSubmit={redeem} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8, marginBottom: '1rem', display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: '0.4rem', alignItems: 'end' }}>
          <div>
            <label style={labelStyle}><Minus size={11} /> Redeem</label>
            <input type="number" min={1} max={data.balance} value={redeemPoints} onChange={(e) => setRedeemPoints(parseInt(e.target.value) || 0)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Reason</label>
            <input value={redeemReason} onChange={(e) => setRedeemReason(e.target.value)} placeholder={`e.g. ${currencySymbol()}500 service discount`} style={inputStyle} />
          </div>
          <button type="submit" disabled={busy || data.balance < redeemPoints} style={{ padding: '0.55rem 1rem', background: data.balance < redeemPoints ? 'var(--text-tertiary)' : 'var(--warning-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: data.balance < redeemPoints ? 'not-allowed' : 'pointer' }}>
            {busy ? '…' : 'Redeem'}
          </button>
        </form>

        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem' }}>Recent transactions</h3>
        {data.transactions.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '1rem', textAlign: 'center' }}>No transactions yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Date</th>
                <th style={{ textAlign: 'left', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Type</th>
                <th style={{ textAlign: 'right', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Pts</th>
                <th style={{ textAlign: 'left', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((tx) => (
                <tr key={tx.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.4rem' }}>{formatDate(tx.createdAt)}</td>
                  <td style={{ padding: '0.4rem' }}>{tx.type}</td>
                  <td style={{ padding: '0.4rem', textAlign: 'right', color: tx.points >= 0 ? 'var(--success-color)' : 'var(--warning-color)', fontWeight: 600 }}>{tx.points >= 0 ? '+' : ''}{tx.points}</td>
                  <td style={{ padding: '0.4rem', color: 'var(--text-secondary)' }}>{tx.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Agent B: Telehealth tab (Jitsi-embedded video consults) ───────
function slugifyName(n) {
  return String(n || 'patient')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'patient';
}

function TelehealthTab({ patient, onSaved }) {
  const notify = useNotify();
  const [activeRoom, setActiveRoom] = useState(null); // string room name
  const [busyVisitId, setBusyVisitId] = useState(null);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);

  const allVisits = (patient.visits || []).slice().sort(
    (a, b) => new Date(b.visitDate) - new Date(a.visitDate),
  );
  const visits = (rangeStart && rangeEnd)
    ? allVisits.filter((v) => {
        const ts = new Date(v.visitDate).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : allVisits;

  const startOrJoin = async (visit) => {
    let room = visit.videoRoom;
    if (!room) {
      room = `gbs-${visit.id}-${slugifyName(patient.name)}`;
      setBusyVisitId(visit.id);
      try {
        await fetchApi(`/api/wellness/visits/${visit.id}`, {
          method: 'PUT',
          body: JSON.stringify({ videoRoom: room }),
        });
        if (onSaved) onSaved();
      } catch (e) {
        notify.error('Failed to start consult: ' + (e.message || 'unknown error'));
        setBusyVisitId(null);
        return;
      }
      setBusyVisitId(null);
    }
    setActiveRoom(room);
    setCopied(false);
  };

  const shareUrl = activeRoom ? `https://meet.jit.si/${activeRoom}` : '';

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = shareUrl;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch (_) {}
      document.body.removeChild(ta);
    }
  };

  if (allVisits.length === 0) {
    return (
      <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        No visits yet — log a visit first to start a video consult.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div
        className="glass"
        style={{
          padding: '0.6rem 0.85rem', display: 'flex', flexWrap: 'wrap',
          alignItems: 'center', gap: '0.6rem',
        }}
      >
        <DateRangeFilter value={filter} onChange={setFilter} label="Filter by visit date" />
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {visits.length === allVisits.length
            ? `${allVisits.length} visit${allVisits.length === 1 ? '' : 's'}`
            : `${visits.length} of ${allVisits.length} visits`}
        </span>
      </div>
      <div className="glass" style={{ padding: '1rem' }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
          Each visit can host one video room. Patients join the same link from the patient portal.
        </div>
        {visits.length === 0 && (
          <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No visits in the selected range.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {visits.map((v) => {
            const has = !!v.videoRoom;
            const isActive = activeRoom && v.videoRoom === activeRoom;
            return (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', background: 'rgba(255,255,255,0.04)', borderRadius: 8, border: isActive ? '1px solid var(--accent-color)' : '1px solid transparent' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                    {v.service?.name || 'Visit'} <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>— {new Date(v.visitDate).toLocaleString('en-IN')}</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Status: {v.status}
                    {has && <> • Room: <code style={{ color: 'var(--accent-color)' }}>{v.videoRoom}</code></>}
                    {/* Wave 7D — surface bookingType + travel-time so the
                        clinician knows whether this is a clinic visit, an
                        at-home visit (with travel buffer), a video, or a
                        phone consult. */}
                    {v.bookingType && v.bookingType !== 'CLINIC_VISIT' && (
                      <> • {v.bookingType.replace(/_/g, ' ').toLowerCase()}</>
                    )}
                    {v.bookingType === 'IN_HOME' && Number.isFinite(v.travelTimeMinutes) && v.travelTimeMinutes > 0 && (
                      <> • Travel: {v.travelTimeMinutes} min</>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => startOrJoin(v)}
                  disabled={busyVisitId === v.id}
                  style={{ padding: '0.45rem 0.85rem', background: has ? 'var(--success-color)' : 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <Video size={14} />
                  {busyVisitId === v.id ? 'Starting…' : has ? 'Join video' : 'Start video consult'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {activeRoom && (
        <div className="glass" style={{ padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Live consult — room <code style={{ color: 'var(--text-primary)' }}>{activeRoom}</code>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button
                onClick={copyLink}
                style={{ padding: '0.4rem 0.75rem', background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
              >
                <Copy size={13} /> {copied ? 'Copied!' : 'Share with patient'}
              </button>
              <button
                onClick={() => setActiveRoom(null)}
                style={{ padding: '0.4rem 0.75rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem' }}
              >
                Close
              </button>
            </div>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', wordBreak: 'break-all' }}>
            {shareUrl}
          </div>
          <iframe
            title="Telehealth video consult"
            src={shareUrl}
            allow="camera; microphone; fullscreen; display-capture; autoplay"
            style={{ width: '100%', height: 600, border: 0, borderRadius: 8, background: '#000' }}
          />
        </div>
      )}
    </div>
  );
}

// ── Wave 11 Agent EE: Memberships tab ──────────────────────────────
// Lists the patient's memberships (active + cancelled + expired), shows
// remaining balances per service, and offers a "Buy membership" button
// that opens the plan picker. Redemption happens from the visit-create
// flow (PHI-write gate); this tab is the patient-side surface.
function MembershipsTab({ patient, services }) {
  const notify = useNotify();
  const [memberships, setMemberships] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showBuy, setShowBuy] = useState(false);
  const [pickedPlanId, setPickedPlanId] = useState('');
  const [buying, setBuying] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/wellness/patients/${patient.id}/memberships`).catch(() => []),
      fetchApi('/api/wellness/membership-plans').catch(() => []),
    ])
      .then(([m, p]) => {
        setMemberships(Array.isArray(m) ? m : []);
        setPlans(Array.isArray(p) ? p : []);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [patient.id]);

  const buy = async () => {
    if (!pickedPlanId) {
      notify.error('Pick a plan first');
      return;
    }
    setBuying(true);
    try {
      await fetchApi(`/api/wellness/patients/${patient.id}/memberships`, {
        method: 'POST',
        body: JSON.stringify({ planId: parseInt(pickedPlanId, 10) }),
      });
      notify.success('Membership purchased');
      setShowBuy(false);
      setPickedPlanId('');
      load();
    } catch (_err) {
      // fetchApi toasted
    } finally {
      setBuying(false);
    }
  };

  const cancel = async (m) => {
    if (!confirm(`Cancel "${m.plan?.name || 'membership'}"? Remaining entitlements will be void.`)) return;
    try {
      await fetchApi(`/api/wellness/memberships/${m.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'staff cancel' }),
      });
      notify.success('Membership cancelled');
      load();
    } catch (_err) { /* toasted */ }
  };

  const serviceName = (id) => {
    const s = services.find((x) => x.id === id);
    return s ? s.name : `Service #${id}`;
  };

  if (loading) return <div className="glass" style={{ padding: '1.5rem' }}>Loading memberships…</div>;

  return (
    <div className="glass" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Crown size={18} /> Memberships
        </h2>
        <button
          onClick={() => setShowBuy(!showBuy)}
          style={{ padding: '0.4rem 0.8rem', borderRadius: 6, background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
        >
          <Plus size={14} /> {showBuy ? 'Cancel' : 'Buy membership'}
        </button>
      </div>

      {showBuy && (
        <div style={{ background: 'var(--surface-color)', padding: '1rem', borderRadius: 6, marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>Select a plan</label>
          <select
            value={pickedPlanId}
            onChange={(e) => setPickedPlanId(e.target.value)}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)', marginBottom: '0.75rem' }}
          >
            <option value="">— Choose a plan —</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.durationDays} days, {p.currency} {p.price})</option>
            ))}
          </select>
          <button onClick={buy} disabled={buying || !pickedPlanId} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: 'none', background: 'var(--primary-color, var(--accent-color))', color: '#fff', cursor: buying ? 'wait' : 'pointer' }}>
            {buying ? 'Purchasing…' : 'Confirm purchase'}
          </button>
        </div>
      )}

      {memberships.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>This patient has no memberships yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {memberships.map((m) => {
            let balance = [];
            try { balance = JSON.parse(m.balance || '[]'); } catch { balance = []; }
            const expired = m.status === 'expired' || (new Date(m.endDate) < new Date());
            const cancelled = m.status === 'cancelled';
            const statusColor = cancelled ? '#991b1b' : expired ? '#92400e' : '#065f46';
            const statusBg = cancelled ? '#fee2e2' : expired ? '#fef3c7' : '#d1fae5';
            return (
              <div key={m.id} style={{ padding: '1rem', border: '1px solid var(--border-color)', borderRadius: 8, opacity: cancelled ? 0.65 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <div>
                    <strong>{m.plan?.name || `Plan #${m.planId}`}</strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatDate(m.startDate)} → {formatDate(m.endDate)}
                    </div>
                  </div>
                  <span style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: 4, background: statusBg, color: statusColor }}>
                    {cancelled ? 'cancelled' : expired ? 'expired' : 'active'}
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem' }}>
                  <strong>Remaining:</strong>
                  {balance.length === 0 ? (
                    <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>(no balance)</span>
                  ) : (
                    <ul style={{ paddingLeft: '1.2rem', margin: '0.25rem 0' }}>
                      {balance.map((b, i) => (
                        <li key={i}>{serviceName(b.serviceId)}: {b.remaining}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {!cancelled && !expired && (
                  <button
                    onClick={() => cancel(m)}
                    style={{ marginTop: '0.5rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', borderRadius: 4, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--danger-color, #ef4444)', cursor: 'pointer' }}
                  >
                    Cancel membership
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
