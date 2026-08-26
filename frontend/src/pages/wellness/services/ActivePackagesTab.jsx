import { useState } from 'react';
import { Package, Eye, EyeOff, Archive, RotateCcw, AlertTriangle, CalendarClock, ShoppingBag, Loader, CheckCircle2, CalendarPlus } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { formatDate } from '../../../utils/date';

// Day counts the builder offers, spelled back out. Anything else falls back to
// a plain day count rather than guessing at a name for it.
const VALIDITY_LABELS = { 1: 'Today', 7: '1 week', 14: '2 weeks', 30: '1 month', 180: '6 months', 365: '1 year' };

function validityLabel(days) {
  if (!days) return null;
  return VALIDITY_LABELS[days] || `${days} days`;
}

/** True once the sell-by date has passed — the package can no longer be sold. */
function pastSellBy(sellByDate) {
  if (!sellByDate) return false;
  const when = new Date(sellByDate);
  return !Number.isNaN(when.getTime()) && when.getTime() < Date.now();
}

/** True once a plan's use-by date has gone. */
function planLapsed(plan) {
  if (!plan?.nextDueAt) return false;
  const when = new Date(plan.nextDueAt);
  return !Number.isNaN(when.getTime()) && when.getTime() < Date.now();
}

/** Stored ISO timestamp → the YYYY-MM-DD a <input type="date"> expects. */
function toDateInput(value) {
  if (!value) return '';
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? '' : when.toISOString().slice(0, 10);
}

/**
 * Saved service packages.
 *
 * Lists the commercial bundles the clinic sells. Not to be confused with the
 * "Active Packages" TAB, which is backed by TreatmentPlan rows (what a patient
 * has bought and is working through) — that is per-patient clinical data, this
 * is catalog config.
 *
 * Two surfaces render this: the "Packages you offer" section at the top of the
 * Active Packages tab (staff, mutable), and the customer-facing Packages tab
 * (`readOnly`).
 *
 * `isActive` = offered at all. `isPublic` = listed on the customer catalog.
 * Both are toggled here, because "built but not yet published" is the normal
 * state of a package while pricing is still being agreed.
 *
 * Read-only for customers (`readOnly`), which is how the same component backs
 * the customer-facing Packages tab without a second implementation.
 */
