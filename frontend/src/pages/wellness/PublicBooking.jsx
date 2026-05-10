import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Sparkles, Clock, MapPin, IndianRupee, CheckCircle2, Home, Video, Phone, Building2 } from 'lucide-react';
import { useFormAutosave } from '../../utils/useFormAutosave';

const INITIAL_FORM = {
  name: '', phone: '', email: '', notes: '', preferredSlot: '',
  // Wave 2 Agent LL — booking-widget completion (2026-05-08 Google Doc audit).
  // bookingType selector + at-home address fields. Default to CLINIC_VISIT
  // so legacy "just submit the form" flow still works on existing services
  // whose supportedBookingTypes is null.
  bookingType: 'CLINIC_VISIT',
  atHomeAddress: '', atHomeCity: '', atHomePincode: '',
  // Wave 8b — optional Resource (room/chair/equipment) preference for
  // CLINIC_VISIT bookings. Empty string = "no preference" (server stores
  // null). The widget hides the picker when the tenant has no resources.
  resourceId: '',
};

// Booking-type metadata (icon + label + description) — kept here next to the
// initial form so adding a new variant is a single-file edit.
const BOOKING_TYPE_META = {
  CLINIC_VISIT: { label: 'Clinic visit',  icon: Building2, hint: 'Visit our clinic at the chosen location' },
  IN_HOME:      { label: 'At home',       icon: Home,      hint: 'Our staff travels to your address' },
  VIDEO:        { label: 'Video consult', icon: Video,     hint: "We'll send you a video link" },
  PHONE:        { label: 'Phone consult', icon: Phone,     hint: "We'll call you on the number above" },
};

