import { useEffect, useState } from 'react';
import { fetchApi } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { formatDate } from '../../../../utils/date';
import { formatMoney } from '../../../../utils/money';
import TopScrollSync from '../../../../components/TopScrollSync';

// ── Wallet tab — balance + recent transactions + redeem-giftcard ──
// Wave 11 Agent FF. Read-only history; redeem flow lets staff paste a gift
// code that the patient handed in (the credit lands in this patient's
// wallet). For larger flows (admin manual credit/debit, full ledger view)
// see /wellness/wallet at the admin sidebar entry.
export default function WalletTab({ patient }) {
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
  const wallet = data?.wallet ?? {};
  const transactions = data?.transactions || [];

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
        <TopScrollSync>
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
        </TopScrollSync>
      )}
    </div>
  );
}