export default function ActivePackagesTab({ packages, loading, onChanged, readOnly = false, onBuy = null, buyingId = null, onRequestSession = null }) {
  const notify = useNotify();
  const [busyId, setBusyId] = useState(null);

  const patch = async (pkg, body, successMessage) => {
    setBusyId(pkg.id);
    try {
      await fetchApi(`/api/wellness/packages/${pkg.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      notify.success(successMessage);
      onChanged?.();
    } catch (err) {
      notify.error(err?.message || 'Could not update the package');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (pkg) => {
    // Retire, not delete — anything already quoted against this package must
    // keep resolving. A hard delete is a separate, deliberate action.
    if (!window.confirm(`Retire "${pkg.name}"? It stops being offered but stays on record.`)) return;
    setBusyId(pkg.id);
    try {
      await fetchApi(`/api/wellness/packages/${pkg.id}`, { method: 'DELETE' });
      notify.success(`"${pkg.name}" retired`);
      onChanged?.();
    } catch (err) {
      notify.error(err?.message || 'Could not retire the package');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-secondary)', padding: '2rem', textAlign: 'center' }}>Loading packages…</div>;
  }

  if (!packages.length) {
    return (
      <div className="glass" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <Package size={28} style={{ color: 'var(--accent-color)', marginBottom: '0.6rem' }} />
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>
          {readOnly ? 'No packages available yet' : 'No packages saved yet'}
        </div>
        <div style={{ fontSize: '0.85rem' }}>
          {readOnly
            ? 'Your clinic has not published any packages. Check back soon.'
            : 'Build one on the Packages tab and save it to see it here.'}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="active-packages-list"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: '1rem' }}
    >
      {packages.map((pkg) => {
        const busy = busyId === pkg.id;
        return (
          <div
            key={pkg.id}
            className="glass"
            data-testid={`package-card-${pkg.id}`}
            style={{
              padding: '1.1rem',
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              opacity: pkg.isActive ? 1 : 0.6,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start' }}>
              <div style={{ fontWeight: 600, minWidth: 0 }}>{pkg.name}</div>
              <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                {!pkg.isActive && <Badge tone="muted">Retired</Badge>}
                {pkg.isActive && pkg.isPublic && <Badge tone="success">Live</Badge>}
                {pkg.isActive && !pkg.isPublic && <Badge tone="warn">Draft</Badge>}
                {/* A package past its sell-by is already gone from the customer
                    catalog — say so here rather than leaving staff to wonder
                    why a "Live" package isn't showing up. */}
                {pkg.isActive && pastSellBy(pkg.sellByDate) && <Badge tone="warn">Past sell-by</Badge>}
              </div>
            </div>

            {pkg.description && (
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{pkg.description}</div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
              {pkg.services.map((s) => (
                <span
                  key={s.id}
                  style={{
                    fontSize: '0.7rem',
                    padding: '0.15rem 0.45rem',
                    borderRadius: 999,
                    background: 'var(--subtle-bg-3)',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {s.name}
                </span>
              ))}
            </div>

            {/* The stored price is a snapshot. If a bundled service has since
                been deleted, say so rather than quietly showing a total that
                no longer adds up from the catalog. */}
            {pkg.missingServiceIds?.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.72rem',
                  color: '#f59e0b',
                }}
              >
                <AlertTriangle size={12} />
                {pkg.missingServiceIds.length} bundled service(s) no longer in the catalog
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <span>{pkg.sessions} sessions</span>
              {pkg.discountPercent > 0 && <span>{pkg.discountPercent}% off</span>}
              {pkg.taxPercent > 0 && <span>+{pkg.taxPercent}% tax</span>}
            </div>

            {(pkg.validityDays || pkg.sellByDate) && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '0.72rem',
                  color: pastSellBy(pkg.sellByDate) ? '#f59e0b' : 'var(--text-secondary)',
                }}
              >
                <CalendarClock size={12} />
                {pkg.validityDays && <span>Valid {validityLabel(pkg.validityDays)} after purchase</span>}
                {pkg.sellByDate && (
                  <span>
                    {!pastSellBy(pkg.sellByDate)
                      ? `Sell by ${formatDate(pkg.sellByDate)}`
                      /* Published but past its sell-by is the confusing state:
                         the card says "Live" while the customer catalog has
                         already dropped it. Spell out the consequence. */
                      : pkg.isPublic
                        ? `Hidden from customers — sell-by ${formatDate(pkg.sellByDate)} has passed`
                        : `Sell-by ${formatDate(pkg.sellByDate)} has passed`}
                  </span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '0.15rem' }}>
              <span style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-color)' }}>
                ₹{Math.round(pkg.price).toLocaleString('en-IN')}
              </span>
              {pkg.grossPrice > pkg.price && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textDecoration: 'line-through' }}>
                  ₹{Math.round(pkg.grossPrice).toLocaleString('en-IN')}
                </span>
              )}
            </div>

            {/* A sell-by date could be set at build time but never changed,
                so a package that ran past it had no way back onto the customer
                catalog short of rebuilding it. Editable here, and clearing the
                field puts it back on sale indefinitely. */}
            {/* What a buyer needs after paying: that it is theirs, how much
                of it is left, and the date it stops being usable. Without this
                the card looked identical before and after the purchase. */}
            {readOnly && pkg.ownedPlan && (
              <div
                data-testid={`package-owned-${pkg.id}`}
                style={{
                  marginTop: '0.5rem',
                  padding: '0.6rem 0.7rem',
                  borderRadius: 8,
                  background: 'rgba(16,185,129,0.10)',
                  border: '1px solid rgba(16,185,129,0.28)',
                  display: 'grid',
                  gap: '0.25rem',
                  fontSize: '0.75rem',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#10b981', fontWeight: 600 }}>
                  <CheckCircle2 size={13} /> You bought this
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {Math.max(0, pkg.ownedPlan.totalSessions - pkg.ownedPlan.completedSessions)} of{' '}
                  {pkg.ownedPlan.totalSessions} sessions left
                  {pkg.ownedPlan.startedAt ? ` · bought ${formatDate(pkg.ownedPlan.startedAt)}` : ''}
                </span>
                {pkg.ownedPlan.nextDueAt && (
                  <span style={{ color: planLapsed(pkg.ownedPlan) ? '#f59e0b' : 'var(--text-secondary)' }}>
                    {planLapsed(pkg.ownedPlan)
                      ? `Ran out on ${formatDate(pkg.ownedPlan.nextDueAt)} — ask the clinic before booking`
                      : `Book your sessions by ${formatDate(pkg.ownedPlan.nextDueAt)}`}
                  </span>
                )}
                {!pkg.ownedPlan.nextDueAt && (
                  <span style={{ color: 'var(--text-secondary)' }}>No expiry — book whenever suits you</span>
                )}

                {/* Owning sessions is only useful if you can ask to use one.
                    Hidden once they are all spent — there is nothing left to
                    book, and the Buy again button below is the real action. */}
                {onRequestSession
                  && pkg.ownedPlan.completedSessions < pkg.ownedPlan.totalSessions
                  && !planLapsed(pkg.ownedPlan) && (
                  <button
                    type="button"
                    onClick={() => onRequestSession(pkg)}
                    data-testid={`package-request-session-${pkg.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.35rem',
                      marginTop: '0.35rem',
                      padding: '0.45rem 0.75rem',
                      background: 'rgba(16,185,129,0.16)',
                      border: '1px solid rgba(16,185,129,0.4)',
                      borderRadius: 7,
                      color: '#10b981',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <CalendarPlus size={13} /> Request a session
                  </button>
                )}
              </div>
            )}

            {/* The customer's only action. Price and tax are recomputed
                server-side at checkout — this button carries no amount. */}
            {readOnly && onBuy && pkg.isActive && (
              <button
                type="button"
                disabled={buyingId != null}
                onClick={() => onBuy(pkg)}
                data-testid={`package-buy-${pkg.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                  marginTop: '0.6rem',
                  padding: '0.55rem 1rem',
                  width: '100%',
                  background: pkg.ownedPlan ? 'transparent' : 'var(--accent-color)',
                  border: pkg.ownedPlan ? '1px solid var(--border-color)' : 'none',
                  borderRadius: 8,
                  color: pkg.ownedPlan ? 'var(--text-secondary)' : '#fff',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: buyingId != null ? 'not-allowed' : 'pointer',
                  opacity: buyingId != null && buyingId !== pkg.id ? 0.6 : 1,
                }}
              >
                {buyingId === pkg.id ? (
                  <>
                    <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Opening checkout…
                  </>
                ) : (
                  <>
                    <ShoppingBag size={14} /> {pkg.ownedPlan ? 'Buy again' : 'Buy package'}
                  </>
                )}
              </button>
            )}

            {!readOnly && pkg.isActive && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontSize: '0.72rem',
                  color: 'var(--text-secondary)',
                  marginTop: '0.35rem',
                }}
              >
                Sell by
                <input
                  type="date"
                  value={toDateInput(pkg.sellByDate)}
                  disabled={busy}
                  data-testid={`package-sellby-${pkg.id}`}
                  onChange={(e) => patch(
                    pkg,
                    { sellByDate: e.target.value || null },
                    e.target.value
                      ? `"${pkg.name}" sellable until ${e.target.value}`
                      : `"${pkg.name}" has no sell-by date now`,
                  )}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '0.25rem 0.4rem',
                    background: 'var(--subtle-bg-3)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    color: 'var(--text-primary)',
                    fontSize: '0.72rem',
                    colorScheme: 'dark light',
                  }}
                />
              </label>
            )}

            {!readOnly && (
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                {pkg.isActive && (
                  <ActionBtn
                    disabled={busy}
                    onClick={() => patch(pkg, { isPublic: !pkg.isPublic }, pkg.isPublic ? `"${pkg.name}" hidden from customers` : `"${pkg.name}" published`)}
                    testId={`package-publish-${pkg.id}`}
                    icon={pkg.isPublic ? <EyeOff size={13} /> : <Eye size={13} />}
                  >
                    {pkg.isPublic ? 'Unpublish' : 'Publish'}
                  </ActionBtn>
                )}
                {pkg.isActive ? (
                  <ActionBtn
                    disabled={busy}
                    onClick={() => remove(pkg)}
                    testId={`package-retire-${pkg.id}`}
                    icon={<Archive size={13} />}
                  >
                    Retire
                  </ActionBtn>
                ) : (
                  <ActionBtn
                    disabled={busy}
                    onClick={() => patch(pkg, { isActive: true }, `"${pkg.name}" restored`)}
                    testId={`package-restore-${pkg.id}`}
                    icon={<RotateCcw size={13} />}
                  >
                    Restore
                  </ActionBtn>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Badge({ tone, children }) {
  const palette = {
    success: { fg: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    warn: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    muted: { fg: 'var(--text-secondary)', bg: 'var(--subtle-bg-3)' },
  }[tone];
  return (
    <span
      style={{
        fontSize: '0.65rem',
        fontWeight: 600,
        padding: '0.15rem 0.45rem',
        borderRadius: 999,
        color: palette.fg,
        background: palette.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function ActionBtn({ children, icon, onClick, disabled, testId }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="btn-secondary"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.3rem 0.6rem',
        fontSize: '0.75rem',
      }}
    >
      {icon} {children}
    </button>
  );
}

