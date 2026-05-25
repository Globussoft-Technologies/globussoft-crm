import { useEffect, useMemo, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Calendar, Stethoscope, FileText, FileSignature, ClipboardList, Plus, Camera, Package, Trash2, Video, Copy, Award, X, Minus, Download, ChevronDown, ChevronUp, Wallet as WalletIcon, Crown, CheckCircle, Clock, Pill, Activity } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { useFormAutosave } from '../../utils/useFormAutosave';
import { formatDate } from '../../utils/date';
import { currencySymbol, formatMoney } from '../../utils/money';
import DateRangePicker, { effectiveRangeFor } from '../../components/DateRangePicker';

const tabStyle = (active) => ({
  padding: '0.5rem 1rem', border: 'none', background: active ? 'var(--accent-color)' : 'transparent',
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

export default function PatientDetail() {
  const { id } = useParams();
  const [patient, setPatient] = useState(null);
  const [services, setServices] = useState([]);
  const [doctors, setDoctors] = useState([]);
  // #793 — surface wallet balance as a header chip on Patient 360 so
  // front-desk operators see prepaid balance without drilling into the
  // Wallet tab. Loaded independently from the patient core so a wallet
  // 404 / non-wellness-tenant fetch failure does not red the whole page.
  const [walletInfo, setWalletInfo] = useState(null);
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
    // #793 — fetch wallet alongside patient core. Defaulted to null on any
    // error (lazy-create endpoint returns 404 only on cross-tenant access;
    // a fresh patient with no transactions still gets a zero-balance wallet
    // from getOrCreateWallet on the backend).
    fetchApi(`/api/wellness/patients/${id}/wallet`)
      .then((w) => setWalletInfo(w && w.wallet ? w.wallet : null))
      .catch(() => setWalletInfo(null));
    Promise.all([
      fetchApi(`/api/wellness/patients/${id}`),
      fetchApi('/api/wellness/services'),
      fetchApi('/api/staff').catch(() => []),
    ]).then(([p, s, staff]) => {
      setPatient(p);
      setServices(s);
      // #752 — "Doctor" dropdown was filtering wellnessRole === 'doctor' only,
      // so professionals (stylists, aestheticians, slimming therapists,
      // Ayurveda practitioners — 12 of them on demo) couldn't be assigned to
      // a visit. The Calendar grid (#262) and the WorkingHoursEditor already
      // include both roles for the same reason; align the Log Visit dropdown
      // with that convention. Filters out deactivated rows so the list stays
      // current (the Staff directory keeps inactive rows but flags them).
      setDoctors(
        (Array.isArray(staff) ? staff : []).filter(
          (u) =>
            (u.wellnessRole === 'doctor' || u.wellnessRole === 'professional') &&
            !u.deactivatedAt
        )
      );
    }).catch(() => setPatient(null)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (!patient) return <div style={{ padding: '2rem' }}>Patient not found.</div>;

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <Link to="/wellness/patients" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-secondary)', textDecoration: 'none', marginBottom: '1rem', fontSize: '0.85rem' }}>
        <ArrowLeft size={14} /> Back to patients
      </Link>

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
              // #792 — surface anniversary alongside DOB for the
              // anniversary-marketing operator workflow.
              if (patient.anniversary) {
                const aDate = new Date(patient.anniversary);
                if (!Number.isNaN(aDate.getTime())) {
                  parts.push(`Anniv ${formatDate(patient.anniversary)}`);
                }
              }
              // #792 — GSTIN visible for B2B / corporate patients so the
              // doctor doesn't have to dig into Profile to confirm the
              // invoice will carry it.
              if (patient.gst) parts.push(`GST ${patient.gst}`);
              return parts.length ? parts.join(' · ') : '—';
            })()}
          </div>
        </div>
        {/* #793 — wallet balance chip. Appears between the subline and the
            counts column so it sits at eye-level next to the patient's name.
            Skipped silently when the wallet endpoint is unavailable (e.g.
            generic-tenant Patient row that predates the wallet model). */}
        {walletInfo && (
          <div
            data-testid="patient-header-wallet-chip"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.4rem 0.75rem', borderRadius: 999,
              background: 'rgba(38,88,85,0.08)',
              border: '1px solid rgba(38,88,85,0.2)',
              color: 'var(--primary-color, var(--accent-color))',
              fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap',
            }}
            title={`Wallet balance — ${formatMoney(walletInfo.balance, { currency: walletInfo.currency })}`}
          >
            <WalletIcon size={14} />
            <span data-testid="patient-header-wallet-amount">
              {formatMoney(walletInfo.balance, { currency: walletInfo.currency })}
            </span>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: 500 }}>wallet</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <span>Source: <strong style={{ color: 'var(--text-primary)' }}>{patient.source || '—'}</strong></span>
          <span>{patient.visits.length} visits • {patient.prescriptions.length} Rx • {patient.treatmentPlans.length} treatment plans</span>
          {/* #840 — consolidated patient-record export. Forces a save (not a
              tab-open) because operators handing off records to referring
              providers / archives want a file on disk, not a preview. The
              endpoint requires Bearer auth so we stream via fetch + blob
              rather than navigating via window.location. */}
          <DownloadFullReportButton patientId={patient.id} patientName={patient.name} />
        </div>
      </div>

      {/* Agent D: loyalty card — sits above the tab list, NOT inside it. */}
      <LoyaltyCard patientId={patient.id} />

      {/* Tabs.
          #523: className-based responsive hook (was [style*="flex-wrap"]
          attribute selector). Mobile rule allows the strip to scroll
          horizontally when too many tabs survive the wrap. */}
      <div className="wellness-tab-strip" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {/* Tick #200 — unified Timeline tab consumes the server-merged
            /timeline endpoint (1 fetch instead of the 4 stitched fetches the
            Case-history tab does client-side). Listed FIRST because it's the
            "what happened with this patient in chronological order" summary
            view operators most often want as the landing surface. The
            existing 4 per-resource tabs stay — they serve detail editing /
            new-capture surfaces, while Timeline is the unified read view. */}
        <button data-testid="timeline-tab" style={tabStyle(tab === 'timeline')} onClick={() => setTab('timeline')}><Activity size={14} /> Timeline</button>
        <button style={tabStyle(tab === 'history')} onClick={() => setTab('history')}><Calendar size={14} /> Case history</button>
        {/* #838 — dedicated Prescriptions list tab with Active/Past status
            indicators + filter chips. Distinct from "New prescription"
            (which is the capture surface). Clinicians need a one-click
            way to see "what is this patient currently taking?" without
            scrolling the merged case-history timeline. */}
        <button data-testid="rx-list-tab" style={tabStyle(tab === 'rxlist')} onClick={() => setTab('rxlist')}><Pill size={14} /> Prescriptions</button>
        <button style={tabStyle(tab === 'prescribe')} onClick={() => setTab('prescribe')}><FileText size={14} /> New prescription</button>
        <button style={tabStyle(tab === 'consent')} onClick={() => setTab('consent')}><FileSignature size={14} /> Consent form</button>
        <button style={tabStyle(tab === 'plans')} onClick={() => setTab('plans')}><ClipboardList size={14} /> Treatment plans</button>
        <button style={tabStyle(tab === 'visit')} onClick={() => setTab('visit')}><Plus size={14} /> Log visit</button>
        <button style={tabStyle(tab === 'photos')} onClick={() => setTab('photos')}><Camera size={14} /> Photos</button>
        <button style={tabStyle(tab === 'inventory')} onClick={() => setTab('inventory')}><Package size={14} /> Inventory used</button>
        {/* Agent B: telehealth tab */}
        <button style={tabStyle(tab === 'telehealth')} onClick={() => setTab('telehealth')}><Video size={14} /> Telehealth</button>
        {/* Wave 11 Agent FF: wallet tab. D16 Arc 1 slice 7 (this tick):
            top-up modal + new endpoint integration. */}
        <button data-testid="wallet-tab" style={tabStyle(tab === 'wallet')} onClick={() => setTab('wallet')}><WalletIcon size={14} /> Wallet</button>
        {/* Wave 11 Agent EE: Memberships tab — patient's purchased plans + balances */}
        <button style={tabStyle(tab === 'memberships')} onClick={() => setTab('memberships')}><Crown size={14} /> Memberships</button>
      </div>

      {tab === 'timeline' && <TimelineTab patientId={patient.id} />}
      {tab === 'history' && <CaseHistoryTab patient={patient} />}
      {tab === 'rxlist' && <PrescriptionsListTab patient={patient} />}
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

