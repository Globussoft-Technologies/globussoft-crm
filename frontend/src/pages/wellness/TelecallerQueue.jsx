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
import { useNotify } from '../../utils/notify';

// #215: every disposition goes through one consistent flow — confirm modal,
// optionally with a follow-up form for the three appointment-booking-ish ones
// (booked / callback / interested). The modal text + extras adapt by disposition.
const DISPOSITIONS = [
  {
    key: 'interested',
    label: 'Interested',
    icon: CheckCircle2,
    color: '#10b981',
    confirmText: 'Mark Interested',
    title: 'Mark as Interested?',
    message: "They'll stay in your queue for follow-up. Add any notes you want stamped on the contact.",
    form: 'interested', // optional notes textarea
  },
  {
    key: 'callback',
    label: 'Callback',
    icon: Clock3,
    color: '#f59e0b',
    confirmText: 'Schedule Callback',
    title: 'Schedule a callback?',
    message: 'Pick when to call them back. A task will be created for that time.',
    form: 'callback', // required when datetime
  },
  {
    key: 'booked',
    label: 'Booked',
    icon: CalendarCheck,
    color: '#3b82f6',
    confirmText: 'Mark Booked',
    title: 'Mark as Booked?',
    message: 'Optionally fill in the appointment details now. You can also book the visit later.',
    form: 'booked', // optional appt + service
  },
  {
    key: 'not interested',
    label: 'Not interested',
    icon: XCircle,
    color: '#ef4444',
    confirmText: 'Mark Not Interested',
    title: 'Mark as Not interested?',
    message: 'They stay in the system but drop out of your queue. You can re-engage later.',
  },
  {
    key: 'wrong number',
    label: 'Wrong number',
    icon: Ban,
    color: '#6b7280',
    confirmText: 'Mark Wrong Number',
    title: 'Mark as Wrong number?',
    message: 'This removes them from the telecaller queue. Misclassified leads are hard to recover.',
    destructive: true,
  },
  {
    key: 'junk',
    label: 'Junk',
    icon: Trash2,
    color: '#64748b',
    confirmText: 'Mark Junk',
    title: 'Mark as Junk?',
    message: 'This removes them from the telecaller queue. Misclassified leads are hard to recover.',
    destructive: true,
  },
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

// Small inline form modal used for the 3 dispositions that gain extra fields.
// Plain confirm-only dispositions go through useNotify().confirm() instead.
function DispositionFormModal({ disp, lead, services, onCancel, onSubmit }) {
  const [notes, setNotes] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [appointmentAt, setAppointmentAt] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const Icon = disp.icon;

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (disp.form === 'callback' && !callbackAt) {
      setError('Please pick a callback time.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({
        notes: notes.trim() || undefined,
        callbackAt: callbackAt || undefined,
        appointmentAt: appointmentAt || undefined,
        serviceId: serviceId || undefined,
      });
    } catch (err) {
      setError(err?.message || 'Failed');
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid={`telecaller-form-modal-${disp.key.replace(/\s+/g, '-')}`}
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 10001,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
        backdropFilter: 'blur(2px)',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{
          background: 'var(--surface-bg, #ffffff)',
          color: 'var(--text-primary, #1f2937)',
          padding: '1.5rem',
          borderRadius: 12,
          minWidth: 360,
          maxWidth: 480,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Icon size={16} color={disp.color} /> {disp.title}
        </h3>
        <p style={{ margin: 0, marginBottom: '1rem', color: 'var(--text-secondary, #6b7280)', fontSize: '0.9rem', lineHeight: 1.45 }}>
          {disp.message} {lead?.name ? `(${lead.name})` : ''}
        </p>

        {disp.form === 'callback' && (
          <label style={{ display: 'block', marginBottom: '1rem', fontSize: '0.85rem', fontWeight: 500 }}>
            When? *
            <input
              type="datetime-local"
              required
              value={callbackAt}
              onChange={(e) => setCallbackAt(e.target.value)}
              style={inputStyle}
            />
          </label>
        )}

        {disp.form === 'booked' && (
          <>
            <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.85rem', fontWeight: 500 }}>
              Appointment date/time (optional)
              <input
                type="datetime-local"
                value={appointmentAt}
                onChange={(e) => setAppointmentAt(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={{ display: 'block', marginBottom: '1rem', fontSize: '0.85rem', fontWeight: 500 }}>
              Service (optional)
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                style={inputStyle}
              >
                <option value="">— Select a service —</option>
                {(services || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          </>
        )}

        <label style={{ display: 'block', marginBottom: '1rem', fontSize: '0.85rem', fontWeight: 500 }}>
          Notes {disp.form === 'interested' ? '(optional)' : '(optional)'}
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything worth stamping on the contact…"
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </label>

        {error && (
          <div style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={{
              padding: '0.5rem 1rem',
              background: 'transparent',
              border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
              color: 'var(--text-primary, #1f2937)',
              borderRadius: 8,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem',
            }}
          >Cancel</button>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '0.5rem 1rem',
              background: disp.color,
              border: 'none',
              color: '#fff',
              borderRadius: 8,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem',
              fontWeight: 500,
            }}
          >{submitting ? 'Working…' : disp.confirmText}</button>
        </div>
      </form>
    </div>
  );
}

const inputStyle = {
  display: 'block',
  width: '100%',
  marginTop: '0.35rem',
  padding: '0.55rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
  background: 'var(--input-bg, rgba(0,0,0,0.03))',
  color: 'var(--text-primary, #1f2937)',
  fontSize: '0.9rem',
  outline: 'none',
  fontFamily: 'inherit',
};

export default function TelecallerQueue() {
  const notify = useNotify();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [disposing, setDisposing] = useState({});
  const [services, setServices] = useState([]);
  // Inline modal state for the 3 form-bearing dispositions. Plain ones use
  // notify.confirm() instead, which doesn't need its own state.
  const [formModal, setFormModal] = useState(null); // { disp, lead }
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

  // Lazy-load services once — only used by the Booked form.
  const ensureServices = useCallback(async () => {
    if (services.length) return;
    try {
      const d = await fetchApi('/api/wellness/services');
      setServices(d.services || d || []);
    } catch (_) {
      // Non-fatal; the dropdown just stays empty.
    }
  }, [services.length]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 30000);
    return () => clearInterval(timerRef.current);
  }, [load]);

  // Core dispose call. Pulled out so both the simple-confirm path and the
  // form-modal path share one network code path.
  const doDispose = async (lead, disp, extras = {}) => {
    const contactId = lead.id;
    setDisposing((s) => ({ ...s, [contactId]: disp.key }));
    try {
      // 1. Stamp the disposition. notes can be packed with structured extras
      //    so the backend stores them on the contact even though the route
      //    only formally accepts { contactId, disposition, notes }.
      const stampedNotes = (() => {
        const parts = [];
        if (extras.notes) parts.push(extras.notes);
        if (extras.callbackAt) parts.push(`Callback scheduled for ${new Date(extras.callbackAt).toLocaleString()}`);
        if (extras.appointmentAt) parts.push(`Appointment ${new Date(extras.appointmentAt).toLocaleString()}`);
        return parts.join(' · ') || undefined;
      })();

      await fetchApi('/api/wellness/telecaller/dispose', {
        method: 'POST',
        body: JSON.stringify({
          contactId,
          disposition: disp.key,
          notes: stampedNotes,
        }),
      });

      // 2. For Booked + filled appointment, also POST a Visit. The dispose
      //    endpoint already flips contact status; this just creates the
      //    actual appointment record.
      if (disp.key === 'booked' && extras.appointmentAt) {
        try {
          await fetchApi('/api/wellness/visits', {
            method: 'POST',
            body: JSON.stringify({
              contactId,
              scheduledAt: new Date(extras.appointmentAt).toISOString(),
              serviceId: extras.serviceId || undefined,
              status: 'scheduled',
            }),
          });
        } catch (visitErr) {
          // Don't unwind the dispose — just warn. The user can log the
          // visit manually from the contact page.
          notify.error(`Disposition saved, but visit creation failed: ${visitErr.message}`);
        }
      }

      setLeads((prev) => prev.filter((l) => l.id !== contactId));
      notify.success(`${disp.label}: ${lead.name || `lead #${contactId}`}`);
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setDisposing((s) => {
        const copy = { ...s };
        delete copy[contactId];
        return copy;
      });
    }
  };

  // Entry point from the disposition button. Routes to either notify.confirm()
  // (simple dispositions) or the inline form modal (booked / callback / interested).
  const startDispose = async (lead, disp) => {
    if (disp.form) {
      if (disp.form === 'booked') ensureServices();
      setFormModal({ disp, lead });
      return;
    }
    const ok = await notify.confirm({
      title: disp.title,
      message: `${disp.message}${lead?.name ? `\n\n— ${lead.name}` : ''}`,
      confirmText: disp.confirmText,
      destructive: !!disp.destructive,
    });
    if (!ok) return;
    await doDispose(lead, disp);
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
                      onClick={() => startDispose(l, d)}
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

      {formModal && (
        <DispositionFormModal
          disp={formModal.disp}
          lead={formModal.lead}
          services={services}
          onCancel={() => setFormModal(null)}
          onSubmit={async (extras) => {
            const { disp, lead } = formModal;
            setFormModal(null);
            await doDispose(lead, disp, extras);
          }}
        />
      )}
    </div>
  );
}
