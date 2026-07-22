import React, { useState, useEffect } from 'react';
import { Bell } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

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
  // Wellness vertical surfaces
  { key: 'appointment', label: 'Appointments & Bookings', paths: ['/wellness/appointments', '/wellness/my-appointments', '/wellness/my-bookings', '/wellness/book-appointment', '/wellness/calendar', '/booking-pages'] },
  { key: 'prescription', label: 'Prescriptions', paths: ['/wellness/prescriptions', '/wellness/my-prescriptions'] },
  { key: 'visit', label: 'Visits', paths: ['/wellness/visits'] },
  { key: 'membership', label: 'Memberships', paths: ['/wellness/memberships'] },
  { key: 'payment', label: 'Payments & Transactions', paths: ['/payments', '/wellness/my-transactions', '/wellness/wallet', '/invoices', '/wellness/invoices'] },
  { key: 'waitlist', label: 'Waitlist', paths: ['/wellness/waitlist'] },
  { key: 'inventory', label: 'Inventory', paths: ['/wellness/inventory', '/wellness/inventory-receipts', '/wellness/inventory-adjustments'] },
];

export default function UserSettings() {
  const notify = useNotify();
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [accessiblePaths, setAccessiblePaths] = useState(null);

  const visibleCategories = (() => {
    if (!Array.isArray(accessiblePaths)) return categoryOptions;
    const pathSet = new Set(accessiblePaths);
    return categoryOptions.filter((cat) =>
      (cat.paths || []).some((p) => pathSet.has(p))
    );
  })();

  const channelOptions = [
    { key: 'db', label: 'In-App Bell' },
    { key: 'socket', label: 'Real-Time Updates' },
    { key: 'push', label: 'Browser Push' },
    { key: 'email', label: 'Email' },
  ];

  // Timezone list
  const timezones = [
    'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Australia/Sydney'
  ];

  const load = async () => {
    try {
      const data = await fetchApi('/api/notifications/preferences');
      setPrefs(data);
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
      channels: {
        ...prefs.channels,
        [channel]: !prefs.channels[channel],
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
        <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Bell size={20} color="var(--accent-color)" /> Notification Preferences
          </h3>

          {visibleCategories.length > 0 && (
          <div style={{ marginBottom: '2rem' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: '600', marginBottom: '1rem', color: 'var(--text-primary)' }}>Notification Categories</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>Choose which types of notifications you want to receive.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0.75rem' }}>
              {visibleCategories.map(cat => (
                <label key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.5rem', borderRadius: 6, background: 'var(--surface-color)', border: '1px solid var(--border-color)' }}>
                  <input
                    type="checkbox"
                    checked={prefs.categoryToggles[cat.key] !== false}
                    onChange={() => handleCategoryToggle(cat.key)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.9rem' }}>{cat.label}</span>
                </label>
              ))}
            </div>
          </div>
          )}

          <div style={{ marginBottom: '2rem' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: '600', marginBottom: '1rem', color: 'var(--text-primary)' }}>Delivery Channels</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>Select how you want to receive notifications.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0.75rem' }}>
              {channelOptions.map(ch => (
                <label key={ch.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.5rem', borderRadius: 6, background: 'var(--surface-color)', border: '1px solid var(--border-color)' }}>
                  <input
                    type="checkbox"
                    checked={prefs.channels[ch.key] !== false}
                    onChange={() => handleChannelToggle(ch.key)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.9rem' }}>{ch.label}</span>
                </label>
              ))}
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
