import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Plus,
  MapPin,
  Clock,
  IndianRupee,
  Package,
  Copy,
  Check,
  Pencil,
  Trash2,
  X,
  Save,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';

const tierColor = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' };

export default function Services() {
  const [tab, setTab] = useState('catalog'); // catalog | packages
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'aesthetics', ticketTier: 'medium', basePrice: 0, durationMin: 60, targetRadiusKm: 30, description: '' });

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/services').then(setServices).catch(() => setServices([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/wellness/services', { method: 'POST', body: JSON.stringify(form) });
      setShowAdd(false);
      setForm({ name: '', category: 'aesthetics', ticketTier: 'medium', basePrice: 0, durationMin: 60, targetRadiusKm: 30, description: '' });
      load();
    } catch (err) { alert(`Failed: ${err.message}`); }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={24} /> Service catalog
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Each service has a price, duration, and target marketing radius.</p>
        </div>
        {tab === 'catalog' && (
          <button onClick={() => setShowAdd(!showAdd)} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            <Plus size={16} /> {showAdd ? 'Cancel' : 'New service'}
          </button>
        )}
      </header>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <TabBtn active={tab === 'catalog'} onClick={() => setTab('catalog')} icon={Sparkles} label="Catalog" />
        <TabBtn active={tab === 'packages'} onClick={() => setTab('packages')} icon={Package} label="Packages" />
      </div>

      {tab === 'catalog' && (
        <CatalogTab
          services={services}
          loading={loading}
          showAdd={showAdd}
          form={form}
          setForm={setForm}
          submit={submit}
          onChanged={load}
        />
      )}

      {tab === 'packages' && <PackageBuilder services={services} />}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0.6rem 1rem',
        background: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        cursor: 'pointer',
        fontSize: '0.9rem',
        fontWeight: 500,
      }}
    >
      <Icon size={15} /> {label}
    </button>
  );
}

function CatalogTab({ services, loading, showAdd, form, setForm, submit, onChanged }) {
  return (
    <>
      {/* Visually-hidden section heading so screen readers see h1 -> h2 hierarchy
          before the per-service h3 cards (a11y: heading-order). */}
      <h2 style={srOnly}>Available services</h2>
      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' }}>
          <input placeholder="Service name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inputStyle}>
            {['hair', 'skin', 'aesthetics', 'slimming', 'ayurveda', 'salon'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={form.ticketTier} onChange={(e) => setForm({ ...form, ticketTier: e.target.value })} style={inputStyle}>
            <option value="low">Low tier</option>
            <option value="medium">Medium tier</option>
            <option value="high">High tier</option>
          </select>
          <input type="number" placeholder="Base price ₹" value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: parseFloat(e.target.value) || 0 })} style={inputStyle} />
          <input type="number" placeholder="Duration (min)" value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: parseInt(e.target.value) || 30 })} style={inputStyle} />
          <input type="number" placeholder="Target radius (km, blank = unlimited)" value={form.targetRadiusKm || ''} onChange={(e) => setForm({ ...form, targetRadiusKm: e.target.value ? parseInt(e.target.value) : null })} style={inputStyle} />
          <button type="submit" style={{ padding: '0.5rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', gridColumn: 'span 2' }}>Save</button>
        </form>
      )}

      {loading && <div>Loading…</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {services.map((s) => (
          <ServiceCard key={s.id} service={s} onChanged={onChanged} />
        ))}
      </div>
    </>
  );
}

