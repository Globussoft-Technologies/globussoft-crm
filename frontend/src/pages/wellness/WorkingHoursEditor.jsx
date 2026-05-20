import { useEffect, useState } from 'react';
import { Clock, Save } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

// Wave 11 Agent GG — admin per-practitioner working-hours editor. Pick a
// practitioner; the page renders a 7-day weekly grid; admin sets
// startTime/endTime per day + an "active" flag for the day. The
// booking-conflict gate at backend/lib/bookingAvailability.js raises
// OUTSIDE_WORKING_HOURS when a visit slot falls outside the matching
// dayOfWeek's [startTime, endTime] window. Days with no row are treated
// as "no schedule configured" → silent no-op (operator opt-in).

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const defaultRow = (dayOfWeek) => ({
  dayOfWeek,
  startTime: '09:00',
  endTime: '19:00',
  isActive: dayOfWeek !== 0, // Sunday off by default
});

export default function WorkingHoursEditor() {
  const notify = useNotify();
  const [staff, setStaff] = useState([]);
  const [doctorId, setDoctorId] = useState('');
  const [schedule, setSchedule] = useState(() => Array.from({ length: 7 }, (_, i) => defaultRow(i)));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchApi('/api/staff').then((s) => {
      const arr = Array.isArray(s) ? s : [];
      setStaff(arr);
      const first = arr.find((u) => u.wellnessRole === 'doctor' || u.wellnessRole === 'professional');
      if (first) setDoctorId(String(first.id));
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!doctorId) return;
    fetchApi(`/api/wellness/working-hours?doctorId=${doctorId}`).then((rows) => {
      const arr = Array.isArray(rows) ? rows : [];
      const next = Array.from({ length: 7 }, (_, i) => defaultRow(i));
      for (const row of arr) {
        if (row.dayOfWeek >= 0 && row.dayOfWeek <= 6) {
          next[row.dayOfWeek] = {
            dayOfWeek: row.dayOfWeek,
            startTime: row.startTime,
            endTime: row.endTime,
            isActive: row.isActive !== false,
          };
        }
      }
      setSchedule(next);
    }).catch(() => {
      setSchedule(Array.from({ length: 7 }, (_, i) => defaultRow(i)));
    });
  }, [doctorId]);


  const updateDay = (idx, patch) => {
    setSchedule((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const save = async () => {
    if (!doctorId) return;
    setSaving(true);
    try {
      // Send only active days. Days with isActive=false are dropped — the
      // gate treats "no row for this dayOfWeek" as "no schedule" → silent
      // no-op (matches the route's contract — opt-in).
      const payload = schedule.filter((s) => s.isActive).map((s) => ({
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        isActive: true,
      }));
      await fetchApi(`/api/wellness/working-hours/${doctorId}`, {
        method: 'PUT',
        body: JSON.stringify({ schedule: payload }),
      });
      const docName = staff.find((u) => u.id === parseInt(doctorId, 10))?.name || 'practitioner';
      notify.success(`Saved ${docName}'s schedule (${payload.length} active days)`);
    } catch (_err) { /* fetchApi already toasted */ }
    setSaving(false);
  };


  const doctors = staff.filter((u) => u.wellnessRole === 'doctor' || u.wellnessRole === 'professional');

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock size={24} /> Working hours
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Per-practitioner weekly schedule. Bookings outside these hours are blocked at create-time.
          </p>
        </div>
      </header>

      {loading ? <div>Loading…</div> : doctors.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No practitioners configured. Add staff with wellnessRole=doctor or professional under Staff.
        </div>
      ) : (
        <>
          <div className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Practitioner:</label>
            <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} style={inputStyle}>
              {doctors.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.wellnessRole}</option>)}
            </select>
          </div>

          <div className="glass" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto', gap: '0.75rem 1rem', alignItems: 'center', maxWidth: 600 }}>
              <div style={cellHead}>Active</div><div style={cellHead}>Day</div><div style={cellHead}>Start</div><div style={cellHead}>End</div>
              {schedule.map((s, idx) => (
                <Row key={s.dayOfWeek} s={s} idx={idx} updateDay={updateDay} />
              ))}
            </div>
            <div style={{ marginTop: '1.25rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={save} disabled={saving} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Save size={14} /> {saving ? 'Saving…' : 'Save schedule'}
              </button>
            </div>
            <p style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Tip: leave a day inactive to opt out of the working-hours guard for that weekday — the calendar will not block bookings on that day.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ s, idx, updateDay }) {
  return (
    <>
      <input type="checkbox" checked={s.isActive} onChange={(e) => updateDay(idx, { isActive: e.target.checked })} aria-label={`${DAY_LABELS[s.dayOfWeek]} active`} />
      <div style={{ fontSize: '0.9rem' }}>{DAY_LABELS[s.dayOfWeek]}</div>
      <input type="time" value={s.startTime} disabled={!s.isActive} onChange={(e) => updateDay(idx, { startTime: e.target.value })} style={inputStyle} />
      <input type="time" value={s.endTime} disabled={!s.isActive} onChange={(e) => updateDay(idx, { endTime: e.target.value })} style={inputStyle} />
    </>
  );
}


const inputStyle = { padding: '0.4rem 0.6rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(255,255,255,0.1))', background: 'transparent', color: 'var(--text-primary)', fontSize: '0.85rem' };
const btnPrimary = { padding: '0.55rem 1.25rem', background: 'var(--primary-color, var(--accent-color))', border: 'none', color: '#fff', borderRadius: 8, cursor: 'pointer', fontWeight: 600 };
const cellHead = { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' };
