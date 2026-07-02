/**
 * LandingPageTemplateEditor — lightweight form editor for the new
 * template-driven travel pages (Phase D1).
 *
 * Mounted by LandingPageBuilder.jsx in place of the block-array canvas
 * + properties panel when the page's templateType matches a registered
 * template id (educational-trip-v1 / travel-premium-v1 / religious-tour-
 * v1 / luxury-tour-v1).
 *
 * Editable slots in D1 — covered by structured form fields:
 *   - brand           (programme name + partner logos)
 *   - nav             (top-nav links + CTA)
 *   - hero            (eyebrow + headline + lede + benefit cards + countdown + poster)
 *   - programme       (two-column "why" section + CTA banner)
 *   - cultural        (flip-card items)
 *   - safety          (features + included items + banner + quote)
 *   - investment      (tiers + indicative inclusions + CTA)
 *   - faq             (categories + items)
 *   - registration    (form copy + tenant routing)
 *   - brochure        (info cards + brochure copy)
 *   - contact         (footer brand + contact sections + copyright)
 *
 * Slots without structured forms (marquee / preview / testimonials /
 * details / floatingCta) are editable as raw JSON via the "Other slots"
 * section. D2 will add structured forms for these too; the JSON path
 * stays as a defensive fallback.
 *
 * Saves go through the parent component's onContentChange — the
 * builder owns the PUT /api/landing-pages/:id request and dirty-state
 * tracking. This component is a controlled editor only.
 */

import React, { useState } from 'react';
import { Trash2, Plus, Upload, AlertCircle } from 'lucide-react';
import { getAuthToken } from '../utils/api';
import { isUploadedS3Url } from '../utils/uploadDisplay';
import UploadedAssetChip from '../components/UploadedAssetChip';

// ── upload helper (mirror of the image-upload logic in the builder) ─
async function uploadImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  const token = getAuthToken();
  const r = await fetch('/api/landing-pages/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!r.ok) {
    let msg = `Upload failed (${r.status})`;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (_e) { /* ignore */ }
    throw new Error(msg);
  }
  const j = await r.json();
  if (!j.url) throw new Error('Upload returned no URL');
  return j.url;
}

// Sibling helper for video uploads — posts to the existing
// /api/landing-pages/upload-video route. Returns the relative URL.
async function uploadVideo(file) {
  const fd = new FormData();
  fd.append('video', file);
  const token = getAuthToken();
  const r = await fetch('/api/landing-pages/upload-video', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!r.ok) {
    let msg = `Upload failed (${r.status})`;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (_e) { /* ignore */ }
    throw new Error(msg);
  }
  const j = await r.json();
  if (!j.url) throw new Error('Upload returned no URL');
  return j.url;
}

