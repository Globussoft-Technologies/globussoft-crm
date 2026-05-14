// Wave 11 Agent FF — admin issuance + list view for gift cards.
//
// Issuing a gift card auto-generates a 16-char Crockford-base32 code and
// returns it to the issuer (one-time view — display the code prominently
// so the operator can copy + send to the recipient channel of their choice).
import { useEffect, useRef, useState } from 'react';
import { Gift, Copy, Plus, UserPlus, Search } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/date';

export default function GiftCardsPage() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [issueOpen, setIssueOpen] = useState(false);
  const [applyTarget, setApplyTarget] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [latestCode, setLatestCode] = useState(null);
  const notify = useNotify();

  const load = async () => {
    setLoading(true);
    try {
      const url = statusFilter
        ? `/api/wellness/giftcards?status=${statusFilter}`
        : '/api/wellness/giftcards';
      const j = await fetchApi(url);
      setList(j.giftCards || []);
    } catch (e) {
      notify.error(e.message || 'Failed to load gift cards');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Gift size={24} /> Gift Cards
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Issue, track, and audit gift-card codes. Redemption credits the recipient's wallet.
          </p>
        </div>
        <button onClick={() => setIssueOpen(true)} style={btnPrimary}>
          <Plus size={14} /> Issue gift card
        </button>
      </header>

      {latestCode && (
        <div className="glass" style={{ padding: '1rem', marginBottom: '1rem', background: 'var(--success-bg, #ecfdf5)' }}>
          <strong>New gift card issued:</strong>{' '}
          <code style={{ fontSize: '1.2rem' }}>{latestCode.code}</code> ·{' '}
          {formatMoney(latestCode.amount, { currency: latestCode.currency })}{' '}
          <button onClick={() => { navigator.clipboard.writeText(latestCode.code); notify.success('Code copied'); }} style={{ marginLeft: '0.5rem', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 4, padding: '0.25rem 0.5rem', cursor: 'pointer' }}>
            <Copy size={12} /> Copy
          </button>
        </div>
      )}

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ marginRight: '0.5rem' }}>Filter:</label>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '0.4rem 0.6rem', borderRadius: 6 }}>
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="redeemed">Redeemed</option>
          <option value="expired">Expired</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {loading ? (
        <div>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No gift cards yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={th}>Code</th>
              <th style={th}>Amount</th>
              <th style={th}>Status</th>
              <th style={th}>Created</th>
              <th style={th}>Expires</th>
              <th style={th}>Redeemed</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={td}><code>{g.code}</code></td>
                <td style={td}>{formatMoney(g.amount, { currency: g.currency })}</td>
                <td style={td}><span style={statusPill(g.status)}>{g.status}</span></td>
                <td style={td}>{formatDate(g.createdAt)}</td>
                <td style={td}>{g.expiresAt ? formatDate(g.expiresAt) : '—'}</td>
                <td style={td}>{g.redeemedAt ? formatDate(g.redeemedAt) : '—'}</td>
                <td style={td}>
                  {g.status === 'active' ? (
                    <button
                      onClick={() => setApplyTarget(g)}
                      style={btnRowAction}
                      title="Apply this gift card to a patient's wallet"
                    >
                      <UserPlus size={12} /> Apply to patient
                    </button>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {issueOpen && (
        <IssueModal
          onDone={(row) => { setLatestCode(row); setIssueOpen(false); load(); }}
          onCancel={() => setIssueOpen(false)}
        />
      )}

      {applyTarget && (
        <ApplyModal
          giftCard={applyTarget}
          onDone={() => { setApplyTarget(null); load(); }}
          onCancel={() => setApplyTarget(null)}
        />
      )}
    </div>
  );
}

function IssueModal({ onDone, onCancel }) {
  const [amount, setAmount] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [issuedTo, setIssuedTo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotify();

  const submit = async () => {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return notify.error('Enter a positive amount.');
    setSubmitting(true);
    try {
      const body = { amount: a };
      if (expiresAt) body.expiresAt = expiresAt;
      if (issuedTo) body.issuedTo = parseInt(issuedTo, 10);
      const row = await fetchApi('/api/wellness/giftcards', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify.success('Gift card issued');
      onDone(row);
    } catch (e) {
      notify.error(e.message || 'Failed to issue gift card');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={modalOverlay}>
      <div style={modalCard}>
        <h3>Issue gift card</h3>
        <label style={lbl}>Amount
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} style={inp} min="0" step="0.01" />
        </label>
        <label style={lbl}>Expires (optional)
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inp} />
        </label>
        <label style={lbl}>Recipient patient id (optional, "to:" line)
          <input type="number" value={issuedTo} onChange={(e) => setIssuedTo(e.target.value)} style={inp} />
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button onClick={onCancel} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={submit} style={btnPrimary} disabled={submitting}>{submitting ? 'Issuing…' : 'Issue'}</button>
        </div>
      </div>
    </div>
  );
}

// Admin / manager apply-direct flow — bypasses the plaintext-code requirement
// of the recipient redeem path. Uses the by-id `POST /giftcards/:id/apply`
// endpoint, which trusts the authenticated session instead of a code.
function ApplyModal({ giftCard, onDone, onCancel }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotify();
  const debounceRef = useRef(null);

  // Debounced patient search. Mirrors the /api/wellness/patients?q= contract;
  // empty query renders an empty result list (no autoload — avoids surprising
  // the operator with a huge default list on big tenants).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setResults([]); setSearching(false); return; }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const j = await fetchApi(`/api/wellness/patients?q=${encodeURIComponent(q)}&limit=10`);
        setResults(j.patients || []);
      } catch (e) {
        notify.error(e.message || 'Patient search failed');
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const submit = async () => {
    if (!selected) return notify.error('Pick a patient first.');
    setSubmitting(true);
    try {
      await fetchApi(`/api/wellness/giftcards/${giftCard.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ patientId: selected.id }),
      });
      notify.success(`Applied ${formatMoney(giftCard.amount, { currency: giftCard.currency })} to ${selected.name}'s wallet`);
      onDone();
    } catch (e) {
      notify.error(e.message || 'Failed to apply gift card');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={modalOverlay} onClick={onCancel}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Apply gift card to patient</h3>
        <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Crediting <strong>{formatMoney(giftCard.amount, { currency: giftCard.currency })}</strong>{' '}
          from card <code>{giftCard.code}</code> to the patient's wallet. This marks the card as redeemed.
        </div>

        <label style={lbl}>Patient
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
              placeholder="Search by name, phone, or email"
              autoFocus
              style={{ ...inp, paddingLeft: '2rem' }}
            />
          </div>
        </label>

        {!selected && query.trim() && (
          <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: '0.75rem' }}>
            {searching ? (
              <div style={{ padding: '0.6rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Searching…</div>
            ) : results.length === 0 ? (
              <div style={{ padding: '0.6rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No matches.</div>
            ) : (
              results.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setSelected(p); setQuery(''); setResults([]); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.5rem 0.75rem', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-color)', cursor: 'pointer', fontSize: '0.9rem' }}
                >
                  <div style={{ fontWeight: 500 }}>{p.name || `Patient #${p.id}`}</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    {[p.phone, p.email].filter(Boolean).join(' · ') || `id ${p.id}`}
                  </div>
                </button>
              ))
            )}
          </div>
        )}

        {selected && (
          <div style={{ padding: '0.6rem 0.75rem', background: 'var(--success-bg, #ecfdf5)', borderRadius: 6, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{selected.name || `Patient #${selected.id}`}</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                {[selected.phone, selected.email].filter(Boolean).join(' · ') || `id ${selected.id}`}
              </div>
            </div>
            <button type="button" onClick={() => setSelected(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}>Change</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button onClick={onCancel} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={submit} style={btnPrimary} disabled={submitting || !selected}>
            {submitting ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

const th = { textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' };
const td = { padding: '0.5rem', fontSize: '0.9rem' };
const btnPrimary = { padding: '0.6rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' };
const btnSecondary = { padding: '0.6rem 1rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer' };
const btnRowAction = { padding: '0.35rem 0.65rem', background: 'transparent', color: 'var(--primary-color, var(--accent-color))', border: '1px solid var(--primary-color, var(--accent-color))', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' };
const modalOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalCard = { background: 'var(--bg-color, #fff)', padding: '1.5rem', borderRadius: 12, minWidth: 360, maxWidth: 500 };
const lbl = { display: 'block', marginBottom: '0.75rem', fontSize: '0.9rem' };
const inp = { width: '100%', padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', marginTop: '0.25rem', boxSizing: 'border-box' };

function statusPill(status) {
  const map = {
    active: { background: '#dcfce7', color: '#166534' },
    redeemed: { background: '#dbeafe', color: '#1e40af' },
    expired: { background: '#fee2e2', color: '#991b1b' },
    cancelled: { background: '#f3f4f6', color: '#374151' },
  };
  const palette = map[status] || map.cancelled;
  return { ...palette, padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.75rem' };
}
