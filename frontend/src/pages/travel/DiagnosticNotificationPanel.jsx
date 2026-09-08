// Diagnostic Builder — Notifications panel (Travel CRM, 2026-08-28).
//
// Lets an admin pick who gets told when a new diagnostic is submitted for
// this sub-brand, and via which channel(s) — dashboard (always on), email
// (live-checked against SENDGRID_API_KEY), WhatsApp (live-checked against
// whether the tenant has an active WhatsApp Web session). Backed by
// backend/lib/diagnosticNotificationSettings.js (storage) and
// backend/lib/diagnosticNotifications.js (the actual send fan-out, wired
// into every diagnostic-submit route).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell, Mail, MessageCircle, LayoutDashboard, Plus, X, Send, Loader2,
  CheckCircle2, AlertTriangle, Info, Search,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';

const CHANNELS = [
  { key: 'db', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
];

export default function DiagnosticNotificationPanel({ subBrand, notify, isAdmin }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [recipients, setRecipients] = useState([]); // [{userId, name, email, hasPhone, channels}]
  const [baseline, setBaseline] = useState([]);
  const [availability, setAvailability] = useState({ db: true, email: false, whatsapp: false });
  const [staffOptions, setStaffOptions] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, staffRes] = await Promise.all([
        fetchApi(`/api/travel/diagnostics/notification-settings?subBrand=${encodeURIComponent(subBrand)}`, { silent: true }).catch(() => null),
        fetchApi('/api/staff?fields=summary', { silent: true }).catch(() => null),
      ]);
      const loadedRecipients = Array.isArray(settingsRes?.recipients) ? settingsRes.recipients : [];
      setRecipients(loadedRecipients);
      setBaseline(loadedRecipients);
      setAvailability(settingsRes?.channelAvailability || { db: true, email: false, whatsapp: false });
      setStaffOptions(Array.isArray(staffRes) ? staffRes : []);
      setTestResult(null);
    } finally {
      setLoading(false);
    }
  }, [subBrand]);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(
    () => JSON.stringify(recipients) !== JSON.stringify(baseline),
    [recipients, baseline],
  );

  const addedIds = useMemo(() => new Set(recipients.map((r) => r.userId)), [recipients]);
  const filteredStaff = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    return staffOptions
      .filter((u) => !addedIds.has(u.id))
      .filter((u) => !q || `${u.name || ''} ${u.email || ''}`.toLowerCase().includes(q))
      .slice(0, 25);
  }, [staffOptions, addedIds, addQuery]);

  const toggleChannel = (userId, channelKey) => {
    setRecipients((prev) => prev.map((r) => {
      if (r.userId !== userId) return r;
      const has = r.channels.includes(channelKey);
      return { ...r, channels: has ? r.channels.filter((c) => c !== channelKey) : [...r.channels, channelKey] };
    }));
  };

  const removeRecipient = (userId) => {
    setRecipients((prev) => prev.filter((r) => r.userId !== userId));
  };

  const addRecipient = (user) => {
    setRecipients((prev) => [...prev, {
      userId: user.id,
      name: user.name || user.email || `User #${user.id}`,
      email: user.email || null,
      hasPhone: false, // unknown until saved + re-fetched; whatsapp chip stays available, backend will just skip send if truly absent
      channels: ['db'],
    }]);
    setAddOpen(false);
    setAddQuery('');
  };

  const save = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await fetchApi('/api/travel/diagnostics/notification-settings', {
        method: 'PUT',
        body: JSON.stringify({
          subBrand,
          recipients: recipients.map((r) => ({ userId: r.userId, channels: r.channels })),
        }),
      });
      notify.success(
        Array.isArray(res?.recipients) && res.recipients.length
          ? `Saved — ${res.recipients.length} recipient${res.recipients.length > 1 ? 's' : ''} configured.`
          : 'Saved — no recipients configured, so new diagnostics will fall back to notifying every Admin/Manager on the dashboard.',
      );
      await load();
    } catch (e) {
      notify.error(e?.body?.error || e?.message || 'Failed to save notification settings');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetchApi('/api/travel/diagnostics/notification-settings/test', {
        method: 'POST',
        body: JSON.stringify({ subBrand }),
      });
      setTestResult(res);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || 'Failed to send test notification');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <section style={card} aria-busy="true">
        <h2 style={cardTitle}><Bell size={18} aria-hidden /> Notifications</h2>
        <p style={{ color: 'var(--text-secondary)' }}>Loading notification settings...</p>
      </section>
    );
  }

  return (
    <section style={card} aria-label="Diagnostic notification settings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ ...cardTitle, margin: 0 }}><Bell size={18} aria-hidden /> Notifications</h2>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 14px' }}>
        Choose who should be told when a new diagnostic comes in for this sub-brand, and how — dashboard alert, email, WhatsApp, or any combination per person.
      </p>

      {/* Channel availability legend */}
      <div style={legendRow}>
        {CHANNELS.map((c) => {
          const Icon = c.icon;
          const ok = availability[c.key] !== false;
          return (
            <div key={c.key} style={{ ...legendChip, ...(ok ? legendChipOk : legendChipWarn) }}>
              <Icon size={14} aria-hidden />
              <span>{c.label}</span>
              {ok ? (
                <CheckCircle2 size={13} aria-hidden style={{ marginLeft: 'auto', opacity: 0.8 }} />
              ) : (
                <AlertTriangle size={13} aria-hidden style={{ marginLeft: 'auto' }} />
              )}
            </div>
          );
        })}
      </div>
      {(!availability.email || !availability.whatsapp) && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0 14px' }}>
          {!availability.email && 'Email isn’t configured for this environment yet (no AI/notification email key set). '}
          {!availability.whatsapp && 'WhatsApp isn’t connected for this tenant — connect a session under WhatsApp settings to enable it. '}
          People can still be added with these channels selected — they’ll just take effect automatically once connected.
        </p>
      )}

      {/* Recipient list */}
      <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
        {recipients.length === 0 && (
          <div style={emptyBox}>
            <Info size={16} aria-hidden style={{ flexShrink: 0, marginTop: 1, color: 'var(--text-secondary)' }} />
            <span>
              No one is configured yet. Until you add someone, new diagnostics for this sub-brand will notify every Admin/Manager on the dashboard only (today&rsquo;s default behavior) — nothing breaks by leaving this empty.
            </span>
          </div>
        )}
        {recipients.map((r) => (
          <div key={r.userId} style={recipientRow}>
            <div style={{ minWidth: 0, flex: '1 1 200px' }}>
              <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
              {r.email && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r.email}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {CHANNELS.map((c) => {
                const Icon = c.icon;
                const active = r.channels.includes(c.key);
                const unavailable = availability[c.key] === false;
                const noPhone = c.key === 'whatsapp' && r.hasPhone === false && baseline.some((b) => b.userId === r.userId);
                const title = unavailable
                  ? `${c.label} isn’t connected for this tenant yet — selecting it is fine, it’ll start working once connected.`
                  : noPhone
                    ? `${r.name} has no phone number on file — WhatsApp won’t reach them until one is added.`
                    : `Notify via ${c.label}`;
                return (
                  <button
                    key={c.key}
                    type="button"
                    title={title}
                    aria-pressed={active}
                    aria-label={`${active ? 'Stop notifying' : 'Notify'} ${r.name} via ${c.label}`}
                    onClick={() => toggleChannel(r.userId, c.key)}
                    style={active ? (unavailable || noPhone ? channelChipActiveCaution : channelChipActive) : channelChipIdle}
                  >
                    <Icon size={12} aria-hidden /> {c.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => removeRecipient(r.userId)}
              aria-label={`Remove ${r.name}`}
              title="Remove"
              style={removeBtn}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>

      {/* Add person */}
      <div style={{ position: 'relative', marginTop: 12 }}>
        {!addOpen ? (
          <button type="button" onClick={() => setAddOpen(true)} style={addBtn}>
            <Plus size={14} aria-hidden /> Add person
          </button>
        ) : (
          <div style={addBox}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Search size={14} aria-hidden style={{ color: 'var(--text-secondary)' }} />
              <input
                autoFocus
                type="text"
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder="Search staff by name or email..."
                style={addInput}
                aria-label="Search staff to add"
              />
              <button type="button" onClick={() => { setAddOpen(false); setAddQuery(''); }} style={{ ...removeBtn, flexShrink: 0 }} aria-label="Close">
                <X size={14} aria-hidden />
              </button>
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 4 }}>
              {filteredStaff.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '6px 4px' }}>
                  {staffOptions.length === 0 ? 'No staff found for this tenant.' : 'Everyone matching that search is already added.'}
                </div>
              ) : (
                filteredStaff.map((u) => (
                  <button key={u.id} type="button" onClick={() => addRecipient(u)} style={staffOption}>
                    <span style={{ fontWeight: 600 }}>{u.name || u.email}</span>
                    {u.email && <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>{u.email}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {testResult && (
        <div style={testResultBox}>
          <strong style={{ fontSize: 12 }}>Test notification result:</strong>
          <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap', fontSize: 12 }}>
            {CHANNELS.map((c) => (
              <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {testResult[c.key] === 'sent' ? (
                  <CheckCircle2 size={13} aria-hidden style={{ color: 'var(--success-color, #2F7A4D)' }} />
                ) : (
                  <AlertTriangle size={13} aria-hidden style={{ color: 'var(--text-secondary)' }} />
                )}
                {c.label}: {testResult[c.key].replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
        {!isAdmin && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 12, alignSelf: 'center' }}>
            Read-only. Admin access is required to save.
          </span>
        )}
        <button
          type="button"
          onClick={runTest}
          disabled={testing || !isAdmin}
          style={testing || !isAdmin ? secondaryBtnDisabled : secondaryBtn}
          title="Sends a real test notification to you across all 3 channels, regardless of the saved list."
        >
          {testing ? <Loader2 size={14} className="spin" aria-hidden /> : <Send size={14} aria-hidden />}
          {testing ? 'Sending...' : 'Send test notification'}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !isAdmin || !dirty}
          style={saving || !isAdmin || !dirty ? primaryBtnDisabled : primaryBtn}
        >
          {saving ? <Loader2 size={14} className="spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </section>
  );
}

const card = {
  background: 'var(--surface-color)', borderRadius: 12, padding: 16,
  border: '1px solid var(--border-color)',
};
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 };
const legendRow = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const legendChip = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '5px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
  border: '1px solid var(--border-color)',
};
const legendChipOk = { background: 'rgba(47, 122, 77, 0.10)', color: 'var(--success-color, #2F7A4D)', borderColor: 'rgba(47, 122, 77, 0.3)' };
const legendChipWarn = { background: 'rgba(217, 119, 6, 0.10)', color: 'var(--warning-color, #d97706)', borderColor: 'rgba(217, 119, 6, 0.3)' };
const emptyBox = {
  display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 8,
  background: 'var(--subtle-bg, rgba(91,110,248,0.06))', border: '1px dashed var(--border-color)',
  fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5,
};
const recipientRow = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
};
const channelChipIdle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
const channelChipActive = {
  ...channelChipIdle,
  background: 'var(--primary-color)', color: '#fff', borderColor: 'var(--primary-color)',
};
const channelChipActiveCaution = {
  ...channelChipIdle,
  background: 'rgba(217, 119, 6, 0.12)', color: 'var(--warning-color, #d97706)', borderColor: 'rgba(217, 119, 6, 0.35)',
};
const removeBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 26, borderRadius: 6, background: 'transparent',
  color: 'var(--text-secondary)', border: '1px solid var(--border-color)', cursor: 'pointer',
};
const addBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', borderRadius: 8, fontWeight: 600, fontSize: 13,
  background: 'transparent', color: 'var(--primary-color)',
  border: '1px dashed var(--primary-color)', cursor: 'pointer',
};
const addBox = {
  border: '1px solid var(--border-color)', borderRadius: 8, padding: 10,
  background: 'var(--bg-color)',
};
const addInput = {
  flex: 1, padding: '6px 8px', borderRadius: 6, fontSize: 13,
  border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)',
};
const staffOption = {
  textAlign: 'left', padding: '7px 8px', borderRadius: 6, fontSize: 13,
  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
};
const testResultBox = {
  marginTop: 14, padding: '8px 12px', borderRadius: 8,
  background: 'var(--subtle-bg, rgba(91,110,248,0.06))', border: '1px solid var(--border-color)',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', borderRadius: 8, fontWeight: 600, fontSize: 14,
  background: 'var(--primary-color)', color: '#fff', border: 'none', cursor: 'pointer',
};
const primaryBtnDisabled = { ...primaryBtn, opacity: 0.5, cursor: 'not-allowed' };
const secondaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', borderRadius: 8, fontWeight: 600, fontSize: 14,
  background: 'var(--surface-color)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
const secondaryBtnDisabled = { ...secondaryBtn, opacity: 0.5, cursor: 'not-allowed' };
