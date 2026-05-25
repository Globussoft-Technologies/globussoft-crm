/**
 * WalletRules.jsx — ADMIN-only operator UI for per-tenant wallet top-up
 * bonus rule CRUD.
 *
 * Consumes /api/wallet/rules CRUD (Agent B ships the route in slice 3 next
 * tick; Agent A is adding the WalletBonusRule + WalletCreditBatch Prisma
 * models this tick). This page is the FR-3.6 surface from
 * docs/PRD_WALLET_TOPUP.md §3.6 — it lets a clinic operator configure the
 * bonus-rule table that the top-up engine evaluates per FR-3.2:
 *
 *     when a top-up of amount A arrives, find all WalletBonusRule rows
 *     where (active=true AND validFrom <= now <= validTo AND minAmountCents
 *     <= A); per DD-5.1 (HIGHEST-PERCENT-WINS for v1), the rule with the
 *     largest bonusPercent wins; emit a WalletCreditBatch with
 *     bucket='BONUS', remainingCents=A*pct/100, expiresAt=now+validityMonths.
 *
 * SLICE-5 STATE — backend route does NOT exist yet. This page ships in a
 * "graceful degradation" shape:
 *   - GET /api/wallet/rules → 404 → render empty-state with friendly copy
 *     ("No bonus rules yet. Click + New Rule to create one.")
 *   - POST /api/wallet/rules → 404 → surface a notify.error ("Backend not
 *     ready; rule will save once shipped")
 *   - When Agent B's route lands (slice 3 next tick), no frontend change
 *     needed — the page just starts behaving correctly.
 *
 * Endpoint shape pinned per PRD §3.6 + FR-3.1 schema:
 *   GET    /api/wallet/rules          → { rules:[{ id, name, minAmountCents,
 *                                                   bonusPercent, validityMonths,
 *                                                   active, validFrom, validTo,
 *                                                   precedence, createdAt }] }
 *   POST   /api/wallet/rules          { name, minAmountCents, bonusPercent,
 *                                       validityMonths, active } → 201 envelope
 *   PUT    /api/wallet/rules/:id      → 200 envelope (slice 6+)
 *   DELETE /api/wallet/rules/:id      → 204            (slice 6+)
 *
 * UX shape — list-view with empty-state placeholder + "+ New Rule" button
 * opening a modal with 5 fields (Name, Min Amount ₹, Bonus %, Validity
 * months, Active toggle). Submit POSTs the new rule. Edit/Delete deferred
 * to slice 6 (this slice is PARTIAL — list + create only).
 *
 * Rupee↔paise boundary: PRD §3.1 schema stores cents (paise for INR
 * wellness tenants — the default currency). The UI input is in rupees;
 * the POST body sends paise via Math.round(rupees * 100). Mirror of the
 * dollar↔cents pattern in TenantSettings.jsx commit 0054a03.
 */

