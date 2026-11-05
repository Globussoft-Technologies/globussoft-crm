import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { fetchApi } from '../utils/api';

function formatPaise(value) {
  return `₹${(Number(value || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PayoutConfirmation() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [details, setDetails] = useState(null);
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(Boolean(token));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    fetchApi(`/api/pickup-plot-payouts/public/details?token=${encodeURIComponent(token)}`, { silent: true })
      .then((response) => { setDetails(response.payout); setConfirmed(response.payout?.confirmationStatus === 'VERIFIED'); })
      .catch((requestError) => setError(requestError.message || 'This payout link is invalid or expired.'))
      .finally(() => setLoading(false));
  }, [token]);

  const confirm = async (event) => {
    event.preventDefault();
    try {
      await fetchApi('/api/pickup-plot-payouts/public/confirm', { method: 'POST', body: JSON.stringify({ token, otp }), silent: true });
      setConfirmed(true);
      setError('');
    } catch (requestError) { setError(requestError.message || 'The OTP could not be verified.'); }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, background: 'var(--page-background, #f4f6fa)' }}>
      <section className="card" style={{ width: 'min(100%, 520px)', display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><ShieldCheck size={26} color="var(--primary-color, var(--accent-color))" /><div><h1 style={{ margin: 0, fontSize: '1.35rem' }}>Confirm payout receipt</h1><p style={{ margin: '5px 0 0', color: 'var(--text-secondary)' }}>Verify that you received the company payout.</p></div></div>
        {loading && <p>Loading payout details…</p>}
        {!loading && details && <div style={{ display: 'grid', gap: 8, padding: 14, borderRadius: 10, background: 'var(--surface-muted, #f5f6fa)' }}><strong>{details.partnerName}</strong><span>Amount paid: {formatPaise(details.totalNetPaise)}</span><span>UTR: {details.utr}</span><span>Mobile: {details.mobile}</span><a href={`/api/pickup-plot-payouts/public/advice.pdf?token=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer">Download payout advice PDF</a></div>}
        {confirmed ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--success-color, #15803d)', fontWeight: 700 }}><CheckCircle2 size={20} /> Receipt confirmed successfully.</div> : !loading && details && <form onSubmit={confirm} style={{ display: 'grid', gap: 10 }}><label>OTP sent by the company<input className="input-field" required inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={otp} onChange={(event) => setOtp(event.target.value)} placeholder="6-digit OTP" /></label><button type="submit" className="btn-primary">Confirm receipt</button></form>}
        {error && <p style={{ margin: 0, color: 'var(--danger-color, #b91c1c)' }}>{error}</p>}
        {!token && <p style={{ margin: 0, color: 'var(--danger-color, #b91c1c)' }}>A payout confirmation token is required.</p>}
      </section>
    </main>
  );
}
