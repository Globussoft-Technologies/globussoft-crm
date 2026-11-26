import React, { useState, useEffect, useContext } from 'react';
import { Bell, Zap, Monitor, Mail } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import ProductTourSettings from '../components/ProductTourSettings';
import { AuthContext } from '../App';

// Notification categories ⇄ sidebar paths. A category renders only when at
// least one of its mapped paths is in /api/pages/me, so the preferences
// surface mirrors the sidebar the signed-in user actually sees:
//   • Generic CRM users → Deals / Tasks / Tickets / Leads / Approvals / Expenses.
//   • Wellness customer-tier → Appointments / Prescriptions / Visits /
//     Memberships / Payments — the workflow categories their sidebar exposes.
//   • Wellness staff (doctors / professionals / telecallers) → the clinical
//     subset PLUS Waitlist / Inventory / Leads / Approvals as their role grants.
// New categories are render-only today (the existing notify() callsites pass
// the legacy keys); future notify() calls can adopt the new keys and the
// surface is already there. Fetch failure degrades to "show everything" so a
// transient network blip doesn't strand the user's settings page empty.
const categoryOptions = [
  // Generic CRM workflow surfaces
  { key: 'deal', label: 'Deals & Opportunities', paths: ['/deals', '/pipeline', '/pipelines', '/deal-insights'] },
  { key: 'task', label: 'Tasks', paths: ['/tasks'] },
  { key: 'ticket', label: 'Support Tickets', paths: ['/tickets'] },
  { key: 'lead', label: 'Leads', paths: ['/leads', '/converted-leads', '/lead-routing', '/lead-scoring'] },
  { key: 'approval', label: 'Approvals', paths: ['/approvals'] },
  { key: 'leave', label: 'Leave Requests', paths: ['/wellness/leave', '/leaves'] },
  { key: 'expense', label: 'Expense Reports', paths: ['/expenses'] },
  { key: 'tmc_catalogue', label: 'TMC Catalogue Requests', paths: ['/travel/diagnostics', '/travel/tmc/catalogue'] },
  // Wellness vertical surfaces
  { key: 'appointment', label: 'Appointments & Bookings', paths: ['/wellness/appointments', '/wellness/my-appointments', '/wellness/my-bookings', '/wellness/book-appointment', '/wellness/calendar', '/booking-pages'] },
  { key: 'prescription', label: 'Prescriptions', paths: ['/wellness/prescriptions', '/wellness/my-prescriptions', '/wellness/prescription-requests', '/wellness/my-prescription-requests'] },
  { key: 'visit', label: 'Visits', paths: ['/wellness/visits'] },
  { key: 'membership', label: 'Memberships', paths: ['/wellness/memberships'] },
  { key: 'payment', label: 'Payments & Transactions', paths: ['/payments', '/wellness/my-transactions', '/wellness/wallet', '/invoices', '/wellness/invoices'] },
  { key: 'waitlist', label: 'Waitlist', paths: ['/wellness/waitlist'] },
  { key: 'inventory', label: 'Inventory', paths: ['/wellness/inventory', '/wellness/inventory-receipts', '/wellness/inventory-adjustments'] },
];

