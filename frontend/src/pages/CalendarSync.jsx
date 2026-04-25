import React, { useEffect, useState } from 'react';
import { Calendar, RefreshCw, ExternalLink, Check, Plug, Trash2, Users, Video } from 'lucide-react';
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
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div style={{
      position: 'fixed', top: '1.5rem', right: '1.5rem', zIndex: 9999,
      background: 'rgba(34,197,94,0.95)', color: '#fff',
      padding: '0.75rem 1.25rem', borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      backdropFilter: 'blur(8px)',
    }}>
      <Check size={18} /> {msg}
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
      const res = await fetchApi(`/api/calendar/${provider}/sync`, { method: 'POST' });
      setToast(`Synced ${res.synced ?? 0} ${provider} events`);
      await loadAll();
    } catch (e) {
      setToast(`Sync failed: ${e.message || provider}`);
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1rem' }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '10px',
                  background: p.bg, color: p.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: '1.1rem',
                }}>
                  {p.initials}
                </div>
                <div style={{ flex: 1 }}>
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
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '160px 1fr auto',
                    gap: '1rem', alignItems: 'center',
                    padding: '0.75rem 1rem',
                    borderRadius: '10px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.05)',
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

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 0.9s linear infinite; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