// ── primitives ───────────────────────────────────────────────────────
const labelStyle = { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' };
const inputStyle = { width: '100%', padding: '0.5rem 0.7rem', fontSize: '0.85rem' };
const sectionStyle = { padding: '1rem 1.1rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--surface-color)', marginBottom: '1rem' };
const sectionTitleStyle = { fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const subItemStyle = { padding: '0.65rem', border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: '0.5rem', background: 'var(--subtle-bg)' };

function TextField({ label, value, onChange, placeholder, multiline = false, rows = 2 }) {
  return (
    <div style={{ marginBottom: '0.65rem' }}>
      {label && <label style={labelStyle}>{label}</label>}
      {multiline ? (
        <textarea className="input-field" rows={rows} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ ...inputStyle, resize: 'vertical' }} />
      ) : (
        <input className="input-field" value={value == null ? '' : value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
      )}
    </div>
  );
}

function CheckboxField({ label, value, onChange, hint }) {
  return (
    <div style={{ marginBottom: '0.65rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{label}</span>
      {hint && <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>— {hint}</span>}
    </div>
  );
}

function ImageField({ label, value, onChange, hint }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const ref = React.useRef(null);
  const onPick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError(null);
    uploadImage(file)
      .then((url) => onChange(url))
      .catch((err) => setError(err.message || 'Upload failed'))
      .finally(() => { setUploading(false); if (ref.current) ref.current.value = ''; });
  };
  const showChip = isUploadedS3Url(value);
  return (
    <div style={{ marginBottom: '0.65rem' }}>
      {label && <label style={labelStyle}>{label}</label>}
      {showChip ? (
        <UploadedAssetChip
          url={value}
          kind="image"
          uploading={uploading}
          onReplace={() => ref.current?.click()}
          onRemove={() => onChange('')}
        />
      ) : (
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          <input className="input-field" value={value || ''} onChange={(e) => onChange(e.target.value || null)} placeholder="https://… or /uploads/…" style={{ ...inputStyle, flex: 1 }} />
          <button type="button" onClick={() => ref.current?.click()} disabled={uploading} style={{ padding: '0.4rem 0.65rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--subtle-bg)', cursor: uploading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.78rem' }}>
            <Upload size={12} /> {uploading ? '...' : 'Upload'}
          </button>
          <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onPick} style={{ display: 'none' }} />
        </div>
      )}
      {hint && <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>{hint}</p>}
      {error && <p style={{ fontSize: '0.7rem', color: '#ef4444', marginTop: '0.2rem' }}>{error}</p>}
    </div>
  );
}

// VideoField — URL field + Upload button for direct video uploads.
// The renderer normalises YouTube / Vimeo / Wistia paste URLs to the
// provider's /embed path; direct MP4/WebM uploads render via the
// native <video> control. Same compatibility surface as the legacy
// `travelVideo` block but inside the template editor.
function VideoField({ label, value, onChange, hint }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const ref = React.useRef(null);
  const onPick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError(null);
    uploadVideo(file)
      .then((url) => onChange(url))
      .catch((err) => setError(err.message || 'Upload failed'))
      .finally(() => { setUploading(false); if (ref.current) ref.current.value = ''; });
  };
  const showChip = isUploadedS3Url(value);
  return (
    <div style={{ marginBottom: '0.65rem' }}>
      {label && <label style={labelStyle}>{label}</label>}
      {showChip ? (
        <UploadedAssetChip
          url={value}
          kind="video"
          uploading={uploading}
          onReplace={() => ref.current?.click()}
          onRemove={() => onChange('')}
        />
      ) : (
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          <input
            className="input-field"
            value={value || ''}
            onChange={(e) => onChange(e.target.value || '')}
            placeholder="https://youtube.com/… or paste Vimeo / Wistia URL"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            onClick={() => ref.current?.click()}
            disabled={uploading}
            style={{ padding: '0.4rem 0.65rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--subtle-bg)', cursor: uploading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.78rem' }}
            title="Upload an MP4 / WebM / MOV (max 50 MB)"
          >
            <Upload size={12} /> {uploading ? '...' : 'Upload'}
          </button>
          <input ref={ref} type="file" accept="video/mp4,video/webm,video/quicktime,video/ogg" onChange={onPick} style={{ display: 'none' }} />
        </div>
      )}
      {hint && <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>{hint}</p>}
      {error && <p style={{ fontSize: '0.7rem', color: '#ef4444', marginTop: '0.2rem' }}>{error}</p>}
    </div>
  );
}

function ArrayEditor({ items, onChange, renderItem, addText = '+ Add', makeNew }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div>
      {list.map((item, idx) => (
        <div key={idx} style={subItemStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>#{idx + 1}</span>
            <button type="button" onClick={() => onChange(list.filter((_, j) => j !== idx))} title="Remove" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
          {renderItem(item, (patch) => {
            onChange(list.map((it, j) => (j === idx ? { ...it, ...patch } : it)));
          })}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, makeNew()])} style={{ fontSize: '0.78rem', color: 'var(--accent-color)', background: 'none', border: '1px dashed var(--border-color)', borderRadius: 6, padding: '0.35rem 0.8rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
        <Plus size={12} /> {addText}
      </button>
    </div>
  );
}

function StringArrayEditor({ items, onChange, addText = '+ Add Item', placeholder = 'Item' }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div>
      {list.map((it, idx) => (
        <div key={idx} style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
          <input className="input-field" value={it == null ? '' : it} onChange={(e) => onChange(list.map((s, j) => (j === idx ? e.target.value : s)))} placeholder={placeholder} style={{ ...inputStyle, flex: 1 }} />
          <button type="button" onClick={() => onChange(list.filter((_, j) => j !== idx))} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, ''])} style={{ fontSize: '0.78rem', color: 'var(--accent-color)', background: 'none', border: '1px dashed var(--border-color)', borderRadius: 6, padding: '0.3rem 0.7rem', cursor: 'pointer' }}>{addText}</button>
    </div>
  );
}

function JsonEditor({ value, onChange }) {
  const [text, setText] = useState(() => {
    try { return JSON.stringify(value ?? {}, null, 2); }
    catch { return '{}'; }
  });
  const [error, setError] = useState(null);
  const commit = () => {
    try {
      const parsed = JSON.parse(text);
      setError(null);
      onChange(parsed);
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <div>
      <textarea className="input-field" rows={8} value={text} onChange={(e) => setText(e.target.value)} style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '0.78rem', resize: 'vertical' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.3rem' }}>
        <span style={{ fontSize: '0.7rem', color: error ? '#ef4444' : 'var(--text-secondary)' }}>{error || 'Edit JSON then click "Apply".'}</span>
        <button type="button" onClick={commit} style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--subtle-bg)', cursor: 'pointer' }}>Apply</button>
      </div>
    </div>
  );
}

// ── slot editors ────────────────────────────────────────────────────

function BrandSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <TextField label="Programme name" value={v.programmeName} onChange={(x) => set({ programmeName: x })} />
      <TextField label="Programme tagline" value={v.programmeTagline} onChange={(x) => set({ programmeTagline: x })} />
      <TextField label="Brand label (e.g. JAPAN 2026)" value={v.label} onChange={(x) => set({ label: x })} />
      <TextField label="Brand kanji / leading symbol" value={v.kanji} onChange={(x) => set({ kanji: x })} placeholder="日本 (optional)" />
      <ImageField label="Brand logo" value={v.logoUrl} onChange={(x) => set({ logoUrl: x })} />
      <label style={labelStyle}>Partner logos</label>
      <ArrayEditor
        items={v.partnerLogos}
        onChange={(x) => set({ partnerLogos: x })}
        addText="+ Add partner logo"
        makeNew={() => ({ src: '', alt: '' })}
        renderItem={(item, patch) => (
          <>
            <ImageField label="Logo image" value={item.src} onChange={(x) => patch({ src: x })} />
            <TextField label="Alt text" value={item.alt} onChange={(x) => patch({ alt: x })} />
          </>
        )}
      />
    </>
  );
}

function NavSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <TextField label="CTA button text" value={v.ctaText} onChange={(x) => set({ ctaText: x })} />
      <TextField label="CTA href (e.g. #register)" value={v.ctaHref} onChange={(x) => set({ ctaHref: x })} />
      <label style={labelStyle}>Nav links</label>
      <ArrayEditor
        items={v.links}
        onChange={(x) => set({ links: x })}
        addText="+ Add nav link"
        makeNew={() => ({ label: '', href: '' })}
        renderItem={(item, patch) => (
          <>
            <TextField label="Label" value={item.label} onChange={(x) => patch({ label: x })} />
            <TextField label="href (e.g. #programme)" value={item.href} onChange={(x) => patch({ href: x })} />
          </>
        )}
      />
    </>
  );
}

function HeroSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  const eyebrow = v.eyebrow || {};
  const setEyebrow = (patch) => set({ eyebrow: { ...eyebrow, ...patch } });
  const countdown = v.countdown || {};
  const setCountdown = (patch) => set({ countdown: { ...countdown, ...patch } });
  return (
    <>
      <TextField label="Kanji watermark (decorative)" value={v.kanjiWatermark} onChange={(x) => set({ kanjiWatermark: x })} placeholder="成長 (optional)" />
      <TextField label="Eyebrow date" value={eyebrow.date} onChange={(x) => setEyebrow({ date: x })} placeholder="SEPT – OCT 2026" />
      <TextField label="Eyebrow audience" value={eyebrow.audience} onChange={(x) => setEyebrow({ audience: x })} placeholder="GRADES 6-12" />
      <TextField label="Eyebrow pill" value={eyebrow.batchPill} onChange={(x) => setEyebrow({ batchPill: x })} placeholder="Limited to 45 Students per Batch" />
      <TextField label="Kicker" value={v.kicker} onChange={(x) => set({ kicker: x })} placeholder="09 Days. 04 Cities." />
      <TextField label="Hero headline" value={v.headline} onChange={(x) => set({ headline: x })} multiline rows={2} />
      <TextField label="Lede paragraph" value={v.lede} onChange={(x) => set({ lede: x })} multiline rows={3} />
      <ImageField label="Hero poster image" value={v.posterUrl} onChange={(x) => set({ posterUrl: x })} hint="Tall poster — 4:5 / portrait works best." />
      <TextField label="Visual title (above poster)" value={v.visualTitle} onChange={(x) => set({ visualTitle: x })} />
      <TextField label="Visual subtitle" value={v.visualSub} onChange={(x) => set({ visualSub: x })} multiline rows={2} />
      <label style={labelStyle}>Benefit cards (4 recommended)</label>
      <ArrayEditor
        items={v.benefitCards}
        onChange={(x) => set({ benefitCards: x })}
        addText="+ Add benefit card"
        makeNew={() => ({ icon: '◈', title: '', desc: '' })}
        renderItem={(item, patch) => (
          <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '0.4rem' }}>
            <TextField label="Icon" value={item.icon} onChange={(x) => patch({ icon: x })} />
            <div>
              <TextField label="Title" value={item.title} onChange={(x) => patch({ title: x })} />
              <TextField label="Description" value={item.desc} onChange={(x) => patch({ desc: x })} multiline rows={2} />
            </div>
          </div>
        )}
      />
      <h4 style={{ fontSize: '0.85rem', margin: '0.8rem 0 0.4rem' }}>Countdown</h4>
      <TextField label="Countdown label" value={countdown.label} onChange={(x) => setCountdown({ label: x })} placeholder="REGISTRATION CLOSES IN" />
      <TextField label="Deadline (ISO date, blank to hide)" value={countdown.deadlineIso} onChange={(x) => setCountdown({ deadlineIso: x })} placeholder="2026-06-30T23:59:59+05:30" />
      <TextField label="Countdown CTA text" value={countdown.ctaText} onChange={(x) => setCountdown({ ctaText: x })} />
      <TextField label="Countdown CTA href" value={countdown.ctaHref} onChange={(x) => setCountdown({ ctaHref: x })} />
    </>
  );
}

