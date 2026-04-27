import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, User as UserIcon, Stethoscope, Plus, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const HOURS = Array.from({ length: 11 }, (_, i) => 9 + i); // 9 AM → 7 PM
const STATUS_COLOR = {
  booked:        'rgba(59,130,246,0.18)',
  confirmed:     'rgba(99,102,241,0.20)',
  arrived:       'rgba(168,85,247,0.20)',
  'in-treatment':'rgba(245,158,11,0.25)',
  completed:     'rgba(16,185,129,0.20)',
  'no-show':     'rgba(239,68,68,0.20)',
  cancelled:     'rgba(100,116,139,0.20)',
};
const STATUS_BORDER = {
  booked: '#3b82f6', confirmed: '#6366f1', arrived: '#a855f7',
  'in-treatment': '#f59e0b', completed: '#10b981',
  'no-show': '#ef4444', cancelled: '#64748b',
};

// #262: practitioners who can be assigned to visits include both doctors
// and professionals (salon stylists, aestheticians, slimming therapists,
// Ayurveda practitioners — see PRD §1). Pre-fix the calendar filter only
// kept wellnessRole === 'doctor', so 12 professionals had no column even
// though they had visits booked, and the receptionist couldn't see their
// availability from the grid.
const PRACTITIONER_ROLES = new Set(['doctor', 'professional']);

// #263: render the IST calendar day, not the UTC day. toISOString() returns
// UTC, so any IST clock time before 05:30 (e.g. 1 AM IST = 19:30 prev-day UTC)
// previously yielded the wrong date string and the calendar fetched a
// different day than the Owner Dashboard's IST-aware startOfDay()/endOfDay()
// helpers in backend/routes/wellness.js — producing different "today" counts.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const isoDay = (d) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;
const UNASSIGNED_KEY = '__unassigned__';

