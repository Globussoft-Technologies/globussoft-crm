import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Sparkles, Clock, MapPin, IndianRupee, CheckCircle2 } from 'lucide-react';

export default function PublicBooking() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [step, setStep] = useState('service');
  const [picked, setPicked] = useState({ service: null, location: null });
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '', preferredSlot: '' });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    fetch(`/api/wellness/public/tenant/${slug}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then(setProfile)
      .catch(() => setError('Clinic not found.'))
      .finally(() => setLoading(false));
  }, [slug]);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/wellness/public/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantSlug: slug,
          serviceId: picked.service.id,
          locationId: picked.location?.id || null,
          ...form,
        }),
      });
      const data = await res.json();
      if (res.ok) setDone(data);
      else setError(data.error || 'Booking failed');
    } catch (err) { setError('Network error.'); }
    setSubmitting(false);
  };

  if (loading) return <FullPage>Loading…</FullPage>;
  if (error && !profile) return <FullPage>{error}</FullPage>;

  if (done) {
    return (
      <FullPage>
        <div className="glass" style={confirmCard}>
          <CheckCircle2 size={48} color="var(--success-color)" style={{ marginBottom: '1rem' }} />
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.5rem' }}>Booking confirmed</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Hi {done.patient?.name}, your appointment for <strong>{picked.service.name}</strong> is provisionally booked. Our team will call you on <strong>{form.phone}</strong> to confirm the slot.
          </p>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Reference: visit #{done.visit?.id}
          </div>
        </div>
      </FullPage>
    );
  }

  return (
    <FullPage>
      <header style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600 }}>{profile.tenant.name}</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Book your appointment</p>
      </header>

      {step === 'service' && (
        <>
          <h3 style={sectionH}>1. Pick a service</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.75rem' }}>
            {profile.services.slice(0, 30).map((s) => (
              <button key={s.id} onClick={() => { setPicked({ ...picked, service: s }); setStep('location'); }} style={cardBtn}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{s.category}</div>
                <div style={{ fontWeight: 600, marginTop: '0.2rem' }}>{s.name}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.4rem', display: 'flex', gap: '0.7rem' }}>
                  <span><IndianRupee size={12} style={{ verticalAlign: 'middle' }} /> {s.basePrice.toLocaleString('en-IN')}</span>
                  <span><Clock size={12} style={{ verticalAlign: 'middle' }} /> {s.durationMin} min</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 'location' && (
        <>
          <h3 style={sectionH}>2. Pick a clinic</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.75rem' }}>
            {profile.locations.map((l) => (
              <button key={l.id} onClick={() => { setPicked({ ...picked, location: l }); setStep('details'); }} style={cardBtn}>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <MapPin size={14} /> {l.name}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.3rem', lineHeight: 1.4 }}>
                  {l.addressLine}, {l.city}{l.pincode ? ` ${l.pincode}` : ''}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 'details' && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.5rem' }}>
          <h3 style={sectionH}>3. Your details</h3>
          <div style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.3)', padding: '0.75rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.85rem' }}>
            <Sparkles size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }} />
            <strong>{picked.service.name}</strong> at <strong>{picked.location?.name}</strong> — ₹{picked.service.basePrice.toLocaleString('en-IN')} · {picked.service.durationMin} min
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <input placeholder="Your name *" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={input} />
            <input placeholder="Phone (10 digits) *" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={input} />
          </div>
          <input placeholder="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={{ ...input, marginBottom: '0.5rem' }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <input type="datetime-local" value={form.preferredSlot} onChange={(e) => setForm({ ...form, preferredSlot: e.target.value })} style={input} />
            <input placeholder="Anything we should know? (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={input} />
          </div>
          {error && <div style={{ color: 'var(--danger-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between' }}>
            <button type="button" onClick={() => setStep('location')} style={{ padding: '0.55rem 1rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, cursor: 'pointer' }}>← Back</button>
            <button type="submit" disabled={submitting} style={{ padding: '0.55rem 1.5rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 500 }}>
              {submitting ? 'Booking…' : 'Confirm booking'}
            </button>
          </div>
        </form>
      )}
    </FullPage>
  );
}

// Public booking is shown to cold visitors who have no authenticated theme
// context, so the page hardcodes its own palette instead of inheriting
// --app-bg / --text-primary (which were producing dark-on-dark text and
// failing axe contrast on /book/:slug). Colors: cream bg + deep teal text,
// ~18:1 contrast (WCAG AAA).
const PUB_BG       = '#FDF6EC';
const PUB_TEXT     = '#111827';
const PUB_CARD_BG  = '#ffffff';
const PUB_BORDER   = 'rgba(17, 24, 39, 0.12)';

function FullPage({ children }) {
  return (
    <div style={{ minHeight: '100vh', padding: '2rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', background: PUB_BG, color: PUB_TEXT }}>
      <div style={{ width: '100%', maxWidth: '880px' }}>{children}</div>
    </div>
  );
}

const sectionH = { fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: PUB_TEXT };
const cardBtn = { padding: '1rem', background: PUB_CARD_BG, border: `1px solid ${PUB_BORDER}`, borderRadius: 12, cursor: 'pointer', textAlign: 'left', color: PUB_TEXT, transition: 'all 0.15s' };
const input = { padding: '0.6rem 0.75rem', background: PUB_CARD_BG, border: `1px solid ${PUB_BORDER}`, borderRadius: 8, color: PUB_TEXT, fontSize: '0.9rem', outline: 'none', width: '100%' };
const confirmCard = { padding: '2.5rem', textAlign: 'center', maxWidth: '520px', margin: '4rem auto' };
