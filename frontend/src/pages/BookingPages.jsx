import React, { useState, useEffect } from 'react';
import { Calendar, Plus, Copy, Edit, Trash2, Clock, Check, X as XIcon, Link as LinkIcon, Image, Upload, GripVertical, Phone, Mail } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const DAYS = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' },
];

const DEFAULT_AVAIL = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
};

function publicUrl(slug) {
  return `${window.location.origin}/api/booking-pages/public/${slug}`;
}

function parseAvail(raw) {
  if (!raw) return { ...DEFAULT_AVAIL };
  if (typeof raw === 'object') return { ...DEFAULT_AVAIL, ...raw };
  try { return { ...DEFAULT_AVAIL, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_AVAIL }; }
}

export default function BookingPages() {
  const notify = useNotify();
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null); // page object opened in editor
  const [bookings, setBookings] = useState([]);
  const [copied, setCopied] = useState(null);

  const load = () => {
    setLoading(true);
    fetchApi('/api/booking-pages')
      .then(d => { setPages(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openPage = async (page) => {
    setSelected({ ...page, availability: parseAvail(page.availability) });
    try {
      const list = await fetchApi(`/api/booking-pages/${page.id}/bookings`);
      setBookings(Array.isArray(list) ? list : []);
    } catch {
      setBookings([]);
    }
  };

  const copyUrl = async (slug) => {
    try {
      await navigator.clipboard.writeText(publicUrl(slug));
      setCopied(slug);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      await notify.prompt('Copy this URL:', publicUrl(slug));
    }
  };

  const handleDelete = async (page) => {
    if (!await notify.confirm(`Delete booking page "${page.title}"? All bookings will be removed.`)) return;
    await fetchApi(`/api/booking-pages/${page.id}`, { method: 'DELETE' });
    if (selected && selected.id === page.id) setSelected(null);
    load();
  };

  const cancelBooking = async (bookingId) => {
    if (!selected) return;
    if (!await notify.confirm('Cancel this booking?')) return;
    await fetchApi(`/api/booking-pages/${selected.id}/cancel/${bookingId}`, { method: 'POST' });
    const list = await fetchApi(`/api/booking-pages/${selected.id}/bookings`);
    setBookings(Array.isArray(list) ? list : []);
    load();
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      {/* #492: header was display:flex with no flexWrap, so on narrow viewports
          (<768px) the Create Page button overlapped the description text. Adding
          flexWrap:'wrap' + a min-width on the title block lets the button drop
          to its own line on mobile while keeping the side-by-side layout on
          wider viewports. */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: '1 1 280px' }}>
          <Calendar size={24} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Booking Pages</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Share scheduling links so prospects can book meetings on your calendar.
            </p>
          </div>
        </div>
        <button
          className="btn-primary"
          onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}
        >
          <Plus size={18} /> Create Page
        </button>
      </header>

      {loading ? (
        <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading...</p>
      ) : pages.length === 0 ? (
        <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
          <Calendar size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ marginBottom: '0.5rem' }}>No booking pages yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Create a page with your availability and share the link to start receiving bookings.
          </p>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Create Page
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
          {pages.map(page => (
            <div key={page.id} className="card" style={{ padding: '1.5rem', cursor: 'pointer' }} onClick={() => openPage(page)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <h3 style={{ fontWeight: 600, fontSize: '1.1rem', flex: 1 }}>{page.title}</h3>
                <span style={{
                  padding: '0.2rem 0.6rem', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600,
                  background: page.isActive ? 'rgba(16,185,129,0.1)' : 'rgba(107,114,128,0.1)',
                  color: page.isActive ? '#10b981' : '#6b7280',
                }}>
                  {page.isActive ? 'ACTIVE' : 'PAUSED'}
                </span>
              </div>
              {page.description && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>{page.description}</p>
              )}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem',
                color: 'var(--text-secondary)', marginBottom: '1rem',
              }}>
                <LinkIcon size={12} /> <code style={{ fontSize: '0.75rem' }}>/{page.slug}</code>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
                <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <Clock size={14} /> {page.durationMins}m
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Duration</div>
                </div>
                <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: 6 }}>
                  <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{page.bookingCount || 0}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Bookings</div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0.6rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                  onClick={() => copyUrl(page.slug)}
                >
                  {copied === page.slug ? <Check size={14} /> : <Copy size={14} />} {copied === page.slug ? 'Copied!' : 'Copy URL'}
                </button>
                <button
                  className="btn-secondary"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.6rem', display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => openPage(page)}
                >
                  <Edit size={14} />
                </button>
                <button
                  className="btn-secondary"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.6rem', color: '#ef4444' }}
                  onClick={() => handleDelete(page)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

      {selected && (
        <EditDrawer
          page={selected}
          bookings={bookings}
          onClose={() => setSelected(null)}
          onSaved={(updated) => { setSelected({ ...updated, availability: parseAvail(updated.availability) }); load(); }}
          onCancelBooking={cancelBooking}
          onCopyUrl={copyUrl}
          copied={copied}
        />
      )}
    </div>
  );
}

// ── Create modal ─────────────────────────────────────────────────

function CreateModal({ onClose, onCreated }) {
  const notify = useNotify();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [durationMins, setDurationMins] = useState(30);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await fetchApi('/api/booking-pages', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          durationMins: parseInt(durationMins, 10) || 30,
          availability: DEFAULT_AVAIL,
        }),
      });
      onCreated();
    } catch {
      notify.error('Failed to create booking page');
      setSubmitting(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div className="card" style={{ ...modalStyle, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>New Booking Page</h3>
          <button onClick={onClose} style={iconBtnStyle}><XIcon size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input
              required value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="30-min Discovery Call" style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Description (optional)</label>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              rows={3} style={{ ...inputStyle, resize: 'vertical' }}
              placeholder="A short intro call to understand your needs."
            />
          </div>
          <div>
            <label style={labelStyle}>Duration (minutes)</label>
            <select value={durationMins} onChange={(e) => setDurationMins(e.target.value)} style={inputStyle}>
              <option value={15}>15</option>
              <option value={30}>30</option>
              <option value={45}>45</option>
              <option value={60}>60</option>
              <option value={90}>90</option>
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Page'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit drawer with availability + bookings ─────────────────────

function EditDrawer({ page, bookings, onClose, onSaved, onCancelBooking, onCopyUrl, copied }) {
  const notify = useNotify();
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState(page.description || '');
  const [durationMins, setDurationMins] = useState(page.durationMins);
  const [bufferMins, setBufferMins] = useState(page.bufferMins || 0);
  const [isActive, setIsActive] = useState(page.isActive);
  const [availability, setAvailability] = useState(page.availability);
  const [saving, setSaving] = useState(false);
  // Wave 7D — rich-content editor state. featuredServiceIds is an ordered
  // list (drag to reorder); empty list = "show all services in default order".
  const [logoUrl, setLogoUrl] = useState(page.logoUrl || '');
  const [heroImageUrl, setHeroImageUrl] = useState(page.heroImageUrl || '');
  const [heroHeadline, setHeroHeadline] = useState(page.heroHeadline || '');
  const [heroSubheadline, setHeroSubheadline] = useState(page.heroSubheadline || '');
  const [contactPhone, setContactPhone] = useState(page.contactPhone || '');
  const [contactEmail, setContactEmail] = useState(page.contactEmail || '');
  const [hoursJson, setHoursJson] = useState(page.hoursJson || '');
  const [featuredServiceIds, setFeaturedServiceIds] = useState(() => {
    if (Array.isArray(page.featuredServiceIds)) return page.featuredServiceIds;
    if (typeof page.featuredServiceIds === 'string' && page.featuredServiceIds) {
      try { const p = JSON.parse(page.featuredServiceIds); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
  });
  const [services, setServices] = useState([]);
  const [uploading, setUploading] = useState(null); // 'logo' | 'hero' | null

  useEffect(() => {
    setTitle(page.title);
    setDescription(page.description || '');
    setDurationMins(page.durationMins);
    setBufferMins(page.bufferMins || 0);
    setIsActive(page.isActive);
    setAvailability(page.availability);
    setLogoUrl(page.logoUrl || '');
    setHeroImageUrl(page.heroImageUrl || '');
    setHeroHeadline(page.heroHeadline || '');
    setHeroSubheadline(page.heroSubheadline || '');
    setContactPhone(page.contactPhone || '');
    setContactEmail(page.contactEmail || '');
    setHoursJson(page.hoursJson || '');
    setFeaturedServiceIds(() => {
      if (Array.isArray(page.featuredServiceIds)) return page.featuredServiceIds;
      if (typeof page.featuredServiceIds === 'string' && page.featuredServiceIds) {
        try { const p = JSON.parse(page.featuredServiceIds); return Array.isArray(p) ? p : []; } catch { return []; }
      }
      return [];
    });
  }, [page.id]);

  // Load services for the featured-services picker. Wellness tenant ships
  // /api/wellness/services; generic tenants don't have a comparable list,
  // so a 4xx silently leaves featured-services UI empty and the page-level
  // editor still saves the rest of the rich content.
  useEffect(() => {
    fetchApi('/api/wellness/services')
      .then((s) => setServices(Array.isArray(s) ? s : []))
      .catch(() => setServices([]));
  }, []);

  const uploadImage = async (file, kind) => {
    if (!file) return;
    setUploading(kind);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const tok = localStorage.getItem('token') || '';
      const res = await fetch(`/api/booking-pages/${page.id}/upload?kind=${kind}`, {
        method: 'POST',
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        body: fd,
      });
      if (!res.ok) {
        let msg = 'Upload failed';
        try { msg = (await res.json()).error || msg; } catch { /* swallow */ }
        notify.error(msg);
        return;
      }
      const body = await res.json();
      if (kind === 'hero') setHeroImageUrl(body.url);
      else setLogoUrl(body.url);
    } catch (e) {
      notify.error(e.message || 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const moveFeatured = (idx, delta) => {
    setFeaturedServiceIds((prev) => {
      const next = [...prev];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return prev;
      const [row] = next.splice(idx, 1);
      next.splice(target, 0, row);
      return next;
    });
  };
  const removeFeatured = (idx) => setFeaturedServiceIds((prev) => prev.filter((_, i) => i !== idx));
  const addFeatured = (id) => {
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid) || featuredServiceIds.includes(sid)) return;
    setFeaturedServiceIds((prev) => [...prev, sid]);
  };
  const serviceLabel = (id) => {
    const s = services.find((x) => x.id === id);
    return s ? s.name : `Service #${id}`;
  };
  const availableServices = services.filter((s) => s.isActive !== false && !featuredServiceIds.includes(s.id));

  const updateWindow = (day, idx, field, value) => {
    setAvailability(prev => {
      const next = { ...prev, [day]: [...(prev[day] || [])] };
      next[day][idx] = { ...next[day][idx], [field]: value };
      return next;
    });
  };

  const addWindow = (day) => {
    setAvailability(prev => ({ ...prev, [day]: [...(prev[day] || []), { start: '09:00', end: '17:00' }] }));
  };

  const removeWindow = (day, idx) => {
    setAvailability(prev => ({ ...prev, [day]: (prev[day] || []).filter((_, i) => i !== idx) }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await fetchApi(`/api/booking-pages/${page.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title, description: description || null,
          durationMins: parseInt(durationMins, 10) || 30,
          bufferMins: parseInt(bufferMins, 10) || 0,
          isActive, availability,
          // Wave 7D rich-content fields. Send `null` (not '') so the backend
          // clears the column rather than stamping an empty string.
          logoUrl: logoUrl || null,
          heroImageUrl: heroImageUrl || null,
          heroHeadline: heroHeadline || null,
          heroSubheadline: heroSubheadline || null,
          featuredServiceIds,
          contactPhone: contactPhone || null,
          contactEmail: contactEmail || null,
          hoursJson: hoursJson || null,
        }),
      });
      onSaved(updated);
    } catch {
      notify.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div className="card" style={{ ...modalStyle, maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 600 }}>{page.title}</h3>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem',
              color: 'var(--text-secondary)', marginTop: 4,
            }}>
              <LinkIcon size={12} />
              <code>{publicUrl(page.slug)}</code>
              <button onClick={() => onCopyUrl(page.slug)} style={{ ...iconBtnStyle, padding: 4 }} title="Copy URL">
                {copied === page.slug ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <button onClick={onClose} style={iconBtnStyle}><XIcon size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Status</label>
            <select value={isActive ? '1' : '0'} onChange={(e) => setIsActive(e.target.value === '1')} style={inputStyle}>
              <option value="1">Active</option>
              <option value="0">Paused</option>
            </select>
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={labelStyle}>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <div>
            <label style={labelStyle}>Duration (min)</label>
            <input type="number" min={5} max={480} value={durationMins} onChange={(e) => setDurationMins(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Buffer (min)</label>
            <input type="number" min={0} max={120} value={bufferMins} onChange={(e) => setBufferMins(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ marginBottom: '1.25rem' }}>
          <h4 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem' }}>Weekly Availability</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {DAYS.map(d => {
              const wins = availability[d.key] || [];
              return (
                <div key={d.key} style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.5rem 0.75rem', background: 'var(--subtle-bg)', borderRadius: 6,
                }}>
                  <div style={{ width: 50, fontWeight: 600, fontSize: '0.85rem' }}>{d.label}</div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {wins.length === 0 ? (
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Unavailable</span>
                    ) : wins.map((w, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <input type="time" value={w.start || '09:00'} onChange={(e) => updateWindow(d.key, i, 'start', e.target.value)} style={{ ...inputStyle, padding: '0.3rem 0.5rem', width: 110 }} />
                        <span style={{ color: 'var(--text-secondary)' }}>—</span>
                        <input type="time" value={w.end || '17:00'} onChange={(e) => updateWindow(d.key, i, 'end', e.target.value)} style={{ ...inputStyle, padding: '0.3rem 0.5rem', width: 110 }} />
                        <button onClick={() => removeWindow(d.key, i)} style={{ ...iconBtnStyle, padding: 4, color: '#ef4444' }} title="Remove window">
                          <XIcon size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => addWindow(d.key)} style={{ ...iconBtnStyle, padding: '0.3rem 0.5rem', fontSize: '0.75rem' }} title="Add window">
                    <Plus size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Wave 7D — Mini Website rich-content editor. Logo + hero image
            uploads via POST /:id/upload, hero copy, drag-ordered featured
            services, contact block + hours. All optional — admins can leave
            this whole section blank for a pure-scheduler experience. */}
        <div style={{ marginBottom: '1.25rem' }}>
          <h4 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Image size={16} aria-hidden="true" /> Mini Website Content
          </h4>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '0.75rem' }}>
            <div>
              <label style={labelStyle}>Logo</label>
              {logoUrl ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <img src={logoUrl} alt="Logo preview" data-testid="logo-preview" style={{ height: 48, borderRadius: 6, background: 'var(--subtle-bg)' }} />
                  <button type="button" className="btn-secondary" onClick={() => setLogoUrl('')} style={{ fontSize: '0.75rem' }}>Remove</button>
                </div>
              ) : (
                <label data-testid="logo-upload-label" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                  <Upload size={14} /> {uploading === 'logo' ? 'Uploading…' : 'Upload Logo'}
                  <input
                    type="file" accept="image/png,image/jpeg,image/webp" hidden
                    onChange={(e) => uploadImage(e.target.files?.[0], 'logo')}
                  />
                </label>
              )}
            </div>
            <div>
              <label style={labelStyle}>Hero Image</label>
              {heroImageUrl ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <img src={heroImageUrl} alt="Hero preview" data-testid="hero-preview" style={{ height: 48, borderRadius: 6, background: 'var(--subtle-bg)' }} />
                  <button type="button" className="btn-secondary" onClick={() => setHeroImageUrl('')} style={{ fontSize: '0.75rem' }}>Remove</button>
                </div>
              ) : (
                <label data-testid="hero-upload-label" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                  <Upload size={14} /> {uploading === 'hero' ? 'Uploading…' : 'Upload Hero'}
                  <input
                    type="file" accept="image/png,image/jpeg,image/webp" hidden
                    onChange={(e) => uploadImage(e.target.files?.[0], 'hero')}
                  />
                </label>
              )}
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label style={labelStyle}>Hero Headline</label>
              <input
                value={heroHeadline}
                onChange={(e) => setHeroHeadline(e.target.value)}
                placeholder="Welcome to Enhanced Wellness"
                style={inputStyle}
                data-testid="hero-headline"
              />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label style={labelStyle}>Hero Subheadline</label>
              <textarea
                value={heroSubheadline}
                onChange={(e) => setHeroSubheadline(e.target.value)}
                rows={2}
                placeholder="Book your next appointment with our specialists"
                style={{ ...inputStyle, resize: 'vertical' }}
                data-testid="hero-subheadline"
              />
            </div>
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={labelStyle}>Featured Services (drag to reorder)</label>
            {featuredServiceIds.length === 0 ? (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontStyle: 'italic', margin: '0 0 0.5rem 0' }}>
                No featured services. Add one below to control the order patients see on your booking page.
              </p>
            ) : (
              <div data-testid="featured-services-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.5rem' }}>
                {featuredServiceIds.map((id, idx) => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.6rem', background: 'var(--subtle-bg)', borderRadius: 6 }}>
                    <GripVertical size={14} style={{ color: 'var(--text-secondary)' }} />
                    <span style={{ flex: 1, fontSize: '0.85rem' }}>{idx + 1}. {serviceLabel(id)}</span>
                    <button type="button" onClick={() => moveFeatured(idx, -1)} disabled={idx === 0} style={{ ...iconBtnStyle, padding: 4, opacity: idx === 0 ? 0.3 : 1 }} title="Move up">↑</button>
                    <button type="button" onClick={() => moveFeatured(idx, +1)} disabled={idx === featuredServiceIds.length - 1} style={{ ...iconBtnStyle, padding: 4, opacity: idx === featuredServiceIds.length - 1 ? 0.3 : 1 }} title="Move down">↓</button>
                    <button type="button" onClick={() => removeFeatured(idx)} style={{ ...iconBtnStyle, padding: 4, color: '#ef4444' }} title="Remove"><XIcon size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            {availableServices.length > 0 && (
              <select
                value=""
                onChange={(e) => { addFeatured(e.target.value); e.target.value = ''; }}
                style={{ ...inputStyle, fontSize: '0.85rem' }}
                data-testid="featured-services-add"
              >
                <option value="">+ Add service to featured list</option>
                {availableServices.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={labelStyle}><Phone size={11} style={{ verticalAlign: 'middle' }} /> Contact Phone</label>
              <input
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+91 98765 43210"
                style={inputStyle}
                data-testid="contact-phone"
              />
            </div>
            <div>
              <label style={labelStyle}><Mail size={11} style={{ verticalAlign: 'middle' }} /> Contact Email</label>
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="hello@clinic.example"
                style={inputStyle}
                data-testid="contact-email"
              />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label style={labelStyle}>Hours (free-text)</label>
              <textarea
                value={hoursJson}
                onChange={(e) => setHoursJson(e.target.value)}
                rows={2}
                placeholder='Mon-Sat 9:00-19:00, Sun closed'
                style={{ ...inputStyle, resize: 'vertical' }}
                data-testid="contact-hours"
              />
              <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                Plain-text or a JSON object like <code>{'{"monday":"9-19"}'}</code>. Surfaced on the public booking page.
              </p>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: '1.25rem' }}>
          <h4 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem' }}>Recent Bookings ({bookings.length})</h4>
          {bookings.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', padding: '0.75rem', background: 'var(--subtle-bg)', borderRadius: 6 }}>
              No bookings yet. Share your URL to receive your first booking.
            </p>
          ) : (
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 6 }}>
              {bookings.map(b => (
                <div key={b.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '0.6rem 0.85rem', borderBottom: '1px solid var(--border-color)', gap: '0.5rem',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{b.contactName}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {b.contactEmail} · {new Date(b.scheduledAt).toLocaleString()}
                    </div>
                  </div>
                  <span style={{
                    padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', fontWeight: 600,
                    background: b.status === 'CANCELED' ? 'rgba(239,68,68,0.1)'
                      : b.status === 'COMPLETED' ? 'rgba(107,114,128,0.1)' : 'rgba(16,185,129,0.1)',
                    color: b.status === 'CANCELED' ? '#ef4444'
                      : b.status === 'COMPLETED' ? '#6b7280' : '#10b981',
                  }}>
                    {b.status}
                  </span>
                  {b.status !== 'CANCELED' && (
                    <button onClick={() => onCancelBooking(b.id)} style={{ ...iconBtnStyle, padding: 4, color: '#ef4444' }} title="Cancel">
                      <XIcon size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Inline styles ────────────────────────────────────────────────

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem',
};

const modalStyle = {
  width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem',
};

const labelStyle = {
  display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.35rem',
  color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em',
};

const inputStyle = {
  width: '100%', padding: '0.5rem 0.75rem', borderRadius: 6,
  border: '1px solid var(--border-color)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', fontSize: '0.85rem', boxSizing: 'border-box',
};

const iconBtnStyle = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
