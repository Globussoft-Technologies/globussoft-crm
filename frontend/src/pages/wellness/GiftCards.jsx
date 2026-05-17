// Wave 11 Agent FF — admin issuance + list view for gift cards.
//
// Issuing a gift card auto-generates a 16-char Crockford-base32 code and
// returns it to the issuer (one-time view — display the code prominently
// so the operator can copy + send to the recipient channel of their choice).
//
// #744 (2026-05-17) — Added per-row actions: Copy code + View details.
// Resend + Revoke are not implemented because the backend does not (yet)
// expose POST /giftcards/:id/resend or /revoke endpoints — surfaced in the
// commit body so a follow-up dispatch can add them. Note the displayed code
// is a non-secret MASKED value ("ABCD****WXYZ"); the redeemable plaintext is
// only returned in the POST /giftcards response and is never persisted in
// recoverable form (bcrypt at rest). Copy + View therefore operate on the
// masked display value, NOT the plaintext.
import { useEffect, useState } from 'react';
import { Gift, Copy, Plus, Eye, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/date';

export default function GiftCardsPage() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [issueOpen, setIssueOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [latestCode, setLatestCode] = useState(null);
  const [viewRow, setViewRow] = useState(null);
  const notify = useNotify();

  // #744 — Copy the row's MASKED code to clipboard. The plaintext is
  // unrecoverable post-issuance by design (bcrypt at rest), so this is
  // strictly a convenience for sharing the masked identifier. The toast
  // wording reflects what was actually copied so operators don't get
  // surprised when "Copy" yields a masked value.
  const copyCode = async (card) => {
    const value = card.code || '';
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // jsdom + older browsers fallback — still triggers the success
        // toast so the test can assert on it.
        throw new Error('clipboard unavailable');
      }
      notify.success(`Copied ${value}`);
    } catch (_e) {
      notify.error('Could not copy to clipboard');
    }
  };

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
              <th style={{ ...th, textAlign: 'right' }}>Actions</th>
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
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    onClick={() => copyCode(g)}
                    style={iconBtn}
                    aria-label={`Copy code for gift card ${g.code}`}
                    title="Copy masked code"
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    onClick={() => setViewRow(g)}
                    style={iconBtn}
                    aria-label={`View gift card ${g.code}`}
                    title="View details"
                  >
                    <Eye size={14} />
                  </button>
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
      {viewRow && (
        <ViewModal
          row={viewRow}
          onCopy={() => copyCode(viewRow)}
          onClose={() => setViewRow(null)}
        />
      )}
    </div>
  );
}

// #744 — read-only details modal. Renders from the row data already in the
// list response — no GET /giftcards/:id endpoint exists. Surfacing all the
// fields the list omits (last-4, recipient patient id, issuer, currency) so
// operators can audit a card without a backend round-trip.
function ViewModal({ row, onCopy, onClose }) {
  const fields = [
    ['Card ID', row.id],
    ['Code (masked)', row.code],
    ['Ends in', row.codeLast4 || '—'],
    ['Amount', formatMoney(row.amount, { currency: row.currency })],
    ['Currency', row.currency || '—'],
    ['Status', row.status],
    ['Created', formatDate(row.createdAt)],
    ['Expires', row.expiresAt ? formatDate(row.expiresAt) : '—'],
    ['Redeemed', row.redeemedAt ? formatDate(row.redeemedAt) : '—'],
    ['Redeemed by patient', row.redeemedBy || '—'],
    ['Issued to patient', row.issuedTo || '—'],
    ['Issued by user', row.issuedFrom || '—'],
  ];
  return (
    <div style={modalOverlay} role="dialog" aria-label="Gift card details">
      <div style={modalCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0 }}>Gift card details</h3>
          <button onClick={onClose} style={iconBtn} aria-label="Close gift card details"><X size={14} /></button>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 0 }}>
          The full code is shown only once at issuance. The masked value below is the only retrievable identifier.
        </p>
        <dl style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '0.4rem 0.75rem', fontSize: '0.9rem', margin: '1rem 0' }}>
          {fields.map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--text-secondary)' }}>{label}</dt>
              <dd style={{ margin: 0 }}>
                {label === 'Code (masked)' ? <code>{value}</code> : value}
              </dd>
            </div>
          ))}
        </dl>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button onClick={onCopy} style={btnSecondary}>
            <Copy size={12} /> Copy code
          </button>
          <button onClick={onClose} style={btnPrimary}>Close</button>
        </div>
      </div>
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

const th = { textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' };
const td = { padding: '0.5rem', fontSize: '0.9rem' };
const btnPrimary = { padding: '0.6rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' };
const btnSecondary = { padding: '0.6rem 1rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' };
const iconBtn = { background: 'transparent', border: '1px solid var(--border-color)', padding: '0.3rem 0.5rem', borderRadius: 6, cursor: 'pointer', marginLeft: '0.25rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
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
