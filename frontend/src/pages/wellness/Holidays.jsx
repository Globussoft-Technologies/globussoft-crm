import { useEffect, useMemo, useState } from 'react';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../components/wellness/DateRangeFilter';

// Wave 11 Agent GG — admin Holiday calendar. The next 365 days surface as a
// scrollable list grouped by month; clicking an empty cell opens an inline
// "mark holiday" form. The booking-conflict gate at backend/lib/
// bookingAvailability.js raises HOLIDAY_BLOCKED when a visit lands on a
// holiday matching tenant / location / doctor scope.

const dayMs = 24 * 60 * 60 * 1000;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' });

export default function Holidays() {
  const notify = useNotify();
  const [holidays, setHolidays] = useState([]);
  const [locations, setLocations] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ date: '', name: '', locationId: '', doctorId: '', recurringAnnually: false });
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const visibleHolidays = (rangeStart && rangeEnd)
    ? holidays.filter((h) => {
        const ts = new Date(h.date).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : holidays;

  // Default range: today + next 365 days.
  const range = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today.getTime() + 365 * dayMs);
    return {
      from: today.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    };
  }, []);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/wellness/holidays?from=${range.from}&to=${range.to}`).catch(() => []),
      fetchApi('/api/wellness/locations').catch(() => []),
      fetchApi('/api/staff').catch(() => []),
    ])
      .then(([h, l, s]) => {
        setHolidays(Array.isArray(h) ? h : []);
        setLocations(Array.isArray(l) ? l : []);
        setStaff(Array.isArray(s) ? s : []);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.date || !form.name) return;
    setSaving(true);
    try {
      await fetchApi('/api/wellness/holidays', {
        method: 'POST',
        body: JSON.stringify({
          date: form.date,
          name: form.name,
          locationId: form.locationId ? parseInt(form.locationId, 10) : null,
          doctorId: form.doctorId ? parseInt(form.doctorId, 10) : null,
          recurringAnnually: form.recurringAnnually,
        }),
      });
      notify.success(`Marked ${form.date} as "${form.name}"${form.recurringAnnually ? ' (recurring annually)' : ''}`);
      setForm({ date: '', name: '', locationId: '', doctorId: '', recurringAnnually: false });
      setAdding(false);
      load();
    } catch (_err) { /* fetchApi already toasted */ }
    setSaving(false);
  };

  const remove = async (h) => {
    if (!window.confirm(`Remove holiday "${h.name}" on ${fmtDate(h.date)}?`)) return;
    try {
      await fetchApi(`/api/wellness/holidays/${h.id}`, { method: 'DELETE' });
      notify.success(`Removed "${h.name}"`);
      load();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  const doctors = staff.filter((u) => u.wellnessRole === 'doctor' || u.wellnessRole === 'professional');

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CalendarOff size={24} /> Holidays
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Clinic-wide closures + per-location / per-practitioner leave days. {holidays.length} configured for the next 365 days.
          </p>
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          <Plus size={16} /> {adding ? 'Cancel' : 'Mark holiday'}
        </button>
      </header>

      {adding && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '0.5rem' }}>
          <input type="date" required min={range.from} max={range.to} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} style={inputStyle} />
          <input placeholder="Name — e.g. Diwali, Republic Day" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} style={inputStyle}>
            <option value="">— all locations (clinic-wide) —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select value={form.doctorId} onChange={(e) => setForm({ ...form, doctorId: e.target.value })} style={inputStyle}>
            <option value="">— all practitioners —</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.recurringAnnually}
              onChange={(e) => setForm({ ...form, recurringAnnually: e.target.checked })}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <span>
              Recurring annually
              <span style={{ marginLeft: '0.4rem', color: 'var(--text-tertiary, var(--text-secondary))', fontSize: '0.75rem' }}>
                — repeats every year on the same date, no need to re-add
              </span>
            </span>
          </label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button type="button" onClick={() => setAdding(false)} style={btnSecondary}>Cancel</button>
            <button type="submit" disabled={saving || !form.date || !form.name} style={btnPrimary}>{saving ? 'Saving…' : 'Mark holiday'}</button>
          </div>
        </form>
      )}

      {loading ? <div>Loading…</div> : (
        holidays.length === 0 ? (
          <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            No holidays configured. Mark Diwali, Republic Day, or a per-practitioner leave day to gate the calendar.
          </div>
        ) : (
          <>
            <div
              className="glass"
              style={{
                padding: '0.6rem 0.85rem', display: 'flex', flexWrap: 'wrap',
                alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem',
              }}
            >
              <DateRangeFilter value={filter} onChange={setFilter} />
              <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {visibleHolidays.length === holidays.length
                  ? `${holidays.length} holiday${holidays.length === 1 ? '' : 's'}`
                  : `${visibleHolidays.length} of ${holidays.length} holidays`}
              </span>
            </div>
            {visibleHolidays.length === 0 ? (
              <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                No holidays in the selected range.
              </div>
            ) : (
              <div className="glass" style={{ padding: '0.5rem', overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                      <th style={th}>Date</th><th style={th}>Name</th><th style={th}>Scope</th><th style={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleHolidays.map((h) => {
                      const loc = locations.find((l) => l.id === h.locationId);
                      const doc = staff.find((u) => u.id === h.doctorId);
                      const scope = doc
                        ? `Practitioner: ${doc.name}`
                        : loc
                          ? `Location: ${loc.name}`
                          : 'Clinic-wide';
                      const dateCell = h.recurringAnnually
                    ? `${new Date(h.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} (every year)`
                    : fmtDate(h.date);
                  return (
                        <tr key={h.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={td}>
                        {dateCell}
                        {h.recurringAnnually && (
                          <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: 999, background: 'rgba(34,197,94,0.15)', color: 'rgb(34,197,94)', border: '1px solid rgba(34,197,94,0.3)' }}>
                            Annual
                          </span>
                        )}
                      </td>
                          <td style={td}>{h.name}</td>
                          <td style={td}>{scope}</td>
                          <td style={{ ...td, textAlign: 'right' }}>
                            <button onClick={() => remove(h)} style={iconBtn} aria-label="Delete"><Trash2 size={14} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

const inputStyle = { padding: '0.55rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(255,255,255,0.1))', background: 'transparent', color: 'var(--text-primary)', fontSize: '0.9rem' };
const btnPrimary = { padding: '0.55rem 1.25rem', background: 'var(--primary-color, var(--accent-color))', border: 'none', color: '#fff', borderRadius: 8, cursor: 'pointer', fontWeight: 600 };
const btnSecondary = { padding: '0.55rem 1.25rem', background: 'transparent', border: '1px solid var(--border-color, rgba(255,255,255,0.15))', color: 'var(--text-primary)', borderRadius: 8, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '0.6rem 0.75rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' };
const td = { padding: '0.6rem 0.75rem', fontSize: '0.85rem' };
const iconBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0.3rem' };
