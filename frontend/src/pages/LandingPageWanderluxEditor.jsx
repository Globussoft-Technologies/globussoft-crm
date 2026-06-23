/**
 * LandingPageWanderluxEditor.jsx — full schema-matched editor for
 * wanderlux-v1 pages (2026-06-23, expanded).
 *
 * Covers every editable section the reference's `landing-page.dc.html`
 * understands: brand, hero, countdown, cities (marquee), video (with
 * upload), intro, highlights (flip cards), safety, investment, register,
 * faqs, finalCta, footer. Every image/video field has both a URL input
 * AND an Upload button that talks to /api/landing-pages/upload (image)
 * or /api/landing-pages/upload-video (video). Bottom of the editor has
 * a Raw JSON escape hatch for any field the form doesn't cover.
 *
 * Builder routes wanderlux-v1 pages here via the
 * `page.templateType === 'wanderlux-v1'` check in LandingPageBuilder.jsx.
 */

import React, { useState } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const sectionStyle = {
  marginBottom: '1.2rem',
  padding: '1rem 1.2rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
};
const sectionTitleStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: '0.9rem',
  fontWeight: 600,
  margin: 0,
};
const labelStyle = {
  display: 'block',
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-secondary)',
  margin: '0.7rem 0 0.3rem',
  fontWeight: 600,
};
const inputStyle = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  background: 'var(--bg-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
};
const textAreaStyle = { ...inputStyle, minHeight: '5rem', resize: 'vertical', fontFamily: 'inherit' };
const subItemStyle = {
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  padding: '0.7rem 0.85rem',
  marginBottom: '0.55rem',
  background: 'var(--bg-color)',
};

function TextField({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input type="text" style={inputStyle} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 3 }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <textarea style={{ ...textAreaStyle, minHeight: `${rows * 1.4}rem` }} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function NumberField({ label, value, onChange, min, max }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input type="number" style={inputStyle} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} min={min} max={max} />
    </div>
  );
}

/**
 * URL input + Upload button. Used for hero image, city images, flip-card
 * images, brand logo, etc. Hits the existing /api/landing-pages/upload
 * route; the returned URL is set into the value via onChange.
 */