function CtaSubBlock({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <div style={{ border: '1px dashed var(--border-color)', padding: '0.55rem', borderRadius: 6, marginTop: '0.5rem' }}>
      <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>Section CTA banner</p>
      <TextField label="Title" value={v.title} onChange={(x) => set({ title: x })} />
      <TextField label="Body" value={v.body} onChange={(x) => set({ body: x })} multiline rows={2} />
      <TextField label="CTA text" value={v.ctaText} onChange={(x) => set({ ctaText: x })} />
      <TextField label="CTA href" value={v.ctaHref} onChange={(x) => set({ ctaHref: x })} />
    </div>
  );
}

function ProgrammeSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Kanji watermark" value={v.kanjiWatermark} onChange={(x) => set({ kanjiWatermark: x })} placeholder="洞察 (optional)" />
      <TextField label="Left column headline" value={v.leftHeadline} onChange={(x) => set({ leftHeadline: x })} multiline rows={2} />
      <label style={labelStyle}>Left column paragraphs</label>
      <StringArrayEditor items={v.leftParagraphs} onChange={(x) => set({ leftParagraphs: x })} addText="+ Add paragraph" placeholder="Paragraph text" />
      <TextField label="Right card headline" value={v.rightHeadline} onChange={(x) => set({ rightHeadline: x })} />
      <TextField label="Right card quote" value={v.rightQuote} onChange={(x) => set({ rightQuote: x })} multiline rows={2} />
      <label style={labelStyle}>Right card checklist</label>
      <StringArrayEditor items={v.rightChecks} onChange={(x) => set({ rightChecks: x })} addText="+ Add checklist item" placeholder="Check item" />
      <CtaSubBlock value={v.cta} onChange={(x) => set({ cta: x })} />
    </>
  );
}

function CulturalSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Tag (eyebrow above title)" value={v.tag} onChange={(x) => set({ tag: x })} />
      <TextField label="Section title" value={v.title} onChange={(x) => set({ title: x })} />
      <TextField label="Subtitle" value={v.subtitle} onChange={(x) => set({ subtitle: x })} multiline rows={2} />
      <TextField label="Kanji watermark" value={v.kanjiWatermark} onChange={(x) => set({ kanjiWatermark: x })} />
      <label style={labelStyle}>Cultural items (flip cards)</label>
      <ArrayEditor
        items={v.items}
        onChange={(x) => set({ items: x })}
        addText="+ Add cultural item"
        makeNew={() => ({ id: '', name: '', label: '', icon: '', body: [''], benefit: '' })}
        renderItem={(item, patch) => (
          <>
            <TextField label="Item id (e.g. tokyo)" value={item.id} onChange={(x) => patch({ id: x })} />
            <TextField label="Display name" value={item.name} onChange={(x) => patch({ name: x })} />
            <TextField label="Back-of-card label (e.g. URBAN PRECISION)" value={item.label} onChange={(x) => patch({ label: x })} />
            <TextField label="Icon id (tokyo / fuji / kyoto / nara / osaka / generic)" value={item.icon} onChange={(x) => patch({ icon: x })} />
            <label style={labelStyle}>Back-of-card body paragraphs</label>
            <StringArrayEditor items={item.body} onChange={(x) => patch({ body: x })} addText="+ Add paragraph" placeholder="Body paragraph" />
            <TextField label="Derived benefit (italic pull quote)" value={item.benefit} onChange={(x) => patch({ benefit: x })} multiline rows={2} />
          </>
        )}
      />
      <CtaSubBlock value={v.cta} onChange={(x) => set({ cta: x })} />
    </>
  );
}

function SafetySlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  const included = v.included || {};
  const setIncluded = (patch) => set({ included: { ...included, ...patch } });
  const banner = v.banner || {};
  const setBanner = (patch) => set({ banner: { ...banner, ...patch } });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Section title" value={v.title} onChange={(x) => set({ title: x })} multiline rows={2} />
      <TextField label="Subtitle" value={v.subtitle} onChange={(x) => set({ subtitle: x })} multiline rows={2} />
      <label style={labelStyle}>Safety features</label>
      <ArrayEditor
        items={v.features}
        onChange={(x) => set({ features: x })}
        addText="+ Add safety feature"
        makeNew={() => ({ icon: 'shield', title: '', desc: '' })}
        renderItem={(item, patch) => (
          <>
            <TextField label="Icon id (shield / briefcase / send / package / check)" value={item.icon} onChange={(x) => patch({ icon: x })} />
            <TextField label="Title" value={item.title} onChange={(x) => patch({ title: x })} />
            <TextField label="Description" value={item.desc} onChange={(x) => patch({ desc: x })} multiline rows={2} />
          </>
        )}
      />
      <h4 style={{ fontSize: '0.85rem', margin: '0.8rem 0 0.4rem' }}>What&apos;s Included</h4>
      <TextField label="Heading" value={included.title} onChange={(x) => setIncluded({ title: x })} />
      <label style={labelStyle}>Items</label>
      <StringArrayEditor items={included.items} onChange={(x) => setIncluded({ items: x })} addText="+ Add inclusion" placeholder="Inclusion item" />
      <h4 style={{ fontSize: '0.85rem', margin: '0.8rem 0 0.4rem' }}>Safety banner</h4>
      <TextField label="Banner title" value={banner.title} onChange={(x) => setBanner({ title: x })} />
      <TextField label="Banner body" value={banner.body} onChange={(x) => setBanner({ body: x })} multiline rows={2} />
      <TextField label="Banner CTA text" value={banner.ctaText} onChange={(x) => setBanner({ ctaText: x })} />
      <TextField label="Banner CTA href" value={banner.ctaHref} onChange={(x) => setBanner({ ctaHref: x })} />
      <TextField label="Closing quote" value={v.quote} onChange={(x) => set({ quote: x })} multiline rows={2} />
    </>
  );
}

function InvestmentSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  const inclusions = v.inclusions || {};
  const setInclusions = (patch) => set({ inclusions: { ...inclusions, ...patch } });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Tag (eyebrow)" value={v.tag} onChange={(x) => set({ tag: x })} />
      <TextField label="Section title" value={v.title} onChange={(x) => set({ title: x })} />
      <TextField label="Subtitle" value={v.subtitle} onChange={(x) => set({ subtitle: x })} multiline rows={2} />
      <TextField label="Currency symbol" value={v.currency} onChange={(x) => set({ currency: x })} placeholder="₹" />
      <div style={{ padding: '0.5rem 0.65rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, marginBottom: '0.65rem', display: 'flex', gap: '0.4rem', fontSize: '0.75rem', alignItems: 'flex-start' }}>
        <AlertCircle size={14} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
        <span>Pricing values are operator-entered. The publish gate blocks pages with empty tier amounts.</span>
      </div>
      <label style={labelStyle}>Tiers</label>
      <ArrayEditor
        items={v.tiers}
        onChange={(x) => set({ tiers: x })}
        addText="+ Add tier"
        makeNew={() => ({ step: 1, title: '', subtitle: '', amount: null, tag: null, date: null, vendor: null, startHere: false })}
        renderItem={(item, patch) => (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '0.4rem' }}>
              <TextField label="Step #" value={item.step} onChange={(x) => patch({ step: parseInt(x, 10) || 1 })} />
              <TextField label="Title (e.g. First Instalment)" value={item.title} onChange={(x) => patch({ title: x })} />
            </div>
            <TextField label="Subtitle" value={item.subtitle} onChange={(x) => patch({ subtitle: x })} />
            <TextField label="Amount" value={item.amount} onChange={(x) => patch({ amount: x || null })} placeholder="34,980" />
            <TextField label="Tag (e.g. Non-refundable)" value={item.tag} onChange={(x) => patch({ tag: x || null })} />
            <TextField label="Due date" value={item.date} onChange={(x) => patch({ date: x || null })} placeholder="30th June 2026" />
            <TextField label="Vendor" value={item.vendor} onChange={(x) => patch({ vendor: x || null })} />
            <CheckboxField label="START HERE badge (highlight as the first step)" value={item.startHere} onChange={(x) => patch({ startHere: x })} />
          </>
        )}
      />
      <h4 style={{ fontSize: '0.85rem', margin: '0.8rem 0 0.4rem' }}>Indicative inclusions</h4>
      <TextField label="Inclusions label" value={inclusions.label} onChange={(x) => setInclusions({ label: x })} />
      <StringArrayEditor items={inclusions.items} onChange={(x) => setInclusions({ items: x })} addText="+ Add inclusion" placeholder="e.g. International airfare" />
      <TextField label="Footer line under tiers" value={v.foot} onChange={(x) => set({ foot: x })} multiline rows={2} />
      <CtaSubBlock value={v.cta} onChange={(x) => set({ cta: x })} />
    </>
  );
}

function FaqSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Tag (eyebrow)" value={v.tag} onChange={(x) => set({ tag: x })} />
      <TextField label="Title" value={v.title} onChange={(x) => set({ title: x })} />
      <TextField label="Subtitle" value={v.subtitle} onChange={(x) => set({ subtitle: x })} multiline rows={2} />
      <TextField label="Kanji watermark" value={v.kanjiWatermark} onChange={(x) => set({ kanjiWatermark: x })} />
      <label style={labelStyle}>Categories</label>
      <ArrayEditor
        items={v.categories}
        onChange={(x) => set({ categories: x })}
        addText="+ Add category"
        makeNew={() => ({ id: '', label: '', icon: '' })}
        renderItem={(item, patch) => (
          <>
            <TextField label="id (e.g. tour)" value={item.id} onChange={(x) => patch({ id: x })} />
            <TextField label="Label" value={item.label} onChange={(x) => patch({ label: x })} />
            <TextField label="Icon (single character / emoji)" value={item.icon} onChange={(x) => patch({ icon: x })} />
          </>
        )}
      />
      <label style={labelStyle}>FAQ items</label>
      <ArrayEditor
        items={v.items}
        onChange={(x) => set({ items: x })}
        addText="+ Add FAQ"
        makeNew={() => ({ cat: '', q: '', a: '' })}
        renderItem={(item, patch) => (
          <>
            <TextField label="Category id" value={item.cat} onChange={(x) => patch({ cat: x })} placeholder="tour / payments / safety / registration" />
            <TextField label="Question" value={item.q} onChange={(x) => patch({ q: x })} multiline rows={2} />
            <TextField label="Answer" value={item.a} onChange={(x) => patch({ a: x })} multiline rows={4} />
          </>
        )}
      />
    </>
  );
}

function RegistrationSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Tag (eyebrow)" value={v.tag} onChange={(x) => set({ tag: x })} />
      <TextField label="Section title" value={v.title} onChange={(x) => set({ title: x })} />
      <TextField label="Subtitle" value={v.subtitle} onChange={(x) => set({ subtitle: x })} multiline rows={2} />
      <label style={labelStyle}>School dropdown options (leave empty for free-text input)</label>
      <StringArrayEditor items={v.schoolOptions} onChange={(x) => set({ schoolOptions: x })} addText="+ Add school" placeholder="School name" />
      <TextField label="Submit-button text" value={v.submitText} onChange={(x) => set({ submitText: x })} />
      <TextField label="Success title" value={v.successTitle} onChange={(x) => set({ successTitle: x })} />
      <TextField label="Success body" value={v.successBody} onChange={(x) => set({ successBody: x })} multiline rows={2} />
      <TextField label="Lead source tag" value={v.leadSource} onChange={(x) => set({ leadSource: x })} placeholder="e.g. tmc_registration" />
      <TextField label="Lead sub-brand (tmc / rfu / travelstall / visasure)" value={v.leadSubBrand} onChange={(x) => set({ leadSubBrand: x })} />
      <TextField label="Tenant slug (for inbound routing)" value={v.tenantSlug} onChange={(x) => set({ tenantSlug: x })} />
    </>
  );
}

function BrochureSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <label style={labelStyle}>Info cards (2x2 grid)</label>
      <ArrayEditor
        items={v.infoCards}
        onChange={(x) => set({ infoCards: x })}
        addText="+ Add info card"
        makeNew={() => ({ title: '', desc: '' })}
        renderItem={(item, patch) => (
          <>
            <TextField label="Title" value={item.title} onChange={(x) => patch({ title: x })} />
            <TextField label="Description" value={item.desc} onChange={(x) => patch({ desc: x })} multiline rows={2} />
          </>
        )}
      />
      <TextField label="Pill text" value={v.pillText} onChange={(x) => set({ pillText: x })} placeholder="STILL EXPLORING?" />
      <TextField label="Section headline" value={v.headTitle} onChange={(x) => set({ headTitle: x })} />
      <TextField label="Info body paragraph" value={v.infoBody} onChange={(x) => set({ infoBody: x })} multiline rows={3} />
      <TextField label="Divider text" value={v.dividerText} onChange={(x) => set({ dividerText: x })} multiline rows={2} />
      <label style={labelStyle}>School dropdown options</label>
      <StringArrayEditor items={v.schoolOptions} onChange={(x) => set({ schoolOptions: x })} placeholder="School name" />
      <TextField label="CTA button text" value={v.ctaText} onChange={(x) => set({ ctaText: x })} />
      <TextField label="Foot note" value={v.footNote} onChange={(x) => set({ footNote: x })} />
      <TextField label="Lead source tag" value={v.leadSource} onChange={(x) => set({ leadSource: x })} placeholder="e.g. brochure_request" />
      <TextField label="Lead sub-brand" value={v.leadSubBrand} onChange={(x) => set({ leadSubBrand: x })} />
      <TextField label="Tenant slug" value={v.tenantSlug} onChange={(x) => set({ tenantSlug: x })} />
    </>
  );
}

function ContactSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <CheckboxField label="Show footer" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Brand kanji" value={v.kanji} onChange={(x) => set({ kanji: x })} placeholder="日本 (optional)" />
      <TextField label="Brand label" value={v.label} onChange={(x) => set({ label: x })} placeholder="JAPAN 2026" />
      <TextField label="Tagline" value={v.tagline} onChange={(x) => set({ tagline: x })} />
      <ImageField label="Footer logo" value={v.logoUrl} onChange={(x) => set({ logoUrl: x })} />
      <label style={labelStyle}>Footer sections (2-column grid)</label>
      <ArrayEditor
        items={v.sections}
        onChange={(x) => set({ sections: x })}
        addText="+ Add footer section"
        makeNew={() => ({ label: '', lines: [''] })}
        renderItem={(item, patch) => (
          <>
            <TextField label="Section label (e.g. EMAIL INQUIRIES)" value={item.label} onChange={(x) => patch({ label: x })} />
            <label style={labelStyle}>Lines</label>
            <StringArrayEditor items={item.lines} onChange={(x) => patch({ lines: x })} placeholder="contact line" />
          </>
        )}
      />
      <TextField label="Copyright line" value={v.copyright} onChange={(x) => set({ copyright: x })} multiline rows={2} />
    </>
  );
}

// Photo marquee — array of destination cards (tag + title + image).
// Each card has an Image upload field so operators don't need to JSON-
// edit URLs. Empty cities array hides the marquee entirely (renderer
// short-circuits via Array.isArray check).
function MarqueeSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 0.75rem', lineHeight: 1.5 }}>
        Auto-scrolling photo strip between the hero and "Why" sections.
        Each card shows a destination image with a tag + title overlay.
      </p>
      <label style={labelStyle}>Destination cards</label>
      <ArrayEditor
        items={v.cities}
        onChange={(x) => set({ cities: x })}
        addText="+ Add destination card"
        makeNew={() => ({ tag: '', title: '', img: null })}
        renderItem={(item, patch) => (
          <>
            <TextField label="Tag (e.g. ICONIC / TEMPLES / COAST)" value={item.tag} onChange={(x) => patch({ tag: x })} />
            <TextField label="Title" value={item.title} onChange={(x) => patch({ title: x })} />
            <ImageField label="Image" value={item.img} onChange={(x) => patch({ img: x })} hint="Tall photos (4:5 or portrait) work best." />
          </>
        )}
      />
    </>
  );
}

// Video preview — interactive video frame with quote + CTA. Embed URL
// accepts YouTube / Vimeo / Wistia paste, OR direct MP4 upload via
// the Upload button. Mirrors the legacy `travelVideo` block surface.
function PreviewSlot({ value, onChange }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <>
      <CheckboxField label="Show this section" value={v.show} onChange={(x) => set({ show: x })} />
      <TextField label="Kanji watermark (decorative)" value={v.kanjiWatermark} onChange={(x) => set({ kanjiWatermark: x })} placeholder="体験 (optional)" />
      <TextField label="Tag (eyebrow, e.g. INTERACTIVE PREVIEW)" value={v.tag} onChange={(x) => set({ tag: x })} />
      <TextField label="Section title" value={v.title} onChange={(x) => set({ title: x })} multiline rows={2} />
      <TextField label="Subtitle" value={v.subtitle} onChange={(x) => set({ subtitle: x })} multiline rows={2} />
      <TextField label="Italic quote (above video)" value={v.quote} onChange={(x) => set({ quote: x })} multiline rows={3} />
      <VideoField label="Video embed URL or upload" value={v.videoEmbedUrl} onChange={(x) => set({ videoEmbedUrl: x })} hint="YouTube / Vimeo / Wistia URL, or upload an MP4 / WebM directly." />
      <TextField label="CTA text" value={v.ctaText} onChange={(x) => set({ ctaText: x })} placeholder="REGISTER NOW" />
      <TextField label="CTA href" value={v.ctaHref} onChange={(x) => set({ ctaHref: x })} placeholder="#register" />
    </>
  );
}

