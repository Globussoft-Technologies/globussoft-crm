import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, User as UserIcon, Stethoscope } from 'lucide-react';
import { fetchApi } from '../../utils/api';

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

const isoDay = (d) => d.toISOString().slice(0, 10);
const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;

export default function CalendarGrid() {
  const [date, setDate] = useState(() => new Date());
  const [visits, setVisits] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);

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
      const [staff, vs] = await Promise.all([
        fetchApi('/api/staff').catch(() => []),
        fetchApi(`/api/wellness/visits?from=${encodeURIComponent(fromQ)}&to=${encodeURIComponent(toQ)}&limit=500`),
      ]);
      const docs = (Array.isArray(staff) ? staff : []).filter((u) => u.wellnessRole === 'doctor');
      setDoctors(docs.length ? docs : (Array.isArray(staff) ? staff.slice(0, 4) : []));
      setVisits(Array.isArray(vs) ? vs : []);
    } catch (e) { setVisits([]); setDoctors([]); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [date]);

  // #247: include visits without a doctor assignment in an "Unassigned"
  // column instead of silently dropping them. The dashboard counts ALL
  // visits today; the calendar must too, otherwise the counts disagree
  // and unassigned bookings stay invisible. Also clamp visits scheduled
  // before 09:00 / after 19:00 to the boundary hour so they're surfaced.
  const UNASSIGNED_KEY = '__unassigned__';
  const columns = useMemo(() => {
    const cols = doctors.map((d) => ({ id: d.id, name: d.name, isUnassigned: false }));
    if (visits.some((v) => !v.doctorId)) {
      cols.push({ id: UNASSIGNED_KEY, name: 'Unassigned', isUnassigned: true });
    }
    return cols;
  }, [visits, doctors]);

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

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CalendarIcon size={24} /> Calendar
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Day view by doctor — {date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button onClick={() => shift(-1)} className="glass" style={navBtn}><ChevronLeft size={16} /></button>
          <button onClick={() => setDate(new Date())} className="glass" style={{ ...navBtn, padding: '0.4rem 0.9rem', fontSize: '0.85rem', width: 'auto' }}>Today</button>
          <button onClick={() => shift(1)} className="glass" style={navBtn}><ChevronRight size={16} /></button>
        </div>
      </header>

      {loading && <div>Loading…</div>}

      {!loading && columns.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No doctors configured and no visits scheduled. Add a doctor under Staff or book a visit.
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
              </div>
            ))}

            {HOURS.map((h) => (
              <React.Fragment key={h}>
                <div style={hourLabel}>{fmtHour(h)}</div>
                {columns.map((c) => {
                  const cell = grid[c.id]?.[h] || [];
                  return (
                    <div key={`${c.id}-${h}`} style={hourCell}>
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
                        >
                          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} · {v.patient?.name || `#${v.patientId}`}
                          </div>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {v.service?.name || '—'}
                          </div>
                        </Link>
                      ))}
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
    </div>
  );
}

const navBtn = { width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', background: 'transparent', color: 'var(--text-primary)' };
const colHead = { padding: '0.5rem 0.75rem', fontWeight: 600, fontSize: '0.8rem', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' };
const hourLabel = { padding: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'right', borderRight: '1px solid rgba(255,255,255,0.05)' };
const hourCell = { padding: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', minHeight: '60px', borderBottom: '1px solid rgba(255,255,255,0.04)' };
