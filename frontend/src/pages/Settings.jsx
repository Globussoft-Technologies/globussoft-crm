import React, { useState, useEffect, useContext } from 'react';
import { Shield, UserPlus, Trash2, Key, Sun, Moon, Plus, ArrowUp, ArrowDown, Layers, Building2, Image as ImageIcon, Palette, Monitor } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { ThemeContext, AuthContext } from '../App';

// #391: single source of truth for the default brand color so the color
// picker swatch, the placeholder hint, and the color actually applied
// when no brand color is set all match. Mirrors --accent-color in
// index.css.
const DEFAULT_BRAND_COLOR = '#3b82f6';

export default function Settings() {
  const notify = useNotify();
  const { theme, setTheme, toggleTheme } = useContext(ThemeContext);
  const { tenant: ctxTenant, setTenant } = useContext(AuthContext);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'USER' });
  const [pipelineStages, setPipelineStages] = useState([]);
  const [newStage, setNewStage] = useState({ name: '', color: '#3b82f6' });
  const [stagesLoading, setStagesLoading] = useState(true);
  const [tenant, setTenantState] = useState(ctxTenant || null);
  const [tenantSaving, setTenantSaving] = useState(false);
  // Branding (logo + brand color) — backed by /api/wellness/branding
  const [branding, setBranding] = useState({ logoUrl: null, brandColor: '' });
  const [brandingSaving, setBrandingSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [brandingMsg, setBrandingMsg] = useState('');

  useEffect(() => {
    fetchApi('/api/tenants/current')
      .then((res) => { setTenantState(res); if (setTenant) setTenant(res); })
      .catch(() => { /* tenant endpoint may not be reachable */ });
    // Branding lives under /api/wellness/branding (works for any tenant — only the
    // sidebar conditionally surfaces it on wellness verticals today).
    fetchApi('/api/wellness/branding')
      .then((res) => setBranding({ logoUrl: res.logoUrl || null, brandColor: res.brandColor || '' }))
      .catch(() => { /* branding endpoint may be unavailable for non-wellness tenants */ });
  }, []);

  const handleUploadLogo = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setLogoUploading(true);
    setBrandingMsg('');
    try {
      const fd = new FormData();
      fd.append('logo', file);
      const token = getAuthToken();
      const resp = await fetch('/api/wellness/branding/logo', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json.error || 'Upload failed');
      setBranding((b) => ({ ...b, logoUrl: json.logoUrl }));
      // Reflect into sidebar instantly
      if (setTenant && ctxTenant) setTenant({ ...ctxTenant, logoUrl: json.logoUrl });
      setBrandingMsg('Logo updated.');
    } catch (err) {
      setBrandingMsg(err.message || 'Logo upload failed');
    } finally {
      setLogoUploading(false);
    }
  };

  const handleSaveBrandColor = async () => {
    setBrandingSaving(true);
    setBrandingMsg('');
    try {
      const value = branding.brandColor || '';
      if (value && !/^#[0-9a-fA-F]{6}$/.test(value)) {
        throw new Error('Brand color must be a 6-digit hex (e.g. #265855).');
      }
      const res = await fetchApi('/api/wellness/branding/color', {
        method: 'PUT',
        body: JSON.stringify({ brandColor: value || null }),
      });
      setBranding((b) => ({ ...b, brandColor: res.brandColor || '' }));
      if (setTenant && ctxTenant) setTenant({ ...ctxTenant, brandColor: res.brandColor || null });
      setBrandingMsg('Brand color saved.');
    } catch (err) {
      setBrandingMsg(err.message || 'Failed to save brand color');
    } finally {
      setBrandingSaving(false);
    }
  };

  const handleSaveTenant = async (e) => {
    e.preventDefault();
    setTenantSaving(true);
    try {
      const updated = await fetchApi('/api/tenants/current', {
        method: 'PUT',
        body: JSON.stringify({ name: tenant.name, ownerEmail: tenant.ownerEmail }),
      });
      setTenantState(updated);
      if (setTenant) setTenant(updated);
    } catch (err) {
      notify.error('Failed to update organization');
    }
    setTenantSaving(false);
  };

  const fetchStages = () => {
    fetchApi('/api/pipeline_stages')
      .then(res => { setPipelineStages(Array.isArray(res) ? res : []); setStagesLoading(false); })
      .catch(() => setStagesLoading(false));
  };

  useEffect(() => {
    fetchApi('/api/auth/users')
      .then(res => { setUsers(res); setLoading(false); })
      .catch(err => console.error(err));
    fetchStages();
  }, []);

  const handleAddStage = async (e) => {
    e.preventDefault();
    if (!newStage.name.trim()) return;
    try {
      await fetchApi('/api/pipeline_stages', {
        method: 'POST',
        body: JSON.stringify({ name: newStage.name, color: newStage.color, position: pipelineStages.length })
      });
      setNewStage({ name: '', color: '#3b82f6' });
      fetchStages();
    } catch (err) {
      notify.error('Failed to add stage');
    }
  };

  const handleDeleteStage = async (id) => {
    if (await notify.confirm('Delete this pipeline stage?')) {
      await fetchApi(`/api/pipeline_stages/${id}`, { method: 'DELETE' });
      fetchStages();
    }
  };

  // #390: persist reorder to the backend. Optimistic UI update first, then
  // PUT /api/pipeline_stages/reorder with the new {id, position} pairs. The
  // server returns the canonical sorted list which we adopt as ground truth
  // (so any server-side dedup / clamp wins). On failure we reload to undo
  // the optimistic swap and notify the user — silent failures previously
  // looked like "snap back on refresh" because the PUT errored without
  // surfacing.
  const handleMoveStage = async (index, direction) => {
    const newStages = [...pipelineStages];
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= newStages.length) return;
    [newStages[index], newStages[swapIndex]] = [newStages[swapIndex], newStages[index]];
    const reordered = newStages.map((s, i) => ({ id: s.id, position: i }));
    // Reflect new positions locally so the optimistic UI matches what we
    // POST (previously items kept their old position values).
    const optimistic = newStages.map((s, i) => ({ ...s, position: i }));
    setPipelineStages(optimistic);
    try {
      const updated = await fetchApi('/api/pipeline_stages/reorder', {
        method: 'PUT',
        body: JSON.stringify({ stages: reordered })
      });
      if (Array.isArray(updated)) {
        setPipelineStages(updated);
      } else {
        fetchStages();
      }
    } catch (err) {
      notify.error('Failed to save stage order');
      fetchStages();
    }
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(newUser)
      });
      const data = await fetchApi('/api/auth/users');
      setUsers(data);
      setNewUser({ name: '', email: '', password: '', role: 'USER' });
    } catch (err) {
      notify.error("Failed to create user.");
    }
  };

  const handleDelete = async (id) => {
    if (await notify.confirm("Delete this user?")) {
      await fetchApi(`/api/auth/users/${id}`, { method: 'DELETE' });
      setUsers(users.filter(u => u.id !== id));
    }
  };

  const handleChangeRole = async (id, newRole) => {
    await fetchApi(`/api/auth/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) });
    setUsers(users.map(u => u.id === id ? { ...u, role: newRole } : u));
  };

  // #479/#484: clamp horizontal padding so narrow viewports get 1rem of
  // breathing room instead of the desktop 2rem (which eats ~64px of a
  // 425px viewport before any content gets to render).
  return (
    <div style={{ padding: 'clamp(1rem, 4vw, 2rem)', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Organization Settings</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage team members, roles, and administrative security.</p>
      </header>

      {/* #479/#484: outer two-column grid uses auto-fit + minmax so the
          right column collapses below the second card under ~700px viewports
          rather than squeezing both columns until labels/buttons clip. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1.5rem', maxWidth: '1400px' }}>

        {/* Left Column */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem', minWidth: 0 }}>

        {/* Organization Card */}
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Building2 size={20} color="var(--accent-color)" /> Organization
          </h3>
          {tenant ? (
            // #484: form grid uses auto-fit + minmax(min(100%, 240px)) so on
            // narrow viewports columns stack instead of squeezing inputs to
            // truncation width. min(100%, 240px) keeps the form single-column
            // on phones while staying two-column on tablets/desktop.
            <form onSubmit={handleSaveTenant} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '1rem' }}>
              <div style={{ minWidth: 0 }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Organization Name</label>
                <input type="text" required className="input-field" value={tenant.name || ''} onChange={e => setTenantState({ ...tenant, name: e.target.value })} />
              </div>
              <div style={{ minWidth: 0 }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Slug</label>
                <input type="text" disabled className="input-field" value={tenant.slug || ''} title="Organization slug is permanent" />
              </div>
              {/* #441: surface the public booking URL with a one-click copy
                  button. Pre-fix the owner had to view-source / DOM-inspect
                  to retrieve the URL — friction at the "send me your booking
                  link" moment. The URL is built from window.location.origin
                  + slug; SSR doesn't apply (Settings is auth-required, never
                  rendered server-side). */}
              {tenant.slug && (
                // #484: gridColumn:'1 / -1' (full row) replaces 'span 2' so
                // the cell still spans every column whether the auto-fit grid
                // resolved to 1, 2, or more columns. flexWrap on the inner
                // row lets the Copy URL button drop below the input on
                // narrow viewports instead of squeezing the URL input.
                <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
                  <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Public Booking URL</label>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      readOnly
                      className="input-field"
                      value={`${window.location.origin}/book/${tenant.slug}`}
                      style={{ flex: '1 1 200px', minWidth: 0 }}
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        const url = `${window.location.origin}/book/${tenant.slug}`;
                        navigator.clipboard?.writeText(url).then(
                          () => notify.success('Public booking URL copied to clipboard'),
                          () => notify.error('Could not copy — please select and copy manually')
                        );
                      }}
                      style={{ padding: '0.5rem 1rem', whiteSpace: 'nowrap' }}
                    >
                      Copy URL
                    </button>
                  </div>
                  <p style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Share this with {tenant.vertical === 'wellness' ? 'patients' : 'customers'} to let them self-book without logging in.
                  </p>
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Owner Email</label>
                <input type="email" className="input-field" value={tenant.ownerEmail || ''} onChange={e => setTenantState({ ...tenant, ownerEmail: e.target.value })} />
              </div>
              <div style={{ minWidth: 0 }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Plan</label>
                <input type="text" disabled className="input-field" value={tenant.plan || 'starter'} />
              </div>
              <button type="submit" className="btn-primary" disabled={tenantSaving} style={{ gridColumn: '1 / -1' }}>
                {tenantSaving ? 'Saving...' : 'Save Organization Details'}
              </button>
            </form>
          ) : (
            <p style={{ color: 'var(--text-secondary)' }}>Loading organization details…</p>
          )}
        </div>

        {/* Appearance Card */}
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sun size={20} color="var(--warning-color)" /> Appearance
          </h3>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontWeight: '500', fontSize: '1rem', marginBottom: '1rem' }}>Theme</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>
              Choose how the interface should appear.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {[
                { value: 'light', label: 'Light mode', icon: Sun },
                { value: 'dark', label: 'Dark mode', icon: Moon },
                { value: 'system', label: 'Based on system preference', icon: Monitor },
              ].map(({ value, label, icon: IconComponent }) => (
                <label
                  key={value}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    border: `2px solid ${theme === value ? 'var(--accent-color)' : 'var(--border-color)'}`,
                    background:
                      theme === value
                        ? 'rgba(59, 130, 246, 0.1)'
                        : 'rgba(59, 130, 246, 0.02)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  className="theme-option"
                  data-selected={theme === value}
                  onMouseEnter={(e) => {
                    if (theme !== value) {
                      e.currentTarget.style.borderColor = '#3b82f6';
                      e.currentTarget.style.background = 'rgba(59, 130, 246, 0.08)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (theme !== value) {
                      e.currentTarget.style.borderColor = 'var(--border-color)';
                      e.currentTarget.style.background = 'rgba(59, 130, 246, 0.02)';
                    }
                  }}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={theme === value}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setTheme(value);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  {IconComponent && <IconComponent size={18} />}
                  <span style={{ fontWeight: theme === value ? '600' : '500' }}>
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Branding Card */}
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Palette size={20} color="var(--accent-color)" /> Branding
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
            Upload your clinic logo and pick a brand color. These appear in the sidebar and on branded PDFs.
          </p>

          {/* #479: Branding two-column (Logo | Brand color) collapses to
              single-column under ~360px-each via auto-fit + minmax, fixing
              the "B colo..." label clip + "Save c..." button-text clip on
              ~425px viewports. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '2rem', alignItems: 'start' }}>
            {/* Logo */}
            <div style={{ minWidth: 0 }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                <ImageIcon size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} /> Logo
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                {branding.logoUrl ? (
                  <img
                    src={branding.logoUrl}
                    alt="Current logo"
                    style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', border: '1px solid var(--border-color)' }}
                  />
                ) : (
                  <div style={{ width: 56, height: 56, borderRadius: 8, border: '1px dashed var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                    <ImageIcon size={20} />
                  </div>
                )}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                  onChange={handleUploadLogo}
                  disabled={logoUploading}
                  style={{ flex: 1, fontSize: '0.85rem' }}
                />
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                PNG, JPG, GIF, WEBP or SVG. Max 2 MB. Square works best.
              </p>
            </div>

            {/* Brand color */}
            <div style={{ minWidth: 0 }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                <Palette size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} /> Brand color
              </label>
              {/* #479: flexWrap + whiteSpace:nowrap on the Save button so the
                  button stays as one piece ("Save c..." → "Save color") even
                  when wrapped to its own line. min-width:0 on the hex input
                  lets it shrink instead of pushing the button off-screen. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(branding.brandColor || '') ? branding.brandColor : DEFAULT_BRAND_COLOR}
                  onChange={(e) => setBranding({ ...branding, brandColor: e.target.value })}
                  style={{ width: 48, height: 40, border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer', padding: 2, background: 'var(--input-bg)' }}
                />
                <input
                  type="text"
                  className="input-field"
                  placeholder={DEFAULT_BRAND_COLOR}
                  value={branding.brandColor || ''}
                  onChange={(e) => setBranding({ ...branding, brandColor: e.target.value })}
                  style={{ flex: '1 1 120px', minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={brandingSaving}
                  onClick={handleSaveBrandColor}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {brandingSaving ? 'Saving...' : 'Save color'}
                </button>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                6-digit hex. Leave blank to fall back to the default theme accent.
              </p>
            </div>
          </div>

          {brandingMsg && (
            <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--accent-color)' }}>{brandingMsg}</p>
          )}
        </div>

        {/* Pipeline Stages Card */}
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={20} color="var(--accent-color)" /> Pipeline Stages
          </h3>

          {stagesLoading ? <p>Loading stages...</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {pipelineStages.length === 0 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No custom stages configured. The pipeline uses default stages.</p>
              )}
              {pipelineStages.map((stage, index) => (
                <div key={stage.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-color)', border: '1px solid var(--border-color)', padding: '1rem 1.25rem', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ width: '20px', height: '20px', borderRadius: '6px', backgroundColor: stage.color, flexShrink: 0 }} />
                    <span style={{ fontWeight: '500' }}>{stage.name}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Position {index + 1}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button onClick={() => handleMoveStage(index, -1)} disabled={index === 0} style={{ background: 'none', border: 'none', color: index === 0 ? 'var(--border-color)' : 'var(--text-secondary)', cursor: index === 0 ? 'default' : 'pointer', padding: '0.25rem' }}>
                      <ArrowUp size={16} />
                    </button>
                    <button onClick={() => handleMoveStage(index, 1)} disabled={index === pipelineStages.length - 1} style={{ background: 'none', border: 'none', color: index === pipelineStages.length - 1 ? 'var(--border-color)' : 'var(--text-secondary)', cursor: index === pipelineStages.length - 1 ? 'default' : 'pointer', padding: '0.25rem' }}>
                      <ArrowDown size={16} />
                    </button>
                    <button onClick={() => handleDeleteStage(stage.id)} style={{ background: 'none', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', padding: '0.25rem' }}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* #479: flexWrap so the color picker + Add button drop below the
              stage-name input on narrow viewports rather than truncating it. */}
          <form onSubmit={handleAddStage} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="text" placeholder="Stage name" required className="input-field" style={{ flex: '1 1 180px', minWidth: 0 }} value={newStage.name} onChange={e => setNewStage({ ...newStage, name: e.target.value })} />
            <input type="color" value={newStage.color} onChange={e => setNewStage({ ...newStage, color: e.target.value })} style={{ width: '40px', height: '40px', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', padding: '2px', background: 'var(--input-bg)' }} />
            <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}>
              <Plus size={16} /> Add Stage
            </button>
          </form>
        </div>
        </div>

        {/* Right Column - Roster */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem', minWidth: 0 }}>
        {/* User Roster */}
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Shield size={20} color="var(--success-color)" /> Access Control Roster
          </h3>

          {loading ? <p>Loading team...</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '700px', overflowY: 'auto' }}>
              {users.map(u => (
                // #479: roster row wraps on narrow viewports so the role
                // dropdown + delete button drop below the name/email block
                // instead of squeezing the email into truncation.
                <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-color)', border: '1px solid var(--border-color)', padding: '1.25rem', borderRadius: '8px', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                    <h4 style={{ fontWeight: '600', fontSize: '1.1rem', wordBreak: 'break-word' }}>{u.name || 'Unknown User'} <span style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', background: u.role === 'ADMIN' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.2)', color: u.role === 'ADMIN' ? '#ef4444' : '#3b82f6', borderRadius: '12px', marginLeft: '0.5rem' }}>{u.role}</span></h4>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem', wordBreak: 'break-all' }}>{u.email}</p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <select value={u.role} onChange={(e) => handleChangeRole(u.id, e.target.value)} style={{ padding: '0.5rem', borderRadius: '4px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
                      <option value="USER">Standard Rep</option>
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                    {u.role !== 'ADMIN' ? (
                      <button onClick={() => handleDelete(u.id)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', padding: '0.5rem' }}>
                        <Trash2 size={18} />
                      </button>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>—</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Invite User Card */}
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <UserPlus size={20} color="var(--accent-color)" /> Invite Team Member
          </h3>
          {/* #484: Invite form uses auto-fit + minmax so fields stack on
              narrow viewports rather than truncating placeholders/values. */}
          <form onSubmit={handleCreateUser} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '1rem' }}>
             <input type="text" placeholder="Full Name" required className="input-field" style={{ minWidth: 0 }} value={newUser.name} onChange={e => setNewUser({...newUser, name: e.target.value})} />
             <input type="email" placeholder="Email Address" required className="input-field" style={{ minWidth: 0 }} value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} />
             <input type="password" placeholder="Temporary Password" required className="input-field" style={{ minWidth: 0 }} value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} />
             <select className="input-field" value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})} style={{ background: 'var(--input-bg)', minWidth: 0 }}>
               <option value="USER">Standard Rep</option>
               <option value="MANAGER">Sales Manager</option>
               <option value="ADMIN">System Administrator</option>
             </select>
             <button type="submit" className="btn-primary" style={{ gridColumn: '1 / -1' }}>Send Invitation & Create Account</button>
          </form>
        </div>
        </div>

      </div>
    </div>
  );
}
