import { useEffect, useMemo, useRef, useState } from 'react';
import { Package, Copy, Check, X, Save, Loader, Info } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { formatMoney } from '../../../utils/money';
import { inputStyle, isPastDateInput, labelStyle, todayDateInput } from './shared';
import MultiSelectDropdown from './MultiSelectDropdown';
import SingleSelectDropdown from './SingleSelectDropdown';

/**
 * A small "what does this number mean" bubble.
 *
 * Sessions, runs and visits are three different counts here and the difference
 * is not guessable from the labels alone, so the explanation sits next to the
 * number rather than in a manual nobody opens. Hover, focus or tap — the click
 * toggle is what makes it reachable on a touchscreen.
 */
function Hint({ text, testId }) {
  // Click OPENS, it never toggles: a tap fires mouseover first, so a toggle
  // would open then immediately close and a touchscreen would show nothing at
  // all. Dismiss is leaving, blurring or Escape.
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}>
      <button
        type="button"
        aria-label="What this number means"
        data-testid={testId}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); } }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-secondary)',
          cursor: 'help',
        }}
      >
        <Info size={12} />
      </button>
      {open && (
        <span
          role="tooltip"
          data-testid={`${testId}-bubble`}
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.35rem)',
            left: 0,
            zIndex: 5,
            width: 250,
            padding: '0.45rem 0.55rem',
            borderRadius: 6,
            // --popover-bg is the opaque floating surface and is defined in
            // both themes; --card-bg does not exist, so the old fallback
            // painted a dark box in light mode.
            background: 'var(--popover-bg)',
            border: '1px solid var(--border-color)',
            boxShadow: 'var(--glass-shadow, 0 6px 18px rgba(0, 0, 0, 0.18))',
            color: 'var(--text-secondary)',
            fontSize: '0.68rem',
            fontWeight: 400,
            lineHeight: 1.45,
            textTransform: 'none',
            letterSpacing: 0,
            whiteSpace: 'normal',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

// GST slabs a clinic actually charges. The column takes any 0-100 rate, so a
// slab change here does not need a migration.
// Matches MAX_SESSIONS in routes/wellness_packages.js.
const MAX_SESSIONS_PER_SERVICE = 60;
// The slider covers the common range; the per-service boxes take anything up
// to MAX_SESSIONS_PER_SERVICE. It starts at 1 because a single run is a real
// package — a floor of 2 could not even represent what the boxes allow.
const SLIDER_MIN = 1;
const SLIDER_MAX = 12;

const TAX_OPTIONS = [
  { value: 0, label: 'No Tax' },
  { value: 5, label: 'GST 5%' },
  { value: 18, label: 'GST 18%' },
];

// How long the buyer has to use the package once bought. Stored as a day
// count so "6 Months" is unambiguous across month lengths.
const VALIDITY_OPTIONS = [
  { value: '', label: 'No expiry', days: null },
  { value: '1', label: 'Today', days: 1 },
  { value: '7', label: '1 Week', days: 7 },
  { value: '14', label: '2 Weeks', days: 14 },
  { value: '30', label: '1 Month', days: 30 },
  { value: '180', label: '6 Months', days: 180 },
  { value: '365', label: '1 Year', days: 365 },
];

function Row({ label, children, negative, muted }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: muted ? '0.8rem' : '0.9rem' }}>
      <span style={{ color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      <span style={{ color: negative ? '#f59e0b' : muted ? 'var(--text-secondary)' : 'var(--text-primary)', whiteSpace: 'nowrap' }}>
        {children}
      </span>
    </div>
  );
}

/**
 * Package builder — bundle one or more services into a discounted pitch.
 *
 * `sessions` is how many times the WHOLE bundle repeats, so the gross is
 * (sum of the selected services' per-session prices) × sessions. A package of
 * one service therefore prices exactly as it did before multi-select landed.
 */