const STRUCTURED_SLOTS = [
  { id: 'brand', label: 'Brand & partner logos', Component: BrandSlot },
  { id: 'nav', label: 'Top navigation', Component: NavSlot },
  { id: 'hero', label: 'Hero section', Component: HeroSlot },
  { id: 'marquee', label: 'Photo marquee', Component: MarqueeSlot },
  { id: 'preview', label: 'Video preview', Component: PreviewSlot },
  { id: 'programme', label: 'Programme / "Why" section', Component: ProgrammeSlot },
  { id: 'cultural', label: 'Cultural highlights (flip cards)', Component: CulturalSlot },
  { id: 'safety', label: 'Safety section', Component: SafetySlot },
  { id: 'investment', label: 'Investment / Pricing', Component: InvestmentSlot },
  { id: 'faq', label: 'FAQ section', Component: FaqSlot },
  { id: 'registration', label: 'Registration form', Component: RegistrationSlot },
  { id: 'brochure', label: 'Brochure download', Component: BrochureSlot },
  { id: 'contact', label: 'Footer / contact', Component: ContactSlot },
];

// Remaining JSON-only slots. testimonials stays JSON-edited because
// operator-only content is small + occasional; details + floatingCta
// are static decorative strips with 2-5 fields, JSON edit fits.
const JSON_SLOTS = [
  { id: 'testimonials', label: 'Testimonials (operator-only)' },
  { id: 'details', label: 'Details strip' },
  { id: 'floatingCta', label: 'Floating register CTA' },
];

export default function LandingPageTemplateEditor({ content, onChange, templateType }) {
  const [open, setOpen] = useState(() => ({
    brand: true, hero: true, faq: false, safety: false, investment: false, programme: false, cultural: false, registration: false, brochure: false, contact: false, nav: false,
  }));
  const slotValue = (id) => (content && content[id]) || undefined;
  const setSlot = (id, value) => onChange({ ...(content || {}), [id]: value });

  return (
    <div style={{ padding: '1rem 1.4rem', background: 'var(--subtle-bg)', overflowY: 'auto', height: '100%' }}>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.2rem' }}>Template editor</h2>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0 }}>
          Editing a <code style={{ background: 'var(--surface-color)', padding: '0 0.3rem', borderRadius: 3 }}>{templateType}</code> page. The renderer owns layout — you only edit content.
        </p>
      </div>
      {STRUCTURED_SLOTS.map(({ id, label, Component }) => {
        const isOpen = !!open[id];
        return (
          <div key={id} style={sectionStyle}>
            <div style={sectionTitleStyle}>
              <span>{label}</span>
              <button type="button" onClick={() => setOpen({ ...open, [id]: !isOpen })} style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, fontSize: '0.7rem', padding: '0.15rem 0.5rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                {isOpen ? 'Collapse' : 'Edit'}
              </button>
            </div>
            {isOpen && (
              <div style={{ marginTop: '0.5rem' }}>
                <Component value={slotValue(id)} onChange={(v) => setSlot(id, v)} />
              </div>
            )}
          </div>
        );
      })}
      <h3 style={{ fontSize: '0.85rem', margin: '1.2rem 0 0.5rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Other slots (JSON for now)</h3>
      {JSON_SLOTS.map(({ id, label }) => {
        const isOpen = !!open[id];
        return (
          <div key={id} style={sectionStyle}>
            <div style={sectionTitleStyle}>
              <span>{label}</span>
              <button type="button" onClick={() => setOpen({ ...open, [id]: !isOpen })} style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, fontSize: '0.7rem', padding: '0.15rem 0.5rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                {isOpen ? 'Collapse' : 'Edit'}
              </button>
            </div>
            {isOpen && (
              <div style={{ marginTop: '0.5rem' }}>
                <JsonEditor value={slotValue(id)} onChange={(v) => setSlot(id, v)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