function ServiceCard({ service, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(service);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await fetchApi(`/api/wellness/services/${service.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: draft.name, category: draft.category, ticketTier: draft.ticketTier,
          basePrice: parseFloat(draft.basePrice) || 0,
          durationMin: parseInt(draft.durationMin) || 30,
          targetRadiusKm: draft.targetRadiusKm ? parseInt(draft.targetRadiusKm) : null,
          description: draft.description || null,
          isActive: draft.isActive !== false,
        }),
      });
      setEditing(false);
      onChanged && onChanged();
    } catch (err) { alert(`Save failed: ${err.message}`); }
    setSaving(false);
  };

  const remove = async () => {
    if (!confirm(`Deactivate "${service.name}"? It won't show in the catalog or booking page.`)) return;
    try {
      await fetchApi(`/api/wellness/services/${service.id}`, {
        method: 'PUT', body: JSON.stringify({ isActive: false }),
      });
      onChanged && onChanged();
    } catch (err) { alert(`Failed: ${err.message}`); }
  };

  if (editing) {
    return (
      <div className="glass" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} placeholder="Service name" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
          <select value={draft.category || ''} onChange={(e) => setDraft({ ...draft, category: e.target.value })} style={inputStyle}>
            {['hair', 'hair-transplant', 'hair-restoration', 'hair-concern', 'skin', 'skin-surgery', 'aesthetics', 'anti-ageing', 'pigmentation', 'medifacial', 'under-eye', 'acne', 'laser-hair', 'laser-skin', 'body-contouring', 'slimming', 'ayurveda', 'salon'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={draft.ticketTier} onChange={(e) => setDraft({ ...draft, ticketTier: e.target.value })} style={inputStyle}>
            <option value="low">Low tier</option><option value="medium">Medium tier</option><option value="high">High tier</option>
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
          <input type="number" value={draft.basePrice} onChange={(e) => setDraft({ ...draft, basePrice: e.target.value })} style={inputStyle} placeholder="₹ price" />
          <input type="number" value={draft.durationMin} onChange={(e) => setDraft({ ...draft, durationMin: e.target.value })} style={inputStyle} placeholder="min" />
          <input type="number" value={draft.targetRadiusKm || ''} onChange={(e) => setDraft({ ...draft, targetRadiusKm: e.target.value })} style={inputStyle} placeholder="km radius" />
        </div>
        <textarea value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Description" />
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={save} disabled={saving} style={{ flex: 1, padding: '0.5rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => { setEditing(false); setDraft(service); }} style={{ padding: '0.5rem 0.75rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass" style={{ padding: '1.25rem', position: 'relative' }}>
      <div style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', display: 'flex', gap: '0.25rem' }}>
        <button onClick={() => setEditing(true)} title="Edit" style={iconBtn}><Pencil size={12} /></button>
        <button onClick={remove} title="Deactivate" style={{ ...iconBtn, color: 'var(--danger-color)' }}><Trash2 size={12} /></button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem', paddingRight: '3rem' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{service.category}</div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.15rem' }}>{service.name}</h3>
        </div>
        <span style={{ background: tierColor[service.ticketTier], color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600 }}>
          {service.ticketTier}
        </span>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <span><IndianRupee size={12} style={{ verticalAlign: 'middle' }} /> {service.basePrice.toLocaleString('en-IN')}</span>
        <span><Clock size={12} style={{ verticalAlign: 'middle' }} /> {service.durationMin} min</span>
        <span><MapPin size={12} style={{ verticalAlign: 'middle' }} /> {service.targetRadiusKm ? `${service.targetRadiusKm} km` : 'Unlimited'}</span>
      </div>
      {service.description && <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', lineHeight: 1.4 }}>{service.description}</p>}
    </div>
  );
}

const iconBtn = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)', padding: '0.25rem', borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };

function PackageBuilder({ services }) {
  // Prefer high-tier services for packages, fall back to all.
  const eligible = useMemo(() => {
    const hi = services.filter((s) => s.ticketTier === 'high');
    return hi.length ? hi : services;
  }, [services]);

  const [serviceId, setServiceId] = useState('');
  const [sessions, setSessions] = useState(6);
  const [discount, setDiscount] = useState(15);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!serviceId && eligible.length) setServiceId(String(eligible[0].id));
  }, [eligible, serviceId]);

  const service = eligible.find((s) => String(s.id) === String(serviceId));
  const gross = service ? service.basePrice * sessions : 0;
  const savings = Math.round((gross * discount) / 100);
  const net = Math.round(gross - savings);

  const pitch = service
    ? `${service.name} × ${sessions} sessions = ₹${net.toLocaleString('en-IN')} (${discount}% off)`
    : '';

  const copyPitch = async () => {
    if (!pitch) return;
    try {
      await navigator.clipboard.writeText(pitch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback — legacy textarea copy
      const ta = document.createElement('textarea');
      ta.value = pitch;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        alert('Could not copy');
      }
      ta.remove();
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
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

function Row({ label, children, negative }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: negative ? '#f59e0b' : 'var(--text-primary)' }}>{children}</span>
    </div>
  );
}

const inputStyle = { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', width: '100%', boxSizing: 'border-box' };

const labelStyle = {
  display: 'block',
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.35rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

// Visually-hidden style for screen-reader-only headings (a11y heading hierarchy).
const srOnly = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
