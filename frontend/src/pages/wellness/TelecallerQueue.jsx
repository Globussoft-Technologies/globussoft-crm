import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  PhoneCall,
  Phone,
  CheckCircle2,
  XCircle,
  Clock3,
  CalendarCheck,
  Ban,
  Trash2,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';

const DISPOSITIONS = [
  { key: 'interested', label: 'Interested', icon: CheckCircle2, color: '#10b981' },
  { key: 'not interested', label: 'Not interested', icon: XCircle, color: '#ef4444' },
  { key: 'callback', label: 'Callback', icon: Clock3, color: '#f59e0b' },
  { key: 'booked', label: 'Booked', icon: CalendarCheck, color: '#3b82f6' },
  { key: 'wrong number', label: 'Wrong number', icon: Ban, color: '#6b7280' },
  { key: 'junk', label: 'Junk', icon: Trash2, color: '#64748b' },
];

const scoreColor = (score) => {
  if (score >= 75) return '#10b981';
  if (score >= 50) return '#f59e0b';
  if (score >= 25) return '#f97316';
  return '#64748b';
};

const ageLabel = (iso) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

const slaFor = (iso) => {
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 5) return { color: '#10b981', label: 'SLA OK' };
  if (mins < 30) return { color: '#f59e0b', label: 'SLA warn' };
  return { color: '#ef4444', label: 'SLA breach' };
};

export default function TelecallerQueue() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [disposing, setDisposing] = useState({});
  const [notes, setNotes] = useState({});
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchApi('/api/wellness/telecaller/queue');
      setLeads(d.leads || []);
    } catch (e) {
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 30000);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const dispose = async (contactId, disposition) => {
    setDisposing((s) => ({ ...s, [contactId]: disposition }));
    try {
      await fetchApi('/api/wellness/telecaller/dispose', {
        method: 'POST',
        body: JSON.stringify({
          contactId,
          disposition,
          notes: (notes[contactId] || '').trim() || undefined,
        }),
      });
      setLeads((prev) => prev.filter((l) => l.id !== contactId));
      setNotes((n) => {
        const copy = { ...n };
        delete copy[contactId];
        return copy;
      });
    } catch (err) {
      alert(`Failed: ${err.message}`);
    } finally {
      setDisposing((s) => {
        const copy = { ...s };
        delete copy[contactId];
        return copy;
      });
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: 'var(--font-family)',
              fontSize: '1.75rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <PhoneCall size={24} /> Telecaller Queue
            <span
              style={{
                background: 'var(--accent-color)',
                color: '#fff',
                fontSize: '0.85rem',
                padding: '0.2rem 0.6rem',
                borderRadius: 999,
                marginLeft: '0.5rem',
              }}
            >
              {leads.length}
            </span>
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Leads assigned to you, oldest first. Queue auto-refreshes every 30s.
          </p>
        </div>
        <button
          onClick={load}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.3rem',
            padding: '0.5rem 1rem',
            background: 'rgba(255,255,255,0.05)',
            color: 'var(--text-primary)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      {loading && <div>Loading…</div>}

      {!loading && leads.length === 0 && (
        <div
          className="glass"
          style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}
        >
          Inbox zero. No leads are currently assigned to you.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
          gap: '1rem',
        }}
      >
        {leads.map((l) => {
          const sla = slaFor(l.createdAt);
          const busy = !!disposing[l.id];
          return (
            <div
              key={l.id}
              className="glass"
              style={{
                padding: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                opacity: busy ? 0.6 : 1,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{l.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                    {l.source || 'Organic'} · {ageLabel(l.createdAt)}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'flex-end' }}>
                  <span
                    style={{
                      background: scoreColor(l.aiScore || 0),
                      color: '#fff',
                      padding: '0.15rem 0.5rem',
                      borderRadius: 4,
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                    }}
                  >
                    <Sparkles size={10} /> {l.aiScore || 0}
                  </span>
                  <span
                    style={{
                      background: sla.color,
                      color: '#fff',
                      padding: '0.1rem 0.4rem',
                      borderRadius: 4,
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                    }}
                  >
                    {sla.label}
                  </span>
                </div>
              </div>

              {l.phone ? (
                <a
                  href={`tel:${l.phone}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.65rem 0.85rem',
                    background: 'rgba(59, 130, 246, 0.12)',
                    border: '1px solid rgba(59, 130, 246, 0.35)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                    textDecoration: 'none',
                    fontSize: '1.15rem',
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                  }}
                >
                  <Phone size={18} /> {l.phone}
                </a>
              ) : (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No phone on file</div>
              )}

              <input
                placeholder="Add a note (optional)"
                value={notes[l.id] || ''}
                onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })}
                style={{
                  padding: '0.5rem 0.75rem',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem',
                  outline: 'none',
                }}
              />

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: '0.4rem',
                }}
              >
                {DISPOSITIONS.map((d) => {
                  const Icon = d.icon;
                  return (
                    <button
                      key={d.key}
                      disabled={busy}
                      onClick={() => dispose(l.id, d.key)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.3rem',
                        padding: '0.45rem 0.5rem',
                        background: `${d.color}20`,
                        border: `1px solid ${d.color}55`,
                        borderRadius: 6,
                        color: 'var(--text-primary)',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        cursor: busy ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Icon size={13} color={d.color} /> {d.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