export default function CalendarGrid() {
  const notify = useNotify();
  const [date, setDate] = useState(() => new Date());
  const [visits, setVisits] = useState([]);
  const [allStaff, setAllStaff] = useState([]);
  const [services, setServices] = useState([]);
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  // #270: empty-slot click opens a "New visit" modal seeded with the chosen
  // (doctorId, hour). Booked visits are status='booked' which doesn't require
  // serviceId or doctorId per visitPOST validators (#109), but we collect
  // both up-front because that's how a receptionist actually books.
  const [newVisit, setNewVisit] = useState(null); // { columnId, hour } | null

  const load = async () => {
    setLoading(true);
    const dStr = isoDay(date);
    try {
      // #112: pass an explicit IST offset (+05:30) so the backend's `new Date(from)`
      // resolves to the IST calendar day regardless of the server's local TZ
      // (production runs in UTC). Pre-fix the query window was shifted by 5h30,
      // so all genuine IST visits fell outside the requested range and the
      // calendar appeared empty even though the dashboard showed the correct counts.
      const fromQ = `${dStr}T00:00:00+05:30`;
      const toQ = `${dStr}T23:59:59+05:30`;
      const [staff, vs, svc, pts] = await Promise.all([
        fetchApi('/api/staff').catch(() => []),
        fetchApi(`/api/wellness/visits?from=${encodeURIComponent(fromQ)}&to=${encodeURIComponent(toQ)}&limit=500`),
        fetchApi('/api/wellness/services').catch(() => []),
        fetchApi('/api/wellness/patients').catch(() => []),
      ]);
      setAllStaff(Array.isArray(staff) ? staff : []);
      setVisits(Array.isArray(vs) ? vs : []);
      setServices(Array.isArray(svc) ? svc.filter((s) => s.isActive !== false) : []);
      setPatients(Array.isArray(pts) ? pts : []);
    } catch (_e) { setVisits([]); setAllStaff([]); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [date]);

  // #262: build the practitioner list. Default view = practitioners with at
  // least one visit on this day (so the grid stays readable on small clinics).
  // Toggle "Show all" to surface every practitioner for booking empty slots.
  const practitioners = useMemo(() => {
    const all = allStaff.filter((u) => PRACTITIONER_ROLES.has(u.wellnessRole));
    const doctorIdsToday = new Set(visits.map((v) => v.doctorId).filter(Boolean));
    if (showAll) return all;
    const withVisits = all.filter((u) => doctorIdsToday.has(u.id));
    // Fallback: if no practitioner has visits today, surface everyone so the
    // grid isn't empty and the receptionist can still book.
    return withVisits.length ? withVisits : all;
  }, [allStaff, visits, showAll]);

  // #247: include visits without a doctor assignment in an "Unassigned"
  // column instead of silently dropping them. The dashboard counts ALL
  // visits today; the calendar must too. Also clamp visits scheduled
  // before 09:00 / after 19:00 to the boundary hour so they're surfaced.
  const columns = useMemo(() => {
    const cols = practitioners.map((d) => ({
      id: d.id,
      name: d.name,
      role: d.wellnessRole,
      isUnassigned: false,
    }));
    if (visits.some((v) => !v.doctorId)) {
      cols.push({ id: UNASSIGNED_KEY, name: 'Unassigned', role: null, isUnassigned: true });
    }
    return cols;
  }, [visits, practitioners]);

  const grid = useMemo(() => {
    const out = {};
    for (const c of columns) out[c.id] = {};
    for (const v of visits) {
      const colId = v.doctorId || UNASSIGNED_KEY;
      if (!out[colId]) out[colId] = {};
      const rawHour = new Date(v.visitDate).getHours();
      const h = Math.max(HOURS[0], Math.min(HOURS[HOURS.length - 1], rawHour));
      if (!out[colId][h]) out[colId][h] = [];
      out[colId][h].push(v);
    }
    return out;
  }, [visits, columns]);

  const shift = (days) => {
    const next = new Date(date); next.setDate(next.getDate() + days); setDate(next);
  };

  // #262 sub-counts for the header chip
  const totalPractitionerCount = useMemo(() => allStaff.filter((u) => PRACTITIONER_ROLES.has(u.wellnessRole)).length, [allStaff]);
  const visiblePractitionerCount = practitioners.length;

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CalendarIcon size={24} /> Calendar
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Day view by practitioner — {date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {totalPractitionerCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="glass"
              style={{
                padding: '0.4rem 0.8rem', fontSize: '0.8rem',
                borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${showAll ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.1)'}`,
                background: showAll ? 'rgba(99,102,241,0.15)' : 'transparent',
                color: 'var(--text-primary)',
              }}
              title={showAll ? `Showing all ${totalPractitionerCount} practitioners` : `Showing ${visiblePractitionerCount} with visits today`}
            >
              {showAll ? `All ${totalPractitionerCount}` : `${visiblePractitionerCount} of ${totalPractitionerCount}`}
            </button>
          )}
          <button onClick={() => shift(-1)} className="glass" style={navBtn}><ChevronLeft size={16} /></button>
          <button onClick={() => setDate(new Date())} className="glass" style={{ ...navBtn, padding: '0.4rem 0.9rem', fontSize: '0.85rem', width: 'auto' }}>Today</button>
          <button onClick={() => shift(1)} className="glass" style={navBtn}><ChevronRight size={16} /></button>
        </div>
      </header>

      {loading && <div>Loading…</div>}

      {!loading && columns.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No practitioners configured and no visits scheduled. Add staff under Staff or book a visit.
        </div>
      )}

      {!loading && columns.length > 0 && (
        <div className="glass" style={{ padding: '1rem', overflow: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `80px repeat(${columns.length}, minmax(180px, 1fr))`, gap: '4px' }}>
            <div style={{ ...colHead, background: 'transparent' }}></div>
            {columns.map((c) => (
              <div key={c.id} style={{ ...colHead, opacity: c.isUnassigned ? 0.7 : 1 }}>
                {c.isUnassigned ? (
                  <UserIcon size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7 }} />
                ) : (
                  <Stethoscope size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7 }} />
                )}
                {c.name}
                {c.role && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginLeft: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {c.role}
                  </span>
                )}
              </div>
            ))}

            {HOURS.map((h) => (
              <React.Fragment key={h}>
                <div style={hourLabel}>{fmtHour(h)}</div>
                {columns.map((c) => {
                  const cell = grid[c.id]?.[h] || [];
                  // #270: empty slots are clickable when the column belongs to a
                  // real practitioner (not the synthetic Unassigned column —
                  // a fresh booking should always be assigned to someone).
                  const isCreatable = !c.isUnassigned && cell.length === 0;
                  return (
                    <div
                      key={`${c.id}-${h}`}
                      style={{
                        ...hourCell,
                        cursor: isCreatable ? 'pointer' : 'default',
                        position: 'relative',
                      }}
                      onClick={isCreatable ? () => setNewVisit({ columnId: c.id, hour: h }) : undefined}
                      title={isCreatable ? `Book ${fmtHour(h)} with ${c.name}` : undefined}
                      onMouseEnter={isCreatable ? (e) => { e.currentTarget.querySelector('[data-empty-affordance]')?.style.setProperty('opacity', '0.8'); } : undefined}
                      onMouseLeave={isCreatable ? (e) => { e.currentTarget.querySelector('[data-empty-affordance]')?.style.setProperty('opacity', '0'); } : undefined}
                    >
                      {cell.map((v) => (
                        <Link
                          to={`/wellness/patients/${v.patient?.id || v.patientId}`}
                          key={v.id}
                          style={{
                            textDecoration: 'none', color: 'var(--text-primary)',
                            background: STATUS_COLOR[v.status] || 'rgba(255,255,255,0.05)',
                            borderLeft: `3px solid ${STATUS_BORDER[v.status] || '#64748b'}`,
                            padding: '0.4rem 0.5rem', borderRadius: '6px',
                            fontSize: '0.75rem', display: 'block',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} · {v.patient?.name || `#${v.patientId}`}
                          </div>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {v.service?.name || '—'}
                          </div>
                        </Link>
                      ))}
                      {isCreatable && (
                        <span
                          data-empty-affordance
                          style={{
                            position: 'absolute', inset: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'var(--accent-color)', opacity: 0,
                            transition: 'opacity 0.12s',
                            pointerEvents: 'none',
                            fontSize: '0.7rem', fontWeight: 500, gap: '0.25rem',
                          }}
                        >
                          <Plus size={12} /> Book
                        </span>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.75rem' }}>
        {Object.entries(STATUS_BORDER).map(([s, color]) => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />{s}
          </span>
        ))}
      </div>

      {newVisit && (
        <NewVisitModal
          column={columns.find((c) => c.id === newVisit.columnId)}
          hour={newVisit.hour}
          date={date}
          patients={patients}
          services={services}
          notify={notify}
          onClose={() => setNewVisit(null)}
          onCreated={() => { setNewVisit(null); load(); }}
        />
      )}
    </div>
  );
}

// #270: lightweight modal for booking a visit from the calendar grid.
// Only required field is patientId (per the visit POST validator at
// routes/wellness.js:472). status defaults to 'booked' so the receptionist
// doesn't trip the "completed visits need serviceId + doctorId" gate.
function NewVisitModal({ column, hour, date, patients, services, notify, onClose, onCreated }) {
  const [patientId, setPatientId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const localDate = new Date(date);
  localDate.setHours(hour, 0, 0, 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!patientId) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      // visitDate built as IST wall time; backend stores as UTC, dashboard
      // applies the same +05:30 offset on read so the slot lands at the
      // intended hour for the receptionist's column.
      const istIso = `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+05:30`;
      await fetchApi('/api/wellness/visits', {
        method: 'POST',
        body: JSON.stringify({
          patientId: parseInt(patientId, 10),
          serviceId: serviceId ? parseInt(serviceId, 10) : null,
          doctorId: column.id,
          visitDate: istIso,
          status: 'booked',
          notes: notes || null,
        }),
      });
      const patientName = patients.find((p) => p.id === parseInt(patientId, 10))?.name;
      notify.success(`Booked ${patientName || 'visit'} at ${String(hour).padStart(2, '0')}:00 with ${column.name}`);
      onCreated();
    } catch (_err) { /* fetchApi already toasted */ }
    setSubmitting(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-visit-title"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="glass"
        style={{
          background: 'var(--surface-bg, #ffffff)', color: 'var(--text-primary)',
          padding: '1.5rem', borderRadius: 12, width: '100%', maxWidth: 480,
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="new-visit-title" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
            New visit
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {column.name} • {localDate.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
        </p>

        <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Patient *</label>
        <select required value={patientId} onChange={(e) => setPatientId(e.target.value)} style={modalInput}>
          <option value="">— select patient —</option>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.phone ? ` · ${p.phone}` : ''}</option>
          ))}
        </select>

        <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Service (optional)</label>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={modalInput}>
          <option value="">— pick later —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          style={{ ...modalInput, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="Walk-in confirmed, follow-up consult, etc."
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button type="button" onClick={onClose} style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color, rgba(0,0,0,0.15))', borderRadius: 8, cursor: 'pointer', color: 'var(--text-primary)' }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!patientId || submitting}
            style={{
              padding: '0.5rem 1.25rem',
              background: !patientId || submitting ? 'rgba(99,102,241,0.4)' : 'var(--accent-color, #6366f1)',
              border: 'none', color: '#fff', borderRadius: 8,
              cursor: !patientId || submitting ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            {submitting ? 'Booking…' : 'Book visit'}
          </button>
        </div>
      </form>
    </div>
  );
}

const navBtn = { width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', background: 'transparent', color: 'var(--text-primary)' };
const colHead = { padding: '0.5rem 0.75rem', fontWeight: 600, fontSize: '0.8rem', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' };
const hourLabel = { padding: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'right', borderRight: '1px solid rgba(255,255,255,0.05)' };
const hourCell = { padding: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', minHeight: '60px', borderBottom: '1px solid rgba(255,255,255,0.04)' };
const modalInput = { padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(0,0,0,0.15))', background: 'var(--input-bg, rgba(0,0,0,0.03))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
