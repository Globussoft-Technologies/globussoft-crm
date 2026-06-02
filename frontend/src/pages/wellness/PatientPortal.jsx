import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  HeartPulse,
  Phone,
  LogOut,
  FileText,
  Pill,
  ClipboardList,
  ShieldCheck,
  Download,
  Calendar as CalendarIcon,
} from 'lucide-react';
import { useNotify } from '../../utils/notify';
import { formatDate } from '../../utils/date';

const PORTAL_TOKEN_KEY = 'patientPortalToken';
const PORTAL_NAME_KEY = 'patientPortalName';

// Standalone portal fetch — uses its own Bearer token, not the staff CRM token.
const portalFetch = async (url, token, options = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(url, { ...options, headers });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || data.message || 'Request failed');
  }
  if (r.status === 204) return true;
  // For binary responses (PDFs) caller handles separately.
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return r.json();
  return r;
};

function Login({ onSuccess }) {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState('phone'); // phone, otp
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Agent B: real SMS-based OTP — resend cooldown (seconds remaining).
  const [resendIn, setResendIn] = useState(0);

  // T1.2: probe whether the SMS provider is configured before showing the
  // OTP form. If not, the request-otp endpoint silently queues a message
  // that's never delivered; better to render a graceful-degrade notice
  // that points patients at their clinic. null = still loading.
  const [smsConfigured, setSmsConfigured] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/wellness/portal/health')
      .then((r) => (r.ok ? r.json() : { smsConfigured: false }))
      .then((d) => { if (!cancelled) setSmsConfigured(!!d?.smsConfigured); })
      .catch(() => { if (!cancelled) setSmsConfigured(false); });
    return () => { cancelled = true; };
  }, []);

  // Tick the resend cooldown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const requestOtp = async () => {
    setErr('');
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      setErr('Enter a valid 10-digit phone number');
      return false;
    }
    setBusy(true);
    try {
      await portalFetch('/api/wellness/portal/login/request-otp', null, {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
      setResendIn(30);
      return true;
    } catch (ex) {
      setErr(ex.message || 'Failed to send code');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendOtp = async (e) => {
    e.preventDefault();
    const ok = await requestOtp();
    if (ok) setStage('otp');
  };

  const resend = async () => {
    if (resendIn > 0 || busy) return;
    setOtp('');
    await requestOtp();
  };

  const verify = async (e) => {
    e.preventDefault();
    if (!/^\d{4}$/.test(otp)) {
      setErr('Enter the 4-digit code');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const d = await portalFetch('/api/wellness/portal/login/verify-otp', null, {
        method: 'POST',
        body: JSON.stringify({ phone, otp }),
      });
      localStorage.setItem(PORTAL_TOKEN_KEY, d.token);
      localStorage.setItem(PORTAL_NAME_KEY, d.patient?.name || '');
      onSuccess(d.token, d.patient);
    } catch (ex) {
      // Friendly message for the most common failure modes.
      const msg = ex.message || '';
      if (/expired|invalid/i.test(msg)) {
        setErr('Invalid or expired code. Try resending.');
      } else {
        setErr(msg || 'Login failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: 'var(--bg-color, #0b1220)',
      }}
    >
      <div
        className="glass"
        style={{ padding: '2rem', width: '100%', maxWidth: 420, borderRadius: 16 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <HeartPulse size={24} color="#ef4444" />
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Patient Portal</h1>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
          Access your visits, prescriptions, and treatment plans securely.
        </p>

        {smsConfigured === false && (
          <div
            role="alert"
            data-testid="portal-sms-unavailable"
            style={{
              background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              color: 'var(--text-primary, #1f2937)',
              padding: '1rem',
              borderRadius: 10,
              fontSize: '0.85rem',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ display: 'block', marginBottom: '0.35rem' }}>
              Phone-OTP login is temporarily unavailable.
            </strong>
            Please contact your clinic for help accessing your records.
          </div>
        )}

        {smsConfigured !== false && stage === 'phone' && (
          <form onSubmit={sendOtp}>
            <label
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
                display: 'block',
                marginBottom: '0.35rem',
              }}
            >
              Phone number
            </label>
            <input
              autoFocus
              placeholder="10-digit mobile number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={inputStyle}
            />
            {err && <div style={errStyle}>{err}</div>}
            <button type="submit" disabled={busy} style={btnStyle}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        )}

        {stage === 'otp' && (
          <form onSubmit={verify}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Enter the 4-digit code we sent to <strong>{phone}</strong>.
            </div>
            <label
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
                display: 'block',
                marginBottom: '0.35rem',
              }}
            >
              Verification code
            </label>
            <input
              autoFocus
              maxLength={4}
              placeholder="4-digit code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              style={{ ...inputStyle, letterSpacing: '0.5em', textAlign: 'center', fontSize: '1.2rem' }}
            />
            {err && <div style={errStyle}>{err}</div>}
            <button type="submit" disabled={busy} style={btnStyle}>
              {busy ? 'Verifying…' : 'Verify & enter'}
            </button>
            {/* Agent B: Resend OTP with 30s cooldown */}
            <button
              type="button"
              onClick={resend}
              disabled={resendIn > 0 || busy}
              style={{
                marginTop: '0.5rem',
                width: '100%',
                padding: '0.5rem',
                background: 'transparent',
                border: 'none',
                color: resendIn > 0 ? 'var(--text-secondary)' : 'var(--accent-color)',
                fontSize: '0.85rem',
                cursor: resendIn > 0 || busy ? 'not-allowed' : 'pointer',
              }}
            >
              {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend OTP'}
            </button>
            <button
              type="button"
              onClick={() => {
                setStage('phone');
                setOtp('');
                setErr('');
              }}
              style={{
                marginTop: '0.25rem',
                width: '100%',
                padding: '0.5rem',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Change phone number
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Dashboard({ token, onLogout }) {
  const notify = useNotify();
  const [tab, setTab] = useState('visits');
  const [me, setMe] = useState(null);
  const [visits, setVisits] = useState([]);
  const [prescriptions, setPrescriptions] = useState([]);
  // Patient permission set resolved from /portal/me/permissions. Driven by
  // the tenant's CUSTOMER role permissions (see backend/lib/portalPermissions.js).
  // Tabs that require a permission render only when that permission is in
  // this set — the backend still enforces the same gate, this is just
  // sidebar/tab visibility.
  const [permissions, setPermissions] = useState(null);
  const [loading, setLoading] = useState(true);

  const hasPerm = useCallback(
    (key) => Array.isArray(permissions) && permissions.includes(key),
    [permissions],
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      // Always-permitted fetches first (profile + permissions). Without
      // permissions resolved we can't decide whether to attempt the Rx
      // fetch, so this MUST resolve before the gated calls below.
      const [m, perms] = await Promise.all([
        portalFetch('/api/wellness/portal/me', token),
        portalFetch('/api/wellness/portal/me/permissions', token),
      ]);
      const permList = Array.isArray(perms?.permissions) ? perms.permissions : [];
      setMe(m);
      setPermissions(permList);

      // Visits is always shown for now (no per-tab gate yet); Rx is
      // gated on `my_prescriptions.read`. Skip the gated fetches when
      // the permission is missing so we don't surface a 403 toast.
      const v = await portalFetch('/api/wellness/portal/visits', token);
      setVisits(v || []);

      if (permList.includes('my_prescriptions.read')) {
        try {
          const p = await portalFetch('/api/wellness/portal/prescriptions', token);
          setPrescriptions(p || []);
        } catch (rxEx) {
          // 403 here means the permission was revoked between the perms
          // fetch and the Rx fetch (rare race). Treat as "no access" and
          // leave the list empty; the tab is already hidden by hasPerm.
          if (!/forbidden|denied/i.test(rxEx.message || '')) throw rxEx;
        }
      } else {
        setPrescriptions([]);
      }
    } catch (ex) {
      if (/token/i.test(ex.message)) onLogout();
    } finally {
      setLoading(false);
    }
  }, [token, onLogout]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const downloadRx = async (rxId) => {
    try {
      // Patient-portal tokens carry { patientId } not { userId }, so the
      // staff endpoint /api/wellness/prescriptions/:id/pdf rejects them.
      // The portal-specific endpoint at /api/wellness/portal/prescriptions/
      // :id/pdf uses verifyPatientToken and scopes to req.patient.id (so
      // patients can only fetch THEIR OWN prescriptions).
      const r = await fetch(`/api/wellness/portal/prescriptions/${rxId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error('PDF download failed');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prescription-${rxId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (ex) {
      notify.error(`Could not download: ${ex.message}`);
    }
  };

  // Tab list — each entry can declare a `permission` it depends on.
  // Filter out tabs the patient lacks permission for so the nav doesn't
  // show a link the backend will 403 on. `permissions === null` (still
  // loading) hides gated tabs to avoid a flash of unavailable UI.
  // useMemo'd so the array reference stays stable across renders — the
  // useEffect below depends on `tabs` and would re-run every render
  // otherwise.
  const tabs = useMemo(() => {
    const allTabs = [
      { key: 'visits', label: 'My Visits', icon: CalendarIcon },
      {
        key: 'prescriptions',
        label: 'Prescriptions',
        icon: Pill,
        permission: 'my_prescriptions.read',
      },
      { key: 'plan', label: 'Treatment Plan', icon: ClipboardList },
      { key: 'consent', label: 'Consent Forms', icon: ShieldCheck },
    ];
    return allTabs.filter((t) => !t.permission || hasPerm(t.permission));
  }, [hasPerm]);

  // If the currently-selected tab got filtered out (permission revoked
  // mid-session, or initial load resolved without the grant), fall back
  // to the first visible tab so the main panel never tries to render a
  // hidden tab's content.
  useEffect(() => {
    if (permissions === null) return;
    if (!tabs.find((t) => t.key === tab)) {
      setTab(tabs[0]?.key || 'visits');
    }
  }, [permissions, tab, tabs]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-color, #0b1220)' }}>
      <header
        style={{
          padding: '1rem 2rem',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <HeartPulse size={22} color="#ef4444" />
          <div>
            <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>Patient Portal</div>
            {me && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Welcome, {me.name}
                {me.phone && (
                  <>
                    {' '}
                    · <Phone size={10} style={{ verticalAlign: 'middle' }} /> {me.phone}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.3rem',
            padding: '0.5rem 1rem',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            color: 'var(--text-primary)',
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}
        >
          <LogOut size={14} /> Log out
        </button>
      </header>

      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          padding: '1rem 2rem 0 2rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          overflowX: 'auto',
        }}
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.6rem 1rem',
                background: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                border: 'none',
                borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      <main style={{ padding: '1.5rem 2rem' }}>
        {loading && <div>Loading…</div>}

        {!loading && tab === 'visits' && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {visits.length === 0 && (
              <div
                className="glass"
                style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}
              >
                No visits on record yet.
              </div>
            )}
            {visits.map((v) => (
              <div key={v.id} className="glass" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{v.service?.name || 'Consultation'}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                      {new Date(v.visitDate).toLocaleString('en-IN')}
                      {v.doctor?.name && ` · Dr ${v.doctor.name}`}
                    </div>
                  </div>
                  <span
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      padding: '0.2rem 0.6rem',
                      borderRadius: 999,
                      fontSize: '0.7rem',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {v.status}
                  </span>
                </div>
                {v.notes && (
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.6rem', lineHeight: 1.5 }}>
                    {v.notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {!loading && tab === 'prescriptions' && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {prescriptions.length === 0 && (
              <div
                className="glass"
                style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}
              >
                No prescriptions yet.
              </div>
            )}
            {prescriptions.map((rx) => {
              let drugs = [];
              try {
                drugs = JSON.parse(rx.drugs || '[]');
              } catch {
                drugs = [];
              }
              return (
                <div key={rx.id} className="glass" style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <Pill size={15} /> Prescription #{rx.id}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        {formatDate(rx.createdAt)}
                        {rx.doctor?.name && ` · Dr ${rx.doctor.name}`}
                        {rx.visit?.service?.name && ` · ${rx.visit.service.name}`}
                      </div>
                    </div>
                    <button
                      onClick={() => downloadRx(rx.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.4rem 0.8rem',
                        background: 'var(--accent-color)',
                        border: 'none',
                        borderRadius: 6,
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                      }}
                    >
                      <Download size={13} /> PDF
                    </button>
                  </div>
                  {drugs.length > 0 && (
                    <ul
                      style={{
                        listStyle: 'none',
                        padding: 0,
                        marginTop: '0.75rem',
                        display: 'grid',
                        gap: '0.35rem',
                      }}
                    >
                      {drugs.map((d, i) => (
                        <li
                          key={i}
                          style={{
                            fontSize: '0.85rem',
                            padding: '0.4rem 0.6rem',
                            background: 'rgba(255,255,255,0.04)',
                            borderRadius: 6,
                          }}
                        >
                          <strong>{d.name}</strong>
                          {d.dosage && ` — ${d.dosage}`}
                          {d.frequency && `, ${d.frequency}`}
                          {d.duration && ` for ${d.duration}`}
                        </li>
                      ))}
                    </ul>
                  )}
                  {rx.instructions && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.6rem', lineHeight: 1.5 }}>
                      {rx.instructions}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!loading && tab === 'plan' && (
          <div
            className="glass"
            style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}
          >
            <ClipboardList size={28} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
            <div>Your treatment plan will appear here once your doctor shares one.</div>
          </div>
        )}

        {!loading && tab === 'consent' && (
          <div
            className="glass"
            style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}
          >
            <FileText size={28} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
            <div>Consent forms you’ve signed at the clinic will appear here.</div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function PatientPortal() {
  const [token, setToken] = useState(() => localStorage.getItem(PORTAL_TOKEN_KEY));

  const handleSuccess = (t) => setToken(t);
  const handleLogout = () => {
    localStorage.removeItem(PORTAL_TOKEN_KEY);
    localStorage.removeItem(PORTAL_NAME_KEY);
    setToken(null);
  };

  if (!token) return <Login onSuccess={handleSuccess} />;
  return <Dashboard token={token} onLogout={handleLogout} />;
}

const inputStyle = {
  width: '100%',
  padding: '0.65rem 0.85rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.95rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const btnStyle = {
  marginTop: '1rem',
  width: '100%',
  padding: '0.7rem',
  background: 'var(--accent-color)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: '0.95rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const errStyle = {
  marginTop: '0.6rem',
  fontSize: '0.8rem',
  color: '#ef4444',
};
