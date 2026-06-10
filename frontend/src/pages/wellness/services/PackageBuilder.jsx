import { useEffect, useMemo, useRef, useState } from 'react';
import { Package, Copy, Check } from 'lucide-react';
import { useNotify } from '../../../utils/notify';
import { formatMoney } from '../../../utils/money';
import { inputStyle, labelStyle } from './shared';

function Row({ label, children, negative }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: negative ? '#f59e0b' : 'var(--text-primary)' }}>{children}</span>
    </div>
  );
}

export default function PackageBuilder({ services }) {
  const notify = useNotify();
  // Prefer high-tier services for packages, fall back to all.
  const eligible = useMemo(() => {
    const hi = services.filter((s) => s.ticketTier === 'high');
    return hi.length ? hi : services;
  }, [services]);

  const [serviceId, setServiceId] = useState('');
  const [sessions, setSessions] = useState(6);
  const [discount, setDiscount] = useState(15);
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef(null);

  useEffect(() => {
    if (!serviceId && eligible.length) setServiceId(String(eligible[0].id));
  }, [eligible, serviceId]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  const service = eligible.find((s) => String(s.id) === String(serviceId));
  const gross = service ? service.basePrice * sessions : 0;
  const savings = Math.round((gross * discount) / 100);
  const net = Math.round(gross - savings);

  const pitch = service
    ? `${service.name} × ${sessions} sessions = ${formatMoney(net, { maximumFractionDigits: 0 })} (${discount}% off)`
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

  return (
    <div id="package-builder-anchor" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
      <div className="glass" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
          <Package size={16} /> Build a package
        </h2>

        <label style={labelStyle}>Service</label>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputStyle}>
          {eligible.length === 0 && <option value="">No services available</option>}
          {eligible.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — ₹{s.basePrice.toLocaleString('en-IN')} ({s.ticketTier})
            </option>
          ))}
        </select>

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
      </div>

      <div className="glass" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>Package summary</h2>

        {!service ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Pick a service to see pricing.</div>
        ) : (
          <>
            <Row label="Per session">₹{service.basePrice.toLocaleString('en-IN')}</Row>
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
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Package price</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--accent-color)' }}>
                ₹{net.toLocaleString('en-IN')}
              </div>
            </div>

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

            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
              Packages are computed on the fly — no DB record is created.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