// ── Download full patient record (#840) ───────────────────────────
//
// Streams /api/wellness/patients/:id/full-report.pdf via fetch (the endpoint
// is Bearer-auth-gated, so a plain anchor href won't work) and pushes the
// resulting blob through a synthetic <a download> click. Save dialog opens
// directly — no new tab, no preview. We do NOT use window.location.href
// because that would drop the Authorization header.
function DownloadFullReportButton({ patientId, patientName }) {
  const notify = useNotify();
  const [downloading, setDownloading] = useState(false);

  const onClick = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/patients/${patientId}/full-report.pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `patient-${patientId}-full-report.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notify.success(`Downloaded ${patientName || 'patient'} record`);
    } catch (err) {
      notify.error(err.message || 'Failed to download patient report.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="download-full-report-btn"
      onClick={onClick}
      disabled={downloading}
      title="Download visits, prescriptions, consents, treatment plans, photos, and inventory as one PDF"
      style={{
        marginTop: '0.25rem',
        padding: '0.45rem 0.85rem',
        background: 'var(--primary-color, var(--accent-color))',
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        cursor: downloading ? 'wait' : 'pointer',
        fontSize: '0.8rem',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        opacity: downloading ? 0.7 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      <Download size={13} />
      {downloading ? 'Preparing…' : 'Download full record (PDF)'}
    </button>
  );
}

// ── Wallet tab — balance + recent transactions + top-up + redeem-giftcard ──
//
// Wave 11 Agent FF (gift-card redeem) + D16 Arc 1 slice 7 (this tick —
// top-up modal + new-endpoint integration).
//
// Backend wiring (slice 7):
//   - GET /api/wallet/:patientId/balance       → { balanceCents, currency, lastUpdated }
//   - GET /api/wallet/:patientId/transactions  → { transactions, total }
//   - POST /api/wallet/:patientId/topup        → { success, balanceCents, bonusBatchId?, bonusPercent }
//
// The legacy gift-card redeem flow (POST /api/wellness/giftcards/redeem)
// stays in place — it's an orthogonal credit channel (customer hands a
// gift code at the counter; not a top-up).
//
// 404 on /topup is handled gracefully — useful during a deploy gap where
// the backend slice hasn't landed yet on the target environment.
//
// Validation: amount is constrained client-side to ₹100–₹100,000 (the
// backend cap is ₹100K = 10_000_000 cents per single top-up per PRD
// FR-3.2 MAX_TOPUP_CENTS; the floor of ₹100 prevents accidental ₹1 typos
// that would otherwise create batch noise).
const MIN_TOPUP_INR = 100;
const MAX_TOPUP_INR = 100_000;
const PAYMENT_METHODS = ['cash', 'card', 'upi', 'online'];

function formatRelativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function WalletTab({ patient }) {
  const [balance, setBalance] = useState(null); // {balanceCents, currency, lastUpdated}
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
  const notify = useNotify();

  const load = async () => {
    setLoading(true);
    try {
      const [bal, txns] = await Promise.all([
        fetchApi(`/api/wallet/${patient.id}/balance`).catch(() => null),
        fetchApi(`/api/wallet/${patient.id}/transactions?limit=10`).catch(() => null),
      ]);
      setBalance(bal || { balanceCents: 0, currency: 'INR', lastUpdated: null });
      setTransactions(Array.isArray(txns?.transactions) ? txns.transactions : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line */ }, [patient.id]);

  const redeem = async () => {
    if (!code.trim()) return notify.error('Enter a gift card code.');
    setRedeeming(true);
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
      setRedeeming(false);
    }
  };

  if (loading) return <div>Loading wallet…</div>;

  const balanceRupees = balance ? (balance.balanceCents / 100) : 0;
  const currency = balance?.currency || 'INR';

  return (
    <div className="glass" style={{ padding: '1.25rem' }} data-testid="wallet-tab-panel">
      {/* ── Balance card ─────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Wallet balance</div>
          <div data-testid="wallet-balance" style={{ fontSize: '1.75rem', fontWeight: 600 }}>
            {formatMoney(balanceRupees, { currency })}
          </div>
          <div data-testid="wallet-last-updated" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {balance?.lastUpdated ? `Last updated ${formatRelativeTime(balance.lastUpdated)}` : 'No top-ups yet'}
          </div>
        </div>
        <button
          type="button"
          data-testid="wallet-topup-btn"
          onClick={() => setTopupOpen(true)}
          style={{ padding: '0.55rem 1.1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontWeight: 600 }}
        >
          <Plus size={14} /> Top up
        </button>
      </div>

      {/* ── Recent transactions list ─────────────────────────── */}
      <h4 style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>Recent transactions</h4>
      {transactions.length === 0 ? (
        <div data-testid="wallet-txn-empty" style={{ color: 'var(--text-secondary)', padding: '0.5rem 0' }}>No transactions yet.</div>
      ) : (
        <table data-testid="wallet-txn-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Date</th>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Type</th>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Amount</th>
              <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Method / reason</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => {
              const isCredit = (tx.type === 'TOP_UP') || (tx.amount > 0 && tx.type !== 'REDEEM');
              const signedRupees = isCredit ? Math.abs(tx.amount) : -Math.abs(tx.amount);
              return (
                <tr key={tx.id} data-testid={`wallet-txn-${tx.id}`} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>{formatDate(tx.createdAt)}</td>
                  <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>{(tx.type || '').replace(/_/g, ' ')}</td>
                  <td style={{ padding: '0.5rem', fontSize: '0.85rem', color: signedRupees >= 0 ? 'var(--success-color, #10b981)' : 'var(--danger-color, #ef4444)' }}>
                    {signedRupees >= 0 ? '+' : '-'}{formatMoney(Math.abs(signedRupees), { currency })}
                  </td>
                  <td style={{ padding: '0.5rem', fontSize: '0.85rem' }}>{tx.reason || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ── Gift-card redeem strip (kept from Wave 11) ───────── */}
      <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.5rem', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '0.85rem' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Redeem gift card:</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Gift card code"
          style={{ padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', textTransform: 'uppercase' }}
        />
        <button
          type="button"
          onClick={redeem}
          disabled={redeeming}
          style={{ padding: '0.5rem 1rem', background: 'transparent', color: 'var(--primary-color, var(--accent-color))', border: '1px solid var(--primary-color, var(--accent-color))', borderRadius: 6, cursor: redeeming ? 'wait' : 'pointer' }}
        >
          {redeeming ? 'Redeeming…' : 'Redeem'}
        </button>
      </div>

      {topupOpen && (
        <WalletTopupModal
          patientId={patient.id}
          currency={currency}
          onClose={() => setTopupOpen(false)}
          onSuccess={() => { setTopupOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Top-up modal (D16 Arc 1 slice 7) ──────────────────────────────
//
// Captures (amountRupees, paymentMethod) and POSTs to
// /api/wallet/:patientId/topup with `{amountCents, paymentMethod}`. On
// success, shows the bonus credited (if any) and refreshes the parent
// balance + transactions. Validation is client-side (₹100–₹100,000) plus
// the backend's mirror validation; 400 / 403 / 404 are surfaced via
// notify.error with friendly copy.
function WalletTopupModal({ patientId, currency, onClose, onSuccess }) {
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotify();

  const amountNum = parseInt(amount, 10);
  const amountValid = Number.isFinite(amountNum) && amountNum >= MIN_TOPUP_INR && amountNum <= MAX_TOPUP_INR;

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!amountValid) {
      notify.error(`Amount must be between ₹${MIN_TOPUP_INR.toLocaleString()} and ₹${MAX_TOPUP_INR.toLocaleString()}.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchApi(`/api/wallet/${patientId}/topup`, {
        method: 'POST',
        body: JSON.stringify({ amountCents: amountNum * 100, paymentMethod }),
        silent: true, // We surface the toast ourselves so 404 gets the friendly "Backend not ready" copy.
      });
      const bonusPct = res?.bonusPercent || 0;
      const msg = bonusPct > 0
        ? `Top-up succeeded — ₹${amountNum.toLocaleString()} principal + ${bonusPct}% bonus credited.`
        : `Top-up succeeded — ₹${amountNum.toLocaleString()} credited.`;
      notify.success(msg);
      onSuccess?.();
    } catch (err) {
      const status = err?.status;
      if (status === 404) {
        notify.error('Backend not ready — wallet top-up endpoint is being deployed. Try again in a few minutes.');
      } else if (status === 403) {
        notify.error(err.message || 'You don’t have permission to top up this wallet.');
      } else if (status === 400) {
        notify.error(err.message || 'Top-up rejected — check the amount and payment method.');
      } else {
        notify.error(err.message || 'Top-up failed.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="wallet-topup-modal"
      role="dialog"
      aria-label="Wallet top-up"
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          padding: '1.5rem', borderRadius: 12, maxWidth: 420, width: '100%',
          background: 'var(--bg-color, #fff)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Top up wallet</h3>
          <button
            type="button"
            onClick={onClose}
            data-testid="wallet-topup-close"
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <X size={18} />
          </button>
        </div>

        <label style={{ display: 'block', marginBottom: '0.85rem' }}>
          <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
            Amount ({currency === 'INR' ? '₹' : currency})
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_TOPUP_INR}
            max={MAX_TOPUP_INR}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`${MIN_TOPUP_INR}–${MAX_TOPUP_INR.toLocaleString()}`}
            data-testid="wallet-topup-amount"
            style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', fontSize: '1rem' }}
            autoFocus
          />
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            Min ₹{MIN_TOPUP_INR.toLocaleString()} · Max ₹{MAX_TOPUP_INR.toLocaleString()} per top-up.
          </span>
        </label>

        <label style={{ display: 'block', marginBottom: '1rem' }}>
          <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
            Payment method
          </span>
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
            data-testid="wallet-topup-method"
            style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', fontSize: '1rem' }}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}</option>
            ))}
          </select>
        </label>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{ padding: '0.55rem 1rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="wallet-topup-submit"
            disabled={submitting || !amountValid}
            style={{
              padding: '0.55rem 1.1rem',
              background: amountValid ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)',
              color: '#fff', border: 'none', borderRadius: 6,
              cursor: submitting ? 'wait' : (amountValid ? 'pointer' : 'not-allowed'),
              fontWeight: 600,
            }}
          >
            {submitting ? 'Submitting…' : 'Top up'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Prescriptions list tab (#838) ─────────────────────────────────
//
// Dedicated list view for ALL prescriptions on the patient with a status
// indicator (Active / Past) per row and Active/Past/All filter chips.
// Derived client-side because the Prescription model lacks an explicit
// status field — instead we parse the max `duration` token across the
// drugs JSON array and compare (createdAt + maxDays) to today.
//
// Status derivation contract:
//   - Active: createdAt + maxDurationDays >= today
//   - Past:   createdAt + maxDurationDays <  today
//   - Fallback when no parseable duration: treat as Active for the
//     first 30 days, Past after — clinically safest default (better to
//     show "current" than silently hide an Rx the doctor wants to see).
//
// Duration token format: free-text on each drug (e.g. "7 days", "2 weeks",
// "1 month", "30d"). Parsed by parseDurationDays() below; unparseable
// values are skipped and the fallback applies.
//
// TODO: when Prescription gets an explicit status enum + endDate (#838
// follow-up), replace derivation with the schema field. Migration is
// out-of-scope for this commit (needs bless-marker + backfill plan).

const RX_FALLBACK_ACTIVE_DAYS = 30;

// Parse a free-text duration like "7 days", "2 weeks", "1 month", "10d"
// to an integer day count. Returns null if unparseable.
function parseDurationDays(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim().toLowerCase();
  // "7d", "10 d"
  const dMatch = s.match(/^(\d+)\s*d(ays?)?$/);
  if (dMatch) return parseInt(dMatch[1], 10);
  // "2 weeks", "3 wk", "1w"
  const wMatch = s.match(/^(\d+)\s*w(eeks?|k)?$/);
  if (wMatch) return parseInt(wMatch[1], 10) * 7;
  // "1 month", "3 months", "2 mo", "1m"
  const moMatch = s.match(/^(\d+)\s*m(o(nths?)?)?$/);
  if (moMatch) return parseInt(moMatch[1], 10) * 30;
  // Plain integer — assume days (operator convention seen in seed data).
  const intMatch = s.match(/^(\d+)$/);
  if (intMatch) return parseInt(intMatch[1], 10);
  return null;
}

// Given a Prescription row, return { active: boolean, expiresAt: Date|null,
// maxDays: number|null }. expiresAt is the latest known end date across all
// drugs in the Rx; null when no drug has a parseable duration (fallback path).
export function derivePrescriptionStatus(rx, now = new Date()) {
  let drugs = [];
  try { drugs = typeof rx.drugs === 'string' ? JSON.parse(rx.drugs) : rx.drugs; } catch { drugs = []; }
  if (!Array.isArray(drugs)) drugs = [];

  const dayCounts = drugs
    .map((d) => parseDurationDays(d?.duration))
    .filter((n) => n != null && n > 0);

  const createdAt = new Date(rx.createdAt);
  const createdTs = createdAt.getTime();

  if (dayCounts.length === 0) {
    // Fallback: active for first 30 days post-creation.
    const expiresAt = new Date(createdTs + RX_FALLBACK_ACTIVE_DAYS * 86400000);
    return { active: now.getTime() <= expiresAt.getTime(), expiresAt, maxDays: null, fallback: true };
  }

  const maxDays = Math.max(...dayCounts);
  const expiresAt = new Date(createdTs + maxDays * 86400000);
  return { active: now.getTime() <= expiresAt.getTime(), expiresAt, maxDays, fallback: false };
}

function RxStatusBadge({ active, fallback }) {
  // Active = teal (clinical positive), Past = neutral grey.
  const cfg = active
    ? { color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'Active', Icon: CheckCircle }
    : { color: '#6b7280', bg: 'rgba(107,114,128,0.15)', label: 'Past',   Icon: Clock };
  const Icon = cfg.Icon;
  return (
    <span
      data-testid={active ? 'rx-status-active' : 'rx-status-past'}
      title={fallback ? 'Status derived from createdAt (no parseable duration on drugs)' : undefined}
      style={{
        padding: '0.2rem 0.55rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 600,
        backgroundColor: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}33`,
        display: 'inline-flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap',
      }}
    >
      <Icon size={11} />
      {cfg.label}
    </span>
  );
}

function PrescriptionsListTab({ patient }) {
  const [filter, setFilter] = useState('active'); // 'active' | 'past' | 'all'
  const [openRx, setOpenRx] = useState(null);

  // Decorate each Rx with its derived status, sort newest-first, then filter.
  const rxWithStatus = useMemo(() => {
    const now = new Date();
    return (patient.prescriptions || [])
      .map((p) => ({ ...p, _status: derivePrescriptionStatus(p, now) }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [patient.prescriptions]);

  const counts = useMemo(() => ({
    all: rxWithStatus.length,
    active: rxWithStatus.filter((r) => r._status.active).length,
    past: rxWithStatus.filter((r) => !r._status.active).length,
  }), [rxWithStatus]);

  const filtered = useMemo(() => {
    if (filter === 'all') return rxWithStatus;
    if (filter === 'active') return rxWithStatus.filter((r) => r._status.active);
    return rxWithStatus.filter((r) => !r._status.active);
  }, [rxWithStatus, filter]);

  const chipStyle = (active) => ({
    padding: '0.4rem 0.85rem', borderRadius: 999, border: '1px solid var(--border-color)',
    background: active ? 'var(--primary-color, var(--accent-color))' : 'transparent',
    color: active ? '#fff' : 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem',
    fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
  });

  if (rxWithStatus.length === 0) {
    return (
      <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        No prescriptions yet. Use the <strong>New prescription</strong> tab to capture one.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div data-testid="rx-filter-chips" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" data-testid="rx-chip-active" style={chipStyle(filter === 'active')} onClick={() => setFilter('active')}>
          Active <span style={{ opacity: 0.75, fontWeight: 500 }}>({counts.active})</span>
        </button>
        <button type="button" data-testid="rx-chip-past" style={chipStyle(filter === 'past')} onClick={() => setFilter('past')}>
          Past <span style={{ opacity: 0.75, fontWeight: 500 }}>({counts.past})</span>
        </button>
        <button type="button" data-testid="rx-chip-all" style={chipStyle(filter === 'all')} onClick={() => setFilter('all')}>
          All <span style={{ opacity: 0.75, fontWeight: 500 }}>({counts.all})</span>
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="glass" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {filter === 'active' && 'No active prescriptions. The patient is not currently on any medication course.'}
          {filter === 'past' && 'No past prescriptions in this list.'}
        </div>
      ) : (
        filtered.map((rx) => (
          <div
            key={rx.id}
            className="glass"
            data-testid={`rx-row-${rx.id}`}
            onClick={() => setOpenRx(rx)}
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpenRx(rx); } }}
            style={{ padding: '1rem', display: 'flex', gap: '0.75rem', cursor: 'pointer' }}
            title="Click to view full prescription details"
          >
            <div style={{ width: 8, background: '#a855f7', borderRadius: 4, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.3rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <FileText size={14} />
                  <strong>Prescription</strong>
                  <RxStatusBadge active={rx._status.active} fallback={rx._status.fallback} />
                  {rx._status.expiresAt && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {rx._status.active ? 'Ends ' : 'Ended '}
                      {rx._status.expiresAt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {new Date(rx.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                </div>
              </div>
              <RxSummary drugs={rx.drugs} instructions={rx.instructions} />
            </div>
          </div>
        ))
      )}

      {openRx && (
        <RxDetailModal rx={openRx} patient={patient} onClose={() => setOpenRx(null)} />
      )}
    </div>
  );
}

// ── Timeline tab (tick #200) ──────────────────────────────────────
//
// Consumes the server-merged GET /api/wellness/patients/:id/timeline
// endpoint shipped in tick #198 (`c5eec0e7`). Replaces 4 client-side
// fetches + manual stitching with 1 round-trip + uniform event shape:
//   { eventType, eventId, eventAt, summary, refType, refId }
// where eventType ∈ {VISIT, PRESCRIPTION, CONSENT, TREATMENT_PLAN}.
//
// The endpoint sorts DESC server-side (with deterministic tie-breaker
// on eventType ASC + eventId ASC) so this tab just iterates and renders.
// Per-event detail navigation: each row links to the canonical sub-
// resource view via Link to `/wellness/<sub-path>/<refId>` so an
// operator scanning the timeline can drill in with one click.
//
// Filter dropdown supports the endpoint's ?types= comma-list filter
// ("ALL" passes nothing, otherwise sends the single selected type).
// Pagination is fixed at the endpoint's max (200) — sufficient for a
// per-patient view; demand for "Load more" can come later if needed.

const TIMELINE_TYPES = [
  { value: 'ALL', label: 'All' },
  { value: 'VISIT', label: 'Visits' },
  { value: 'PRESCRIPTION', label: 'Prescriptions' },
  { value: 'CONSENT', label: 'Consents' },
  { value: 'TREATMENT_PLAN', label: 'Treatment plans' },
];

function timelineIcon(eventType) {
  const size = 14;
  if (eventType === 'VISIT') return <Stethoscope size={size} />;
  if (eventType === 'PRESCRIPTION') return <Pill size={size} />;
  if (eventType === 'CONSENT') return <FileSignature size={size} />;
  if (eventType === 'TREATMENT_PLAN') return <ClipboardList size={size} />;
  return <Activity size={size} />;
}

function timelineLabel(eventType) {
  if (eventType === 'VISIT') return 'Visit';
  if (eventType === 'PRESCRIPTION') return 'Prescription';
  if (eventType === 'CONSENT') return 'Consent';
  if (eventType === 'TREATMENT_PLAN') return 'Treatment plan';
  return eventType;
}

// Build a deep-link path back into the sub-resource detail surface for
// the event. The backend's refType uses Prisma model names; map them to
// the SPA's routes. We deliberately fall through to the patient page
// itself (current location) when no canonical detail route exists — the
// link still works and the operator stays in context rather than
// landing on a 404.
function timelineHref(event, patientId) {
  if (event.refType === 'Visit') return `/wellness/visits/${event.refId}`;
  if (event.refType === 'Prescription') return `/wellness/prescriptions/${event.refId}`;
  if (event.refType === 'ConsentForm') return `/wellness/consents/${event.refId}`;
  if (event.refType === 'TreatmentPlan') return `/wellness/treatment-plans/${event.refId}`;
  return `/wellness/patients/${patientId}`;
}

function TimelineTab({ patientId }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterType, setFilterType] = useState('ALL');
  // Tick #201 — Export CSV in-flight guard. Disables the button while a
  // download is mid-fetch so a double-click doesn't fire two requests.
  const [timelineCsvBusy, setTimelineCsvBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('limit', '200');
    if (filterType !== 'ALL') params.set('types', filterType);
    fetchApi(`/api/wellness/patients/${patientId}/timeline?${params.toString()}`)
      .then((res) => {
        if (cancelled) return;
        // Endpoint returns { patientId, count, events: [...] }; tolerate
        // a bare array too in case a future revision drops the envelope.
        const list = Array.isArray(res) ? res : Array.isArray(res?.events) ? res.events : [];
        setEvents(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load timeline');
        setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [patientId, filterType]);

  // Tick #201 — Export the on-screen Timeline view as CSV. Mirrors the
  // Patients.jsx XLSX/CSV button pattern from tick #188 (fetch with Auth
  // header → .blob() → createObjectURL → anchor-click → revoke) because
  // the Authorization header forbids a plain <a href> approach. Forwards
  // the active type filter (and the same limit=200 cap) so the exported
  // file matches the visible row set. Filename comes from the response
  // Content-Disposition when the backend supplies one, else falls back
  // to a per-patient default.
  const exportCsv = async () => {
    setTimelineCsvBusy(true);
    try {
      const token = getAuthToken();
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (filterType !== 'ALL') params.set('types', filterType);
      const res = await fetch(
        `/api/wellness/patients/${patientId}/timeline.csv?${params.toString()}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      // Parse filename out of the Content-Disposition header when present;
      // accept both `filename="x.csv"` and bare `filename=x.csv` forms.
      let filename = `patient-${patientId}-timeline.csv`;
      const cd = res.headers.get('Content-Disposition') || res.headers.get('content-disposition') || '';
      const m = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(cd);
      if (m && m[1]) filename = decodeURIComponent(m[1]).replace(/"/g, '');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notify.success(`Exported ${events.length} event${events.length === 1 ? '' : 's'}.`);
    } catch (e) {
      notify.error(e.message || 'CSV export failed.');
    } finally {
      setTimelineCsvBusy(false);
    }
  };

  const exportDisabled = timelineCsvBusy || events.length === 0 || loading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <label htmlFor="timeline-type-filter" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Filter:</label>
        <select
          id="timeline-type-filter"
          data-testid="timeline-type-filter"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          style={{ padding: '0.35rem 0.6rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
        >
          {TIMELINE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button
          type="button"
          data-testid="timeline-export-csv"
          onClick={exportCsv}
          disabled={exportDisabled}
          title={events.length === 0 ? 'No events to export' : 'Export the on-screen timeline as CSV'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.3rem',
            padding: '0.35rem 0.7rem',
            background: 'transparent',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            cursor: exportDisabled ? 'not-allowed' : 'pointer',
            opacity: exportDisabled ? 0.6 : 1,
            fontSize: '0.85rem',
            marginLeft: 'auto',
          }}
        >
          <Download size={14} /> {timelineCsvBusy ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {loading && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading timeline…
        </div>
      )}

      {!loading && error && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--error-color)' }}>
          {error}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No events yet for this patient.
        </div>
      )}

      {!loading && !error && events.length > 0 && (
        <div data-testid="timeline-events" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {events.map((e) => (
            <Link
              key={`${e.eventType}-${e.eventId}`}
              to={timelineHref(e, patientId)}
              data-testid={`timeline-event-${e.eventType}-${e.eventId}`}
              className="glass"
              style={{
                padding: '0.9rem 1rem',
                display: 'flex',
                gap: '0.75rem',
                alignItems: 'flex-start',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <div style={{ flexShrink: 0, paddingTop: 2, color: 'var(--text-secondary)' }}>
                {timelineIcon(e.eventType)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '0.9rem' }}>{timelineLabel(e.eventType)}</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {e.eventAt ? formatDate(e.eventAt) : ''}
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.2rem', lineHeight: 1.4 }}>
                  {e.summary || '—'}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Case history tab ──────────────────────────────────────────────

function CaseHistoryTab({ patient }) {
  // #278: clicking an Rx card pops a detail modal with all fields + PDF download.
  const [openRx, setOpenRx] = useState(null);

  // #837 (cron tick #27 / Agent 1) — date-range filter for the case-history
  // timeline. Filters the merged visits + prescriptions + consents stream by
  // each event's date. Defaults to 'all' because case history is naturally
  // retrospective: a clinician opening the tab wants the full record, not
  // just today (unlike Payments/InventoryReceipts where 'today' is the more
  // useful landing window). Operator can narrow via the dropdown.
  const [dateState, setDateState] = useState({ preset: 'all', customFrom: '', customTo: '' });
  const range = effectiveRangeFor(dateState);

  const allEvents = useMemo(() => [
    ...patient.visits.map((v) => ({ kind: 'visit', date: v.visitDate, data: v })),
    ...patient.prescriptions.map((p) => ({ kind: 'rx', date: p.createdAt, data: p })),
    ...patient.consents.map((c) => ({ kind: 'consent', date: c.signedAt, data: c })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date)),
  [patient.visits, patient.prescriptions, patient.consents]);

  // #837 — apply the date filter client-side. range.from/to are ISO date-only
  // strings (YYYY-MM-DD) in the browser's local TZ; widen `to` to end-of-day
  // so an event timestamped at 18:00 on the selected `to` date is still in
  // window. Empty range (preset='all' or custom-mode with blank inputs)
  // passes everything through.
  const events = useMemo(() => {
    const fromTs = range.from ? new Date(`${range.from}T00:00:00`).getTime() : -Infinity;
    const toTs = range.to ? new Date(`${range.to}T23:59:59.999`).getTime() : Infinity;
    if (!range.from && !range.to) return allEvents;
    return allEvents.filter((e) => {
      const ts = new Date(e.date).getTime();
      return ts >= fromTs && ts <= toTs;
    });
  }, [allEvents, range.from, range.to]);

  // #837 — date-filter pill always renders (even when the patient has no
  // events) so the affordance is discoverable; the empty-state message
  // distinguishes between "no history at all" vs "no history in this window."
  const dateFilter = (
    <DateRangePicker
      id="rx-history-date-preset"
      label="Filter by date:"
      value={dateState}
      onChange={setDateState}
      presets={['today', 'yesterday', 'week7', 'last30', 'month', 'all', 'custom']}
    />
  );

  if (allEvents.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {dateFilter}
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No case history yet.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {dateFilter}
      {events.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No prescriptions, visits, or consents in this window. Broaden the range to see more.
        </div>
      )}
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

// #278 sub-issue 2 + 3: full Rx detail modal. Lists every field (drug, dosage,
// frequency, duration, instructions, prescribed-by, date, patient) and offers
// a "Download PDF" button wired to the existing /api/wellness/prescriptions/:id/pdf
// endpoint (route already exists in backend/routes/wellness.js, which calls
// renderPrescriptionPdf in services/pdfRenderer.js).
function RxDetailModal({ rx, patient, onClose }) {
  const notify = useNotify();
  const [downloading, setDownloading] = useState(false);
  let drugs = [];
  try { drugs = typeof rx.drugs === 'string' ? JSON.parse(rx.drugs) : rx.drugs; } catch { drugs = []; }
  if (!Array.isArray(drugs)) drugs = [];

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      // Use fetch directly so we can stream the binary into a blob URL.
      // fetchApi assumes JSON responses; PDFs are binary.
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
      // Open in a new tab; user can save from there. We also revoke the URL
      // shortly after so we don't leak the blob in memory forever.
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      notify.error(err.message || 'Failed to download prescription PDF.');
    } finally {
      setDownloading(false);
    }
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
          width: '90%', maxWidth: 640, maxHeight: '85vh', overflow: 'auto',
          padding: '1.5rem', background: 'var(--surface-color, #fff)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <FileText size={18} /> Prescription details
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>Patient</div>
            <div style={{ fontWeight: 600 }}>{patient?.name || '—'}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>Date</div>
            <div style={{ fontWeight: 600 }}>{new Date(rx.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>Prescribed by</div>
            <div style={{ fontWeight: 600 }}>{rx.doctor?.name || '—'}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>Visit ID</div>
            <div style={{ fontWeight: 600 }}>#{rx.visitId}</div>
          </div>
        </div>

        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.4rem' }}>Medications</h3>
        {drugs.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '0.5rem 0' }}>(no medications listed)</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', marginBottom: '1rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Drug</th>
                <th style={{ textAlign: 'left', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Dosage</th>
                <th style={{ textAlign: 'left', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Frequency</th>
                <th style={{ textAlign: 'left', padding: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {drugs.map((d, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.4rem', fontWeight: 600 }}>{d.name || d.drug || '—'}</td>
                  <td style={{ padding: '0.4rem' }}>{d.dosage || '—'}</td>
                  <td style={{ padding: '0.4rem' }}>{d.frequency || '—'}</td>
                  <td style={{ padding: '0.4rem' }}>{d.duration || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.4rem' }}>Instructions</h3>
        <div style={{
          fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5,
          whiteSpace: 'pre-wrap', padding: '0.6rem', borderRadius: 8,
          border: '1px solid var(--border-color)', marginBottom: '1rem',
        }}>
          {rx.instructions || '—'}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
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

// ── Prescribe tab ─────────────────────────────────────────────────

const INITIAL_RX = {
  visitId: '',
  drugs: [{ name: '', dosage: '', frequency: '', duration: '' }],
  instructions: '',
};

function PrescribeTab({ patient, onSaved }) {
  const notify = useNotify();
  // #226: persist Rx draft to sessionStorage so a browser refresh doesn't
  // wipe drug/dosage/frequency/duration/instructions.
  const initial = { ...INITIAL_RX, visitId: patient.visits[0]?.id || '' };
  const [draft, setDraft, isDirty, clearDraft] = useFormAutosave(`rx-${patient.id}`, initial);
  const { visitId, drugs, instructions } = draft;
  const [saving, setSaving] = useState(false);

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
          <input placeholder="Drug name" value={d.name} onChange={(e) => setDrug(i, 'name', e.target.value)} style={inputStyle} />
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
  const priorConsents = Array.isArray(patient?.consents) ? patient.consents : [];
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
        <h3 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1rem' }}>Recent consents</h3>
        {priorConsents.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No prior consents on file.
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
      <div style={{ marginBottom: '1rem', display: 'grid', gap: '0.5rem' }}>
        {patient.treatmentPlans.length === 0 && (
          <div className="glass" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No treatment plans yet.</div>
        )}
        {patient.treatmentPlans.map((tp) => (
          <div key={tp.id} className="glass" style={{ padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{tp.name}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {tp.service?.name && <>{tp.service.name} • </>}
                Session {tp.completedSessions}/{tp.totalSessions}
                {tp.totalPrice > 0 && <> • ₹{Math.round(tp.totalPrice).toLocaleString('en-IN')}</>}
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

const INITIAL_VISIT = {
  serviceId: '',
  doctorId: '',
  notes: '',
  amount: 0,
};

function LogVisitTab({ patient, services, doctors, onSaved }) {
  const notify = useNotify();
  // #226: persist log-visit draft to sessionStorage so refresh doesn't wipe input.
  const [draft, setDraft, isDirty, clearDraft] = useFormAutosave(`visit-${patient.id}`, INITIAL_VISIT);
  const { serviceId, doctorId, notes, amount } = draft;
  const setServiceId = (v) => setDraft((s) => ({ ...s, serviceId: v }));
  const setDoctorId = (v) => setDraft((s) => ({ ...s, doctorId: v }));
  const setNotes = (v) => setDraft((s) => ({ ...s, notes: v }));
  const setAmount = (v) => setDraft((s) => ({ ...s, amount: v }));
  // #225: same debounce guard as PlansTab — rapid clicks were creating duplicate visits.
  const [submitting, setSubmitting] = useState(false);

  // #109: Service + Doctor required; amount must be >= 0. Save disabled until valid.
  const valid = !!serviceId && !!doctorId && Number(amount) >= 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid) {
      notify.error('Please select a Service and Doctor, and enter an amount of 0 or more.');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetchApi('/api/wellness/visits', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          serviceId,
          doctorId,
          notes, amountCharged: amount, status: 'completed',
        }),
      });
      clearDraft();
      onSaved();
      notify.success('Visit logged.');
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="glass" style={{ padding: '1.5rem' }}>
      <h3 style={{ marginBottom: '1rem' }}>Log a visit</h3>
      {isDirty && <RestoredBanner onDiscard={clearDraft} />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <div>
          <label style={labelStyle}>Service <span style={{ color: '#ef4444' }}>*</span></label>
          <select required value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputStyle}>
            <option value="">— select —</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name} — ₹{s.basePrice}</option>)}
          </select>
        </div>
        <div>
          {/* #752 — label kept as "Doctor" for clinical familiarity but the
              dropdown now includes professionals (stylists, aestheticians,
              etc.) so any wellness practitioner can be assigned to a visit.
              Role is appended in parens so the staff member can disambiguate
              when names collide. */}
          <label style={labelStyle}>Doctor <span style={{ color: '#ef4444' }}>*</span></label>
          <select required value={doctorId} onChange={(e) => setDoctorId(e.target.value)} style={inputStyle}>
            <option value="">— select —</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}{d.wellnessRole && d.wellnessRole !== 'doctor' ? ` (${d.wellnessRole})` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={labelStyle}>Visit notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical' }} />
      </div>
      <div style={{ marginBottom: '1rem', width: 200 }}>
        <label style={labelStyle}>Amount charged (₹)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
          style={inputStyle}
        />
      </div>
      <button
        type="submit"
        disabled={!valid || submitting}
        title={!valid ? 'Select Service and Doctor; amount must be 0 or more' : ''}
        style={{
          padding: '0.55rem 1.25rem',
          background: valid && !submitting ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
          color: '#fff', border: 'none', borderRadius: 8,
          cursor: valid && !submitting ? 'pointer' : 'not-allowed',
          opacity: valid && !submitting ? 1 : 0.6,
        }}
      >
        {submitting ? 'Saving…' : 'Save visit'}
      </button>
    </form>
  );
}

// ── Photos tab — before/after upload per visit ────────────────────

function PhotosTab({ patient, onSaved }) {
  const notify = useNotify();
  const [visitId, setVisitId] = useState(patient.visits[0]?.id || '');
  const [kind, setKind] = useState('before');
  const [uploading, setUploading] = useState(false);

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
      <h3 style={{ marginBottom: '1rem' }}>Visit photos</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '0.5rem', marginBottom: '1rem', alignItems: 'end' }}>
        <div>
          <label style={labelStyle}>Visit</label>
          <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle}>
            <option value="">— select visit —</option>
            {patient.visits.map((v) => (
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
          <PhotoColumn title="Before" urls={before} onRemove={(u) => remove(u, 'before')} />
          <PhotoColumn title="After"  urls={after}  onRemove={(u) => remove(u, 'after')} />
        </div>
      )}
    </div>
  );
}

// #750 — render a "failed to load" placeholder when the image source returns
// a non-image (the historic backend bug was Content-Type text/html via the
// SPA fallback — fixed in #743 — but a future regression, an expired signed
// URL, or a deleted blob would silently render a black tile that the clinician
// can't distinguish from a successful upload). We track per-URL error state
// + expose a Retry action that forces a re-fetch by appending a cache-busting
// query string. Counters above still claim BEFORE (n) / AFTER (n) but the
// failed-to-load tiles are unambiguous now.
function PhotoThumb({ url, onRemove }) {
  const [errored, setErrored] = useState(false);
  const [bust, setBust] = useState(0);
  const src = bust ? `${url}${url.includes('?') ? '&' : '?'}_r=${bust}` : url;
  const retry = () => {
    setErrored(false);
    setBust(Date.now());
  };
  return (
    <div style={{ position: 'relative' }}>
      {errored ? (
        <div
          data-testid="photo-failed-placeholder"
          style={{
            width: '100%', height: 100, borderRadius: 6,
            background: 'rgba(239,68,68,0.08)', border: '1px dashed rgba(239,68,68,0.4)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '0.25rem', padding: '0.25rem', color: 'var(--text-secondary)', fontSize: '0.7rem',
            textAlign: 'center',
          }}
        >
          <span style={{ color: '#ef4444', fontWeight: 600 }}>Failed to load</span>
          <button
            type="button"
            onClick={retry}
            style={{
              background: 'transparent', border: '1px solid rgba(239,68,68,0.5)',
              color: '#ef4444', borderRadius: 4, padding: '1px 6px', fontSize: '0.7rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <img
          src={src}
          alt=""
          onError={() => setErrored(true)}
          style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)' }}
        />
      )}
      <button onClick={() => onRemove(url)} style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.7)', border: 'none', color: '#fff', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}>
        <Trash2 size={10} />
      </button>
    </div>
  );
}

function PhotoColumn({ title, urls, onRemove }) {
  return (
    <div>
      <h4 style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title} ({urls.length})</h4>
      {urls.length === 0 && <div style={{ padding: '1rem', textAlign: 'center', background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No photos yet.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.5rem' }}>
        {urls.map((u) => (
          <PhotoThumb key={u} url={u} onRemove={onRemove} />
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
      <h3 style={{ marginBottom: '1rem' }}>Inventory used</h3>
      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Visit</label>
        <select value={visitId} onChange={(e) => setVisitId(e.target.value)} style={inputStyle}>
          <option value="">— select visit —</option>
          {patient.visits.map((v) => (
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

  const visits = (patient.visits || []).slice().sort(
    (a, b) => new Date(b.visitDate) - new Date(a.visitDate),
  );

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

  if (visits.length === 0) {
    return (
      <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        No visits yet — log a visit first to start a video consult.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="glass" style={{ padding: '1rem' }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
          Each visit can host one video room. Patients join the same link from the patient portal.
        </div>
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
