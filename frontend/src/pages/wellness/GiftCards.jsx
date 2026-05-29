// Wave 11 Agent FF — admin issuance + list view for gift cards.
//
// Issuing a gift card auto-generates a 16-char Crockford-base32 code and
// returns it to the issuer (one-time view — display the code prominently
// so the operator can copy + send to the recipient channel of their choice).
import { useEffect, useRef, useState } from 'react';
import { Gift, Copy, Plus, Search, Ban, RefreshCw } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/date';

export default function GiftCardsPage() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [issueOpen, setIssueOpen] = useState(false);
  // v3.7.17 — `Apply to patient` row action retired. It mapped to the
  // POS-style "credit this card into a specific wallet right now" flow,
  // which doesn't match the user-facing "customer buys, then redeems"
  // lifecycle. Row actions now only flip status (cancel / reactivate)
  // and copy the masked code; the underlying /apply endpoint stays on
  // the backend for downstream POS use but is no longer surfaced here.
  const [statusFilter, setStatusFilter] = useState('');
  const [latestCode, setLatestCode] = useState(null);
  // Tracks per-row "in flight" state so the Cancel/Reactivate button
  // disables itself + shows a spinner while the PATCH is round-tripping.
  const [pendingStatusId, setPendingStatusId] = useState(null);
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

  // Copy the masked code to the clipboard. Note: this is the MASKED
  // display value (e.g. "B9XT****FYQZ") that the list returns — the
  // redeemable plaintext is only ever shown once at issue time in the
  // `latestCode` toast above.
  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      notify.success('Code copied');
    } catch {
      notify.error('Could not copy to clipboard');
    }
  };

  // Flip a row between active ↔ cancelled. Redeemed is terminal — the
  // backend returns 409 STATUS_TERMINAL for any change on a redeemed
  // row, so the UI hides the button for that state.
  const toggleStatus = async (gift) => {
    const nextStatus = gift.status === 'active' ? 'cancelled' : 'active';
    const verb = nextStatus === 'cancelled' ? 'cancel' : 'reactivate';
    const ok = await notify.confirm(
      `${verb === 'cancel' ? 'Cancel' : 'Reactivate'} gift card ${gift.code}?`
    );
    if (!ok) return;
    setPendingStatusId(gift.id);
    try {
      await fetchApi(`/api/wellness/giftcards/${gift.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      notify.success(`Gift card ${verb}ed`);
      await load();
    } catch (e) {
      notify.error(e?.data?.error || e.message || `Failed to ${verb} gift card`);
    } finally {
      setPendingStatusId(null);
    }
  };

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
        // Theme-aware toast — pre-fix this used a hardcoded `#ecfdf5`
        // (light green) bg with no explicit text color, so the
        // surrounding theme's light text inherited into a light-green
        // surface = unreadable in dark mode. The semi-transparent
        // emerald tint + explicit `--text-primary` works in both
        // light and dark themes (same pattern used by the
        // `mq-submission-recipient-card` and other status surfaces).
        <div
          className="glass"
          style={{
            padding: '1rem',
            marginBottom: '1rem',
            background: 'rgba(16,185,129,0.12)',
            border: '1px solid rgba(16,185,129,0.35)',
            borderRadius: 8,
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.5rem',
          }}
        >
          <strong>New gift card issued:</strong>{' '}
          <code style={{ fontSize: '1.1rem', color: 'var(--text-primary)' }}>{latestCode.code}</code> ·{' '}
          <span>{formatMoney(latestCode.amount, { currency: latestCode.currency })}</span>
          <button
            onClick={() => { navigator.clipboard.writeText(latestCode.code); notify.success('Code copied'); }}
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              background: 'transparent',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              padding: '0.3rem 0.6rem',
              cursor: 'pointer',
              color: 'var(--text-primary)',
              fontSize: '0.85rem',
            }}
          >
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
            {list.map((g) => {
              const inFlight = pendingStatusId === g.id;
              const isActive = g.status === 'active';
              const isCancelled = g.status === 'cancelled';
              const isRedeemed = g.status === 'redeemed';
              return (
                <tr key={g.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={td}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                      <code>{g.code}</code>
                      <button
                        type="button"
                        onClick={() => copyCode(g.code)}
                        title="Copy code"
                        aria-label={`Copy gift card code ${g.code}`}
                        data-testid={`giftcard-copy-${g.id}`}
                        style={btnIconGhost}
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  </td>
                  <td style={td}>{formatMoney(g.amount, { currency: g.currency })}</td>
                  <td style={td}><span style={statusPill(g.status)}>{g.status}</span></td>
                  <td style={td}>{formatDate(g.createdAt)}</td>
                  <td style={td}>{g.expiresAt ? formatDate(g.expiresAt) : '—'}</td>
                  <td style={td}>{g.redeemedAt ? formatDate(g.redeemedAt) : '—'}</td>
                  <td style={td}>
                    {isRedeemed ? (
                      // Redeemed = terminal; nothing to flip. Match
                      // expired's existing UX so the column never reads
                      // empty for completed cards.
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>—</span>
                    ) : isActive ? (
                      <button
                        type="button"
                        onClick={() => toggleStatus(g)}
                        disabled={inFlight}
                        style={{ ...btnRowAction, opacity: inFlight ? 0.6 : 1 }}
                        title="Cancel this gift card (recipient can no longer redeem)"
                        data-testid={`giftcard-cancel-${g.id}`}
                      >
                        <Ban size={12} /> {inFlight ? 'Cancelling…' : 'Cancel'}
                      </button>
                    ) : isCancelled ? (
                      <button
                        type="button"
                        onClick={() => toggleStatus(g)}
                        disabled={inFlight}
                        style={{ ...btnRowAction, opacity: inFlight ? 0.6 : 1 }}
                        title="Reactivate this gift card"
                        data-testid={`giftcard-reactivate-${g.id}`}
                      >
                        <RefreshCw size={12} /> {inFlight ? 'Reactivating…' : 'Reactivate'}
                      </button>
                    ) : (
                      // Expired or other non-flippable state — keep the
                      // column rendered with a dash for consistent layout.
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {issueOpen && (
        <IssueModal
          onDone={(row) => { setLatestCode(row); setIssueOpen(false); load(); }}
          onCancel={() => setIssueOpen(false)}
        />
      )}

    </div>
  );
}

// Validity dropdown options. The integer value is `validityDays` —
// stored verbatim on GiftCard so the UI can re-render the user's
// selection. The backend ALSO computes expiresAt from this when an
// explicit expiresAt isn't sent, so a card with `validityDays=90` has
// `expiresAt = createdAt + 90d` by default.
const VALIDITY_OPTIONS = [
  { value: '',       label: 'No expiry' },
  { value: '30',     label: '1 month' },
  { value: '60',     label: '2 months' },
  { value: '90',     label: '3 months' },
  { value: '180',    label: '6 months' },
  { value: '365',    label: '1 year' },
  { value: '730',    label: '2 years' },
  { value: 'custom', label: 'Custom (days)' },
];

// Default color swatches the admin picks from. Stored as a 7-char hex
// on the GiftCard row; rendered as a chip on the card UI later.
const COLOR_SWATCHES = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f472b6', '#64748b'];

function IssueModal({ onDone, onCancel }) {
  // v3.7.17 — Zylu-style fields. `name` is the friendly label,
  // `validity` drives the expiresAt computation, `giftValue` is what
  // the recipient gets credited (maps to backend `amount`), `price` is
  // what the buyer paid (different from gift value when discounted /
  // marked up). Color is a UI accent only.
  const [name, setName] = useState('');
  const [validity, setValidity] = useState('');
  // `customDays` is only meaningful when `validity === 'custom'`. Lets the
  // operator type any 1..3650 day count — useful for promo cards that
  // expire in days, not the dropdown's month/year presets.
  const [customDays, setCustomDays] = useState('');
  const [giftValue, setGiftValue] = useState('');
  const [price, setPrice] = useState('');
  const [color, setColor] = useState(COLOR_SWATCHES[0]);
  // v3.7.17 — the "Recipient patient id" field was dropped from this
  // modal: this form is for an admin adding a gift-card SKU/template
  // (something a customer later BUYS), not directly issuing one to a
  // specific patient. The backend `issuedTo` column stays available
  // for downstream POS / purchase flows that tie the eventually-bought
  // card to its recipient.
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotify();

  const submit = async () => {
    if (!name.trim()) return notify.error('Enter a name for the gift card.');
    const gv = Number(giftValue);
    if (!Number.isFinite(gv) || gv <= 0) return notify.error('Gift value must be a positive number.');
    const p = price === '' ? null : Number(price);
    if (price !== '' && (!Number.isFinite(p) || p < 0)) {
      return notify.error('Price must be a non-negative number.');
    }
    setSubmitting(true);
    try {
      const body = {
        name: name.trim(),
        amount: gv,           // backend's existing field — the redeemable value
        price: p,             // new field — what the buyer paid
        color,
      };
      if (validity === 'custom') {
        const cd = parseInt(customDays, 10);
        if (!Number.isInteger(cd) || cd < 1 || cd > 3650) {
          notify.error('Custom validity must be a whole number of days between 1 and 3650.');
          setSubmitting(false);
          return;
        }
        body.validityDays = cd;
      } else if (validity) {
        body.validityDays = parseInt(validity, 10);
      }
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
        <h3>Add gift card</h3>
        <label style={lbl}>
          <span><span style={{ color: 'var(--danger-color, #ef4444)' }}>* </span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New year's gift card"
            style={inp}
            data-testid="giftcard-name-input"
          />
        </label>
        <label style={lbl}>
          <span>Validity</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
            Period of time the gift card is valid after purchase
          </span>
          <select
            value={validity}
            onChange={(e) => setValidity(e.target.value)}
            style={inp}
            data-testid="giftcard-validity-select"
          >
            {VALIDITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {validity === 'custom' && (
            <input
              type="number"
              value={customDays}
              onChange={(e) => setCustomDays(e.target.value)}
              style={{ ...inp, marginTop: '0.5rem' }}
              min="1"
              max="3650"
              step="1"
              placeholder="Number of days (1–3650)"
              data-testid="giftcard-custom-days-input"
              autoFocus
            />
          )}
        </label>
        <label style={lbl}>
          <span><span style={{ color: 'var(--danger-color, #ef4444)' }}>* </span>Gift value</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
            The amount your gift recipient can use
          </span>
          <input
            type="number"
            value={giftValue}
            onChange={(e) => setGiftValue(e.target.value)}
            style={inp}
            min="0"
            step="0.01"
            placeholder="100"
            data-testid="giftcard-giftvalue-input"
          />
        </label>
        <label style={lbl}>
          <span><span style={{ color: 'var(--danger-color, #ef4444)' }}>* </span>Price</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
            What you'll pay to buy this gift card
          </span>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            style={inp}
            min="0"
            step="0.01"
            placeholder="90"
            data-testid="giftcard-price-input"
          />
        </label>
        <label style={lbl}>
          <span><span style={{ color: 'var(--danger-color, #ef4444)' }}>* </span>Color</span>
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }} data-testid="giftcard-color-swatches">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Pick color ${c}`}
                data-testid={`giftcard-color-${c}`}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: c,
                  border: c === color ? '2px solid var(--text-primary)' : '1px solid var(--border-color)',
                  cursor: 'pointer',
                  outline: 'none',
                }}
              />
            ))}
          </div>
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button onClick={onCancel} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button
            onClick={submit}
            style={btnPrimary}
            disabled={submitting}
            data-testid="giftcard-save-btn"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
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
          // Theme-aware "selected patient" chip — same emerald tint as
          // the top-of-page New-Gift-Card-Issued toast so the page has
          // a single consistent success surface in both modes.
          <div style={{ padding: '0.6rem 0.75rem', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.35)', color: 'var(--text-primary)', borderRadius: 6, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
// Tiny icon-only ghost button — used for the inline Copy code action
// next to each row's masked code. Stays theme-neutral by inheriting
// the parent's text color through `currentColor` borders + transparent
// background, so it reads correctly in both light and dark modes.
const btnIconGhost = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.2rem',
  background: 'transparent',
  border: '1px solid var(--border-color)',
  borderRadius: 4,
  cursor: 'pointer',
  color: 'var(--text-secondary)',
};
const modalOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
// `var(--bg-color)` resolves to the active theme's app background
// (cream in wellness light, near-black in dark). Falling back to a
// hardcoded `#fff` would render a glaring white card in dark mode if
// the var ever goes unset; `var(--surface-color)` is the codebase's
// standard "elevated card" fallback in that case.
const modalCard = {
  background: 'var(--bg-color, var(--surface-color, #1f2937))',
  color: 'var(--text-primary)',
  padding: '1.5rem',
  borderRadius: 12,
  minWidth: 360,
  maxWidth: 500,
  border: '1px solid var(--border-color)',
};
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
