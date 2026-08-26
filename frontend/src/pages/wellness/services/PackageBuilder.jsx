import { useEffect, useMemo, useRef, useState } from 'react';
import { Package, Copy, Check, X, Save, Loader } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { formatMoney } from '../../../utils/money';
import { inputStyle, labelStyle } from './shared';
import MultiSelectDropdown from './MultiSelectDropdown';
import SingleSelectDropdown from './SingleSelectDropdown';

// GST slabs a clinic actually charges. The column takes any 0-100 rate, so a
// slab change here does not need a migration.
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
  const gross = perSession * sessions;
  const savings = Math.round((gross * discount) / 100);
  const net = Math.round(gross - savings);
  // GST sits ON TOP of the package price — the same convention the appointment
  // checkout uses — so the stored price stays pre-tax and a slab change never
  // rewrites what a customer was already quoted.
  const taxAmount = Math.round((net * taxPercent) / 100);
  const payable = net + taxAmount;
  const validityLabel = VALIDITY_OPTIONS.find((o) => o.value === validity)?.label || 'No expiry';

  const pitch = selected.length
    ? `${selected.map((s) => s.name).join(' + ')} × ${sessions} sessions = ${formatMoney(payable, { maximumFractionDigits: 0 })}${taxPercent ? ' incl. tax' : ''} (${discount}% off)${validity ? `, valid ${validityLabel.toLowerCase()}` : ''}`
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

        <label style={{ ...labelStyle, marginTop: '1rem' }}>
          Sessions: <strong>{sessions}</strong>
        </label>
        <input
          type="range"
          min={2}
          max={12}
          step={1}
          value={sessions}
          onChange={(e) => setSessions(parseInt(e.target.value, 10))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
          <span>2</span>
          <span>12</span>
        </div>

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
            {selected.length > 1 &&
              selected.map((s) => (
                <Row key={s.id} label={s.name} muted>
                  ₹{s.basePrice.toLocaleString('en-IN')}
                </Row>
              ))}
            <Row label={selected.length > 1 ? `Per session (${selected.length} services)` : 'Per session'}>
              ₹{perSession.toLocaleString('en-IN')}
            </Row>
            <Row label="Sessions">{sessions}</Row>
            <Row label="Gross total">₹{gross.toLocaleString('en-IN')}</Row>
            <Row label={`Discount (${discount}%)`} negative>
              − ₹{savings.toLocaleString('en-IN')}
            </Row>
            <div
              style={{
                borderTop: '1px solid rgba(255,255,255,0.08)',
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
                background: 'rgba(255,255,255,0.04)',
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
