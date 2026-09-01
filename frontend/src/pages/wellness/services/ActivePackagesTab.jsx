import { useEffect, useState } from 'react';
import { Package, Eye, EyeOff, Archive, RotateCcw, AlertTriangle, CalendarClock, ShoppingBag, Loader, CheckCircle2, CalendarPlus } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { formatDate } from '../../../utils/date';
import SingleSelectDropdown from './SingleSelectDropdown';
import { isPastDateInput, todayDateInput } from './shared';

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

// Same slabs the builder offers, so a package edited here and one built there
// can only ever carry the same set.
const TAX_OPTIONS = [
  { value: 0, label: 'No Tax' },
  { value: 5, label: 'GST 5%' },
  { value: 18, label: 'GST 18%' },
];

// Matches MAX_SESSIONS in routes/wellness_packages.js — the server rejects
// anything outside this, and a field that lets you type a doomed value is a
// worse experience than one that doesn't.
const MIN_SESSIONS = 1;
const MAX_SESSIONS = 60;

/**
 * Still has sessions on it, and still in time to use them — the state in which
 * buying the same package again would charge for something unused.
 */
function holdsUsableSessions(plan) {
  if (!plan) return false;
  if (plan.completedSessions >= plan.totalSessions) return false;
  return !planLapsed(plan);
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
  // What the card should show while a toggle is in flight. Publishing is a PUT
  // plus the parent's refetch — roughly half a second — and a badge that only
  // flips at the end of that reads as a dead click, so the card shows the
  // outcome straight away and the request catches up behind it.
  const [optimistic, setOptimistic] = useState({});
  // Sessions and discount are typed, not picked, so they are held as drafts and
  // saved on blur — a PUT per keystroke would re-price the package on the way
  // to a number the user has not finished typing.
  const [terms, setTerms] = useState({});
  const minSellByDate = todayDateInput();

  const termFor = (pkg) => terms[pkg.id] || {
    sessions: String(pkg.sessions ?? ''),
    discountPercent: String(pkg.discountPercent ?? 0),
  };
  const setTerm = (pkg, next) => setTerms((t) => ({ ...t, [pkg.id]: { ...termFor(pkg), ...next } }));
  const clearTerm = (pkg) => setTerms((t) => {
    const { [pkg.id]: _drop, ...rest } = t;
    return rest;
  });

  // The split is drafted the same way, but keyed by service: a PUT per
  // keystroke would re-price on the way to a number nobody finished typing.
  const [splits, setSplits] = useState({});
  const splitFor = (pkg) => splits[pkg.id] || { ...(pkg.serviceSessions || {}) };
  const setSplit = (pkg, serviceId, value) =>
    setSplits((d) => ({ ...d, [pkg.id]: { ...splitFor(pkg), [serviceId]: value } }));

  /**
   * Save one service's count.
   *
   * Sent as the whole map, never as a bare `sessions`: the API rejects that on
   * a split package, and the map is what re-derives the total. Every service in
   * the bundle must carry a count or the uncovered ones would price at zero.
   */
  const commitSplit = async (pkg, serviceId, raw) => {
    const current = Number(pkg.serviceSessions?.[serviceId] ?? 0);
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 1 || n > MAX_SESSIONS) {
      notify.error(`Sessions must be a whole number between 1 and ${MAX_SESSIONS}`);
      setSplit(pkg, serviceId, String(current));
      return;
    }
    if (n === current) return;

    const serviceSessions = {};
    for (const svc of pkg.services) {
      serviceSessions[svc.id] = svc.id === serviceId ? n : Number(pkg.serviceSessions?.[svc.id] ?? 0);
    }
    const total = Object.values(serviceSessions).reduce((sum, v) => sum + v, 0);
    await patch(pkg, { serviceSessions }, `"${pkg.name}" now ${total} sessions`);
    setSplits((d) => {
      const { [pkg.id]: _drop, ...rest } = d;
      return rest;
    });
  };

  /**
   * Save a typed number, or put the old one back.
   *
   * Editing sessions or discount re-prices the package at TODAY'S service
   * prices — that is the documented behaviour of the API and the reason the
   * note under these fields exists. Packages patients already bought keep the
   * price they were sold at; only the catalog entry moves.
   */
  const commitNumber = async (pkg, field, raw, { min, max, label, suffix = '' }) => {
    const current = Number(pkg[field] ?? 0);
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < min || n > max) {
      notify.error(`${label} must be a whole number between ${min} and ${max}`);
      setTerm(pkg, { [field]: String(current) });
      return;
    }
    if (n === current) return;
    await patch(pkg, { [field]: n }, `"${pkg.name}" now ${n}${suffix} ${label.toLowerCase()}`);
    // Drop the draft so the field re-seeds from the freshly reloaded package.
    clearTerm(pkg);
  };

  // Drop an optimistic flag once the reloaded list actually carries it. Doing
  // this on arrival rather than when the PUT resolves is what stops the badge
  // snapping back to its old value for the frame between the two.
  useEffect(() => {
    setOptimistic((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0) return current;
      const next = {};
      for (const id of ids) {
        const live = packages.find((p) => String(p.id) === id);
        const caughtUp = live && Object.entries(current[id]).every(([k, v]) => live[k] === v);
        if (!caughtUp) next[id] = current[id];
      }
      return Object.keys(next).length === ids.length ? current : next;
    });
  }, [packages]);

  const forget = (pkgId) => setOptimistic((current) => {
    if (!(pkgId in current)) return current;
    const { [pkgId]: _dropped, ...rest } = current;
    return rest;
  });

  const patch = async (pkg, body, successMessage, showAsIfDone = null) => {
    if (Object.prototype.hasOwnProperty.call(body, 'sellByDate') && isPastDateInput(body.sellByDate, minSellByDate)) {
      notify.error('Sell-by date cannot be in the past');
      return;
    }
    setBusyId(pkg.id);
    if (showAsIfDone) {
      setOptimistic((current) => ({ ...current, [pkg.id]: { ...(current[pkg.id] || {}), ...showAsIfDone } }));
    }
    try {
      await fetchApi(`/api/wellness/packages/${pkg.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      notify.success(successMessage);
      onChanged?.();
    } catch (err) {
      // The card is showing something that did not happen — put it back.
      forget(pkg.id);
      notify.error(err?.message || 'Could not update the package');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (pkg) => {
    // Retire, not delete — anything already quoted against this package must
    // keep resolving. A hard delete is a separate, deliberate action.
    // notify.confirm, not window.confirm: the native dialog is chrome outside
    // the app ("localhost:5173 says…"), unstyled and unthemeable, and it blocks
    // the automated QA tooling that drives these flows.
    const confirmed = await notify.confirm({
      title: `Retire "${pkg.name}"?`,
      message: 'It stops being offered to customers but stays on record, so anything already sold against it keeps resolving. You can restore it later.',
      confirmText: 'Retire package',
      cancelText: 'Keep it live',
      destructive: true,
    });
    if (!confirmed) return;
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
        // What the card shows: the row as loaded, with an in-flight toggle
        // applied on top so the badge and the button label change on click.
        const view = optimistic[pkg.id] ? { ...pkg, ...optimistic[pkg.id] } : pkg;
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
              opacity: busy ? 0.72 : view.isActive ? 1 : 0.6,
              transition: 'opacity 180ms ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start' }}>
              <div style={{ fontWeight: 600, minWidth: 0 }}>{pkg.name}</div>
              <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                {!view.isActive && <Badge tone="muted">Retired</Badge>}
                {view.isActive && view.isPublic && <Badge tone="success">Live</Badge>}
                {view.isActive && !view.isPublic && <Badge tone="warn">Draft</Badge>}
                {/* A package past its sell-by is already gone from the customer
                    catalog — say so here rather than leaving staff to wonder
                    why a "Live" package isn't showing up. */}
                {view.isActive && pastSellBy(pkg.sellByDate) && <Badge tone="warn">Past sell-by</Badge>}
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
                  {pkg.serviceSessions?.[s.id] ? ` × ${pkg.serviceSessions[s.id]}` : ''}
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
              {/* `sessions` is the number of VISITS the patient books, which
                  is what the counter counts down. With services sharing a
                  sitting that is fewer than the treatment runs they cover, so
                  both numbers are printed — 4 visits is not 7 runs. */}
              <span>
                {pkg.sessions} {pkg.sessions === 1 ? 'visit' : 'visits'}
                {pkg.serviceSessions && pkg.services.length > 1
                  ? ` · ${pkg.services.map((s) => pkg.serviceSessions[s.id] ?? 0).join(' + ')} = ${
                      pkg.serviceSessionTotal ?? pkg.sessions
                    } sessions`
                  : ''}
              </span>
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
                {pkg.ownedPlan.nextDueAt && !planLapsed(pkg.ownedPlan) && (
                  <span
                    data-testid={`package-valid-till-${pkg.id}`}
                    style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}
                  >
                    Package valid till {formatDate(pkg.ownedPlan.nextDueAt)}.
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
                  <>
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
                    {pkg.ownedPlan.nextDueAt && (
                      <span
                        data-testid={`package-valid-till-${pkg.id}`}
                        style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}
                      >
                        Package valid till {formatDate(pkg.ownedPlan.nextDueAt)}.
                      </span>
                    )}
                  </>
                )}
              </div>
            )}

            {/* The customer's only action. Price and tax are recomputed
                server-side at checkout — this button carries no amount.
                Hidden while they still hold usable sessions from this package:
                the server refuses that purchase, and offering a button that
                cannot work is worse than offering none. It returns once the
                sessions are spent or the window has closed. */}
            {readOnly && onBuy && view.isActive && !holdsUsableSessions(pkg.ownedPlan) && (
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

            {/* The three numbers printed on the line above, made editable. Tax
                is applied at checkout so changing it moves no stored figure;
                sessions and discount re-price the package, which the note
                below says out loud rather than letting the total shift
                silently under whoever edited it. */}
            {!readOnly && pkg.isActive && (
              <div
                data-testid={`package-terms-${pkg.id}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '0.4rem',
                  marginTop: '0.5rem',
                  paddingTop: '0.5rem',
                  borderTop: '1px solid var(--border-color)',
                }}
              >
                {/* A package that prices per service has no single "sessions"
                    to edit — the API refuses a bare one, because there is no
                    honest way to spread 10 over a 1 + 7 split. So edit the
                    split itself, which is what sets the total. */}
                {pkg.serviceSessions ? (
                  <div style={{ ...termFieldStyle, gridColumn: '1 / -1' }}>
                    Sessions per service
                    <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>
                      {' '}
                      — {pkg.sessionMode === 'separate'
                        ? 'one service per visit'
                        : 'services share a visit'}
                    </span>
                    <div
                      data-testid={`package-split-${pkg.id}`}
                      style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.2rem' }}
                    >
                      {pkg.services.map((svc) => (
                        <label
                          key={svc.id}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem' }}
                        >
                          <span style={{ color: 'var(--text-secondary)' }}>{svc.name}</span>
                          <input
                            type="number"
                            min={1}
                            max={MAX_SESSIONS}
                            step={1}
                            value={splitFor(pkg)[svc.id] ?? ''}
                            disabled={busy}
                            data-testid={`package-split-${pkg.id}-${svc.id}`}
                            onChange={(e) => setSplit(pkg, svc.id, e.target.value)}
                            onBlur={(e) => commitSplit(pkg, svc.id, e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            style={{ ...termInputStyle, width: '3.2rem' }}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                <label style={termFieldStyle}>
                  Sessions
                  <input
                    type="number"
                    min={MIN_SESSIONS}
                    max={MAX_SESSIONS}
                    step={1}
                    value={termFor(pkg).sessions}
                    disabled={busy}
                    data-testid={`package-sessions-${pkg.id}`}
                    onChange={(e) => setTerm(pkg, { sessions: e.target.value })}
                    onBlur={(e) => commitNumber(pkg, 'sessions', e.target.value, {
                      min: MIN_SESSIONS, max: MAX_SESSIONS, label: 'Sessions',
                    })}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    style={termInputStyle}
                  />
                </label>
                )}

                <label style={termFieldStyle}>
                  Discount %
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={termFor(pkg).discountPercent}
                    disabled={busy}
                    data-testid={`package-discount-${pkg.id}`}
                    onChange={(e) => setTerm(pkg, { discountPercent: e.target.value })}
                    onBlur={(e) => commitNumber(pkg, 'discountPercent', e.target.value, {
                      min: 0, max: 100, label: 'Discount', suffix: '%',
                    })}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    style={termInputStyle}
                  />
                </label>

                <div style={{ ...termFieldStyle, gridColumn: '1 / -1' }}>
                  Tax
                  <div data-testid={`package-tax-${pkg.id}`}>
                    <SingleSelectDropdown
                      value={Number(pkg.taxPercent) || 0}
                      onChange={(v) => {
                        if (Number(v) === (Number(pkg.taxPercent) || 0)) return;
                        patch(
                          pkg,
                          { taxPercent: Number(v) },
                          Number(v) === 0
                            ? `"${pkg.name}" is now sold without tax`
                            : `"${pkg.name}" now carries ${v}% tax`,
                        );
                      }}
                      options={TAX_OPTIONS}
                    />
                  </div>
                </div>

                <p
                  style={{
                    gridColumn: '1 / -1',
                    margin: 0,
                    fontSize: '0.68rem',
                    lineHeight: 1.45,
                    color: 'var(--text-secondary)',
                  }}
                >
                  Changing sessions or discount re-prices this package at
                  today&rsquo;s service prices. Packages already bought keep the price they
                  were sold at.
                </p>
              </div>
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
                  min={minSellByDate}
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
                {view.isActive && (
                  <ActionBtn
                    disabled={busy}
                    onClick={() => patch(
                      pkg,
                      { isPublic: !view.isPublic },
                      view.isPublic ? `"${pkg.name}" hidden from customers` : `"${pkg.name}" published`,
                      { isPublic: !view.isPublic },
                    )}
                    testId={`package-publish-${pkg.id}`}
                    icon={view.isPublic ? <EyeOff size={13} /> : <Eye size={13} />}
                  >
                    {view.isPublic ? 'Unpublish' : 'Publish'}
                  </ActionBtn>
                )}
                {view.isActive ? (
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
                    onClick={() => patch(pkg, { isActive: true }, `"${pkg.name}" restored`, { isActive: true })}
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

const termFieldStyle = {
  display: 'grid',
  gap: '0.2rem',
  fontSize: '0.68rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-secondary)',
};

const termInputStyle = {
  padding: '0.25rem 0.4rem',
  background: 'var(--subtle-bg-3)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  fontSize: '0.75rem',
  width: '100%',
  boxSizing: 'border-box',
};

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
        // Live ⇄ Draft is a state change worth seeing happen, not a snap.
        transition: 'color 180ms ease, background 180ms ease',
        animation: 'fadeIn 180ms ease-out',
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