function ImageField({ label, value, onChange, placeholder }) {
  const notify = useNotify();
  const [uploading, setUploading] = useState(false);
  const inputRef = React.useRef(null);
  const handleFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) {
      notify.error('Pick an image file');
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      notify.error('Image too large (max 5 MB)');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', f);
      const res = await fetchApi('/api/landing-pages/upload', { method: 'POST', body: fd });
      if (res && res.url) {
        onChange(res.url);
        notify.success('Image uploaded');
      }
    } catch (_e) {
      notify.error('Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input type="text" style={{ ...inputStyle, flex: 1 }} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'https://… or /uploads/…'} />
        <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
        <button
          type="button"
          onClick={() => inputRef.current && inputRef.current.click()}
          disabled={uploading}
          style={{ padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
        >
          {uploading ? '…' : 'Upload'}
        </button>
      </div>
    </div>
  );
}

/**
 * Video URL input + Upload button. Hits /api/landing-pages/upload-video.
 * Accepts an mp4 / mov / webm; sets the returned URL into the value.
 */
function VideoField({ label, value, onChange, placeholder }) {
  const notify = useNotify();
  const [uploading, setUploading] = useState(false);
  const inputRef = React.useRef(null);
  const handleFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!/^video\//.test(f.type)) {
      notify.error('Pick a video file');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('video', f);
      const res = await fetchApi('/api/landing-pages/upload-video', { method: 'POST', body: fd });
      if (res && res.url) {
        onChange(res.url);
        notify.success('Video uploaded');
      }
    } catch (_e) {
      notify.error('Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input type="text" style={{ ...inputStyle, flex: 1 }} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'https://… (Wistia/YouTube/Vimeo embed URL) or /uploads/…'} />
        <input ref={inputRef} type="file" accept="video/*" onChange={handleFile} style={{ display: 'none' }} />
        <button
          type="button"
          onClick={() => inputRef.current && inputRef.current.click()}
          disabled={uploading}
          style={{ padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
        >
          {uploading ? '…' : 'Upload'}
        </button>
      </div>
    </div>
  );
}

function CheckboxField({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.7rem 0 0.3rem', fontSize: '0.85rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Section({ id, title, openByDefault, children, open, setOpen }) {
  const isOpen = open[id] !== undefined ? open[id] : openByDefault;
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>{title}</span>
        <button
          type="button"
          onClick={() => setOpen({ ...open, [id]: !isOpen })}
          style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, fontSize: '0.7rem', padding: '0.15rem 0.55rem', cursor: 'pointer', color: 'var(--text-secondary)' }}
        >
          {isOpen ? 'Collapse' : 'Edit'}
        </button>
      </div>
      {isOpen && <div style={{ marginTop: '0.6rem' }}>{children}</div>}
    </div>
  );
}

/**
 * Repeatable array editor with add/remove. `renderItem(item, setItem)` is
 * a render-prop that draws the form for one entry. Used for cities,
 * highlights.cards, faqs.items, etc.
 */
function ArrayEditor({ items, onChange, renderItem, itemLabel, newItem }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div>
      {list.map((it, i) => (
        <div key={i} style={subItemStyle}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between' }}>
            <span>{itemLabel} {i + 1}</span>
            <button
              type="button"
              onClick={() => onChange(list.filter((_, j) => j !== i))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e57373', fontSize: '0.95rem' }}
              aria-label={`Remove ${itemLabel} ${i + 1}`}
            >
              ✕
            </button>
          </div>
          {renderItem(it, (next) => {
            const copy = [...list];
            copy[i] = next;
            onChange(copy);
          })}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...list, typeof newItem === 'function' ? newItem() : { ...newItem }])}
        style={{ background: 'none', border: '1px dashed var(--border-color)', borderRadius: 6, padding: '0.5rem 0.9rem', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '0.85rem' }}
      >
        + Add {itemLabel.toLowerCase()}
      </button>
    </div>
  );
}

export default function LandingPageWanderluxEditor({ content, onChange }) {
  const cfg = content || {};
  const [open, setOpen] = useState({
    brand: true, hero: true, countdown: false, cities: true, video: false,
    intro: false, highlights: false, safety: false, investment: false,
    register: false, faqs: false, finalCta: false, footer: false, raw: false,
  });

  // Helper: deep-set into a nested path. Build a new object each change so
  // React picks it up (config is immutable upstream).
  const setPath = (path, value) => {
    const next = JSON.parse(JSON.stringify(cfg));
    let target = next;
    for (let i = 0; i < path.length - 1; i += 1) {
      const k = path[i];
      if (target[k] == null || typeof target[k] !== 'object') target[k] = {};
      target = target[k];
    }
    target[path[path.length - 1]] = value;
    onChange(next);
  };

  return (
    <div style={{ padding: '1rem 1.4rem', background: 'var(--subtle-bg)', overflowY: 'auto', height: '100%' }}>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.2rem' }}>Wanderlux editor</h2>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0 }}>
          Editing a <code style={{ background: 'var(--surface-color)', padding: '0 0.3rem', borderRadius: 3 }}>wanderlux-v1</code> page. Every field has an Upload button for media. Click Save (top-right) when done, then Preview.
        </p>
      </div>

      {/* ── BRAND ── */}
      <Section id="brand" title="Brand" openByDefault open={open} setOpen={setOpen}>
        <TextField label="Brand name" value={cfg.brand && cfg.brand.name} onChange={(v) => setPath(['brand', 'name'], v)} placeholder="WANDERLUX" />
        <TextField label="Sub-brand" value={cfg.brand && cfg.brand.subBrand} onChange={(v) => setPath(['brand', 'subBrand'], v)} placeholder="TravelStall / TMC / RFU / VisaSure" />
        <TextField label="Brand mark (small glyph)" value={cfg.brand && cfg.brand.mark} onChange={(v) => setPath(['brand', 'mark'], v)} placeholder="✦  (optional)" />
      </Section>

      {/* ── HERO ── */}
      <Section id="hero" title="Hero" openByDefault open={open} setOpen={setOpen}>
        <TextField label="Eyebrow (dates / audience)" value={cfg.hero && cfg.hero.eyebrow} onChange={(v) => setPath(['hero', 'eyebrow'], v)} placeholder="SEPT–OCT 2026  |  TRAVELLERS" />
        <TextField label="Badge (seat scarcity, optional)" value={cfg.hero && cfg.hero.badge} onChange={(v) => setPath(['hero', 'badge'], v)} placeholder="Only 30 Seats" />
        <TextField label="Kicker" value={cfg.hero && cfg.hero.kicker} onChange={(v) => setPath(['hero', 'kicker'], v)} placeholder="07 Days. 03 Cities." />
        <TextField label="Title lines (comma separated)" value={(cfg.hero && Array.isArray(cfg.hero.titleLines) ? cfg.hero.titleLines.join(', ') : '')} onChange={(v) => setPath(['hero', 'titleLines'], v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="Bali, but only the, extraordinary parts." />
        <TextArea label="Sub-head" value={cfg.hero && cfg.hero.subhead} onChange={(v) => setPath(['hero', 'subhead'], v)} placeholder="Seven unhurried nights of private villas…" rows={3} />
        <TextField label="CTA label" value={cfg.hero && cfg.hero.ctaLabel} onChange={(v) => setPath(['hero', 'ctaLabel'], v)} placeholder="Reserve Your Suite" />
        <ImageField label="Hero image" value={cfg.hero && cfg.hero.image && cfg.hero.image.src} onChange={(v) => setPath(['hero', 'image'], { ...(cfg.hero && cfg.hero.image || {}), src: v })} />
        <TextField label="Hero image alt" value={cfg.hero && cfg.hero.image && cfg.hero.image.alt} onChange={(v) => setPath(['hero', 'image'], { ...(cfg.hero && cfg.hero.image || {}), alt: v })} placeholder="Bali rice terraces at sunrise" />
        <TextField label="Image title (caption)" value={cfg.hero && cfg.hero.imageTitle} onChange={(v) => setPath(['hero', 'imageTitle'], v)} placeholder="Bali, but only the extraordinary parts." />
        <TextField label="Image subtitle (caption)" value={cfg.hero && cfg.hero.imageSubtitle} onChange={(v) => setPath(['hero', 'imageSubtitle'], v)} placeholder="Bespoke luxury journeys…" />
      </Section>

      {/* ── COUNTDOWN ── */}
      <Section id="countdown" title="Countdown timer" open={open} setOpen={setOpen}>
        <CheckboxField label="Show countdown" value={cfg.countdown && cfg.countdown.enabled} onChange={(v) => setPath(['countdown', 'enabled'], v)} />
        <TextField label="Label" value={cfg.countdown && cfg.countdown.label} onChange={(v) => setPath(['countdown', 'label'], v)} placeholder="Registration Closes In" />
        <TextField label="Deadline (ISO date)" value={cfg.countdown && cfg.countdown.deadline} onChange={(v) => setPath(['countdown', 'deadline'], v)} placeholder="2026-12-31T23:59:00" />
        <TextField label="CTA label" value={cfg.countdown && cfg.countdown.ctaLabel} onChange={(v) => setPath(['countdown', 'ctaLabel'], v)} placeholder="Explore Now" />
      </Section>

      {/* ── CITIES MARQUEE ── */}
      <Section id="cities" title="City marquee" openByDefault open={open} setOpen={setOpen}>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 0.5rem' }}>
          Add at least 5-6 cities so the scrolling marquee feels rich. The reference template loops the array — fewer cards = visible repetition.
        </p>
        <ArrayEditor
          items={cfg.cities}
          onChange={(next) => setPath(['cities'], next)}
          itemLabel="City"
          newItem={() => ({ name: '', tag: '', image: '' })}
          renderItem={(c, set) => (
            <>
              <TextField label="Name" value={c.name} onChange={(v) => set({ ...c, name: v })} placeholder="Little India" />
              <TextField label="Tag" value={c.tag} onChange={(v) => set({ ...c, tag: v })} placeholder="LITTLEINDIA" />
              <ImageField label="Image" value={c.image} onChange={(v) => set({ ...c, image: v })} />
            </>
          )}
        />
      </Section>

      {/* ── VIDEO ── */}
      <Section id="video" title="Video preview" open={open} setOpen={setOpen}>
        <CheckboxField label="Show video section" value={cfg.video && cfg.video.enabled} onChange={(v) => setPath(['video', 'enabled'], v)} />
        <TextField label="Eyebrow" value={cfg.video && cfg.video.eyebrow} onChange={(v) => setPath(['video', 'eyebrow'], v)} placeholder="Interactive Preview" />
        <TextField label="Title" value={cfg.video && cfg.video.title} onChange={(v) => setPath(['video', 'title'], v)} placeholder="See the Experience Before You Decide." />
        <TextArea label="Body" value={cfg.video && cfg.video.body} onChange={(v) => setPath(['video', 'body'], v)} placeholder="Notice the precision. The structure…" rows={2} />
        <VideoField label="Video URL / Upload" value={cfg.video && cfg.video.embedUrl} onChange={(v) => setPath(['video', 'embedUrl'], v)} />
        <ImageField label="Poster image (frame shown before play)" value={cfg.video && cfg.video.posterUrl} onChange={(v) => setPath(['video', 'posterUrl'], v)} />
      </Section>

      {/* ── INTRO ── */}
      <Section id="intro" title="Intro section" open={open} setOpen={setOpen}>
        <TextField label="Title" value={cfg.intro && cfg.intro.title} onChange={(v) => setPath(['intro', 'title'], v)} placeholder="Learning That Doesn't Fit in a Classroom." />
        <TextArea label="Paragraphs (one per line)" value={(cfg.intro && Array.isArray(cfg.intro.paragraphs) ? cfg.intro.paragraphs.join('\n\n') : '')} onChange={(v) => setPath(['intro', 'paragraphs'], v.split(/\n\n+/).map((p) => p.trim()).filter(Boolean))} placeholder={'First paragraph…\n\nSecond paragraph…'} rows={5} />
        <TextField label="Gains title" value={cfg.intro && cfg.intro.gainsTitle} onChange={(v) => setPath(['intro', 'gainsTitle'], v)} placeholder="What You Gain" />
        <TextArea label="Gains quote" value={cfg.intro && cfg.intro.gainsQuote} onChange={(v) => setPath(['intro', 'gainsQuote'], v)} rows={2} />
        <TextField label="Gains list (comma separated)" value={(cfg.intro && Array.isArray(cfg.intro.gains) ? cfg.intro.gains.join(', ') : '')} onChange={(v) => setPath(['intro', 'gains'], v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="Field research skills, Cross-cultural confidence, …" />
        <TextField label="CTA label" value={cfg.intro && cfg.intro.ctaLabel} onChange={(v) => setPath(['intro', 'ctaLabel'], v)} placeholder="Talk to Our Team →" />
      </Section>

      {/* ── HIGHLIGHTS (FLIP CARDS) ── */}
      <Section id="highlights" title="Destination flip cards" open={open} setOpen={setOpen}>
        <TextField label="Eyebrow" value={cfg.highlights && cfg.highlights.eyebrow} onChange={(v) => setPath(['highlights', 'eyebrow'], v)} placeholder="Programme" />
        <TextField label="Title" value={cfg.highlights && cfg.highlights.title} onChange={(v) => setPath(['highlights', 'title'], v)} placeholder="Field Highlights" />
        <TextArea label="Subtitle" value={cfg.highlights && cfg.highlights.subtitle} onChange={(v) => setPath(['highlights', 'subtitle'], v)} rows={2} />
        <ArrayEditor
          items={cfg.highlights && cfg.highlights.cards}
          onChange={(next) => setPath(['highlights', 'cards'], next)}
          itemLabel="Card"
          newItem={() => ({ name: '', eyebrow: '', frontBody: '', backBody: '', benefit: '', image: '' })}
          renderItem={(c, set) => (
            <>
              <TextField label="Name" value={c.name} onChange={(v) => set({ ...c, name: v })} placeholder="Ubud" />
              <TextField label="Eyebrow / region" value={c.eyebrow} onChange={(v) => set({ ...c, eyebrow: v })} placeholder="Highlands" />
              <TextArea label="Front body" value={c.frontBody} onChange={(v) => set({ ...c, frontBody: v })} rows={2} />
              <TextArea label="Back body (shown on flip)" value={c.backBody} onChange={(v) => set({ ...c, backBody: v })} rows={2} />
              <TextArea label="Pull-quote benefit" value={c.benefit} onChange={(v) => set({ ...c, benefit: v })} rows={2} />
              <ImageField label="Card image" value={c.image} onChange={(v) => set({ ...c, image: v })} />
            </>
          )}
        />
        <TextField label="Banner title" value={cfg.highlights && cfg.highlights.bannerTitle} onChange={(v) => setPath(['highlights', 'bannerTitle'], v)} placeholder="Every Region Has a Purpose." />
        <TextArea label="Banner body" value={cfg.highlights && cfg.highlights.bannerBody} onChange={(v) => setPath(['highlights', 'bannerBody'], v)} rows={2} />
        <TextField label="Banner CTA label" value={cfg.highlights && cfg.highlights.bannerCtaLabel} onChange={(v) => setPath(['highlights', 'bannerCtaLabel'], v)} placeholder="Reserve a Seat" />
      </Section>

      {/* ── SAFETY ── */}
      <Section id="safety" title="Safety section" open={open} setOpen={setOpen}>
        <TextField label="Eyebrow" value={cfg.safety && cfg.safety.eyebrow} onChange={(v) => setPath(['safety', 'eyebrow'], v)} placeholder="Safety Framework" />
        <TextField label="Title" value={cfg.safety && cfg.safety.title} onChange={(v) => setPath(['safety', 'title'], v)} placeholder="Safe by Design." />
        <TextArea label="Subtitle" value={cfg.safety && cfg.safety.subtitle} onChange={(v) => setPath(['safety', 'subtitle'], v)} rows={2} />
        <ArrayEditor
          items={cfg.safety && cfg.safety.stats}
          onChange={(next) => setPath(['safety', 'stats'], next)}
          itemLabel="Stat"
          newItem={() => ({ stat: '', title: '', body: '' })}
          renderItem={(s, set) => (
            <>
              <TextField label="Stat (big number)" value={s.stat} onChange={(v) => set({ ...s, stat: v })} placeholder="1:8" />
              <TextField label="Stat title" value={s.title} onChange={(v) => set({ ...s, title: v })} placeholder="Staff Ratio" />
              <TextArea label="Stat body" value={s.body} onChange={(v) => set({ ...s, body: v })} rows={2} />
            </>
          )}
        />
        <TextField label="Inclusions title" value={cfg.safety && cfg.safety.includedTitle} onChange={(v) => setPath(['safety', 'includedTitle'], v)} placeholder="What's Included" />
        <TextArea label="Inclusions quote" value={cfg.safety && cfg.safety.includedQuote} onChange={(v) => setPath(['safety', 'includedQuote'], v)} rows={2} />
        <TextField label="Inclusions list (comma separated)" value={(cfg.safety && Array.isArray(cfg.safety.included) ? cfg.safety.included.join(', ') : '')} onChange={(v) => setPath(['safety', 'included'], v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="Return airfare, All meals, …" />
        <TextField label="CTA label" value={cfg.safety && cfg.safety.ctaLabel} onChange={(v) => setPath(['safety', 'ctaLabel'], v)} placeholder="Reserve a Seat →" />
      </Section>

      {/* ── INVESTMENT (PRICING) ── */}
      <Section id="investment" title="Investment (pricing)" open={open} setOpen={setOpen}>
        <TextField label="Eyebrow" value={cfg.investment && cfg.investment.eyebrow} onChange={(v) => setPath(['investment', 'eyebrow'], v)} placeholder="Investment" />
        <TextField label="Title" value={cfg.investment && cfg.investment.title} onChange={(v) => setPath(['investment', 'title'], v)} placeholder="Transparent Pricing" />
        <TextArea label="Subtitle" value={cfg.investment && cfg.investment.subtitle} onChange={(v) => setPath(['investment', 'subtitle'], v)} rows={2} />
        <NumberField label="Featured index (which instalment gets the highlight)" value={cfg.investment && cfg.investment.featuredIndex} onChange={(v) => setPath(['investment', 'featuredIndex'], v)} min={0} max={5} />
        <ArrayEditor
          items={cfg.investment && cfg.investment.installments}
          onChange={(next) => setPath(['investment', 'installments'], next)}
          itemLabel="Instalment"
          newItem={() => ({ tag: '', title: '', sub: '', amount: '', date: '', entity: '' })}
          renderItem={(t, set) => (
            <>
              <TextField label="Tag" value={t.tag} onChange={(v) => set({ ...t, tag: v })} placeholder="First Instalment" />
              <TextField label="Title" value={t.title} onChange={(v) => set({ ...t, title: v })} placeholder="Booking Fee" />
              <TextField label="Sub-label" value={t.sub} onChange={(v) => set({ ...t, sub: v })} placeholder="Non-refundable" />
              <TextField label="Amount" value={t.amount} onChange={(v) => set({ ...t, amount: v })} placeholder="₹25,000" />
              <TextField label="Date" value={t.date} onChange={(v) => set({ ...t, date: v })} placeholder="20th April 2026" />
              <TextField label="Payee (vendor)" value={t.entity} onChange={(v) => set({ ...t, entity: v })} placeholder="Travel Stall Pvt Ltd" />
            </>
          )}
        />
        <TextField label="Inclusions title" value={cfg.investment && cfg.investment.inclusionsTitle} onChange={(v) => setPath(['investment', 'inclusionsTitle'], v)} placeholder="Indicative Inclusions" />
        <TextField label="Inclusions list (comma separated)" value={(cfg.investment && Array.isArray(cfg.investment.inclusions) ? cfg.investment.inclusions.join(', ') : '')} onChange={(v) => setPath(['investment', 'inclusions'], v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="Airfare, Accommodation, …" />
        <TextArea label="Note" value={cfg.investment && cfg.investment.note} onChange={(v) => setPath(['investment', 'note'], v)} rows={2} />
      </Section>

      {/* ── REGISTER ── */}
      <Section id="register" title="Registration form" open={open} setOpen={setOpen}>
        <TextField label="Eyebrow" value={cfg.register && cfg.register.eyebrow} onChange={(v) => setPath(['register', 'eyebrow'], v)} placeholder="Reserve Your Seat" />
        <TextField label="Title" value={cfg.register && cfg.register.title} onChange={(v) => setPath(['register', 'title'], v)} placeholder="Register — Bali 2027" />
        <TextArea label="Intro copy" value={cfg.register && cfg.register.intro} onChange={(v) => setPath(['register', 'intro'], v)} rows={2} />
        <NumberField label="Capacity (seats)" value={cfg.register && cfg.register.capacity} onChange={(v) => setPath(['register', 'capacity'], v)} min={1} max={9999} />
        <NumberField label="Registered (already-booked count)" value={cfg.register && cfg.register.registered} onChange={(v) => setPath(['register', 'registered'], v)} min={0} max={9999} />
        <TextField label="Deadline (ISO date)" value={cfg.register && cfg.register.deadline} onChange={(v) => setPath(['register', 'deadline'], v)} placeholder="2026-12-31T23:59:00" />
        <TextField label="Submit button label" value={cfg.register && cfg.register.submitLabel} onChange={(v) => setPath(['register', 'submitLabel'], v)} placeholder="Submit Registration" />
      </Section>

      {/* ── FAQS ── */}
      <Section id="faqs" title="FAQs" open={open} setOpen={setOpen}>
        <TextField label="Eyebrow" value={cfg.faqs && cfg.faqs.eyebrow} onChange={(v) => setPath(['faqs', 'eyebrow'], v)} placeholder="Clarifications" />
        <TextField label="Title" value={cfg.faqs && cfg.faqs.title} onChange={(v) => setPath(['faqs', 'title'], v)} placeholder="Frequently Asked Questions" />
        <TextArea label="Subtitle" value={cfg.faqs && cfg.faqs.subtitle} onChange={(v) => setPath(['faqs', 'subtitle'], v)} rows={2} />
        <ArrayEditor
          items={cfg.faqs && cfg.faqs.items}
          onChange={(next) => setPath(['faqs', 'items'], next)}
          itemLabel="Question"
          newItem={() => ({ category: 'all', q: '', a: '' })}
          renderItem={(q, set) => (
            <>
              <TextField label="Category id" value={q.category} onChange={(v) => set({ ...q, category: v })} placeholder="tour / safety / reg / all" />
              <TextField label="Question" value={q.q} onChange={(v) => set({ ...q, q: v })} />
              <TextArea label="Answer" value={q.a} onChange={(v) => set({ ...q, a: v })} rows={3} />
            </>
          )}
        />
      </Section>

      {/* ── FINAL CTA ── */}
      <Section id="finalCta" title="Final CTA" open={open} setOpen={setOpen}>
        <TextField label="Eyebrow" value={cfg.finalCta && cfg.finalCta.eyebrow} onChange={(v) => setPath(['finalCta', 'eyebrow'], v)} placeholder="07 Days · 03 Regions" />
        <TextField label="Title" value={cfg.finalCta && cfg.finalCta.title} onChange={(v) => setPath(['finalCta', 'title'], v)} placeholder="Plan With Confidence." />
        <TextArea label="Subtitle" value={cfg.finalCta && cfg.finalCta.subtitle} onChange={(v) => setPath(['finalCta', 'subtitle'], v)} rows={2} />
        <TextField label="CTA label" value={cfg.finalCta && cfg.finalCta.ctaLabel} onChange={(v) => setPath(['finalCta', 'ctaLabel'], v)} placeholder="Reserve a Seat" />
      </Section>

      {/* ── FOOTER ── */}
      <Section id="footer" title="Footer" open={open} setOpen={setOpen}>
        <TextField label="Footer brand name" value={cfg.footer && cfg.footer.name} onChange={(v) => setPath(['footer', 'name'], v)} placeholder="BALI 2027" />
        <TextField label="Tagline" value={cfg.footer && cfg.footer.tagline} onChange={(v) => setPath(['footer', 'tagline'], v)} placeholder="Where curiosity meets the wild" />
        <TextField label="Contact email" value={cfg.footer && cfg.footer.email} onChange={(v) => setPath(['footer', 'email'], v)} placeholder="hello@travelstall.com" />
        <TextField label="Legal lines (comma separated)" value={(cfg.footer && Array.isArray(cfg.footer.legal) ? cfg.footer.legal.join(', ') : '')} onChange={(v) => setPath(['footer', 'legal'], v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="© 2026 Travel Stall, Bali 2027 Field Immersion" />
      </Section>

      {/* ── RAW JSON ── */}
      <Section id="raw" title="Raw JSON (advanced)" open={open} setOpen={setOpen}>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 0 }}>
          Direct edit of the page's config object. Lets you tweak any field the form above doesn't cover. Changes apply when you click outside the textarea.
        </p>
        <textarea
          style={{ ...textAreaStyle, minHeight: '20rem', fontFamily: 'monospace', fontSize: '0.78rem' }}
          defaultValue={JSON.stringify(cfg, null, 2)}
          key={JSON.stringify(cfg).length}
          onBlur={(e) => {
            try {
              const parsed = JSON.parse(e.target.value);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onChange(parsed);
            } catch (_) {
              // Bad JSON — ignore; operator can fix and re-blur.
            }
          }}
        />
      </Section>
    </div>
  );
}
