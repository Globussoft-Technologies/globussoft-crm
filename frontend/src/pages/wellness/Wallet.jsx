// Wave 11 Agent FF — admin-only wallet ledger viewer.
//
// Surface: search a patient -> see wallet balance + recent transactions
// (CREDIT_GIFTCARD / CREDIT_CASHBACK / CREDIT_REFUND / DEBIT_*). Admin
// can also fire a manual credit/debit row from this page; routes are
// gated to ADMIN role on the backend.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Wallet as WalletIcon, Search, Plus, Minus, Gift, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/date';

export default function WalletPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [walletState, setWalletState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [debitOpen, setDebitOpen] = useState(false);
  const notify = useNotify();
  const searchBoxRef = useRef(null);
  const debounceRef = useRef(null);

  const search = async (q = query) => {
    if (!q.trim()) return setResults([]);
    setLoading(true);
    try {
      const j = await fetchApi(`/api/wellness/patients?q=${encodeURIComponent(q)}&limit=20`);
      setResults(j.patients || []);
      setShowSuggestions(true);
    } catch (e) {
      notify.error(e.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  // Debounced autocomplete: fire ?q= 300ms after the user stops typing.
  // Skips queries under 2 chars to avoid hammering the server on single
  // letters. Mount has query='' so no fetch fires on initial render.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => { search(q); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Click outside the search box hides the dropdown without clearing the input.
  useEffect(() => {
    if (!showSuggestions) return;
    const onDocClick = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showSuggestions]);

  const loadWallet = async (patientId) => {
    setLoading(true);
    try {
      const j = await fetchApi(`/api/wellness/patients/${patientId}/wallet`);
      setWalletState(j);
      setSelected(j.patient);
    } catch (e) {
      notify.error(e.message || 'Failed to load wallet');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <WalletIcon size={24} /> Patient Wallets
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Composite ledger of gift-card credits, cashback earnings, refunds, and debits per patient.
        </p>
      </header>

      <div ref={searchBoxRef} style={{ position: 'relative', display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="text"
            placeholder="Search patient by name, phone, or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (results.length > 0) setShowSuggestions(true); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                search();
              } else if (e.key === 'Escape') {
                setShowSuggestions(false);
              }
            }}
            style={{ width: '100%', padding: '0.6rem 2rem 0.6rem 0.75rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-primary)', boxSizing: 'border-box' }}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setResults([]); setShowSuggestions(false); }}
              aria-label="Clear"
              style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, display: 'flex', alignItems: 'center' }}
            >
              <X size={14} />
            </button>
          )}
          {showSuggestions && !selected && (loading || query.trim().length >= 2) && (
            <div
              role="listbox"
              style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
                background: 'var(--surface-color)', border: '1px solid var(--border-color)',
                borderRadius: 8, maxHeight: 320, overflowY: 'auto',
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)', padding: '0.35rem',
              }}
            >
              {loading && (
                <div style={{ padding: '0.5rem 0.75rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Searching…</div>
              )}
              {!loading && results.length === 0 && (
                <div style={{ padding: '0.5rem 0.75rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No patients match “{query.trim()}”.</div>
              )}
              {!loading && results.map((p) => (
                <button
                  key={p.id}
                  role="option"
                  onClick={() => { loadWallet(p.id); setShowSuggestions(false); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '0.55rem 0.7rem', background: 'transparent',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                    color: 'var(--text-primary)', fontSize: '0.9rem',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--input-bg)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ fontWeight: 500 }}>{p.name}</div>
                  {(p.phone || p.email) && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                      {p.phone ? p.phone : ''}{p.phone && p.email ? ' · ' : ''}{p.email || ''}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => search()}
          disabled={loading}
          style={{ padding: '0.6rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          <Search size={14} /> Search
        </button>
      </div>

      {selected && walletState && (
        <WalletPanel
          state={walletState}
          onCredit={() => setCreditOpen(true)}
          onDebit={() => setDebitOpen(true)}
          onClose={() => { setSelected(null); setWalletState(null); }}
        />
      )}

      {creditOpen && walletState && (
        <ManualLedgerModal
          mode="credit"
          walletId={walletState.wallet.id}
          currency={walletState.wallet.currency}
          onDone={async () => { setCreditOpen(false); await loadWallet(selected.id); }}
          onCancel={() => setCreditOpen(false)}
        />
      )}
      {debitOpen && walletState && (
        <ManualLedgerModal
          mode="debit"
          walletId={walletState.wallet.id}
          currency={walletState.wallet.currency}
          onDone={async () => { setDebitOpen(false); await loadWallet(selected.id); }}
          onCancel={() => setDebitOpen(false)}
        />
      )}
    </div>
  );
}

function WalletPanel({ state, onCredit, onDebit, onClose }) {
  const { patient, wallet, transactions } = state;
  return (
    <div className="glass" style={{ padding: '1.5rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', margin: 0 }}>{patient.name}</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0' }}>Wallet #{wallet.id}</p>
        </div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <X size={20} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Balance</div>
          <div style={{ fontSize: '2rem', fontWeight: 600 }}>{formatMoney(wallet.balance, { currency: wallet.currency })}</div>
        </div>
        <button onClick={onCredit} style={btnPrimary}>
          <Plus size={14} /> Credit
        </button>
        <button onClick={onDebit} style={btnSecondary}>
          <Minus size={14} /> Debit
        </button>
      </div>

      <h3 style={{ marginTop: '1.5rem' }}>Recent transactions</h3>
      {transactions.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No transactions yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={th}>Date</th>
              <th style={th}>Type</th>
              <th style={th}>Amount</th>
              <th style={th}>Balance after</th>
              <th style={th}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={td}>{formatDate(tx.createdAt)}</td>
                <td style={td}>{tx.type.replace('_', ' ')}</td>
                <td style={{ ...td, color: tx.amount >= 0 ? 'var(--success-color, #10b981)' : 'var(--danger-color, #ef4444)' }}>
                  {tx.amount >= 0 ? '+' : ''}{formatMoney(tx.amount, { currency: wallet.currency })}
                </td>
                <td style={td}>{formatMoney(tx.balanceAfter, { currency: wallet.currency })}</td>
                <td style={td}>{tx.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ManualLedgerModal({ mode, walletId, currency, onDone, onCancel }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotify();
  const isCredit = mode === 'credit';

  const submit = async () => {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) {
      notify.error('Enter a positive amount.');
      return;
    }
    setSubmitting(true);
    try {
      await fetchApi(`/api/wellness/wallet/${walletId}/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ amount: a, reason }),
      });
      notify.success(`Wallet ${mode}ed ${formatMoney(a, { currency })}.`);
      onDone();
    } catch (e) {
      notify.error(e.message || `Failed to ${mode} wallet`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={modalOverlay}>
      <div style={modalCard}>
        <h3>{isCredit ? 'Credit wallet' : 'Debit wallet'}</h3>
        <label style={lbl}>Amount ({currency})
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={inp}
            min="0"
            step="0.01"
          />
        </label>
        <label style={lbl}>Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} style={inp} placeholder="Optional" />
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button onClick={onCancel} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={submit} style={btnPrimary} disabled={submitting}>
            {submitting ? 'Saving…' : isCredit ? 'Credit' : 'Debit'}
          </button>
        </div>
      </div>
    </div>
  );
}

const th = { textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' };
const td = { padding: '0.5rem', fontSize: '0.9rem' };
const btnPrimary = { padding: '0.6rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' };
const btnSecondary = { padding: '0.6rem 1rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' };
const modalOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalCard = { background: 'var(--bg-color, #fff)', padding: '1.5rem', borderRadius: 12, minWidth: 360, maxWidth: 500 };
const lbl = { display: 'block', marginBottom: '0.75rem', fontSize: '0.9rem' };
const inp = { width: '100%', padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', marginTop: '0.25rem', boxSizing: 'border-box' };