export default function PublicBooking() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [step, setStep] = useState('service');
  const [picked, setPicked] = useState({ service: null, location: null });
  // #239 — partial form state must survive a mid-form refresh. Keying the
  // autosave by tenant slug keeps drafts from leaking between clinics.
  const [form, setForm, , clearDraft] = useFormAutosave(`public-booking.${slug || 'default'}`, INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);
  // Wave 2 Agent LL — UTM capture from the URL on mount. Hidden form fields,
  // no UI surface (the patient doesn't need to know we're capturing them).
  // Each utm_* search-param maps 1:1 onto the API's utm.* object key. The
  // HTTP Referer header is captured server-side as a fallback; capturing
  // document.referrer here lets us pin the original referring page even
  // when the user navigated via a multi-hop redirect (server-side Referer
  // would be the last hop, not the original campaign source).
  const [utm, setUtm] = useState({});
  const [referrer, setReferrer] = useState('');

  useEffect(() => {
    fetch(`/api/wellness/public/tenant/${slug}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then(setProfile)
      .catch(() => setError('Clinic not found.'))
      .finally(() => setLoading(false));
  }, [slug]);

  // Wave 2 Agent LL — capture UTM + referrer once on mount. Runs in a
  // separate effect from the catalog fetch so an autosaved-draft hydration
  // doesn't blow away the captured UTM. URL params win even on refresh
  // (the click-through campaign carries them on every page hit).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const next = {
        utmSource:   params.get('utm_source')   || null,
        utmMedium:   params.get('utm_medium')   || null,
        utmCampaign: params.get('utm_campaign') || null,
        utmTerm:     params.get('utm_term')     || null,
        utmContent:  params.get('utm_content')  || null,
      };
      // Only persist into state if at least one field is populated — keeps
      // the JSON payload tidy for organic visits (no utm fields = no key
      // sent server-side, server handles the empty case).
      const hasAny = Object.values(next).some(Boolean);
      if (hasAny) setUtm(next);
      if (typeof document !== 'undefined' && document.referrer) {
        setReferrer(document.referrer);
      }
    } catch (_e) {
      // No URLSearchParams in some legacy environments — skip silently.
    }
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      // Wave 2 Agent LL — build the request body with bookingType + at-home
      // fields gated on the chosen channel. Sending atHomeAddress on a
      // CLINIC_VISIT booking is harmless (the server just ignores it
      // outside IN_HOME), but keeping the payload tight makes the network
      // tab easier to debug and shrinks the rate-limited body size.
      const payload = {
        tenantSlug: slug,
        serviceId: picked.service.id,
        locationId: picked.location?.id || null,
        name: form.name,
        phone: form.phone,
        email: form.email,
        notes: form.notes,
        preferredSlot: form.preferredSlot,
        bookingType: form.bookingType || 'CLINIC_VISIT',
      };
      if (form.bookingType === 'IN_HOME') {
        payload.atHomeAddress = form.atHomeAddress;
        payload.atHomeCity = form.atHomeCity;
        payload.atHomePincode = form.atHomePincode;
      }
      // Wave 8b — only attach resourceId on CLINIC_VISIT bookings (rooms
      // / chairs only matter when the patient comes to the clinic). Empty
      // string → server stores null.
      if (form.bookingType === 'CLINIC_VISIT' && form.resourceId) {
        payload.resourceId = parseInt(form.resourceId, 10);
      }
      // Attach UTM only when at least one field is populated — keeps the
      // organic-traffic payload identical to pre-Wave-2 shape.
      if (Object.values(utm).some(Boolean)) payload.utm = utm;
      if (referrer) payload.referrer = referrer;

      const res = await fetch('/api/wellness/public/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        setDone(data);
        // #239 — booking succeeded, drop the autosaved draft so a future
        // visit to the same clinic on this device starts clean.
        clearDraft();
      }
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
            {profile.services
              // #218: defensive — hide rows whose price/duration would corrupt
              // the layout (NaN, Infinity, or absurd legacy values from before
              // the #209 caps shipped). The catalog is now bounded server-side
              // but old rows can still survive; render only well-formed ones.
              .filter((s) => {
                const p = Number(s.basePrice);
                const d = Number(s.durationMin);
                return Number.isFinite(p) && p > 0 && p <= 5_000_000
                  && Number.isFinite(d) && d > 0 && d <= 720;
              })
              .slice(0, 30)
              .map((s) => (
              <button key={s.id} onClick={() => { setPicked({ ...picked, service: s }); setStep('location'); }} style={cardBtn}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{s.category}</div>
                <div style={{ fontWeight: 600, marginTop: '0.2rem' }}>{s.name}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.4rem', display: 'flex', gap: '0.7rem' }}>
                  <span><IndianRupee size={12} style={{ verticalAlign: 'middle' }} /> {Number(s.basePrice).toLocaleString('en-IN')}</span>
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
            <strong>{picked.service.name}</strong> at <strong>{picked.location?.name}</strong> — &#8377;{picked.service.basePrice.toLocaleString('en-IN')} &middot; {picked.service.durationMin} min
          </div>

          {/* Wave 2 Agent LL — booking-type chip group. Filtered by the chosen
              service's supportedBookingTypes (legacy services with null column
              fall back to CLINIC_VISIT-only via the public/tenant endpoint).
              Only renders the chip group when there's MORE than one option —
              if the service supports only CLINIC_VISIT, we just lock the
              choice silently to keep the form short. */}
          {(() => {
            const supported = Array.isArray(picked.service?.supportedBookingTypes) && picked.service.supportedBookingTypes.length > 0
              ? picked.service.supportedBookingTypes
              : ['CLINIC_VISIT'];
            // If the autosaved bookingType is no longer supported (e.g. user
            // picked a different service after re-opening the page), reset
            // it to the first supported option silently.
            const current = supported.includes(form.bookingType) ? form.bookingType : supported[0];
            if (current !== form.bookingType) {
              // Defer the state update to avoid setState-during-render.
              setTimeout(() => setForm({ ...form, bookingType: current }), 0);
            }
            if (supported.length === 1) return null;
            return (
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem' }}>How would you like the appointment?</div>
                <div role="radiogroup" aria-label="Appointment type" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {supported.map((bt) => {
                    const meta = BOOKING_TYPE_META[bt] || { label: bt, icon: Building2, hint: '' };
                    const Icon = meta.icon;
                    const active = current === bt;
                    return (
                      <button
                        key={bt}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setForm({ ...form, bookingType: bt })}
                        style={{
                          padding: '0.5rem 0.85rem', borderRadius: 999,
                          border: `1px solid ${active ? 'var(--primary-color, var(--accent-color))' : PUB_BORDER}`,
                          background: active ? 'rgba(38, 88, 85, 0.1)' : PUB_CARD_BG,
                          color: PUB_TEXT, fontSize: '0.85rem', cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                        }}
                      >
                        <Icon size={14} aria-hidden="true" /> {meta.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'rgba(17,24,39,0.6)', marginTop: '0.3rem' }}>
                  {(BOOKING_TYPE_META[current] || {}).hint || ''}
                </div>
              </div>
            );
          })()}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <input placeholder="Your name *" aria-label="Your name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={input} />
            <input placeholder="Phone (10 digits) *" aria-label="Phone number" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={input} />
          </div>
          <input placeholder="Email (optional)" aria-label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={{ ...input, marginBottom: '0.5rem' }} />

          {/* Wave 2 Agent LL — at-home address fields. Required when
              bookingType=IN_HOME; hidden otherwise. The browser's native
              `required` attribute gives free client-side validation matching
              the server's IN_HOME rules. */}
          {form.bookingType === 'IN_HOME' && (
            <div style={{ marginBottom: '0.5rem', padding: '0.6rem', background: 'rgba(38,88,85,0.06)', borderRadius: 8, border: `1px solid ${PUB_BORDER}` }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.4rem' }}>Where should our staff travel to?</div>
              <textarea
                placeholder="Address line *"
                aria-label="Address line"
                required
                value={form.atHomeAddress}
                onChange={(e) => setForm({ ...form, atHomeAddress: e.target.value })}
                rows={2}
                style={{ ...input, marginBottom: '0.4rem', resize: 'vertical' }}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.4rem' }}>
                <input
                  placeholder="City"
                  aria-label="City"
                  value={form.atHomeCity}
                  onChange={(e) => setForm({ ...form, atHomeCity: e.target.value })}
                  style={input}
                />
                <input
                  placeholder="6-digit pincode *"
                  aria-label="Pincode"
                  required
                  pattern="\d{6}"
                  inputMode="numeric"
                  value={form.atHomePincode}
                  onChange={(e) => setForm({ ...form, atHomePincode: e.target.value })}
                  style={input}
                />
              </div>
            </div>
          )}

          {form.bookingType === 'VIDEO' && (
            <div style={{ marginBottom: '0.5rem', padding: '0.6rem 0.75rem', background: 'rgba(38,88,85,0.06)', borderRadius: 8, fontSize: '0.85rem' }}>
              <Video size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }} aria-hidden="true" />
              You&apos;ll receive a video call link by SMS once we confirm the slot.
            </div>
          )}

          {/* Wave 8b — optional Resource preference for CLINIC_VISIT bookings.
              Filtered to the picked location (or unscoped resources) so the
              patient never sees rooms from a different clinic. Empty list →
              picker is hidden entirely (tenant has no resources defined). */}
          {form.bookingType === 'CLINIC_VISIT' && Array.isArray(profile?.resources) && profile.resources.length > 0 && (() => {
            const locId = picked.location?.id || null;
            const filtered = profile.resources.filter((r) => r.locationId == null || r.locationId === locId);
            if (filtered.length === 0) return null;
            return (
              <div style={{ marginBottom: '0.75rem' }}>
                <label htmlFor="pb-resource" style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>
                  Preferred room (optional)
                </label>
                <select
                  id="pb-resource"
                  aria-label="Preferred room or resource"
                  value={form.resourceId}
                  onChange={(e) => setForm({ ...form, resourceId: e.target.value })}
                  style={input}
                >
                  <option value="">No preference</option>
                  {filtered.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}{r.type && r.type !== 'ROOM' ? ` (${r.type.toLowerCase()})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            );
          })()}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <input type="datetime-local" aria-label="Preferred slot" value={form.preferredSlot} onChange={(e) => setForm({ ...form, preferredSlot: e.target.value })} style={input} />
            <input placeholder="Anything we should know? (optional)" aria-label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={input} />
          </div>
          {error && <div style={{ color: 'var(--danger-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between' }}>
            <button type="button" onClick={() => setStep('location')} style={{ padding: '0.55rem 1rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, cursor: 'pointer' }}>&larr; Back</button>
            <button type="submit" disabled={submitting} style={{ padding: '0.55rem 1.5rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 500 }}>
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