export default function UserSettings() {
  const notify = useNotify();
  const { tenant } = useContext(AuthContext);
  const isTravel = tenant?.vertical === 'travel';
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [accessiblePaths, setAccessiblePaths] = useState(null);

  const visibleCategories = (() => {
    const travelOnly = (cat) =>
      (cat.key !== 'tmc_catalogue' || isTravel) &&
      !(isTravel && cat.key === 'deal');
    if (!Array.isArray(accessiblePaths)) return categoryOptions.filter(travelOnly);
    const pathSet = new Set(accessiblePaths);
    return categoryOptions.filter((cat) =>
      travelOnly(cat) && (cat.paths || []).some((p) => pathSet.has(p))
    );
  })();
  const categoryLabel = (category) =>
    category.key === 'tmc_catalogue' && isTravel
      ? 'Diagnostic & Catalogue Requests'
      : category.label;

  const channelOptions = [
    { key: 'db', label: 'In-App Bell', shortLabel: 'Bell', description: 'CRM notification center', icon: Bell },
    { key: 'socket', label: 'Real-Time Updates', shortLabel: 'Live', description: 'Instant CRM updates', icon: Zap },
    { key: 'push', label: 'Browser Push', shortLabel: 'Push', description: 'Desktop notifications', icon: Monitor },
    { key: 'email', label: 'Email', shortLabel: 'Mail', description: 'Email notifications', icon: Mail },
  ];

  const withCategoryChannels = (data) => {
    const legacyChannels = data?.channels || {};
    const { byCategory: savedByCategory, ...globalChannels } = legacyChannels;
    const byCategory = Object.fromEntries(categoryOptions.map((category) => [
      category.key,
      {
        ...Object.fromEntries(channelOptions.map((channel) => [channel.key, globalChannels[channel.key] !== false])),
        ...(savedByCategory?.[category.key] || {}),
      },
    ]));
    return { ...data, channels: { ...legacyChannels, byCategory } };
  };

  // Timezone list
  const timezones = [
    'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Australia/Sydney'
  ];

  const load = async () => {
    try {
      const data = await fetchApi('/api/notifications/preferences');
      setPrefs(withCategoryChannels(data));
    } catch (err) {
      console.error('Failed to load preferences:', err);
      notify.error('Failed to load notification preferences');
    } finally {
      setLoading(false);
    }
  };

  // Fetch the user's accessible pages so the category list can mirror what
  // they see in their sidebar. A failure here intentionally degrades to
  // "show everything" (accessiblePaths stays null) — losing notification
  // settings on a fetch hiccup is worse than over-displaying.
  const loadAccessiblePages = async () => {
    try {
      const res = await fetchApi('/api/pages/me', { silent: true });
      const paths = Array.isArray(res?.pages)
        ? res.pages.map((p) => p?.path).filter(Boolean)
        : [];
      setAccessiblePaths(paths);
    } catch {
      setAccessiblePaths(null);
    }
  };

  useEffect(() => {
    load();
    loadAccessiblePages();
  }, []);

  const handleCategoryToggle = (category) => {
    setPrefs({
      ...prefs,
      categoryToggles: {
        ...prefs.categoryToggles,
        [category]: !prefs.categoryToggles[category],
      },
    });
  };

  const handleChannelToggle = (channel) => {
    setPrefs({
      ...prefs,
      channels: { ...prefs.channels, [channel]: !prefs.channels[channel] },
    });
  };

  const handleCategoryChannelToggle = (category, channel) => {
    setPrefs({
      ...prefs,
      channels: {
        ...prefs.channels,
        byCategory: {
          ...prefs.channels.byCategory,
          [category]: {
            ...prefs.channels.byCategory[category],
            [channel]: !prefs.channels.byCategory[category][channel],
          },
        },
      },
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetchApi('/api/notifications/preferences', {
        method: 'PUT',
        body: JSON.stringify(prefs),
      });
      notify.success('Notification preferences saved');
    } catch (err) {
      notify.error('Failed to save notification preferences');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!await notify.confirm('Reset notification preferences to defaults?')) return;
    setSaving(true);
    try {
      await fetchApi('/api/notifications/preferences/reset', { method: 'POST' });
      load();
      notify.success('Preferences reset to defaults');
    } catch (err) {
      notify.error('Failed to reset preferences');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: '2rem' }}>Loading preferences…</div>;
  // Defensive: an empty / malformed preference row crashes the categoryOptions
  // .map below ("Cannot read properties of undefined reading 'deal'").
  if (!prefs || !prefs.categoryToggles || !prefs.channels) return null;

  return (
    <div style={{ padding: 'clamp(1rem, 4vw, 2rem)', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Notification Settings</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage how and when you receive notifications.</p>
      </header>

      <div style={{ maxWidth: '800px' }}>
        <ProductTourSettings />
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Bell size={20} color="var(--accent-color)" /> Notification Preferences
          </h3>

          <div style={{ marginBottom: '2rem' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: '600', marginBottom: '0.4rem', color: 'var(--text-primary)' }}>Delivery Channels</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginBottom: '0.8rem' }}>Enable or disable how notifications arrive.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 245px), 1fr))', gap: '0.65rem', marginBottom: '1.25rem' }}>
              {channelOptions.map(channel => {
                const Icon = channel.icon;
                const enabled = prefs.channels[channel.key] !== false;
                return <label key={channel.key} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', minWidth: 0, padding: '0.7rem 0.8rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--surface-color)', cursor: 'pointer' }}><Icon size={18} strokeWidth={1.8} color="var(--text-secondary)" aria-hidden="true" /><span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}><span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{channel.label}</span><span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{channel.description}</span></span><span style={{ position: 'relative', width: 34, height: 20, flexShrink: 0 }}><input aria-label={channel.label} type="checkbox" checked={enabled} onChange={() => handleChannelToggle(channel.key)} style={{ opacity: 0, position: 'absolute', inset: 0, margin: 0, cursor: 'pointer', zIndex: 1 }} /><span aria-hidden="true" style={{ display: 'block', width: 34, height: 20, borderRadius: 999, background: enabled ? 'var(--accent-color)' : 'var(--border-color)', transition: 'background 0.15s ease' }}><span style={{ display: 'block', width: 14, height: 14, borderRadius: '50%', background: '#fff', transform: enabled ? 'translate(17px, 3px)' : 'translate(3px, 3px)', transition: 'transform 0.15s ease', boxShadow: '0 1px 2px rgba(0,0,0,0.18)' }} /></span></span></label>;
              })}
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.2rem', color: 'var(--text-primary)' }}>Channel Preferences</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '0 0 0.7rem' }}>Customize notification methods for each type.</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.8fr) repeat(4, minmax(58px, 1fr))', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ padding: '0.55rem 0.7rem', fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--surface-color)' }}>Notification type</div>
                {channelOptions.map(channel => { const Icon = channel.icon; return <div key={channel.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, padding: '0.35rem 0.15rem', fontSize: '0.64rem', color: 'var(--text-secondary)', background: 'var(--surface-color)' }}><Icon size={14} aria-hidden="true" /><span>{channel.shortLabel}</span></div>; })}
                {visibleCategories.map(category => { const label = categoryLabel(category); return <React.Fragment key={category.key}><label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', minWidth: 0, padding: '0.48rem 0.7rem', borderTop: '1px solid var(--border-color)', fontSize: '0.78rem', color: 'var(--text-primary)', cursor: 'pointer' }}><input aria-label={`${label} enabled`} type="checkbox" checked={prefs.categoryToggles[category.key] !== false} onChange={() => handleCategoryToggle(category.key)} /><span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span></label>{channelOptions.map(channel => { const globallyEnabled = prefs.channels[channel.key] !== false; const categoryEnabled = prefs.categoryToggles[category.key] !== false; return <label key={`${category.key}-${channel.key}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: '1px solid var(--border-color)', background: globallyEnabled && categoryEnabled ? 'transparent' : 'var(--surface-color)' }}><input aria-label={`${label} ${channel.label}`} type="checkbox" disabled={!globallyEnabled || !categoryEnabled} checked={prefs.channels.byCategory?.[category.key]?.[channel.key] !== false} onChange={() => handleCategoryChannelToggle(category.key, channel.key)} /></label>; })}</React.Fragment>; })}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: '2rem' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: '600', marginBottom: '1rem', color: 'var(--text-primary)' }}>Quiet Hours</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>Suppress notifications during these times in your timezone.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: '1rem' }}>
              <div style={{ minWidth: 0 }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Timezone</label>
                <select
                  className="input-field"
                  value={prefs.timezone || ''}
                  onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value || null })}
                  style={{ background: 'var(--input-bg)', minWidth: 0 }}
                >
                  <option value="">—</option>
                  {timezones.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
              <div style={{ minWidth: 0 }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Start Time (HH:MM)</label>
                <input
                  type="time"
                  className="input-field"
                  value={prefs.quietHoursStart || ''}
                  onChange={(e) => setPrefs({ ...prefs, quietHoursStart: e.target.value || null })}
                  style={{ minWidth: 0 }}
                />
              </div>
              <div style={{ minWidth: 0 }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>End Time (HH:MM)</label>
                <input
                  type="time"
                  className="input-field"
                  value={prefs.quietHoursEnd || ''}
                  onChange={(e) => setPrefs({ ...prefs, quietHoursEnd: e.target.value || null })}
                  style={{ minWidth: 0 }}
                />
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSave}
              disabled={saving}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}
            >
              {saving ? 'Saving…' : 'Save Preferences'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleReset}
              disabled={saving}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