export default function PackageBuilder({ services, onSaved }) {
  const notify = useNotify();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  // Prefer high-tier services for packages, fall back to all.
  const eligible = useMemo(() => {
    const hi = services.filter((s) => s.ticketTier === 'high');
    return hi.length ? hi : services;
  }, [services]);

  const [selectedIds, setSelectedIds] = useState([]);
  // Sessions per service, keyed by id. A package is no longer "the bundle, N
  // times": 5 sessions can be 3 of one treatment and 2 of another, and the
  // price follows that split. The slider below still exists — it sets every
  // service at once, which is the common case and what the old single number
  // meant.
  const [sessionsByService, setSessionsByService] = useState({});
  // How those runs are packed into appointments. "combined" is what a package
  // has always meant — one visit delivers every service that still has a run
  // left — so 3 + 4 is four visits. "separate" is one service per visit, so the
  // same 3 + 4 is seven. Price is identical either way; only the number of
  // appointments the patient books changes.
  const [sessionMode, setSessionMode] = useState('combined');
  const [sessions, setSessions] = useState(6);
  const [discount, setDiscount] = useState(15);
  const [taxPercent, setTaxPercent] = useState(0);
  // '' = no expiry. Kept as a string so it round-trips through the dropdown's
  // strict === comparison without a number/string mismatch.
  const [validity, setValidity] = useState('');
  const [sellByDate, setSellByDate] = useState('');
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef(null);

  // Seed with the first service so the summary is never empty on open, the
  // way the single-select version behaved.
  useEffect(() => {
    if (!selectedIds.length && eligible.length) setSelectedIds([eligible[0].id]);
  }, [eligible, selectedIds.length]);

  // Drop selections whose service disappeared (category filter, deletion)
  // rather than silently pricing a service that is no longer on the list.
  useEffect(() => {
    setSelectedIds((current) => {
      const live = current.filter((id) => eligible.some((s) => s.id === id));
      return live.length === current.length ? current : live;
    });
  }, [eligible]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  const selected = useMemo(
    () => eligible.filter((s) => selectedIds.includes(s.id)),
    [eligible, selectedIds],
  );

  // A newly added service starts at whatever the slider says; a removed one
  // drops out, so a service that comes back later does not silently inherit
  // the count it had two edits ago.
  useEffect(() => {
    setSessionsByService((current) => {
      const next = {};
      for (const id of selectedIds) {
        next[id] = current[id] ?? sessions;
      }
      const sameKeys = Object.keys(next).length === Object.keys(current).length;
      const sameValues = sameKeys && Object.keys(next).every((k) => next[k] === current[k]);
      return sameValues ? current : next;
    });
    // `sessions` is read for the default only — reacting to it here would undo
    // a per-service edit every time the slider moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  const sessionsFor = (id) => sessionsByService[id] ?? sessions;

  // What is actually in the box while it is being typed in. Clamping on every
  // keystroke made the field unusable: clearing it to type "5" read as 0, which
  // clamped straight back to 1, so you got "15" and never 5. The raw string
  // lives here until blur, and only a fully valid number reaches the price.
  const [sessionDrafts, setSessionDrafts] = useState({});
  const draftFor = (id) => sessionDrafts[id] ?? String(sessionsFor(id));

  const typeSessionsFor = (id, raw) => {
    setSessionDrafts((d) => ({ ...d, [id]: raw }));
    const n = Number(raw);
    // Price live while the number is real; leave it alone for '' or '0'.
    if (raw !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_SESSIONS_PER_SERVICE) {
      setSessionsByService((current) => ({ ...current, [id]: n }));
    }
  };

  const commitSessionsFor = (id, raw) => {
    const n = Math.round(Number(raw));
    const clamped =
      raw === '' || !Number.isFinite(n) ? sessionsFor(id) : Math.min(MAX_SESSIONS_PER_SERVICE, Math.max(1, n));
    setSessionsByService((current) => ({ ...current, [id]: clamped }));
    setSessionDrafts((d) => {
      const { [id]: _drop, ...rest } = d;
      return rest;
    });
  };

  // Options carry the price in the label so the dropdown stays as informative
  // as the single <select> it replaced.
  const options = useMemo(
    () =>
      eligible.map((s) => ({
        id: s.id,
        name: `${s.name} — ₹${s.basePrice.toLocaleString('en-IN')} (${s.ticketTier})`,
      })),
    [eligible],
  );

  const perSession = selected.reduce((sum, s) => sum + s.basePrice, 0);
  // Each service is priced on its own run, so a 3 + 2 split costs
  // 3 x priceA + 2 x priceB rather than a flat multiple of the bundle.
  const gross = selected.reduce((sum, s) => sum + s.basePrice * sessionsFor(s.id), 0);
  const totalSessions = selected.reduce((sum, s) => sum + sessionsFor(s.id), 0);
  // Visits is what the patient books and what the session counter counts down.
  const visits = selected.length
    ? sessionMode === 'separate'
      ? totalSessions
      : Math.max(...selected.map((s) => sessionsFor(s.id)))
    : 0;
  const packingDiffers = selected.length > 1 && visits !== totalSessions;
  const maxRun = selected.length ? Math.max(...selected.map((s) => sessionsFor(s.id))) : 0;
  const evenSplit = selected.every((s) => sessionsFor(s.id) === sessionsFor(selected[0]?.id));
  // When every service is on the same count that IS the slider's number, so the
  // label and the thumb follow it. Otherwise the split has no single value and
  // the slider falls back to whatever it was last dragged to. Without this the
  // header read "Sessions: 3" while the only service on the package said 1.
  const sharedCount = selected.length && evenSplit ? sessionsFor(selected[0].id) : null;
  const labelCount = sharedCount ?? sessions;
  const sliderValue = Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, labelCount));
  const savings = Math.round((gross * discount) / 100);
  const net = Math.round(gross - savings);
  // GST sits ON TOP of the package price — the same convention the appointment
  // checkout uses — so the stored price stays pre-tax and a slab change never
  // rewrites what a customer was already quoted.
  const taxAmount = Math.round((net * taxPercent) / 100);
  const payable = net + taxAmount;
  const validityLabel = VALIDITY_OPTIONS.find((o) => o.value === validity)?.label || 'No expiry';
  const minSellByDate = todayDateInput();

  const pitch = selected.length
    ? `${selected.map((s) => `${s.name} × ${sessionsFor(s.id)}`).join(' + ')} (${totalSessions} sessions) = ${formatMoney(payable, { maximumFractionDigits: 0 })}${taxPercent ? ' incl. tax' : ''} (${discount}% off)${validity ? `, valid ${validityLabel.toLowerCase()}` : ''}`
    : '';

  const copyPitch = async () => {
    if (!pitch) return;
    try {
      const { copyToClipboard } = await import('../../../utils/clipboard');
      await copyToClipboard(pitch);
      setCopied(true);
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      notify.error('Could not copy');
    }
  };

  const savePackage = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      notify.error('Give the package a name before saving');
      return;
    }
    if (!selected.length) {
      notify.error('Select at least one service');
      return;
    }
    if (isPastDateInput(sellByDate, minSellByDate)) {
      notify.error('Sell-by date cannot be in the past');
      return;
    }
    setSaving(true);
    try {
      // Saved as a draft: isPublic defaults to false server-side, so a bundle
      // is published deliberately from the Active Packages tab and nothing
      // reaches customers by accident.
      const created = await fetchApi('/api/wellness/packages', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          serviceIds: selected.map((s) => s.id),
          serviceSessions: Object.fromEntries(selected.map((s) => [s.id, sessionsFor(s.id)])),
          sessionMode,
          sessions,
          discountPercent: discount,
          taxPercent,
          validityDays: validity === '' ? null : Number(validity),
          sellByDate: sellByDate || null,
        }),
      });
      notify.success(`"${trimmed}" saved — publish it from Active Packages`);
      setName('');
      onSaved?.(created);
    } catch (err) {
      notify.error(err?.message || 'Could not save the package');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="package-builder-anchor" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
      <div className="glass" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
          <Package size={16} /> Build a package
        </h2>

        <label style={labelStyle} htmlFor="package-name">Package name</label>
        <input
          id="package-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Glow Season Bundle"
          style={inputStyle}
          data-testid="package-name-input"
        />

        <label style={{ ...labelStyle, marginTop: '1rem' }}>
          Services {selected.length > 0 && <strong>({selected.length} selected)</strong>}
        </label>
        {eligible.length === 0 ? (
          <div style={{ ...inputStyle, color: 'var(--text-secondary)' }}>No services available</div>
        ) : (
          <div data-testid="package-service-select">
            <MultiSelectDropdown
              categories={options}
              categoriesLoading={false}
              selectedIds={selectedIds}
              onChange={setSelectedIds}
              placeholder="Select services…"
            />
          </div>
        )}

        {/* Removable chips: with several services bundled, the collapsed
            dropdown label truncates, so the selection needs to stay visible
            and individually removable. */}
        {selected.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.6rem' }}>
            {selected.map((s) => (
              <span
                key={s.id}
                data-testid={`package-service-chip-${s.id}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.2rem 0.5rem',
                  borderRadius: 999,
                  fontSize: '0.72rem',
                  background: 'var(--subtle-bg-3)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  maxWidth: '100%',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {/* How many times THIS treatment runs. The slider above sets
                    them all at once; this is where a 3 + 2 split is made. */}
                <input
                  type="number"
                  min={1}
                  max={MAX_SESSIONS_PER_SERVICE}
                  step={1}
                  value={draftFor(s.id)}
                  aria-label={`Sessions of ${s.name}`}
                  data-testid={`package-service-sessions-${s.id}`}
                  onChange={(e) => typeSessionsFor(s.id, e.target.value)}
                  onBlur={(e) => commitSessionsFor(s.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  style={{
                    width: '3.4rem',
                    padding: '0.15rem 0.3rem',
                    // --input-bg is the themed field surface; --bg-color is the
                    // PAGE behind everything, which made the box vanish into
                    // the chip in light mode.
                    background: 'var(--input-bg)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 5,
                    color: 'var(--text-primary)',
                    fontSize: '0.72rem',
                    textAlign: 'center',
                  }}
                />
                <button
                  type="button"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => setSelectedIds((ids) => ids.filter((id) => id !== s.id))}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    display: 'flex',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* This label belongs to the SLIDER, so it says the slider's own value.
            Reading "Sessions: 16" above a thumb sitting on 8 is what made this
            confusing — the totals moved to their own line under the track. */}
        <label
          style={{ ...labelStyle, marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
        >
          {selected.length > 1 ? 'Set every service to' : 'Sessions'}:{' '}
          <strong data-testid="package-sessions-each">{labelCount}</strong>
          <Hint
            testId="package-sessions-hint"
            text={
              selected.length > 1
                ? 'Dragging this sets every service to the same number of runs — it overwrites a split. To give each service its own count, type into the box on its chip above.'
                : 'How many times this treatment runs. The customer books one visit per run.'
            }
          />
        </label>
        <input
          type="range"
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={1}
          value={sliderValue}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            setSessions(next);
            // The slider is "sessions each" — it rewrites every count, which
            // is what the single number always meant.
            setSessionsByService((current) => {
              const updated = {};
              for (const id of Object.keys(current)) updated[id] = next;
              return updated;
            });
            // The slider just overwrote every count, so a half-typed box would
            // otherwise keep showing the number it was on.
            setSessionDrafts({});
          }}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
          <span>{SLIDER_MIN}</span>
          <span>{SLIDER_MAX}</span>
        </div>
        {selected.length > 1 && (
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
            Sets every service to the same count. For a split, type the number on each service above.
          </div>
        )}

        {/* The three counts spelled out in one sentence, because "16 sessions"
            and "8 visits" describe the same package and neither alone is
            enough to price it or to book it. */}
        {selected.length > 0 && (
          <div
            data-testid="package-sessions-summary"
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.3rem',
              marginTop: '0.4rem',
              fontSize: '0.72rem',
              color: 'var(--text-secondary)',
            }}
          >
            <span>
              {selected.length > 1 && `${selected.map((s) => sessionsFor(s.id)).join(' + ')} = `}
              <strong data-testid="package-total-sessions" style={{ color: 'var(--text-primary)' }}>
                {totalSessions}
              </strong>{' '}
              {totalSessions === 1 ? 'session' : 'sessions'}
              {selected.length > 1 && ` across ${selected.length} services`}, booked as{' '}
              <strong data-testid="package-visit-count" style={{ color: 'var(--text-primary)' }}>
                {visits}
              </strong>{' '}
              {visits === 1 ? 'visit' : 'visits'}
            </span>
            <Hint
              testId="package-totals-hint"
              text={
                packingDiffers
                  ? `${totalSessions} treatment runs is what the price is built from. They are delivered in ${visits} appointments because the services share a sitting — and it is the appointments the session counter counts down.`
                  : 'Sessions is what the price is built from; visits is what the customer books and what the session counter counts down. Here they are the same number.'
              }
            />
          </div>
        )}

        {/* The same runs, delivered two different ways. 3 + 4 is four visits if
            the services share a sitting, or seven if each gets its own — the
            price is the same, but the patient books a different number of
            appointments, and that is what the session counter counts down. */}
        {selected.length > 1 && (
          <>
            <label style={{ ...labelStyle, marginTop: '1rem' }}>How the sessions are delivered</label>
            <div
              data-testid="package-session-mode"
              style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}
            >
              {[
                {
                  value: 'combined',
                  title: 'Together in one visit',
                  detail: `Each visit covers every service still due — ${maxRun} visit${maxRun === 1 ? '' : 's'}.`,
                },
                {
                  value: 'separate',
                  title: 'One service per visit',
                  detail: `Every run is its own appointment — ${totalSessions} visit${totalSessions === 1 ? '' : 's'}.`,
                },
              ].map((opt) => (
                <label
                  key={opt.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.45rem',
                    padding: '0.4rem 0.5rem',
                    borderRadius: 6,
                    cursor: 'pointer',
                    border: `1px solid ${sessionMode === opt.value ? 'var(--accent-color)' : 'var(--border-color)'}`,
                    background: sessionMode === opt.value ? 'var(--accent-bg)' : 'var(--subtle-bg-2)',
                  }}
                >
                  <input
                    type="radio"
                    name="package-session-mode"
                    value={opt.value}
                    checked={sessionMode === opt.value}
                    data-testid={`package-session-mode-${opt.value}`}
                    onChange={() => setSessionMode(opt.value)}
                    style={{ marginTop: '0.15rem' }}
                  />
                  <span>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{opt.title}</span>
                    <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                      {opt.detail}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        <label style={{ ...labelStyle, marginTop: '1rem' }}>
          Discount: <strong>{discount}%</strong>
        </label>
        <input
          type="range"
          min={0}
          max={50}
          step={1}
          value={discount}
          onChange={(e) => setDiscount(parseInt(e.target.value, 10))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
          <span>0%</span>
          <span>50%</span>
        </div>

        <label style={{ ...labelStyle, marginTop: '1rem' }}>Select tax</label>
        <div data-testid="package-tax-select">
          <SingleSelectDropdown
            value={taxPercent}
            onChange={setTaxPercent}
            options={TAX_OPTIONS}
          />
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
          Added on top at checkout; the saved price stays pre-tax.
        </div>

        <label style={{ ...labelStyle, marginTop: '1rem' }}>Package validity</label>
        <div data-testid="package-validity-select">
          <SingleSelectDropdown
            value={validity}
            onChange={setValidity}
            options={VALIDITY_OPTIONS}
          />
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
          How long the customer has to use the sessions after buying.
        </div>

        <label style={{ ...labelStyle, marginTop: '1rem' }} htmlFor="package-sell-by">
          Package sell-by date
        </label>
        <input
          id="package-sell-by"
          type="date"
          value={sellByDate}
          onChange={(e) => setSellByDate(e.target.value)}
          min={minSellByDate}
          style={inputStyle}
          data-testid="package-sell-by-input"
        />
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
          Last day it can be sold. After this the customer catalog stops listing it.
        </div>
      </div>

      <div className="glass" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>Package summary</h2>

        {selected.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Pick one or more services to see pricing.</div>
        ) : (
          <>
            {/* Itemise only when bundling — a single service reads better as
                the plain "Per session" row it always was. */}
            {/* Itemised per service, because that is now how it is priced:
                each treatment runs its own number of times. */}
            {/* One service needs no itemisation — its line would just repeat
                the gross total. */}
            {selected.length > 1 &&
              selected.map((s) => (
                <Row key={s.id} label={`${s.name} × ${sessionsFor(s.id)}`} muted>
                  ₹{(s.basePrice * sessionsFor(s.id)).toLocaleString('en-IN')}
                </Row>
              ))}
            {/* Only meaningful when every service runs the same number of
                times — with a 3 + 2 split there is no single "session". */}
            {evenSplit && (
              <Row label={selected.length > 1 ? `Per session (${selected.length} services)` : 'Per session'}>
                ₹{perSession.toLocaleString('en-IN')}
              </Row>
            )}
            <Row label={evenSplit ? 'Sessions' : 'Total sessions'}>{totalSessions}</Row>
            {/* Runs and visits part company as soon as services share a
                sitting, and the second number is the one the patient books. */}
            {packingDiffers && (
              <Row label="Visits to book" muted>
                <span data-testid="package-visits">{visits}</span>
              </Row>
            )}
            <Row label="Gross total">₹{gross.toLocaleString('en-IN')}</Row>
            <Row label={`Discount (${discount}%)`} negative>
              − ₹{savings.toLocaleString('en-IN')}
            </Row>
            <div
              style={{
                borderTop: '1px solid var(--border-color)',
                paddingTop: '0.75rem',
                marginTop: '0.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                {taxPercent ? 'Package price (pre-tax)' : 'Package price'}
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--accent-color)' }}>
                ₹{net.toLocaleString('en-IN')}
              </div>
            </div>

            {taxPercent > 0 && (
              <>
                <Row label={`Tax (${taxPercent}%)`}>+ ₹{taxAmount.toLocaleString('en-IN')}</Row>
                <Row label="Customer pays">
                  <strong>₹{payable.toLocaleString('en-IN')}</strong>
                </Row>
              </>
            )}

            {(validity || sellByDate) && (
              <div style={{ display: 'grid', gap: '0.35rem', paddingTop: '0.5rem' }}>
                {validity && <Row label="Valid for" muted>{validityLabel}</Row>}
                {sellByDate && <Row label="Sell by" muted>{sellByDate}</Row>}
              </div>
            )}

            <div
              style={{
                marginTop: '0.5rem',
                padding: '0.75rem',
                background: 'var(--subtle-bg)',
                borderRadius: 8,
                fontSize: '0.85rem',
                fontStyle: 'italic',
                color: 'var(--text-secondary)',
              }}
            >
              “{pitch}”
            </div>

            <button
              onClick={copyPitch}
              style={{
                marginTop: '0.25rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.4rem',
                padding: '0.6rem 1rem',
                background: copied ? 'var(--success-color)' : 'var(--accent-color)',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied!' : 'Copy pitch'}
            </button>

            <button
              onClick={savePackage}
              disabled={saving}
              data-testid="package-save"
              className="btn-secondary"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.4rem',
                padding: '0.6rem 1rem',
                fontWeight: 600,
              }}
            >
              {saving ? (
                <>
                  <Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Saving…
                </>
              ) : (
                <>
                  <Save size={15} /> Save package
                </>
              )}
            </button>

            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
              Saved packages start as drafts — publish them from Active Packages
              to list them for customers.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
