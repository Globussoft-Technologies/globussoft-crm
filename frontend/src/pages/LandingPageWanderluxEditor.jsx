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
 *
 * Hybrid layout (2026-06-24):
 *   The "Page Layout" panel at the top exposes the section order +
 *   show/hide + custom-block insertion. Operators can reorder any
 *   AI-generated section, hide one, or interleave Heading/Text/Image/
 *   Button/Divider/Spacer/Video/Two Columns blocks from the manual
 *   block-builder catalogue. The order is persisted under
 *   `config._layout.items[]`; the backend composer in
 *   backend/services/templates/wanderlux/layoutComposer.js mirrors it
 *   on render. Schema keys here MUST match the backend exactly.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles, Clock, MapPin, Film, AlignLeft, Star, Shield, MessageSquare,
  Wallet, ClipboardList, FileDown, HelpCircle, Megaphone, PanelBottom,
  Type, Image as ImageIcon, MousePointerClick, Minus, Space as SpaceIcon,
  Video as VideoIcon, Columns, GripVertical,
} from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { isUploadedS3Url, formatUploadFilename } from '../utils/uploadDisplay';
import UploadedAssetChip from '../components/UploadedAssetChip';

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
  const showChip = isUploadedS3Url(value);
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {showChip ? (
        <UploadedAssetChip
          url={value}
          kind="image"
          uploading={uploading}
          onReplace={() => inputRef.current && inputRef.current.click()}
          onRemove={() => onChange('')}
        />
      ) : (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input type="text" style={{ ...inputStyle, flex: 1 }} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'https://… or /uploads/…'} />
          <button
            type="button"
            onClick={() => inputRef.current && inputRef.current.click()}
            disabled={uploading}
            style={{ padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
          >
            {uploading ? '…' : 'Upload'}
          </button>
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
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
  const showChip = isUploadedS3Url(value);
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {showChip ? (
        <UploadedAssetChip
          url={value}
          kind="video"
          uploading={uploading}
          onReplace={() => inputRef.current && inputRef.current.click()}
          onRemove={() => onChange('')}
        />
      ) : (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input type="text" style={{ ...inputStyle, flex: 1 }} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'https://… (Wistia/YouTube/Vimeo embed URL) or /uploads/…'} />
          <button
            type="button"
            onClick={() => inputRef.current && inputRef.current.click()}
            disabled={uploading}
            style={{ padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
          >
            {uploading ? '…' : 'Upload'}
          </button>
        </div>
      )}
      <input ref={inputRef} type="file" accept="video/*" onChange={handleFile} style={{ display: 'none' }} />
    </div>
  );
}

/**
 * Document URL input + Upload button. Used for the brochure section's
 * `fileUrl` field — operator either pastes a hosted-PDF link (Drive, S3,
 * etc.) or uploads a PDF/DOC/PPT via /api/landing-pages/upload-document.
 * Mirrors ImageField / VideoField so the affordance feels familiar.
 *
 * The returned URL is set into the value via onChange; the wanderlux
 * brochure section's success-card surfaces a direct Download CTA when
 * the field is non-empty.
 */
function FileField({ label, value, onChange, placeholder, accept }) {
  const notify = useNotify();
  const [uploading, setUploading] = useState(false);
  // Local draft for the "paste a link" input so typing doesn't flip the field
  // into the filename-chip view on the first keystroke; committed on blur/Enter.
  const [linkDraft, setLinkDraft] = useState('');
  const inputRef = React.useRef(null);
  const handleFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    // 150 MB matches the backend's DOC_UPLOAD_SIZE_BYTES cap. Larger
    // files fail at the multer layer with a friendly 400; the client-
    // side check just spares the round-trip.
    if (f.size > 150 * 1024 * 1024) {
      notify.error('Document too large (max 150 MB)');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('document', f);
      const res = await fetchApi('/api/landing-pages/upload-document', { method: 'POST', body: fd });
      if (res && res.url) {
        onChange(res.url);
        notify.success('Document uploaded');
      }
    } catch (_e) {
      notify.error('Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  // Friendly filename for display — the basename of the stored URL with the
  // leading "<timestamp>-" prefix(es) stripped (S3 keys are "<ts>-<name>.pdf";
  // legacy uploads were double-timestamped). Falls back to the raw value.
  const displayName = formatUploadFilename(value);
  const btnStyle = { padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' };
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {value ? (
        // A file is set — show just the filename (not the full URL), plus
        // Replace (re-upload) and Remove.
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span
            title={displayName}
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.6rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--bg-color)', fontSize: '0.8rem', color: 'var(--text-primary)', overflow: 'hidden' }}
          >
            <span aria-hidden="true">📄</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
          </span>
          <button type="button" onClick={() => inputRef.current && inputRef.current.click()} disabled={uploading} style={btnStyle}>
            {uploading ? '…' : 'Replace'}
          </button>
          <button type="button" onClick={() => { onChange(''); setLinkDraft(''); }} disabled={uploading} style={{ ...btnStyle, color: 'var(--text-secondary)' }}>
            Remove
          </button>
        </div>
      ) : (
        // Empty — paste a hosted link (committed on blur / Enter so typing
        // doesn't flip to the chip mid-entry) or upload a file.
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            style={{ ...inputStyle, flex: 1 }}
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onBlur={() => { const v = linkDraft.trim(); if (v) onChange(v); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = linkDraft.trim(); if (v) onChange(v); } }}
            placeholder={placeholder || 'https://… paste a link (press Enter) or upload'}
          />
          <button type="button" onClick={() => inputRef.current && inputRef.current.click()} disabled={uploading} style={btnStyle}>
            {uploading ? '…' : 'Upload'}
          </button>
        </div>
      )}
      <input ref={inputRef} type="file" accept={accept || '.pdf,.doc,.docx,.ppt,.pptx,application/pdf'} onChange={handleFile} style={{ display: 'none' }} />
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

// Hero eyebrow split into two friendlier inputs (Dates + Audience).
// The persisted shape is a single `hero.eyebrow` string with the two
// halves joined by " | " (matches the template's expectations).
//
// Why this is its own component: a previous inline implementation
// re-derived the field values from `cfg.hero.eyebrow` on every render
// AND called `.trim()` on the user's input inside onChange. That
// combination ate trailing spaces — the moment the operator pressed
// space, the trim erased it before the next character could land,
// making the field feel "broken when typing spaces".
//
// Fix: hold the two halves in local state. The eyebrow is only re-
// derived from `cfg` when it changes from an external source (Raw
// JSON edit, page reload) — the `lastWroteRef` distinguishes those
// from our own writes so we don't echo-trim mid-typing.
// Heuristic: separator-less legacy strings that LOOK like an audience
// (no digits, no month-like tokens — pure phrasing like "SCHOOL STUDENTS"
// or "GRADES 6-12 TRAVELLERS") should land in the Audience slot, not the
// Dates slot. Anything containing digits, month abbreviations, or date
// separators (' - ', '–', '/', '.') is treated as Dates. Used both for
// initial parse of existing data and for the post-load useEffect re-derive.
const MONTH_TOKEN_RE = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b/i;
function splitHeroEyebrow(raw) {
  const s = String(raw || '');
  if (s.includes('|')) {
    const parts = s.split('|');
    return { dates: (parts[0] || '').trim(), audience: (parts.slice(1).join('|') || '').trim() };
  }
  const t = s.trim();
  if (!t) return { dates: '', audience: '' };
  const looksLikeDates = /\d/.test(t) || MONTH_TOKEN_RE.test(t) || /[-–/.]/.test(t);
  return looksLikeDates ? { dates: t, audience: '' } : { dates: '', audience: t };
}

function HeroEyebrowFields({ cfg, setPath }) {
  const eyebrow = (cfg && cfg.hero && cfg.hero.eyebrow) || '';
  const initial = splitHeroEyebrow(eyebrow);
  const [dates, setDates] = useState(() => initial.dates);
  const [audience, setAudience] = useState(() => initial.audience);
  const lastWroteRef = useRef(eyebrow);

  useEffect(() => {
    // External change to eyebrow (Raw JSON / load) — re-derive halves.
    // Skip when the change is our own write, otherwise typing would
    // bounce through the trim and lose trailing spaces.
    if (eyebrow === lastWroteRef.current) return;
    const parts = splitHeroEyebrow(eyebrow);
    setDates(parts.dates);
    setAudience(parts.audience);
    lastWroteRef.current = eyebrow;
  }, [eyebrow]);

  const commit = (nextDates, nextAudience) => {
    const dt = String(nextDates || '').trim();
    const au = String(nextAudience || '').trim();
    // Round-trip shape contract:
    //   both halves filled →  "DATES | AUDIENCE"
    //   dates only         →  "DATES"          (legacy, separator-less)
    //   audience only      →  " | AUDIENCE"    (LEADING sep so a later
    //                                          read still routes the
    //                                          token to the right slot)
    //   both empty         →  ""
    let eb = '';
    if (dt && au) eb = `${dt} | ${au}`;
    else if (dt) eb = dt;
    else if (au) eb = ` | ${au}`;
    lastWroteRef.current = eb;
    setPath(['hero', 'eyebrow'], eb);
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <div style={{ flex: 1 }}>
        <TextField
          label="Dates of travel"
          value={dates}
          onChange={(v) => { setDates(v); commit(v, audience); }}
          placeholder="SEPT – OCT 2026"
        />
      </div>
      <div style={{ flex: 1 }}>
        <TextField
          label="Audience"
          value={audience}
          onChange={(v) => { setAudience(v); commit(dates, v); }}
          placeholder="GRADES 6-12 / TRAVELLERS"
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Hybrid layout — section catalogue + custom-block editors.
// Mirrors backend/services/templates/wanderlux/layoutComposer.js. If
// you add / rename / remove an entry here, update the backend list in
// lockstep or the layout will silently drop the section on render.
// ─────────────────────────────────────────────────────────────────

const LAYOUT_SECTIONS = [
  { key: 'hero', label: 'Hero', icon: Sparkles },
  { key: 'countdown', label: 'Countdown', icon: Clock },
  { key: 'cities', label: 'City marquee', icon: MapPin },
  { key: 'video', label: 'Video / preview', icon: Film },
  { key: 'intro', label: 'Intro', icon: AlignLeft },
  { key: 'highlights', label: 'Highlights (flip cards)', icon: Star },
  { key: 'safety', label: 'Safety', icon: Shield },
  { key: 'testimonials', label: 'Testimonials', icon: MessageSquare },
  { key: 'investment', label: 'Investment (pricing)', icon: Wallet },
  { key: 'register', label: 'Registration form', icon: ClipboardList },
  { key: 'brochure', label: 'Brochure download', icon: FileDown },
  { key: 'faqs', label: 'FAQs', icon: HelpCircle },
  { key: 'finalCta', label: 'Final CTA', icon: Megaphone },
  { key: 'footer', label: 'Footer', icon: PanelBottom },
];

const SECTION_BY_KEY = LAYOUT_SECTIONS.reduce((acc, s) => {
  acc[s.key] = s;
  return acc;
}, {});
const SECTION_LABEL_BY_KEY = LAYOUT_SECTIONS.reduce((acc, s) => {
  acc[s.key] = s.label;
  return acc;
}, {});

// Curated section arrangements — operators apply one with a single
// click to swap their layout to a known-good shape. "Default" maps
// back to the template's native order (= identical to never having
// touched _layout). Items not present in a preset are HIDDEN — the
// preset is the *entire* section list, not a starting point.
const LAYOUT_PRESETS = [
  { id: 'default',    label: 'Default',     keys: LAYOUT_SECTIONS.map((s) => s.key) },
  { id: 'conversion', label: 'Conversion',  keys: ['hero', 'countdown', 'register', 'investment', 'safety', 'faqs', 'finalCta', 'footer'] },
  { id: 'story',      label: 'Story',       keys: ['hero', 'intro', 'cities', 'highlights', 'video', 'safety', 'investment', 'register', 'faqs', 'footer'] },
  { id: 'pricing',    label: 'Pricing',     keys: ['hero', 'investment', 'register', 'safety', 'highlights', 'faqs', 'footer'] },
];

// Custom-block lucide icons (mirrors LandingPageBuilder.jsx's
// COMPONENT_TYPES icon registry so a Heading block looks the same in
// both editors). Kept here so it stays in lockstep with
// CUSTOM_BLOCK_CATALOGUE below.
const CUSTOM_BLOCK_ICON = {
  heading: Type,
  text: AlignLeft,
  image: ImageIcon,
  button: MousePointerClick,
  divider: Minus,
  spacer: SpaceIcon,
  video: VideoIcon,
  columns: Columns,
};

const CUSTOM_BLOCK_CATALOGUE = [
  { type: 'heading', label: 'Heading', defaultProps: { text: 'Headline', level: 'h2', align: 'center', color: '#1a1a1a' } },
  { type: 'text', label: 'Text', defaultProps: { text: 'Paragraph copy.', align: 'left', color: '#444', fontSize: '16px' } },
  { type: 'image', label: 'Image', defaultProps: { src: '', alt: '', maxWidth: '100%' } },
  { type: 'button', label: 'Button', defaultProps: { text: 'Click here', url: '#', bgColor: '#2563eb', color: '#ffffff', align: 'center', size: 'medium' } },
  { type: 'divider', label: 'Divider', defaultProps: { color: '#e5e7eb', margin: '24px' } },
  { type: 'spacer', label: 'Spacer', defaultProps: { height: '32px' } },
  { type: 'video', label: 'Video', defaultProps: { url: '', width: '100%' } },
  {
    type: 'columns',
    label: 'Two columns',
    defaultProps: {
      gap: '2rem',
      columns: [
        { components: [{ id: `b_${Date.now()}_L`, type: 'text', props: { text: 'Left column' } }] },
        { components: [{ id: `b_${Date.now()}_R`, type: 'text', props: { text: 'Right column' } }] },
      ],
    },
  },
];

const CUSTOM_BLOCK_BY_TYPE = CUSTOM_BLOCK_CATALOGUE.reduce((acc, b) => {
  acc[b.type] = b;
  return acc;
}, {});

function newBlockId() {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// The "effective" layout is what the renderer would actually display.
// When `_layout.items` is missing we synthesise the default order so
// the UI has something to show — saving any operator action then
// freezes that order into `_layout.items`.
function effectiveLayoutItems(cfg) {
  const items = cfg && cfg._layout && Array.isArray(cfg._layout.items) ? cfg._layout.items : null;
  if (items && items.length > 0) return items;
  return LAYOUT_SECTIONS.map((s) => ({ kind: 'section', key: s.key }));
}

function hiddenSectionKeys(items) {
  const visible = new Set(items.filter((it) => it.kind === 'section').map((it) => it.key));
  return LAYOUT_SECTIONS.filter((s) => !visible.has(s.key)).map((s) => s.key);
}

// ── per-type inline editors ──────────────────────────────────────

function HeadingBlockEditor({ props, onChange }) {
  return (
    <>
      <TextField label="Text" value={props.text} onChange={(v) => onChange({ ...props, text: v })} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Level</label>
          <select style={inputStyle} value={props.level || 'h2'} onChange={(e) => onChange({ ...props, level: e.target.value })}>
            <option value="h1">H1</option>
            <option value="h2">H2</option>
            <option value="h3">H3</option>
            <option value="h4">H4</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Align</label>
          <select style={inputStyle} value={props.align || 'center'} onChange={(e) => onChange({ ...props, align: e.target.value })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
      </div>
      <TextField label="Color" value={props.color} onChange={(v) => onChange({ ...props, color: v })} placeholder="#1a1a1a" />
    </>
  );
}

function TextBlockEditor({ props, onChange }) {
  return (
    <>
      <TextArea label="Text" value={props.text} onChange={(v) => onChange({ ...props, text: v })} rows={3} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Align</label>
          <select style={inputStyle} value={props.align || 'left'} onChange={(e) => onChange({ ...props, align: e.target.value })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <TextField label="Font size" value={props.fontSize} onChange={(v) => onChange({ ...props, fontSize: v })} placeholder="16px" />
        </div>
      </div>
      <TextField label="Color" value={props.color} onChange={(v) => onChange({ ...props, color: v })} placeholder="#444" />
    </>
  );
}

function ImageBlockEditor({ props, onChange }) {
  return (
    <>
      <ImageField label="Image" value={props.src} onChange={(v) => onChange({ ...props, src: v })} />
      <TextField label="Alt text" value={props.alt} onChange={(v) => onChange({ ...props, alt: v })} />
      <TextField label="Max width" value={props.maxWidth} onChange={(v) => onChange({ ...props, maxWidth: v })} placeholder="100% or 600px" />
    </>
  );
}

function ButtonBlockEditor({ props, onChange }) {
  return (
    <>
      <TextField label="Label" value={props.text} onChange={(v) => onChange({ ...props, text: v })} />
      <TextField label="URL" value={props.url} onChange={(v) => onChange({ ...props, url: v })} placeholder="https://… or #register" />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <div style={{ flex: 1 }}>
          <TextField label="Background" value={props.bgColor} onChange={(v) => onChange({ ...props, bgColor: v })} placeholder="#2563eb" />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label="Text colour" value={props.color} onChange={(v) => onChange({ ...props, color: v })} placeholder="#ffffff" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Align</label>
          <select style={inputStyle} value={props.align || 'center'} onChange={(e) => onChange({ ...props, align: e.target.value })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Size</label>
          <select style={inputStyle} value={props.size || 'medium'} onChange={(e) => onChange({ ...props, size: e.target.value })}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </div>
      </div>
    </>
  );
}

function DividerBlockEditor({ props, onChange }) {
  return (
    <>
      <TextField label="Color" value={props.color} onChange={(v) => onChange({ ...props, color: v })} placeholder="#e5e7eb" />
      <TextField label="Margin" value={props.margin} onChange={(v) => onChange({ ...props, margin: v })} placeholder="24px" />
    </>
  );
}

function SpacerBlockEditor({ props, onChange }) {
  return <TextField label="Height" value={props.height} onChange={(v) => onChange({ ...props, height: v })} placeholder="32px" />;
}

function VideoBlockEditor({ props, onChange }) {
  return (
    <>
      <VideoField label="Video URL / upload" value={props.url} onChange={(v) => onChange({ ...props, url: v })} />
      <TextField label="Width" value={props.width} onChange={(v) => onChange({ ...props, width: v })} placeholder="100% or 800px" />
    </>
  );
}

// Two-Columns editor — kept intentionally simple: each column holds a
// single Text block whose copy is editable inline. Operators who need
// richer column contents can reach for the Raw JSON escape hatch or
// duplicate the column block at runtime. The shape persisted matches
// the manual builder so the public renderer treats them identically.
function ColumnsBlockEditor({ props, onChange }) {
  const cols = Array.isArray(props.columns) ? props.columns : [];
  const leftText =
    (cols[0] && cols[0].components && cols[0].components[0] && cols[0].components[0].props && cols[0].components[0].props.text) || '';
  const rightText =
    (cols[1] && cols[1].components && cols[1].components[0] && cols[1].components[0].props && cols[1].components[0].props.text) || '';
  const setColText = (idx, text) => {
    const nextCols = [cols[0] || { components: [] }, cols[1] || { components: [] }];
    const existing = nextCols[idx].components && nextCols[idx].components[0];
    const block = {
      id: (existing && existing.id) || newBlockId(),
      type: 'text',
      props: { ...(existing && existing.props), text },
    };
    nextCols[idx] = { components: [block] };
    onChange({ ...props, columns: nextCols });
  };
  return (
    <>
      <TextField label="Gap" value={props.gap} onChange={(v) => onChange({ ...props, gap: v })} placeholder="2rem" />
      <TextArea label="Left column text" value={leftText} onChange={(v) => setColText(0, v)} rows={3} />
      <TextArea label="Right column text" value={rightText} onChange={(v) => setColText(1, v)} rows={3} />
      <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: '0.4rem 0 0' }}>
        For richer column layouts, use the Raw JSON section below.
      </p>
    </>
  );
}

function CustomBlockEditor({ block, onChange }) {
  const setProps = (next) => onChange({ ...block, props: next });
  switch (block.type) {
    case 'heading': return <HeadingBlockEditor props={block.props || {}} onChange={setProps} />;
    case 'text': return <TextBlockEditor props={block.props || {}} onChange={setProps} />;
    case 'image': return <ImageBlockEditor props={block.props || {}} onChange={setProps} />;
    case 'button': return <ButtonBlockEditor props={block.props || {}} onChange={setProps} />;
    case 'divider': return <DividerBlockEditor props={block.props || {}} onChange={setProps} />;
    case 'spacer': return <SpacerBlockEditor props={block.props || {}} onChange={setProps} />;
    case 'video': return <VideoBlockEditor props={block.props || {}} onChange={setProps} />;
    case 'columns': return <ColumnsBlockEditor props={block.props || {}} onChange={setProps} />;
    default:
      return <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Unsupported block type: {block.type}</p>;
  }
}

function customBlockSummary(block) {
  const p = block.props || {};
  switch (block.type) {
    case 'heading':
    case 'text': return (p.text || '').slice(0, 60);
    case 'image': return p.alt || (p.src ? p.src.split('/').pop() : '');
    case 'button': return p.text || '';
    case 'video': return p.url ? p.url.replace(/^https?:\/\//, '').slice(0, 40) : '';
    case 'divider': return 'horizontal rule';
    case 'spacer': return p.height || '32px';
    case 'columns': return 'two columns';
    default: return '';
  }
}

// Sortable row — wraps each layout item with dnd-kit's `useSortable`
// hook. Defined at module scope (not inside LayoutPanel) so React
// keeps the same component identity across renders — otherwise the
// useSortable hook would re-register on every parent render and drag
// state would reset mid-drag.
function SortableLayoutItem(props) {
  const {
    id, it, idx, total, isOpen, isFocused, title, summary, IconCmp,
    move, removeItem, updateBlock, setOpenBlockIdx, setFocusedIdx,
  } = props;
  const isSection = it.kind === 'section';
  const sortable = useSortable({ id });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const ctrlBtnStyle = (disabled) => ({
    background: 'none',
    border: '1px solid var(--border-color)',
    borderRadius: 4,
    padding: '0.18rem 0.4rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.35 : 1,
    color: 'var(--text-secondary)',
    fontSize: '0.72rem',
    lineHeight: 1,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    border: `1px solid ${isOpen || isFocused ? 'var(--accent-color)' : 'var(--border-color)'}`,
    borderRadius: 5,
    padding: '0.45rem 0.55rem',
    background: 'var(--bg-color)',
    marginBottom: '0.15rem',
    boxShadow: isDragging ? '0 4px 12px rgba(0,0,0,0.2)' : 'none',
    opacity: isDragging ? 0.85 : 1,
    outline: isFocused ? '2px solid var(--accent-color)' : 'none',
    outlineOffset: -1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={() => setFocusedIdx(idx)}
      role="listitem"
      data-wlx-panel-item={id}
    >
      {/* Row 1: drag handle + kind icon + title (always fits) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', minWidth: 0 }}>
        <button
          type="button"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: 'none',
            border: 'none',
            padding: '0.1rem 0.05rem',
            cursor: 'grab',
            color: 'var(--text-secondary)',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          <GripVertical size={14} />
        </button>
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: isSection ? 'var(--text-secondary)' : 'var(--accent-color)',
          }}
        >
          {IconCmp ? <IconCmp size={14} /> : null}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '0.82rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={title}
          >
            {title}
          </div>
          {summary && (
            <div
              style={{
                fontSize: '0.68rem',
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={summary}
            >
              {summary}
            </div>
          )}
        </div>
      </div>

      {/* Row 2: controls (right-aligned) */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.25rem', marginTop: '0.35rem' }}>
        <button type="button" onClick={(e) => { e.stopPropagation(); move(idx, -1); }} disabled={idx === 0} aria-label="Move up" title="Move up" style={ctrlBtnStyle(idx === 0)}>↑</button>
        <button type="button" onClick={(e) => { e.stopPropagation(); move(idx, 1); }} disabled={idx === total - 1} aria-label="Move down" title="Move down" style={ctrlBtnStyle(idx === total - 1)}>↓</button>
        {!isSection && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpenBlockIdx(isOpen ? null : idx); }}
            aria-label={isOpen ? 'Collapse' : 'Edit'}
            title={isOpen ? 'Collapse' : 'Edit'}
            style={{ ...ctrlBtnStyle(false), padding: '0.18rem 0.55rem' }}
          >
            {isOpen ? 'Close' : 'Edit'}
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); removeItem(idx); }}
          aria-label={isSection ? 'Hide section' : 'Delete block'}
          title={isSection ? 'Hide section' : 'Delete block'}
          style={{ ...ctrlBtnStyle(false), color: '#e57373' }}
        >
          ✕
        </button>
      </div>

      {isOpen && (
        <div style={{ marginTop: '0.55rem', paddingTop: '0.55rem', borderTop: '1px solid var(--border-color)' }}>
          <CustomBlockEditor block={it} onChange={(next) => updateBlock(idx, next)} />
        </div>
      )}
    </div>
  );
}

// Stable item-id per row — sections use the section key; custom blocks
// use their generated id. Sortable contexts require stable ids across
// renders.
function itemId(it) {
  return it.kind === 'section' ? `s-${it.key}` : `b-${it.id}`;
}

// Compact layout panel — built for the narrow (~280-360px) right-side
// aside in the builder. Two-row layout per item keeps the label fully
// readable; controls sit on a dedicated bottom row so they don't
// truncate at narrow widths. Exported so LandingPageBuilder.jsx can
// mount it inside its `<aside>` alongside the existing Page metadata +
// TEE Decision Panel.
export function LayoutPanel({ cfg, onChange, isDirty = false }) {
  const items = effectiveLayoutItems(cfg);
  const hidden = hiddenSectionKeys(items);
  const [openBlockIdx, setOpenBlockIdx] = useState(null);
  // `addAtIdx` is the SLOT (gap) index the operator is inserting at.
  // null = no add tray open; 0 = top slot (before items[0]);
  // items.length = bottom slot (after items[items.length-1]); N = the
  // gap between items[N-1] and items[N]. Replaces the old
  // single-position append-at-end behaviour so admins can drop a block
  // exactly where they want it.
  const [addAtIdx, setAddAtIdx] = useState(null);
  // Hidden-sections tray is collapsed by default so the panel stays
  // compact when nothing is hidden; opens with a click when there's
  // hidden content to restore.
  const [hiddenOpen, setHiddenOpen] = useState(false);

  const commit = (nextItems) => {
    const next = JSON.parse(JSON.stringify(cfg || {}));
    next._layout = { ...(next._layout || {}), items: nextItems };
    onChange(next);
  };

  const move = (idx, delta) => {
    const next = [...items];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    const [it] = next.splice(idx, 1);
    next.splice(target, 0, it);
    commit(next);
  };

  const removeItem = (idx) => {
    const next = [...items];
    next.splice(idx, 1);
    if (openBlockIdx === idx) setOpenBlockIdx(null);
    commit(next);
  };

  const updateBlock = (idx, nextBlock) => {
    const next = [...items];
    next[idx] = nextBlock;
    commit(next);
  };

  // Append-only "show this hidden section" — used by the Hidden tray
  // at the bottom of the panel. Drops the section at the END of the
  // layout. For slot-precise insertion, see `addSectionAt` below.
  const showSection = (key) => {
    commit([...items, { kind: 'section', key }]);
  };

  // Insert a template section at a specific slot (used by the + Insert
  // tray). Mirrors `addBlock` so operators can drop a section like
  // "Brochure download" between two existing rows instead of being
  // forced to append at the end + drag it up.
  const addSectionAt = (key) => {
    if (!key || items.some((it) => it.kind === 'section' && it.key === key)) return;
    const insertAt = addAtIdx == null ? items.length : addAtIdx;
    const next = [...items];
    next.splice(insertAt, 0, { kind: 'section', key });
    commit(next);
    setAddAtIdx(null);
    setFocusedIdx(insertAt);
  };

  const addBlock = (type) => {
    const catalogue = CUSTOM_BLOCK_BY_TYPE[type];
    if (!catalogue) return;
    const block = {
      kind: 'block',
      id: newBlockId(),
      type,
      props: JSON.parse(JSON.stringify(catalogue.defaultProps)),
    };
    const insertAt = addAtIdx == null ? items.length : addAtIdx;
    const next = [...items];
    next.splice(insertAt, 0, block);
    commit(next);
    setAddAtIdx(null);
    setOpenBlockIdx(insertAt); // open the newly-inserted block for editing
  };

  // #4 — preset application. Replaces the entire layout with the
  // preset's section list. Custom blocks are dropped (presets are
  // section-only — operators re-add custom blocks afterwards).
  const applyPreset = (id) => {
    const preset = LAYOUT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    commit(preset.keys.map((key) => ({ kind: 'section', key })));
    setOpenBlockIdx(null);
    setFocusedIdx(null);
  };

  // #1 — dnd-kit sortable. `sortableIds` is the stable string list dnd
  // uses to identify items; `onDragEnd` reorders the items array
  // accordingly. PointerSensor activates after a 6px movement so a
  // simple click on a row still hits the focus handler.
  const [focusedIdx, setFocusedIdx] = useState(null);
  const listRef = useRef(null);
  const sortableIds = items.map(itemId);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sortableIds.indexOf(active.id);
    const newIdx = sortableIds.indexOf(over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = [...items];
    const [moved] = next.splice(oldIdx, 1);
    next.splice(newIdx, 0, moved);
    commit(next);
  };

  // Clear focus when the items array changes shape (e.g. add/remove
  // shifts indexes). Stops a stale focusedIdx from highlighting the
  // wrong row.
  useEffect(() => {
    if (focusedIdx != null && focusedIdx >= items.length) setFocusedIdx(null);
  }, [items.length, focusedIdx]);

  // #2 — postMessage listener for canvas clicks from the live preview.
  // The wanderlux renderer injects a small bridge that posts
  // `{ type: 'wlx-canvas-click', kind, id }` when a section / custom
  // block in the rendered HTML is clicked. We map that back to the
  // matching items[] index, scroll the row into view, and focus it so
  // the operator can keep working with arrow keys / Edit / Delete.
  // Origin check: only accept messages whose `source` is window.opener
  // (the preview popup) or a child iframe — drops third-party messages
  // injected via browser extensions.
  useEffect(() => {
    const onMsg = (e) => {
      const data = e && e.data;
      if (!data || data.type !== 'wlx-canvas-click') return;
      // The preview popup's window object is reachable via e.source.
      // We don't pin to a specific origin because the popup may be on
      // the same host but a different port in local dev. Tighten if you
      // ever serve the preview on a separate domain.
      const idx = items.findIndex((it) => {
        if (data.kind === 'section') return it.kind === 'section' && it.key === data.id;
        if (data.kind === 'block') return it.kind === 'block' && it.id === data.id;
        return false;
      });
      if (idx < 0) return;
      setFocusedIdx(idx);
      // Scroll the corresponding panel row into view.
      const node = listRef.current && listRef.current.querySelector(
        `[data-wlx-panel-item="${itemId(items[idx])}"]`,
      );
      if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [items]);

  // #6 — keyboard shortcuts scoped to the list element:
  //   Alt+↑ / Alt+↓   reorder the focused item
  //   ↑   / ↓         move focus between items
  //   Delete / Backspace   hide section / delete block
  //   Enter           toggle edit on custom blocks
  //   Escape          clear focus
  // Scoped to the list root (not window) so it only fires when the
  // operator is interacting with the panel.
  const onListKeyDown = (e) => {
    if (focusedIdx == null) return;
    const isInForm = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable);
    if (isInForm) return;
    const key = e.key;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      const delta = key === 'ArrowUp' ? -1 : 1;
      if (e.altKey) {
        // Alt+arrow → reorder
        move(focusedIdx, delta);
        const target = focusedIdx + delta;
        if (target >= 0 && target < items.length) setFocusedIdx(target);
      } else {
        // Plain arrow → move focus
        const target = focusedIdx + delta;
        if (target >= 0 && target < items.length) setFocusedIdx(target);
      }
    } else if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      removeItem(focusedIdx);
    } else if (key === 'Enter') {
      const it = items[focusedIdx];
      if (it && it.kind === 'block') {
        e.preventDefault();
        setOpenBlockIdx(openBlockIdx === focusedIdx ? null : focusedIdx);
      }
    } else if (key === 'Escape') {
      setFocusedIdx(null);
    }
  };

  // Inline "+" insertion slot between adjacent items. Stays minimal
  // when idle (a single thin centred plus); on hover or when this slot
  // is the open one, expands to a full-width tray of block-type
  // buttons. Lets operators drop a block at a precise position without
  // first inserting at the bottom and then moving it up.
  const renderInsertSlot = (slotIdx) => {
    const open = addAtIdx === slotIdx;
    if (open) {
      // Template-section buttons go ABOVE the custom-block buttons so
      // operators reach for full sections (Brochure download, FAQs,
      // etc.) first. Only sections NOT already in the layout appear
      // here — once added they vanish from the picker (each section can
      // appear at most once).
      const availableSections = hidden;
      const trayHeadingStyle = {
        width: '100%',
        fontSize: '0.6rem',
        fontWeight: 700,
        color: 'var(--text-secondary)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        margin: '0 0 0.25rem',
      };
      return (
        <div
          key={`slot-${slotIdx}-open`}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.3rem',
            padding: '0.45rem',
            border: '1px solid var(--accent-color)',
            borderRadius: 5,
            background: 'var(--bg-color)',
            margin: '0.15rem 0',
          }}
        >
          {availableSections.length > 0 && (
            <>
              <div style={trayHeadingStyle}>Template sections</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', width: '100%', marginBottom: '0.35rem' }}>
                {availableSections.map((key) => {
                  const SectionIcon = SECTION_BY_KEY[key] && SECTION_BY_KEY[key].icon;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => addSectionAt(key)}
                      style={{ background: 'var(--surface-color)', border: '1px solid var(--accent-color)', borderRadius: 4, padding: '0.3rem 0.55rem', cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.72rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                    >
                      {SectionIcon ? <SectionIcon size={12} /> : null}
                      + {SECTION_LABEL_BY_KEY[key] || key}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div style={trayHeadingStyle}>Custom blocks</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', width: '100%' }}>
            {CUSTOM_BLOCK_CATALOGUE.map((c) => (
              <button
                key={c.type}
                type="button"
                onClick={() => addBlock(c.type)}
                style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '0.3rem 0.55rem', cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.72rem' }}
              >
                + {c.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAddAtIdx(null)}
              style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, padding: '0.3rem 0.55rem', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.72rem', marginLeft: 'auto' }}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <button
        key={`slot-${slotIdx}`}
        type="button"
        onClick={() => { setAddAtIdx(slotIdx); setOpenBlockIdx(null); }}
        aria-label="Insert block here"
        title="Insert a custom block here"
        className="wlx-insert-slot"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'pointer',
          height: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
          opacity: 0.35,
          transition: 'opacity 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.35'; }}
      >
        <span style={{ flex: 1, height: 1, background: 'var(--accent-color)', opacity: 0.6 }} />
        <span
          style={{
            margin: '0 0.4rem',
            fontSize: '0.7rem',
            fontWeight: 600,
            color: 'var(--accent-color)',
            letterSpacing: '0.04em',
          }}
        >
          + Insert
        </span>
        <span style={{ flex: 1, height: 1, background: 'var(--accent-color)', opacity: 0.6 }} />
      </button>
    );
  };

  return (
    <div style={{ marginBottom: '1rem' }}>
      <h4
        style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '0.5rem',
          borderBottom: '1px solid var(--border-color)',
          paddingBottom: '0.35rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          Page layout
          {isDirty && (
            <span
              title="Unsaved changes — click Save (top-right)"
              style={{
                fontSize: '0.6rem',
                fontWeight: 600,
                color: '#f59e0b',
                background: 'rgba(245,158,11,0.12)',
                padding: '0.1rem 0.4rem',
                borderRadius: 999,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
              Unsaved
            </span>
          )}
        </span>
        <span style={{ fontSize: '0.62rem', fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'none', letterSpacing: 0 }}>
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </h4>

      {/* Preset row — single-click swaps the whole layout to one of
          three curated arrangements + a "Default" that restores the
          template's native section order. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.5rem' }}>
        {LAYOUT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPreset(p.id)}
            title={`Apply "${p.label}" arrangement`}
            style={{
              background: 'var(--surface-color)',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              padding: '0.25rem 0.55rem',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              fontSize: '0.7rem',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: '0 0 0.6rem', lineHeight: 1.45 }}>
        Drag to reorder · click to focus, then <kbd style={{ fontSize: '0.62rem' }}>Alt+↑/↓</kbd> reorders · <kbd style={{ fontSize: '0.62rem' }}>Del</kbd> removes · <kbd style={{ fontSize: '0.62rem' }}>Enter</kbd> edits.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => setFocusedIdx(null)}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div
            ref={listRef}
            role="list"
            tabIndex={0}
            onKeyDown={onListKeyDown}
            style={{ display: 'flex', flexDirection: 'column', outline: 'none' }}
          >
            {/* Top insertion slot (before items[0]) */}
            {renderInsertSlot(0)}
            {items.map((it, idx) => {
              const isSection = it.kind === 'section';
              const title = isSection
                ? (SECTION_LABEL_BY_KEY[it.key] || it.key)
                : ((CUSTOM_BLOCK_BY_TYPE[it.type] && CUSTOM_BLOCK_BY_TYPE[it.type].label) || it.type);
              const summary = isSection ? '' : customBlockSummary(it);
              const isOpen = !isSection && openBlockIdx === idx;
              const IconCmp = isSection
                ? (SECTION_BY_KEY[it.key] && SECTION_BY_KEY[it.key].icon)
                : CUSTOM_BLOCK_ICON[it.type];
              return (
                <React.Fragment key={sortableIds[idx]}>
                  <SortableLayoutItem
                    id={sortableIds[idx]}
                    it={it}
                    idx={idx}
                    total={items.length}
                    isOpen={isOpen}
                    isFocused={focusedIdx === idx}
                    title={title}
                    summary={summary}
                    IconCmp={IconCmp}
                    move={move}
                    removeItem={removeItem}
                    updateBlock={updateBlock}
                    setOpenBlockIdx={setOpenBlockIdx}
                    setFocusedIdx={(i) => { setFocusedIdx(i); if (listRef.current) listRef.current.focus(); }}
                  />
                  {/* Insertion slot AFTER this item (= before items[idx + 1]) */}
                  {renderInsertSlot(idx + 1)}
                </React.Fragment>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* Hidden-sections tray — collapsed by default with a count badge
          so the panel stays compact when nothing is hidden. */}
      {hidden.length > 0 && (
        <div style={{ marginTop: '0.7rem', paddingTop: '0.55rem', borderTop: '1px dashed var(--border-color)' }}>
          <button
            type="button"
            onClick={() => setHiddenOpen(!hiddenOpen)}
            aria-expanded={hiddenOpen}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.62rem',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-secondary)',
              fontWeight: 600,
              marginBottom: hiddenOpen ? '0.4rem' : 0,
            }}
          >
            <span>Hidden ({hidden.length})</span>
            <span aria-hidden style={{ fontSize: '0.7rem', lineHeight: 1 }}>{hiddenOpen ? '▾' : '▸'}</span>
          </button>
          {hiddenOpen && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
              {hidden.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => showSection(key)}
                  style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '0.25rem 0.5rem', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.7rem' }}
                >
                  + Show {SECTION_LABEL_BY_KEY[key] || key}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LandingPageWanderluxEditor({ content, onChange, page }) {
  const notify = useNotify();
  const cfg = content || {};
  const [open, setOpen] = useState({
    brand: true, hero: true, countdown: false, cities: true, video: false,
    intro: false, highlights: false, safety: false, testimonials: false,
    investment: false, register: false, brochure: false, faqs: false,
    finalCta: false, footer: false, raw: false,
  });
  const [syncingInvestment, setSyncingInvestment] = useState(false);

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

  const syncInvestmentFromTrip = async () => {
    if (!page || !page.id || !page.tripId) {
      notify.error('Page must be linked to a trip to sync investment pricing');
      return;
    }
    setSyncingInvestment(true);
    try {
      const res = await fetchApi(`/api/landing-pages/${page.id}/sync-investment`, {
        method: 'POST',
      });
      if (res.success) {
        // Update installments from response
        const next = JSON.parse(JSON.stringify(cfg));
        next.investment = next.investment || {};
        next.investment.installments = res.installments;
        onChange(next);
        notify.success(res.message || 'Investment pricing synced from trip');
      }
    } catch (err) {
      console.error('Sync error:', err);
      notify.error(err.message || 'Failed to sync investment pricing');
    } finally {
      setSyncingInvestment(false);
    }
  };

  return (
    <div style={{ padding: '1rem 1.4rem', background: 'var(--subtle-bg)', overflowY: 'auto', height: '100%' }}>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.2rem' }}>Wanderlux editor</h2>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0 }}>
          Editing a <code style={{ background: 'var(--surface-color)', padding: '0 0.3rem', borderRadius: 3 }}>wanderlux-v1</code> page. Every field has an Upload button for media. Click Save (top-right) when done, then Preview.
        </p>
      </div>

      {/* The layout panel (reorder / hide / add custom blocks) is mounted
          by LandingPageBuilder.jsx in the right-side aside so it sits
          alongside Page metadata + the TEE Decision Panel — keeps the
          main editor column focused on per-section field forms. */}

      {/* ── BRAND ── */}
      <Section id="brand" title="Brand" openByDefault open={open} setOpen={setOpen}>
        <TextField label="Brand name" value={cfg.brand && cfg.brand.name} onChange={(v) => setPath(['brand', 'name'], v)} placeholder="WANDERLUX" />
        <TextField label="Sub-brand" value={cfg.brand && cfg.brand.subBrand} onChange={(v) => setPath(['brand', 'subBrand'], v)} placeholder="TravelStall / TMC / RFU / VisaSure" />
        <TextField label="Brand mark (small glyph)" value={cfg.brand && cfg.brand.mark} onChange={(v) => setPath(['brand', 'mark'], v)} placeholder="✦  (optional)" />
      </Section>

      {/* ── HERO ── */}
      <Section id="hero" title="Hero" openByDefault open={open} setOpen={setOpen}>
        {/* Dates + Audience persist as a single `hero.eyebrow` string
            ("SEPT - OCT 2026 | GRADES 6-12"). HeroEyebrowFields holds
            the two halves in local state so trailing-space typing
            keeps working (a previous derived-on-render approach
            trimmed inside onChange and ate every space the operator
            tried to type). */}
        <HeroEyebrowFields cfg={cfg} setPath={setPath} />
        <TextField label="Badge (seat scarcity, optional)" value={cfg.hero && cfg.hero.badge} onChange={(v) => setPath(['hero', 'badge'], v)} placeholder="Only 30 Seats" />
        <TextField label="Kicker" value={cfg.hero && cfg.hero.kicker} onChange={(v) => setPath(['hero', 'kicker'], v)} placeholder="07 Days. 03 Cities." />
        <TextField label="Title lines (comma separated)" value={(cfg.hero && Array.isArray(cfg.hero.titleLines) ? cfg.hero.titleLines.join(', ') : '')} onChange={(v) => setPath(['hero', 'titleLines'], v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="Bali, but only the, extraordinary parts." />
        <TextArea label="Sub-head" value={cfg.hero && cfg.hero.subhead} onChange={(v) => setPath(['hero', 'subhead'], v)} placeholder="Seven unhurried nights of private villas…" rows={3} />
        <TextField label="CTA label" value={cfg.hero && cfg.hero.ctaLabel} onChange={(v) => setPath(['hero', 'ctaLabel'], v)} placeholder="Reserve Your Suite" />

        {/* Logos strip — rendered at the top of the hero (above the
            eyebrow / title). The template's <sc-for list="{{ hero.logos }}">
            iterates this array; each entry takes a {src, alt} pair. */}
        <label style={{ ...labelStyle, marginTop: '1rem' }}>Partner / programme logos (rendered above the title)</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
          Upload one logo per affiliated school, brand, or sponsor. Each card shows the image at ~54px tall.
        </p>
        <ArrayEditor
          items={cfg.hero && cfg.hero.logos}
          onChange={(next) => setPath(['hero', 'logos'], next)}
          itemLabel="Logo"
          newItem={() => ({ src: '', alt: '' })}
          renderItem={(l, set) => (
            <>
              <ImageField label="Image" value={l.src} onChange={(v) => set({ ...l, src: v })} />
              <TextField label="Alt text" value={l.alt} onChange={(v) => set({ ...l, alt: v })} placeholder="Brand or partner name" />
            </>
          )}
        />

        {/* Value cards — the 4 mini-cards under the hero copy that
            describe the company's APPROACH to running trips (Global
            Confidence, Cultural Awareness, Guided Independence, etc.),
            NOT specific destinations. Operators fill these with their
            sub-brand's value-prop messaging; the AI bridge seeds
            sensible defaults per sub-brand. */}
        <label style={{ ...labelStyle, marginTop: '1rem' }}>Value cards (what your company delivers — not the destination)</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
          2-4 cards describing how you run trips: ratios, supervision, cultural prep, etc. Destination highlights belong in the &quot;Highlights&quot; section further down.
        </p>
        <ArrayEditor
          items={cfg.hero && cfg.hero.valueCards}
          onChange={(next) => setPath(['hero', 'valueCards'], next)}
          itemLabel="Card"
          newItem={() => ({ title: '', body: '' })}
          renderItem={(c, set) => (
            <>
              <TextField label="Title" value={c.title} onChange={(v) => set({ ...c, title: v })} placeholder="Global Confidence" />
              <TextArea label="Body" value={c.body} onChange={(v) => set({ ...c, body: v })} placeholder="Composure and adaptability in unfamiliar environments." rows={2} />
            </>
          )}
        />

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
        <ArrayEditor
          items={
            cfg.intro && Array.isArray(cfg.intro.gains)
              ? cfg.intro.gains.map((g) =>
                  g && typeof g === 'object'
                    ? { title: g.title || '', description: g.description || g.body || '' }
                    : { title: String(g || ''), description: '' },
                )
              : []
          }
          onChange={(next) => setPath(['intro', 'gains'], next)}
          itemLabel="Gain"
          newItem={() => ({ title: '', description: '' })}
          renderItem={(g, set) => (
            <>
              <TextField label="Title" value={g.title} onChange={(v) => set({ ...g, title: v })} placeholder="Kaziranga National Park" />
              <TextArea label="Description (one tight sentence)" value={g.description} onChange={(v) => set({ ...g, description: v })} rows={2} />
            </>
          )}
        />
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

      {/* ── TESTIMONIALS ── */}
      <Section id="testimonials" title="Testimonials" open={open} setOpen={setOpen}>
        <TextField label="Eyebrow" value={cfg.testimonials && cfg.testimonials.eyebrow} onChange={(v) => setPath(['testimonials', 'eyebrow'], v)} placeholder="From Parents" />
        <TextField label="Title" value={cfg.testimonials && cfg.testimonials.title} onChange={(v) => setPath(['testimonials', 'title'], v)} placeholder="They Returned More Independent. More Composed." />
        <label style={{ ...labelStyle, marginTop: '0.6rem' }}>Quote cards</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
          3 or more cards work best — the grid wraps at ~280px per card. Rating is shown as filled stars (1-5).
        </p>
        <ArrayEditor
          items={cfg.testimonials && cfg.testimonials.items}
          onChange={(next) => setPath(['testimonials', 'items'], next)}
          itemLabel="Testimonial"
          newItem={() => ({ initial: '', name: '', source: '', rating: 5, quote: '' })}
          renderItem={(t, set) => (
            <>
              <TextField label="Name" value={t.name} onChange={(v) => set({ ...t, name: v, initial: (v && v.trim().charAt(0).toUpperCase()) || t.initial || '' })} placeholder="Priya S." />
              <TextField label="Initial (avatar letter)" value={t.initial} onChange={(v) => set({ ...t, initial: (v || '').slice(0, 1).toUpperCase() })} placeholder="P" />
              <TextField label="Source" value={t.source} onChange={(v) => set({ ...t, source: v })} placeholder="Google Review" />
              <NumberField label="Rating (1-5)" value={t.rating} onChange={(v) => set({ ...t, rating: v == null ? 5 : Math.max(1, Math.min(5, v)) })} min={1} max={5} />
              <TextArea label="Quote" value={t.quote} onChange={(v) => set({ ...t, quote: v })} rows={3} />
            </>
          )}
        />
      </Section>

      {/* ── INVESTMENT (PRICING) ── */}
      <Section id="investment" title="Investment (pricing)" open={open} setOpen={setOpen}>
        {page && page.tripId && (
          <div style={{
            padding: '1rem',
            background: 'linear-gradient(135deg, #d1fae5 0%, #c5f2e4 100%)',
            border: '2px solid #10b981',
            borderRadius: 8,
            marginBottom: '1.2rem',
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.95rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1 }}>
              <span style={{ fontSize: '1.2rem' }}>✓</span>
              <div>
                <div style={{ fontWeight: 600, color: '#047857', fontSize: '0.95rem' }}>Linked to trip</div>
                <div style={{ color: '#059669', fontSize: '0.8rem' }}>Auto-filled from payment plan</div>
              </div>
            </div>
            <button
              onClick={syncInvestmentFromTrip}
              disabled={syncingInvestment}
              style={{
                padding: '0.6rem 1.2rem',
                fontSize: '0.85rem',
                background: 'var(--accent-color)',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: syncingInvestment ? 'not-allowed' : 'pointer',
                opacity: syncingInvestment ? 0.65 : 1,
                whiteSpace: 'nowrap',
                fontWeight: 600,
                flexShrink: 0,
                transition: 'all 0.2s',
              }}
              title={syncingInvestment ? 'Syncing...' : 'Re-sync installments from trip payment plan'}
            >
              {syncingInvestment ? 'Syncing...' : '↻ Regenerate'}
            </button>
          </div>
        )}
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

      {/* ── BROCHURE DOWNLOAD ── */}
      <Section id="brochure" title="Brochure download" open={open} setOpen={setOpen}>
        <CheckboxField label="Show brochure section" value={cfg.brochure && cfg.brochure.enabled} onChange={(v) => setPath(['brochure', 'enabled'], v)} />
        <TextField label="Eyebrow (pill label)" value={cfg.brochure && cfg.brochure.eyebrow} onChange={(v) => setPath(['brochure', 'eyebrow'], v)} placeholder="Still Exploring?" />
        <TextField label="Title" value={cfg.brochure && cfg.brochure.title} onChange={(v) => setPath(['brochure', 'title'], v)} placeholder="Download the Detailed Programme Overview." />
        <TextArea label="Body copy" value={cfg.brochure && cfg.brochure.body} onChange={(v) => setPath(['brochure', 'body'], v)} rows={3} placeholder="If you would prefer to review the complete itinerary…" />
        <TextField label="Divider note (red label between body & form)" value={cfg.brochure && cfg.brochure.note} onChange={(v) => setPath(['brochure', 'note'], v)} placeholder="Select your school to receive the respective version" />

        {/* Brochure file — paste a hosted link OR upload a PDF/DOC.
            When set, the success state on the published page surfaces a
            direct Download CTA in addition to the email-it-to-you copy
            so visitors don't have to wait for the email round-trip. */}
        <FileField
          label="Brochure file (PDF / DOC) — upload or paste link"
          value={cfg.brochure && cfg.brochure.fileUrl}
          onChange={(v) => setPath(['brochure', 'fileUrl'], v)}
          placeholder="https://… (Drive / Dropbox / S3 link) or upload below"
        />
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0.35rem 0 0.6rem' }}>
          When set, visitors see a Download button on the post-submit success card. Leave blank to only send the brochure via email.
        </p>

        <TextField label="Submit button label" value={cfg.brochure && cfg.brochure.submitLabel} onChange={(v) => setPath(['brochure', 'submitLabel'], v)} placeholder="Download Programme Brochure →" />
        <TextField label="Success heading (after submit)" value={cfg.brochure && cfg.brochure.successTitle} onChange={(v) => setPath(['brochure', 'successTitle'], v)} placeholder="Brochure On Its Way" />
        <TextArea label="Success body (after submit)" value={cfg.brochure && cfg.brochure.successBody} onChange={(v) => setPath(['brochure', 'successBody'], v)} rows={2} placeholder="Thank you — we've emailed the programme brochure…" />
        <label style={{ ...labelStyle, marginTop: '0.6rem' }}>Form fields</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
          Each row becomes one input on the lead-capture form. For Select fields, separate options with commas.
        </p>
        <ArrayEditor
          items={cfg.brochure && cfg.brochure.fields}
          onChange={(next) => setPath(['brochure', 'fields'], next)}
          itemLabel="Field"
          newItem={() => ({ name: '', label: '', type: 'text', required: true, placeholder: '' })}
          renderItem={(f, set) => (
            <>
              <TextField label="Field name (id)" value={f.name} onChange={(v) => set({ ...f, name: v })} placeholder="parent_name" />
              <TextField label="Label (shown to visitor)" value={f.label} onChange={(v) => set({ ...f, label: v })} placeholder="Parent's Name" />
              <div>
                <label style={labelStyle}>Type</label>
                <select
                  style={inputStyle}
                  value={f.type || 'text'}
                  onChange={(e) => set({ ...f, type: e.target.value })}
                >
                  <option value="text">Text</option>
                  <option value="email">Email</option>
                  <option value="tel">Phone</option>
                  <option value="number">Number</option>
                  <option value="select">Select (dropdown)</option>
                </select>
              </div>
              <TextField label="Placeholder" value={f.placeholder} onChange={(v) => set({ ...f, placeholder: v })} placeholder="Enter full name" />
              <CheckboxField label="Required" value={f.required} onChange={(v) => set({ ...f, required: v })} />
              {f.type === 'select' && (
                <TextField
                  label="Options (comma separated)"
                  value={Array.isArray(f.options) ? f.options.join(', ') : ''}
                  onChange={(v) => set({ ...f, options: v.split(',').map((s) => s.trim()).filter(Boolean) })}
                  placeholder="DPS, School of India, Other"
                />
              )}
            </>
          )}
        />
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

        {/* Brand logo — when set, replaces the brand-mark glyph next to
            the footer brand name. Matches the nav-bar logo pattern. */}
        <ImageField label="Footer logo" value={cfg.footer && cfg.footer.brandLogo} onChange={(v) => setPath(['footer', 'brandLogo'], v)} />
        <TextField label="Footer logo height" value={cfg.footer && cfg.footer.brandLogoH} onChange={(v) => setPath(['footer', 'brandLogoH'], v)} placeholder="40px (default)" />

        {/* Email inquiries — multiple supported. The template iterates
            footer.emails[] when set; falls back to the legacy single
            footer.email for backward-compat with pages saved before
            this change. */}
        <label style={{ ...labelStyle, marginTop: '0.6rem' }}>Email inquiries (one per line)</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
          Each email becomes a clickable mailto link in the footer.
        </p>
        <ArrayEditor
          items={(cfg.footer && Array.isArray(cfg.footer.emails) && cfg.footer.emails.length > 0)
            ? cfg.footer.emails
            : (cfg.footer && cfg.footer.email ? [cfg.footer.email] : [])}
          onChange={(next) => {
            const cleaned = next.map((e) => String(e || '').trim()).filter(Boolean);
            // Clear the legacy single-email field once the operator has
            // populated the array, so the template renders the array
            // (not both).
            const nextFooter = { ...(cfg.footer || {}), emails: cleaned };
            if (cleaned.length > 0) delete nextFooter.email;
            setPath(['footer'], nextFooter);
          }}
          itemLabel="Email"
          newItem={() => ''}
          renderItem={(e, set) => (
            <TextField label="Address" value={e} onChange={(v) => set(v)} placeholder="hello@travelstall.com" />
          )}
        />

        {/* Direct contact phones — multiple supported. Each entry maps
            to a {label, tel} pair so operators can show a formatted
            label ("9900786677 · 9886753632") and still link via tel:
            scheme on tap. */}
        <label style={{ ...labelStyle, marginTop: '0.6rem' }}>Direct contact phones</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
          &quot;Label&quot; is what visitors see; &quot;Tel&quot; is the dial string used by mobile click-to-call (E.164 recommended).
        </p>
        <ArrayEditor
          items={cfg.footer && cfg.footer.phones}
          onChange={(next) => setPath(['footer', 'phones'], next)}
          itemLabel="Phone"
          newItem={() => ({ label: '', tel: '' })}
          renderItem={(p, set) => (
            <>
              <TextField label="Label" value={p.label} onChange={(v) => set({ ...p, label: v })} placeholder="9900786677" />
              <TextField label="Tel (E.164)" value={p.tel} onChange={(v) => set({ ...p, tel: v })} placeholder="+919900786677" />
            </>
          )}
        />

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
