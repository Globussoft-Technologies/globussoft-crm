import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Calendar, FileText, FileSignature, ClipboardList, Plus, Camera, Package,
  Video, Wallet as WalletIcon, Crown, Download, Award, X, Minus,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatDate } from '../../utils/date';
import { currencySymbol } from '../../utils/money';
import { labelStyle, inputStyle } from './patientDetail/shared/helpers';
import WalletTab from './patientDetail/tabs/WalletTab';
import CaseHistoryTab from './patientDetail/tabs/CaseHistoryTab';
import PrescribeTab from './patientDetail/tabs/PrescribeTab';
import ConsentTab from './patientDetail/tabs/ConsentTab';
import PlansTab from './patientDetail/tabs/PlansTab';
import LogVisitTab from './patientDetail/tabs/LogVisitTab';
import PhotosTab from './patientDetail/tabs/PhotosTab';
import InventoryTab from './patientDetail/tabs/InventoryTab';
import TelehealthTab from './patientDetail/tabs/TelehealthTab';
import MembershipsTab from './patientDetail/tabs/MembershipsTab';

const tabStyle = (active) => ({
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

function isZyluSource(v) {
  return typeof v === 'string' && /^zylu/i.test(v.trim());
}
function displaySource(v) {
  if (!v || isZyluSource(v)) return '—';
  return v;
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
          <span>Source: <strong style={{ color: 'var(--text-primary)' }}>{displaySource(patient.source)}</strong></span>
          <span>{patient.visits.length} visits • {patient.prescriptions.length} Rx • {patient.treatmentPlans.length} treatment plans</span>
        </div>
      </div>

      <LoyaltyCard patientId={patient.id} />

      <div className="wellness-tab-strip" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button style={tabStyle(tab === 'history')} onClick={() => setTab('history')}><Calendar size={14} /> Case history</button>
        <button style={tabStyle(tab === 'prescribe')} onClick={() => setTab('prescribe')}><FileText size={14} /> New prescription</button>
        <button style={tabStyle(tab === 'consent')} onClick={() => setTab('consent')}><FileSignature size={14} /> Consent form</button>
        <button style={tabStyle(tab === 'plans')} onClick={() => setTab('plans')}><ClipboardList size={14} /> Treatment plans</button>
        <button style={tabStyle(tab === 'visit')} onClick={() => setTab('visit')}><Plus size={14} /> Log visit</button>
        <button style={tabStyle(tab === 'photos')} onClick={() => setTab('photos')}><Camera size={14} /> Photos</button>
        <button style={tabStyle(tab === 'inventory')} onClick={() => setTab('inventory')}><Package size={14} /> Inventory used</button>
        <button style={tabStyle(tab === 'telehealth')} onClick={() => setTab('telehealth')}><Video size={14} /> Telehealth</button>
        <button style={tabStyle(tab === 'wallet')} onClick={() => setTab('wallet')}><WalletIcon size={14} /> Wallet</button>
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
