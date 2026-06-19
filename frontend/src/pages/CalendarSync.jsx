import React, { useEffect, useState } from 'react';
import { Calendar, RefreshCw, ExternalLink, Check, Plug, Trash2, Users, Video, Plus, AlertTriangle } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const PROVIDERS = [
  {
    key: 'google',
    label: 'Google Calendar',
    color: '#4285F4',
    bg: 'rgba(66,133,244,0.10)',
    initials: 'G',
  },
  {
    key: 'outlook',
    label: 'Microsoft Outlook',
    color: '#0078D4',
    bg: 'rgba(0,120,212,0.10)',
    initials: 'O',
  },
];

function Toast({ msg, onClose }) {
  // Infer success vs error from the message so failures show red (with an
  // alert icon) instead of a misleading green checkmark. Error toasts also
  // linger longer so the user can actually read a "please reconnect" prompt.
  const isError = /\b(fail|error|expired|reconnect|couldn|could not|denied|invalid|unable|not connected|no sync)\b/i.test(msg || '');
  useEffect(() => {
    const t = setTimeout(onClose, isError ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [onClose, isError]);
  return (
    <div style={{
      position: 'fixed', top: '1.5rem', right: '1.5rem', zIndex: 9999,
      background: isError ? 'rgba(239,68,68,0.96)' : 'rgba(34,197,94,0.95)', color: '#fff',
      padding: '0.75rem 1.25rem', borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
      backdropFilter: 'blur(8px)',
      maxWidth: '380px', lineHeight: 1.4, fontSize: '0.875rem',
    }}>
      {isError
        ? <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
        : <Check size={18} style={{ flexShrink: 0, marginTop: 1 }} />}
      <span>{msg}</span>
    </div>
  );
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function attendeeCount(att) {
  if (!att) return 0;
  try {
    const arr = typeof att === 'string' ? JSON.parse(att) : att;
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
}

export default function CalendarSync() {
  const notify = useNotify();
  const [status, setStatus] = useState({
    google: { connected: false, lastSyncAt: null },
    outlook: { connected: false, lastSyncAt: null },
  });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState({ google: false, outlook: false });
  const [toast, setToast] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createProvider, setCreateProvider] = useState('');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    startTime: '',
    endTime: '',
    attendees: '',
    location: '',
    createMeet: false,
    createZoom: false,
  });
  const [showEventDetail, setShowEventDetail] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [isEditingEvent, setIsEditingEvent] = useState(false);
  const [editFormData, setEditFormData] = useState({});
  // T18 slot-picker (Google only): pick a day → fetch free/busy slots →
  // click a slot to fill start/end. Purely additive; leaving it untouched
  // keeps the manual datetime inputs as the source of truth.
  const [slotPicker, setSlotPicker] = useState({ date: '', slots: [], loading: false, error: '' });
  // Attendee picker — contacts/customers fetched lazily when the modal opens.
  const [contactOptions, setContactOptions] = useState([]);

  // Detect ?connected=google|outlook in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get('connected');
    const err = params.get('error');
    if (c === 'google' || c === 'outlook') {
      setToast(`${c === 'google' ? 'Google' : 'Outlook'} Calendar connected!`);
      // Clean the URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (err) {
      setToast(`Connection failed: ${err}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const loadAll = async () => {
    setLoading(true);
    const next = { google: { connected: false, lastSyncAt: null }, outlook: { connected: false, lastSyncAt: null } };
    const collected = [];
    await Promise.all(
      PROVIDERS.map(async (p) => {
        try {
          const evs = await fetchApi(`/api/calendar/${p.key}/events`);
          if (Array.isArray(evs)) {
            next[p.key].connected = true;
            // Find most recent event's update for "last sync" fallback
            evs.forEach((e) => collected.push({ ...e, _provider: p.key }));
            // Try to fetch integration metadata if route exposes it later, fallback: most recent event time
            const latest = evs.reduce((acc, e) => {
              const t = new Date(e.updatedAt || e.startTime || 0).getTime();
              return t > acc ? t : acc;
            }, 0);
            if (latest) next[p.key].lastSyncAt = new Date(latest).toISOString();
          }
        } catch {
          // not connected or endpoint unavailable — ignore
        }
      })
    );
    collected.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    setStatus(next);
    setEvents(collected);
    setLoading(false);
  };

  useEffect(() => { loadAll(); }, []);

  const handleConnect = async (provider) => {
    setBusy((b) => ({ ...b, [provider]: true }));
    try {
      const res = await fetchApi(`/api/calendar/${provider}/connect`);
      if (res && res.authUrl) {
        window.location.href = res.authUrl;
      } else {
        setToast(`Failed to start ${provider} OAuth`);
      }
    } catch (e) {
      setToast(`Error: ${e.message || 'Unable to connect'}`);
    } finally {
      setBusy((b) => ({ ...b, [provider]: false }));
    }
  };

  const handleSync = async (provider) => {
    setBusy((b) => ({ ...b, [provider]: true }));
    try {
      // silent: true → suppress fetchApi's global auto-toast so we don't show
      // two notifications; this page renders its own (error-styled) toast.
      const res = await fetchApi(`/api/calendar/${provider}/sync`, { method: 'POST', silent: true });
      setToast(`Synced ${res.synced ?? 0} ${provider} events`);
      await loadAll();
    } catch (e) {
      // The backend now returns a friendly, self-explanatory message (e.g.
      // "Your Microsoft Outlook connection has expired. Please reconnect…"),
      // so show it directly rather than prefixing/dumping a raw OAuth error.
      setToast(e.message || `Couldn't sync ${provider === 'google' ? 'Google' : 'Outlook'}. Please try again.`);
    } finally {
      setBusy((b) => ({ ...b, [provider]: false }));
    }
  };

  const handleDisconnect = async (provider) => {
    if (!await notify.confirm(`Disconnect ${provider} Calendar? Synced events will remain.`)) return;
    setBusy((b) => ({ ...b, [provider]: true }));
    try {
      await fetchApi(`/api/calendar/${provider}/disconnect`, { method: 'DELETE' });
      setToast(`${provider === 'google' ? 'Google' : 'Outlook'} Calendar disconnected`);
      await loadAll();
    } catch (e) {
      setToast(`Disconnect failed: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, [provider]: false }));
    }
  };

  // Lazily fetch contacts/customers the first time the Create-Event modal
  // opens, to populate the attendee dropdown. Best-effort — failure just
  // leaves the manual email input as the only path.
  useEffect(() => {
    if (!showCreateModal || contactOptions.length) return;
    fetchApi('/api/contacts?limit=200')
      .then((res) => {
        const list = Array.isArray(res) ? res : (res?.data || res?.contacts || []);
        setContactOptions(
          list
            .filter((c) => c && c.email)
            .map((c) => ({ id: c.id, name: c.name || c.email, email: c.email }))
        );
      })
      .catch(() => {});
  }, [showCreateModal, contactOptions.length]);

  // Append an email to the comma-separated attendees field, de-duplicating.
  const addAttendeeEmail = (email) => {
    if (!email) return;
    const current = formData.attendees.split(',').map((s) => s.trim()).filter(Boolean);
    if (current.includes(email)) return;
    setFormData({ ...formData, attendees: [...current, email].join(', ') });
  };

  const handleCreateEvent = async (e) => {
    e.preventDefault();
    if (!formData.title || !formData.startTime || !formData.endTime) {
      setToast('Title, start time, and end time are required');
      return;
    }
    setBusy((b) => ({ ...b, [createProvider]: true }));
    try {
      const payload = {
        title: formData.title,
        description: formData.description,
        startTime: new Date(formData.startTime).toISOString(),
        endTime: new Date(formData.endTime).toISOString(),
        location: formData.location,
        attendees: formData.attendees ? formData.attendees.split(',').map(a => a.trim()) : [],
      };
      // Online meeting link is opt-in for both providers — Google Meet for
      // Google, Teams for Outlook. Both routes read the same createMeet flag.
      if (formData.createMeet) {
        payload.createMeet = true;
      }
      // Zoom is independent of the calendar provider — the backend creates the
      // Zoom meeting and weaves its join link into the event (no-op if Zoom
      // creds aren't configured server-side).
      if (formData.createZoom) {
        payload.createZoom = true;
      }
      await fetchApi(`/api/calendar/${createProvider}/events`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      setToast(`Event created in ${createProvider === 'google' ? 'Google' : 'Outlook'}`);
      setShowCreateModal(false);
      setFormData({ title: '', description: '', startTime: '', endTime: '', attendees: '', location: '', createMeet: false, createZoom: false }); setSlotPicker({ date: '', slots: [], loading: false, error: '' });
      await loadAll();
    } catch (e) {
      setToast(`Failed to create event: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, [createProvider]: false }));
    }
  };

  // T18: fetch free/busy slots for the chosen day from the Google Calendar
  // slots endpoint. Each returned slot, when clicked, fills the start/end
  // datetime-local inputs (converted to the browser's local wall-clock so the
  // existing inputs render correctly). tzOffsetMins tells the backend which
  // wall-clock the working hours refer to.
  const handleFindSlots = async () => {
    if (!slotPicker.date) {
      setSlotPicker((s) => ({ ...s, error: 'Pick a date first' }));
      return;
    }
    setSlotPicker((s) => ({ ...s, loading: true, error: '', slots: [] }));
    try {
      const tzOffsetMins = -new Date().getTimezoneOffset(); // e.g. +330 for IST
      const qs = new URLSearchParams({
        date: slotPicker.date,
        durationMins: '30',
        tzOffsetMins: String(tzOffsetMins),
      }).toString();
      const res = await fetchApi(`/api/calendar/${createProvider}/slots?${qs}`);
      const slots = Array.isArray(res?.slots) ? res.slots : [];
      setSlotPicker((s) => ({ ...s, loading: false, slots, error: slots.length ? '' : 'No free slots that day' }));
    } catch (err) {
      setSlotPicker((s) => ({ ...s, loading: false, error: err.message || 'Failed to load slots' }));
    }
  };

  // Convert an ISO instant to the value a datetime-local input expects
  // (local wall-clock, no timezone suffix, minute precision).
  const isoToLocalInput = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handlePickSlot = (slot) => {
    setFormData((f) => ({
      ...f,
      startTime: isoToLocalInput(slot.start),
      endTime: isoToLocalInput(slot.end),
    }));
  };

  const handleOpenEventDetail = (event) => {
    setSelectedEvent(event);
    setEditFormData({
      title: event.title,
      description: event.description || '',
      startTime: event.startTime ? new Date(event.startTime).toISOString().slice(0, 16) : '',
      endTime: event.endTime ? new Date(event.endTime).toISOString().slice(0, 16) : '',
      location: event.location || '',
      attendees: event.attendees ? (typeof event.attendees === 'string' ? JSON.parse(event.attendees).map(a => a.email || a).join(', ') : event.attendees.join(', ')) : '',
    });
    setShowEventDetail(true);
  };

  const handleEditEvent = async (e) => {
    e.preventDefault();
    if (!editFormData.title || !editFormData.startTime || !editFormData.endTime) {
      setToast('Title, start time, and end time are required');
      return;
    }
    setBusy((b) => ({ ...b, edit: true }));
    try {
      const payload = {
        title: editFormData.title,
        description: editFormData.description,
        startTime: new Date(editFormData.startTime).toISOString(),
        endTime: new Date(editFormData.endTime).toISOString(),
        location: editFormData.location,
        attendees: editFormData.attendees ? editFormData.attendees.split(',').map(a => a.trim()) : [],
      };
      await fetchApi(`/api/calendar/events/${selectedEvent.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      setToast('Event updated successfully');
      setShowEventDetail(false);
      setIsEditingEvent(false);
      await loadAll();
    } catch (e) {
      setToast(`Failed to update event: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, edit: false }));
    }
  };

  const handleDeleteEvent = async () => {
    if (!await notify.confirm('Are you sure you want to delete this event? This action cannot be undone.')) return;
    setBusy((b) => ({ ...b, delete: true }));
    try {
      await fetchApi(`/api/calendar/events/${selectedEvent.id}`, {
        method: 'DELETE'
      });
      setToast('Event deleted successfully');
      setShowEventDetail(false);
      await loadAll();
    } catch (e) {
      setToast(`Failed to delete event: ${e.message}`);
    } finally {
      setBusy((b) => ({ ...b, delete: false }));
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      {toast && <Toast msg={toast} onClose={() => setToast('')} />}

      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Calendar size={26} style={{ color: 'var(--accent-color)' }} />
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', margin: 0 }}>Calendar Sync</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
            Connect your Google and Outlook calendars to sync meetings into the CRM
          </p>
        </div>
      </header>

      {/* Provider cards */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: '1.25rem', marginBottom: '2rem',
      }}>
        {PROVIDERS.map((p) => {
          const s = status[p.key];
          return (
            <div
              key={p.key}
              className="card"
              style={{
                padding: '1.5rem',
                background: 'var(--card-bg, rgba(255,255,255,0.06))',
                border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
                borderRadius: '14px',
                backdropFilter: 'blur(12px)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
              }}
            >
              {/* Header with provider info and Create Event button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1rem', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: '10px',
                    background: p.bg, color: p.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: '1.1rem',
                  }}>
                    {p.initials}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '1rem' }}>{p.label}</div>
                    <div style={{
                      fontSize: '0.75rem',
                      color: s.connected ? '#22c55e' : 'var(--text-secondary)',
                      display: 'flex', alignItems: 'center', gap: '0.25rem',
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: s.connected ? '#22c55e' : '#94a3b8',
                        display: 'inline-block',
                      }} />
                      {s.connected ? 'Connected' : 'Not connected'}
                    </div>
                  </div>
                </div>

                {/* Create Event button (top right) */}
                {s.connected && (
                  <button
                    onClick={() => { setCreateProvider(p.key); setShowCreateModal(true); }}
                    disabled={busy[p.key]}
                    title="Create new calendar event"
                    style={{
                      width: 40, height: 40, borderRadius: '8px', border: 'none',
                      background: 'rgba(99,102,241,0.15)', color: 'var(--accent-color, #6366f1)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      opacity: busy[p.key] ? 0.6 : 1,
                      transition: 'all 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(99,102,241,0.25)';
                      e.currentTarget.style.transform = 'scale(1.05)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(99,102,241,0.15)';
                      e.currentTarget.style.transform = 'scale(1)';
                    }}
                  >
                    <Plus size={20} />
                  </button>
                )}
              </div>

              <div style={{
                fontSize: '0.8rem', color: 'var(--text-secondary)',
                marginBottom: '1rem', minHeight: '1.25rem',
              }}>
                {s.lastSyncAt
                  ? `Last activity: ${formatDateTime(s.lastSyncAt)}`
                  : s.connected ? 'No sync yet' : 'Connect to start syncing meetings'}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {!s.connected ? (
                  <button
                    onClick={() => handleConnect(p.key)}
                    disabled={busy[p.key]}
                    style={{
                      padding: '0.55rem 1rem', borderRadius: '8px', border: 'none',
                      background: p.color, color: '#fff', cursor: 'pointer',
                      fontWeight: 600, fontSize: '0.85rem',
                      display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                      opacity: busy[p.key] ? 0.7 : 1,
                    }}
                  >
                    <Plug size={15} /> {busy[p.key] ? 'Connecting...' : 'Connect'}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => handleSync(p.key)}
                      disabled={busy[p.key]}
                      style={{
                        padding: '0.55rem 1rem', borderRadius: '8px', border: 'none',
                        background: 'var(--accent-color, #6366f1)', color: '#fff',
                        cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem',
                        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                        opacity: busy[p.key] ? 0.7 : 1,
                      }}
                    >
                      <RefreshCw size={15} className={busy[p.key] ? 'spin' : ''} />
                      {busy[p.key] ? 'Syncing...' : 'Sync Now'}
                    </button>
                    <button
                      onClick={() => handleDisconnect(p.key)}
                      disabled={busy[p.key]}
                      style={{
                        padding: '0.55rem 1rem', borderRadius: '8px',
                        border: '1px solid rgba(239,68,68,0.4)',
                        background: 'transparent', color: '#ef4444',
                        cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem',
                        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                      }}
                    >
                      <Trash2 size={15} /> Disconnect
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Events */}
      <div
        className="card"
        style={{
          padding: '1.5rem',
          background: 'var(--card-bg, rgba(255,255,255,0.06))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          borderRadius: '14px',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '1rem',
        }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>Upcoming meetings</h3>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {events.length} event{events.length === 1 ? '' : 's'}
          </span>
        </div>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Loading events...
          </div>
        ) : events.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            No events synced yet. Connect a calendar above and click "Sync Now".
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {events.slice(0, 50).map((ev) => {
              const provider = PROVIDERS.find((p) => p.key === ev._provider) || PROVIDERS[0];
              const count = attendeeCount(ev.attendees);
              return (
                <div
                  key={`${ev._provider}-${ev.id}`}
                  onClick={() => handleOpenEventDetail(ev)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '160px 1fr auto',
                    gap: '1rem', alignItems: 'center',
                    padding: '0.75rem 1rem',
                    borderRadius: '10px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.05)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                    e.currentTarget.style.transform = 'translateX(2px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)';
                    e.currentTarget.style.transform = 'translateX(0)';
                  }}
                >
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {formatDateTime(ev.startTime)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontWeight: 600, fontSize: '0.95rem',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {ev.title}
                    </div>
                    <div style={{
                      fontSize: '0.75rem', color: 'var(--text-secondary)',
                      display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.15rem',
                    }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: provider.color }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: provider.color, display: 'inline-block',
                        }} />
                        {provider.label}
                      </span>
                      {count > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                          <Users size={12} /> {count}
                        </span>
                      )}
                      {ev.location && (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                          {ev.location}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {ev.meetingUrl && (
                      <a
                        href={ev.meetingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                          padding: '0.4rem 0.75rem', borderRadius: '6px',
                          background: 'rgba(99,102,241,0.12)',
                          color: 'var(--accent-color, #6366f1)',
                          textDecoration: 'none', fontSize: '0.78rem', fontWeight: 600,
                        }}
                      >
                        <Video size={13} /> Join
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Event Detail Modal */}
      {showEventDetail && selectedEvent && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9998,
        }}>
          <div
            style={{
              background: 'var(--bg-color)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
              padding: '2rem',
              maxWidth: '550px',
              width: '90%',
              maxHeight: '85vh',
              overflowY: 'auto',
            }}
          >
            {!isEditingEvent ? (
              <>
                {/* View Mode */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                  <h3 style={{
                    margin: 0, fontSize: '1.3rem', fontWeight: 700,
                    color: 'var(--text-primary)'
                  }}>
                    {selectedEvent.title}
                  </h3>
                  <button
                    onClick={() => setShowEventDetail(false)}
                    style={{
                      background: 'none', border: 'none', fontSize: '1.5rem',
                      color: 'var(--text-secondary)', cursor: 'pointer', padding: '0',
                      transition: 'color 0.2s ease',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
                    onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
                  >
                    ✕
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  {/* Date & Time */}
                  <div style={{ borderLeft: '3px solid #6366f1', paddingLeft: '1rem' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.5rem' }}>
                      Date & Time
                    </div>
                    <div style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                      {formatDateTime(selectedEvent.startTime)} - {new Date(selectedEvent.endTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>

                  {/* Location */}
                  {selectedEvent.location && (
                    <div style={{ borderLeft: '3px solid #10b981', paddingLeft: '1rem' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.5rem' }}>
                        Location
                      </div>
                      <div style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                        {selectedEvent.location}
                      </div>
                    </div>
                  )}

                  {/* Attendees */}
                  {attendeeCount(selectedEvent.attendees) > 0 && (
                    <div style={{ borderLeft: '3px solid #f59e0b', paddingLeft: '1rem' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.5rem' }}>
                        Attendees
                      </div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                        {(() => {
                          try {
                            const att = typeof selectedEvent.attendees === 'string' ? JSON.parse(selectedEvent.attendees) : selectedEvent.attendees;
                            return Array.isArray(att) ? att.map((a, i) => (
                              <div key={i} style={{ marginBottom: '0.25rem' }}>• {a.email || a.name || a}</div>
                            )) : null;
                          } catch { return null; }
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Description */}
                  {selectedEvent.description && (
                    <div style={{ borderLeft: '3px solid #8b5cf6', paddingLeft: '1rem' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.5rem' }}>
                        Description
                      </div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', lineHeight: '1.5' }}>
                        {selectedEvent.description}
                      </div>
                    </div>
                  )}

                  {/* Provider Badge */}
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.5rem 1rem', borderRadius: '8px',
                    background: `${PROVIDERS.find(p => p.key === selectedEvent._provider)?.bg || 'rgba(99,102,241,0.1)'}`,
                    width: 'fit-content',
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: PROVIDERS.find(p => p.key === selectedEvent._provider)?.color || '#6366f1',
                      display: 'inline-block',
                    }} />
                    <span style={{
                      color: PROVIDERS.find(p => p.key === selectedEvent._provider)?.color || '#6366f1',
                      fontSize: '0.85rem', fontWeight: 600
                    }}>
                      {PROVIDERS.find(p => p.key === selectedEvent._provider)?.label || 'Calendar'}
                    </span>
                  </div>
                </div>

                {/* Buttons */}
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '2rem', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowEventDetail(false)}
                    style={{
                      padding: '0.65rem 1.5rem', borderRadius: '8px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-color)', color: 'var(--text-primary)',
                      cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
                      transition: 'all 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--input-bg)';
                      e.currentTarget.style.borderColor = 'var(--border-color)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--input-bg-focus)';
                      e.currentTarget.style.borderColor = 'var(--border-color)';
                    }}
                  >
                    Close
                  </button>
                  <button
                    onClick={() => setIsEditingEvent(true)}
                    style={{
                      padding: '0.65rem 1.5rem', borderRadius: '8px',
                      border: 'none',
                      background: 'var(--accent-color, #6366f1)', color: '#fff',
                      cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
                      transition: 'all 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--accent-hover, #4f46e5)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--accent-color, #6366f1)';
                    }}
                  >
                    ✎ Edit
                  </button>
                  <button
                    onClick={handleDeleteEvent}
                    disabled={busy.delete}
                    style={{
                      padding: '0.65rem 1.5rem', borderRadius: '8px',
                      border: '1px solid rgba(239,68,68,0.3)',
                      background: 'rgba(239,68,68,0.12)', color: '#dc2626',
                      cursor: busy.delete ? 'not-allowed' : 'pointer',
                      fontWeight: 600, fontSize: '0.9rem',
                      opacity: busy.delete ? 0.6 : 1,
                      transition: 'all 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!busy.delete) {
                        e.currentTarget.style.background = 'rgba(239,68,68,0.18)';
                        e.currentTarget.style.borderColor = 'rgba(239,68,68,0.4)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(239,68,68,0.12)';
                      e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)';
                    }}
                  >
                    {busy.delete ? '🗑️ Deleting...' : '🗑️ Delete'}
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* Edit Mode */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                  <h3 style={{
                    margin: 0, fontSize: '1.3rem', fontWeight: 700,
                    color: 'var(--text-primary)'
                  }}>
                    Edit Event
                  </h3>
                  <button
                    onClick={() => setShowEventDetail(false)}
                    style={{
                      background: 'none', border: 'none', fontSize: '1.5rem',
                      color: 'var(--text-secondary)', cursor: 'pointer', padding: '0',
                      transition: 'color 0.2s ease',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
                    onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleEditEvent} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* Title */}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                      Event Title <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={editFormData.title}
                      onChange={(e) => setEditFormData({ ...editFormData, title: e.target.value })}
                      style={{
                        width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        background: 'var(--input-bg)',
                        color: 'var(--text-primary)',
                        boxSizing: 'border-box',
                        transition: 'all 0.2s ease',
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                        e.target.style.background = 'var(--input-bg-focus)';
                        e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = 'var(--border-color)';
                        e.target.style.background = 'var(--input-bg)';
                        e.target.style.boxShadow = 'none';
                      }}
                    />
                  </div>

                  {/* Start and End Time */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                        Start Time <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={editFormData.startTime}
                        onChange={(e) => setEditFormData({ ...editFormData, startTime: e.target.value })}
                        style={{
                          width: '100%', padding: '0.85rem', fontSize: '0.92rem',
                          border: '1px solid var(--border-color)',
                          borderRadius: '8px',
                          background: 'var(--input-bg)',
                          color: 'var(--text-primary)',
                          boxSizing: 'border-box',
                          transition: 'all 0.2s ease',
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                          e.target.style.background = 'var(--input-bg-focus)';
                          e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                        }}
                        onBlur={(e) => {
                          e.target.style.borderColor = 'var(--border-color)';
                          e.target.style.background = 'var(--input-bg)';
                          e.target.style.boxShadow = 'none';
                        }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                        End Time <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={editFormData.endTime}
                        onChange={(e) => setEditFormData({ ...editFormData, endTime: e.target.value })}
                        style={{
                          width: '100%', padding: '0.85rem', fontSize: '0.92rem',
                          border: '1px solid var(--border-color)',
                          borderRadius: '8px',
                          background: 'var(--input-bg)',
                          color: 'var(--text-primary)',
                          boxSizing: 'border-box',
                          transition: 'all 0.2s ease',
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                          e.target.style.background = 'var(--input-bg-focus)';
                          e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                        }}
                        onBlur={(e) => {
                          e.target.style.borderColor = 'var(--border-color)';
                          e.target.style.background = 'var(--input-bg)';
                          e.target.style.boxShadow = 'none';
                        }}
                      />
                    </div>
                  </div>

                  {/* Location */}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                      Location
                    </label>
                    <input
                      type="text"
                      value={editFormData.location}
                      onChange={(e) => setEditFormData({ ...editFormData, location: e.target.value })}
                      style={{
                        width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        background: 'var(--input-bg)',
                        color: 'var(--text-primary)',
                        boxSizing: 'border-box',
                        transition: 'all 0.2s ease',
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                        e.target.style.background = 'var(--input-bg-focus)';
                        e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = 'var(--border-color)';
                        e.target.style.background = 'var(--input-bg)';
                        e.target.style.boxShadow = 'none';
                      }}
                    />
                  </div>

                  {/* Attendees */}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                      Attendees
                    </label>
                    <input
                      type="text"
                      value={editFormData.attendees}
                      onChange={(e) => setEditFormData({ ...editFormData, attendees: e.target.value })}
                      placeholder="email@example.com, another@example.com"
                      style={{
                        width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        background: 'var(--input-bg)',
                        color: 'var(--text-primary)',
                        boxSizing: 'border-box',
                        transition: 'all 0.2s ease',
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                        e.target.style.background = 'var(--input-bg-focus)';
                        e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = 'var(--border-color)';
                        e.target.style.background = 'var(--input-bg)';
                        e.target.style.boxShadow = 'none';
                      }}
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                      Description
                    </label>
                    <textarea
                      value={editFormData.description}
                      onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                      placeholder="Add any notes about this event..."
                      style={{
                        width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        background: 'var(--input-bg)',
                        color: 'var(--text-primary)',
                        boxSizing: 'border-box',
                        minHeight: '90px',
                        resize: 'vertical',
                        fontFamily: 'inherit',
                        transition: 'all 0.2s ease',
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                        e.target.style.background = 'var(--input-bg-focus)';
                        e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = 'var(--border-color)';
                        e.target.style.background = 'var(--input-bg)';
                        e.target.style.boxShadow = 'none';
                      }}
                    />
                  </div>

                  {/* Buttons */}
                  <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => setIsEditingEvent(false)}
                      style={{
                        padding: '0.65rem 1.5rem', borderRadius: '8px',
                        border: '1px solid var(--border-color)',
                        background: 'var(--bg-color)', color: 'var(--text-primary)',
                        cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--input-bg)';
                        e.currentTarget.style.borderColor = 'var(--border-color)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--input-bg-focus)';
                        e.currentTarget.style.borderColor = 'var(--border-color)';
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!editFormData.title || !editFormData.startTime || !editFormData.endTime || busy.edit}
                      style={{
                        padding: '0.65rem 1.75rem', borderRadius: '8px',
                        border: 'none',
                        background: !editFormData.title || !editFormData.startTime || !editFormData.endTime || busy.edit
                          ? '#d1d5db'
                          : '#6366f1',
                        color: '#fff',
                        cursor: !editFormData.title || !editFormData.startTime || !editFormData.endTime || busy.edit ? 'not-allowed' : 'pointer',
                        fontWeight: 600, fontSize: '0.9rem',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!(!editFormData.title || !editFormData.startTime || !editFormData.endTime || busy.edit)) {
                          e.currentTarget.style.background = 'var(--accent-hover, #4f46e5)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!(!editFormData.title || !editFormData.startTime || !editFormData.endTime || busy.edit)) {
                          e.currentTarget.style.background = 'var(--accent-color, #6366f1)';
                        }
                      }}
                    >
                      {busy.edit ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Event Modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9998,
          animation: 'fadeIn 0.25s ease',
        }}>
          <div
            style={{
              background: 'var(--bg-color)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
              padding: '2rem',
              maxWidth: '520px',
              width: '90%',
              maxHeight: '85vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{
                margin: 0, fontSize: '1.3rem', fontWeight: 700,
                color: 'var(--text-primary)'
              }}>
                Create Event in {createProvider === 'google' ? 'Google' : 'Outlook'}
              </h3>
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setFormData({ title: '', description: '', startTime: '', endTime: '', attendees: '', location: '', createMeet: false, createZoom: false }); setSlotPicker({ date: '', slots: [], loading: false, error: '' });
                }}
                style={{
                  background: 'none', border: 'none', fontSize: '1.5rem',
                  color: 'var(--text-secondary)', cursor: 'pointer', padding: '0',
                  transition: 'color 0.2s ease',
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateEvent} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Title */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                  Event Title <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  placeholder="Team Meeting, Client Call, etc."
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  style={{
                    width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    background: 'var(--input-bg)',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                    transition: 'all 0.2s ease',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                    e.target.style.background = 'var(--input-bg-focus)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--border-color)';
                    e.target.style.background = 'var(--input-bg)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              {/* Start and End Time (side by side) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                    Start Time <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    style={{
                      width: '100%', padding: '0.85rem', fontSize: '0.92rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      background: 'var(--input-bg)',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                      transition: 'all 0.2s ease',
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                      e.target.style.background = 'var(--input-bg-focus)';
                      e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = 'var(--border-color)';
                      e.target.style.background = 'var(--input-bg)';
                      e.target.style.boxShadow = 'none';
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                    End Time <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={formData.endTime}
                    onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                    style={{
                      width: '100%', padding: '0.85rem', fontSize: '0.92rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      background: 'var(--input-bg)',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                      transition: 'all 0.2s ease',
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                      e.target.style.background = 'var(--input-bg-focus)';
                      e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = 'var(--border-color)';
                      e.target.style.background = 'var(--input-bg)';
                      e.target.style.boxShadow = 'none';
                    }}
                  />
                </div>
              </div>

              {/* Location */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                  Location
                </label>
                <input
                  type="text"
                  placeholder="Conference Room, Zoom Link, etc."
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  style={{
                    width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    background: 'var(--input-bg)',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                    transition: 'all 0.2s ease',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                    e.target.style.background = 'var(--input-bg-focus)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--border-color)';
                    e.target.style.background = 'var(--input-bg)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              {/* Attendees */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                  Attendees
                </label>
                {contactOptions.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => { addAttendeeEmail(e.target.value); e.target.value = ''; }}
                    style={{
                      width: '100%', padding: '0.7rem', fontSize: '0.9rem', marginBottom: '0.5rem',
                      border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--bg-color)', color: 'var(--text-primary)',
                      boxSizing: 'border-box', cursor: 'pointer',
                    }}
                  >
                    <option value="">+ Add from contacts…</option>
                    {contactOptions.map((c) => (
                      <option key={c.id} value={c.email}>{c.name} ({c.email})</option>
                    ))}
                  </select>
                )}
                <input
                  type="text"
                  placeholder="email@example.com, another@example.com"
                  value={formData.attendees}
                  onChange={(e) => setFormData({ ...formData, attendees: e.target.value })}
                  style={{
                    width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    background: 'var(--input-bg)',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                    transition: 'all 0.2s ease',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                    e.target.style.background = 'var(--input-bg-focus)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--border-color)';
                    e.target.style.background = 'var(--input-bg)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              {/* Description */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: 'var(--text-primary)', letterSpacing: '0.3px' }}>
                  Description
                </label>
                <textarea
                  placeholder="Add any notes about this event..."
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  style={{
                    width: '100%', padding: '0.85rem', fontSize: '0.95rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    background: 'var(--input-bg)',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                    minHeight: '90px',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                    transition: 'all 0.2s ease',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--accent-color, #6366f1)';
                    e.target.style.background = 'var(--input-bg-focus)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--border-color)';
                    e.target.style.background = 'var(--input-bg)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              {/* Slot-picker + online meeting (Google Meet / Teams) — T18 */}
              {(createProvider === 'google' || createProvider === 'outlook') && (
                <div style={{ border: '1px dashed #d1d5db', borderRadius: '8px', padding: '1rem', background: 'var(--input-bg)', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Video size={15} style={{ color: '#4285F4' }} /> Booking helper
                  </div>

                  {/* Find available slots */}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-primary)' }}>
                      Find available slots
                    </label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        type="date"
                        value={slotPicker.date}
                        onChange={(e) => setSlotPicker((s) => ({ ...s, date: e.target.value, error: '' }))}
                        style={{ flex: 1, padding: '0.6rem', fontSize: '0.9rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--bg-color)', color: 'var(--text-primary)', boxSizing: 'border-box' }}
                      />
                      <button
                        type="button"
                        onClick={handleFindSlots}
                        disabled={slotPicker.loading || !slotPicker.date}
                        style={{
                          padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid #4285F4',
                          background: slotPicker.loading || !slotPicker.date ? '#e5e7eb' : 'rgba(66,133,244,0.1)',
                          color: slotPicker.loading || !slotPicker.date ? '#9ca3af' : '#1a56c4',
                          cursor: slotPicker.loading || !slotPicker.date ? 'not-allowed' : 'pointer',
                          fontWeight: 600, fontSize: '0.85rem', whiteSpace: 'nowrap',
                        }}
                      >
                        {slotPicker.loading ? 'Finding…' : 'Find slots'}
                      </button>
                    </div>
                    {slotPicker.error && (
                      <div style={{ fontSize: '0.78rem', color: '#b45309', marginTop: '0.4rem' }}>{slotPicker.error}</div>
                    )}
                    {slotPicker.slots.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.6rem' }}>
                        {slotPicker.slots.map((slot) => {
                          const selected = formData.startTime === isoToLocalInput(slot.start);
                          return (
                            <button
                              key={slot.start}
                              type="button"
                              onClick={() => handlePickSlot(slot)}
                              style={{
                                padding: '0.4rem 0.7rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: 600,
                                border: selected ? '1px solid #4285F4' : '1px solid #e5e7eb',
                                background: selected ? '#4285F4' : '#fff',
                                color: selected ? '#fff' : '#374151', cursor: 'pointer',
                              }}
                            >
                              {formatDateTime(slot.start)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Add Google Meet link */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formData.createMeet}
                      onChange={(e) => setFormData({ ...formData, createMeet: e.target.checked })}
                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                    />
                    Add a {createProvider === 'google' ? 'Google Meet' : 'Teams'} meeting link to this event
                  </label>

                  {/* Add Zoom link — works for either calendar provider */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formData.createZoom}
                      onChange={(e) => setFormData({ ...formData, createZoom: e.target.checked })}
                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                    />
                    Add a Zoom meeting link to this event
                  </label>
                </div>
              )}

              {/* Buttons */}
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setFormData({ title: '', description: '', startTime: '', endTime: '', attendees: '', location: '', createMeet: false, createZoom: false }); setSlotPicker({ date: '', slots: [], loading: false, error: '' });
                  }}
                  style={{
                    padding: '0.65rem 1.5rem', borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-color)', color: 'var(--text-primary)',
                    cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.background = 'var(--input-bg)';
                    e.target.style.borderColor = 'var(--border-color)';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = 'var(--input-bg-focus)';
                    e.target.style.borderColor = 'var(--border-color)';
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!formData.title || !formData.startTime || !formData.endTime || busy[createProvider]}
                  style={{
                    padding: '0.65rem 1.75rem', borderRadius: '8px',
                    border: 'none',
                    background: !formData.title || !formData.startTime || !formData.endTime || busy[createProvider]
                      ? '#d1d5db'
                      : '#6366f1',
                    color: '#fff',
                    cursor: !formData.title || !formData.startTime || !formData.endTime || busy[createProvider] ? 'not-allowed' : 'pointer',
                    fontWeight: 600, fontSize: '0.9rem',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!(!formData.title || !formData.startTime || !formData.endTime || busy[createProvider])) {
                      e.target.style.background = 'var(--accent-hover, #4f46e5)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!(!formData.title || !formData.startTime || !formData.endTime || busy[createProvider])) {
                      e.target.style.background = 'var(--accent-color, #6366f1)';
                    }
                  }}
                >
                  {busy[createProvider] ? 'Creating...' : 'Create Event'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 0.9s linear infinite; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