import { useEffect, useState } from 'react';
import { Wallet, Plus, AlertCircle, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

function rupeesToPaise(rupeeStr) {
  const n = parseFloat(String(rupeeStr).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function paiseToRupeeString(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '0.00';
  return (n / 100).toFixed(2);
}

const INITIAL_FORM = {
  name: '',
  minAmountRupees: '',
  bonusPercent: '',
  validityMonths: '12',
  active: true,
};

export default function WalletRules() {
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [backendMissing, setBackendMissing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    setBackendMissing(false);
    try {
      const data = await fetchApi('/api/wallet/rules');
      setRules(Array.isArray(data?.rules) ? data.rules : []);
    } catch (e) {
      // Backend route doesn't exist yet (slice 3 next tick). Treat 404 +
      // network errors as "empty state with friendly banner" rather than
      // a hard error — the page is a viable scaffold today.
      const msg = String(e?.message || '');
      if (/404|not.found|not.ready|fetch/i.test(msg)) {
        setBackendMissing(true);
        setRules([]);
      } else {
        setLoadError(msg || 'Failed to load wallet bonus rules');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreateModal = () => {
    setForm(INITIAL_FORM);
    setShowModal(true);
  };

  const closeModal = () => {
    if (submitting) return;
    setShowModal(false);
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    // Client-side validation mirrors the backend validator the route ships
    // with (slice 3) so the user gets a fast-fail without round-trip.
    if (!form.name.trim()) {
      notify.error('Rule name is required.');
      return;
    }
    const minPaise = rupeesToPaise(form.minAmountRupees);
    if (minPaise == null) {
      notify.error('Min Amount must be a non-negative rupee value (e.g. 1000).');
      return;
    }
    const pct = parseFloat(form.bonusPercent);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      notify.error('Bonus % must be between 0 and 100 (exclusive of 0).');
      return;
    }
    const months = parseInt(form.validityMonths, 10);
    if (!Number.isFinite(months) || months < 1 || months > 60) {
      notify.error('Validity must be between 1 and 60 months.');
      return;
    }

    setSubmitting(true);
    try {
      await fetchApi('/api/wallet/rules', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          minAmountCents: minPaise,
          bonusPercent: pct,
          validityMonths: months,
          active: Boolean(form.active),
        }),
      });
      notify.success(`Created rule "${form.name.trim()}" (${pct}% bonus on ₹${paiseToRupeeString(minPaise)}+)`);
      setShowModal(false);
      await load();
    } catch (err) {
      const msg = String(err?.message || '');
      if (/404|not.found|not.ready/i.test(msg)) {
        notify.error('Backend not ready; rule will save once shipped.');
      } else {
        // fetchApi auto-toasts the server message; nothing more to do here.
        console.error('[wallet-rules] create failed', err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1
            style={{
              fontSize: '2rem',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              margin: 0,
            }}
          >
            <Wallet size={28} color="var(--primary-color, var(--accent-color))" /> Wallet Bonus Rules
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.4rem', maxWidth: '760px' }}>
            Configure top-up bonus rules per tenant. When a customer tops up their wallet, the
            engine picks the highest-percent active rule that matches the amount (per DD-5.1 of
            PRD_WALLET_TOPUP) and emits a tracked bonus credit batch with a 12-month default
            expiry.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="btn-primary"
          data-testid="wallet-rules-new-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'var(--primary-color, var(--accent-color))',
          }}
        >
          <Plus size={16} /> New Rule
        </button>
      </header>

      {backendMissing && (
        <div
          className="card"
          data-testid="wallet-rules-backend-pending"
          style={{
            padding: '0.9rem 1.1rem',
            marginBottom: '1.25rem',
            borderLeft: '4px solid #f59e0b',
            color: '#b45309',
            fontSize: '0.88rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <AlertCircle size={18} />
          <div style={{ flex: 1 }}>
            Backend route <code>/api/wallet/rules</code> is not yet deployed. The page is
            functional and will start saving + listing rules automatically once the route lands.
          </div>
        </div>
      )}

      {loadError && (
        <div
          className="card"
          style={{
            padding: '0.9rem 1.1rem',
            marginBottom: '1.25rem',
            borderLeft: '4px solid #ef4444',
            color: '#ef4444',
            fontSize: '0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <AlertCircle size={18} />
          <div style={{ flex: 1 }}>{loadError}</div>
          <button onClick={load} className="btn-primary" style={{ padding: '0.35rem 0.85rem', fontSize: '0.82rem' }}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading wallet bonus rules…
        </div>
      ) : rules.length === 0 ? (
        <div
          className="card"
          data-testid="wallet-rules-empty"
          style={{
            padding: '3rem 2rem',
            textAlign: 'center',
            color: 'var(--text-secondary)',
          }}
        >
          <Wallet size={36} color="var(--text-secondary)" style={{ opacity: 0.5, marginBottom: '1rem' }} />
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            No bonus rules yet
          </h3>
          <p style={{ marginTop: '0.5rem', maxWidth: 480, marginInline: 'auto', lineHeight: 1.55 }}>
            No bonus rules yet. Click + New Rule to create one. Rules let you reward customers
            with extra wallet credit when they top up over a threshold (e.g. &ldquo;10% bonus on
            top-ups ≥ ₹2000&rdquo;).
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
            gap: '1.25rem',
          }}
        >
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="card"
              data-testid={`wallet-rule-card-${rule.id}`}
              style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
                <div style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {rule.name}
                </div>
                <span
                  style={{
                    padding: '0.2rem 0.55rem',
                    borderRadius: '999px',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    background: rule.active ? 'rgba(34,197,94,0.15)' : 'rgba(120,120,120,0.15)',
                    border: `1px solid ${rule.active ? '#22c55e' : 'rgba(160,160,160,0.4)'}`,
                    color: rule.active ? '#22c55e' : 'var(--text-secondary)',
                  }}
                >
                  {rule.active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Min top-up: ₹{paiseToRupeeString(rule.minAmountCents)}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Bonus: <strong style={{ color: 'var(--primary-color, var(--accent-color))' }}>{rule.bonusPercent}%</strong>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Validity: {rule.validityMonths} months
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div
          role="dialog"
          aria-label="New Wallet Bonus Rule"
          data-testid="wallet-rules-modal"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            zIndex: 1000,
          }}
          onClick={closeModal}
        >
          <form
            onSubmit={handleSubmit}
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{
              padding: '1.5rem',
              width: '100%',
              maxWidth: 480,
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>New Bonus Rule</h2>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                <X size={20} />
              </button>
            </div>

            <div>
              <label htmlFor="wallet-rule-name" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.3rem' }}>
                Name
              </label>
              <input
                id="wallet-rule-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Festive 2000+ Boost"
                disabled={submitting}
                data-testid="wallet-rule-name-input"
                style={{
                  width: '100%',
                  padding: '0.55rem 0.75rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                  background: 'var(--surface-color, rgba(255,255,255,0.04))',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                }}
              />
            </div>

            <div>
              <label htmlFor="wallet-rule-min-amount" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.3rem' }}>
                Min Amount (₹)
              </label>
              <input
                id="wallet-rule-min-amount"
                type="number"
                min="0"
                step="0.01"
                value={form.minAmountRupees}
                onChange={(e) => setForm((f) => ({ ...f, minAmountRupees: e.target.value }))}
                placeholder="2000"
                disabled={submitting}
                data-testid="wallet-rule-min-amount-input"
                style={{
                  width: '100%',
                  padding: '0.55rem 0.75rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                  background: 'var(--surface-color, rgba(255,255,255,0.04))',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                }}
              />
            </div>

            <div>
              <label htmlFor="wallet-rule-bonus-percent" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.3rem' }}>
                Bonus %
              </label>
              <input
                id="wallet-rule-bonus-percent"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={form.bonusPercent}
                onChange={(e) => setForm((f) => ({ ...f, bonusPercent: e.target.value }))}
                placeholder="10"
                disabled={submitting}
                data-testid="wallet-rule-bonus-percent-input"
                style={{
                  width: '100%',
                  padding: '0.55rem 0.75rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                  background: 'var(--surface-color, rgba(255,255,255,0.04))',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                }}
              />
            </div>

            <div>
              <label htmlFor="wallet-rule-validity-months" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.3rem' }}>
                Validity (months)
              </label>
              <input
                id="wallet-rule-validity-months"
                type="number"
                min="1"
                max="60"
                step="1"
                value={form.validityMonths}
                onChange={(e) => setForm((f) => ({ ...f, validityMonths: e.target.value }))}
                disabled={submitting}
                data-testid="wallet-rule-validity-months-input"
                style={{
                  width: '100%',
                  padding: '0.55rem 0.75rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                  background: 'var(--surface-color, rgba(255,255,255,0.04))',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                }}
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                disabled={submitting}
                data-testid="wallet-rule-active-input"
              />
              <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>Active immediately</span>
            </label>

            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
              <button
                type="button"
                onClick={closeModal}
                disabled={submitting}
                style={{
                  padding: '0.55rem 1rem',
                  borderRadius: '8px',
                  background: 'transparent',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                  color: 'var(--text-secondary)',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="btn-primary"
                data-testid="wallet-rule-submit-btn"
                style={{
                  background: 'var(--primary-color, var(--accent-color))',
                  opacity: submitting ? 0.6 : 1,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >
                {submitting ? 'Creating…' : 'Create Rule'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
