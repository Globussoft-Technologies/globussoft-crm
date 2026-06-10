import { useContext, useEffect, useMemo, useState } from 'react';
import { Clock, Save, Search, Users, X, Calendar as CalendarIcon } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

// Wave 11 Agent GG — per-staff working-hours editor. 2026-05-29 redesign:
// two-pane layout (left: search + role chips + grouped staff list with
// avatars; right: hero header with stats + day-card schedule grid with
// toggle switches). Replaces the original single-dropdown UX that didn't
// scale past 30 staff.
//
// Booking gate: backend/lib/bookingAvailability.js raises OUTSIDE_WORKING_
// HOURS when a visit falls outside a staff member's (dayOfWeek →
// [startTime, endTime]) window. Days with no row are treated as "no
// schedule configured" → silent no-op (operator opt-in).
//
// Role-based access: ADMIN / MANAGER see every staff row; other roles see
// only their own row, read-only. PUT route is server-gated by
// `adminOrPerm('settings','manage')` so writes stay admin-only regardless.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ROLE_ORDER = { doctor: 0, professional: 1, telecaller: 2, helper: 3, nurse: 4 };
const roleSortKey = (u) =>
  ROLE_ORDER[u.wellnessRole] ?? (u.role === 'ADMIN' ? 8 : u.role === 'MANAGER' ? 7 : 9);

const roleLabel = (u) =>
  u.wellnessRole || (u.role ? String(u.role).toLowerCase() : 'staff');

const ROLE_CHIPS = [
  { key: 'doctor', label: 'Doctors', match: (u) => u.wellnessRole === 'doctor' },
  { key: 'professional', label: 'Professionals', match: (u) => u.wellnessRole === 'professional' },
  { key: 'telecaller', label: 'Telecallers', match: (u) => u.wellnessRole === 'telecaller' },
  { key: 'helper', label: 'Helpers', match: (u) => u.wellnessRole === 'helper' },
  { key: 'nurse', label: 'Nurses', match: (u) => u.wellnessRole === 'nurse' },
  { key: 'manager', label: 'Managers', match: (u) => u.wellnessRole === 'manager' || u.role === 'MANAGER' },
  { key: 'admin', label: 'Admins', match: (u) => u.wellnessRole === 'admin' || (u.role === 'ADMIN' && !u.wellnessRole) },
];

const defaultRow = (dayOfWeek) => ({
  dayOfWeek,
  startTime: '09:00',
  endTime: '19:00',
  isActive: dayOfWeek !== 0,
});

// First letter of first word + first letter of last word, stripping
// honorifics in parens. "Dr. Harsh" → "DH"; "Anita Sharma" → "AS";
// "Pooja Mehta (Clinic Manager)" → "PM".
const initials = (name) => {
  const cleaned = String(name || '').replace(/\(.*?\)/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// Compute total weekly minutes from active rows. Used in the right-pane
// stats line so admins can sanity-check coverage at a glance.
const computeWeeklyStats = (schedule) => {
  let activeDays = 0;
  let totalMinutes = 0;
  for (const s of schedule) {
    if (!s.isActive) continue;
    activeDays += 1;
    const [sh, sm] = String(s.startTime || '0:0').split(':').map(Number);
    const [eh, em] = String(s.endTime || '0:0').split(':').map(Number);
    totalMinutes += (eh * 60 + em) - (sh * 60 + sm);
  }
  return { activeDays, totalMinutes };
};

const formatHours = (minutes) => {
  if (minutes <= 0) return '0h';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

export default function WorkingHoursEditor() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const [staff, setStaff] = useState([]);
  const [doctorId, setDoctorId] = useState('');
  const [schedule, setSchedule] = useState(() => Array.from({ length: 7 }, (_, i) => defaultRow(i)));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [activeChip, setActiveChip] = useState('all');

  useEffect(() => {
    fetchApi('/api/staff').then((s) => {
      const arr = Array.isArray(s) ? s : [];
      setStaff(arr);
      if (isAdmin) {
        const preferred = arr.find((u) => u.wellnessRole === 'doctor' || u.wellnessRole === 'professional');
        const first = preferred || arr[0];
        if (first) setDoctorId(String(first.id));
      } else if (user?.userId) {
        const self = arr.find((u) => u.id === user.userId);
        if (self) setDoctorId(String(self.id));
      }
    }).finally(() => setLoading(false));
  }, [isAdmin, user?.userId]);

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

  const visibleStaff = useMemo(() => {
    const active = staff.filter((u) => !u.deactivatedAt);
    const base = isAdmin ? active : active.filter((u) => u.id === user?.userId);
    return [...base].sort((a, b) => {
      const ka = roleSortKey(a);
      const kb = roleSortKey(b);
      if (ka !== kb) return ka - kb;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [staff, isAdmin, user?.userId]);

  const chipsWithCounts = useMemo(() => {
    return ROLE_CHIPS
      .map((c) => ({ ...c, count: visibleStaff.filter(c.match).length }))
      .filter((c) => c.count > 0);
  }, [visibleStaff]);

  const filteredStaff = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleStaff.filter((u) => {
      if (activeChip !== 'all') {
        const chip = ROLE_CHIPS.find((c) => c.key === activeChip);
        if (chip && !chip.match(u)) return false;
      }
      if (q && !String(u.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [visibleStaff, search, activeChip]);

  const groupedStaff = useMemo(() => {
    const groups = new Map();
    for (const u of filteredStaff) {
      const key = roleLabel(u);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    }
    return Array.from(groups.entries()).map(([role, items]) => ({ role, items }));
  }, [filteredStaff]);

  const selected = visibleStaff.find((u) => String(u.id) === String(doctorId));
  const canEdit = isAdmin;
  const { activeDays, totalMinutes } = computeWeeklyStats(schedule);

  return (
    <div className="wh-editor" style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <style>{wellnessHoursStyles}</style>

      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0 }}>
          <span className="wh-title-icon"><Clock size={20} /></span>
          Working hours
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.35rem', marginBottom: 0 }}>
          {isAdmin
            ? 'Per-staff weekly schedule. Bookings outside these hours are blocked at create-time.'
            : 'Your weekly schedule (read-only). Bookings outside these hours are blocked at create-time.'}
        </p>
      </header>

      {loading ? (
        <div>Loading…</div>
      ) : visibleStaff.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {isAdmin
            ? 'No staff configured for this tenant. Add staff under Staff to schedule working hours.'
            : 'No working-hours record found for your account. Ask an admin to configure your schedule.'}
        </div>
      ) : (
        <div className="wh-layout">
          {isAdmin ? (
            <aside className="glass wh-sidebar" aria-label="Staff list">
              <div className="wh-sidebar-header">
                <Users size={15} />
                <span>Staff</span>
                <span className="wh-count-badge">{visibleStaff.length}</span>
              </div>

              <div className="wh-search">
                <Search size={14} className="wh-search-icon" />
                <input
                  type="text"
                  placeholder="Search by name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search staff"
                  className="wh-search-input"
                />
                {search ? (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    className="wh-search-clear"
                  >
                    <X size={13} />
                  </button>
                ) : null}
              </div>

              <div className="wh-chips">
                <ChipButton
                  active={activeChip === 'all'}
                  onClick={() => setActiveChip('all')}
                  label={`All (${visibleStaff.length})`}
                />
                {chipsWithCounts.map((c) => (
                  <ChipButton
                    key={c.key}
                    active={activeChip === c.key}
                    onClick={() => setActiveChip(c.key)}
                    label={`${c.label} (${c.count})`}
                  />
                ))}
              </div>

              <div
                role="listbox"
                aria-label="Staff to schedule"
                className="wh-list"
              >
                {filteredStaff.length === 0 ? (
                  <div className="wh-no-match">No staff match this filter.</div>
                ) : (
                  groupedStaff.map((g) => (
                    <div key={g.role} className="wh-group">
                      <div className="wh-group-head">{g.role}</div>
                      <div className="wh-group-items">
                        {g.items.map((u) => {
                          const isSelected = String(u.id) === String(doctorId);
                          return (
                            <button
                              key={u.id}
                              type="button"
                              role="option"
                              aria-selected={isSelected}
                              onClick={() => setDoctorId(String(u.id))}
                              className={`wh-staff-row ${isSelected ? 'is-selected' : ''}`}
                            >
                              <span className="wh-avatar">{initials(u.name)}</span>
                              <span className="wh-staff-name">{u.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </aside>
          ) : null}

          <main className="wh-main">
            {selected ? (
              <>
                <div className="glass wh-hero">
                  <div className="wh-hero-left">
                    <span className="wh-avatar wh-avatar-lg">{initials(selected.name)}</span>
                    <div className="wh-hero-meta">
                      <div className="wh-hero-name">{selected.name}</div>
                      <div className="wh-hero-sub">
                        <span className="wh-role-pill">{roleLabel(selected)}</span>
                        <span className="wh-stat-dot" aria-hidden>•</span>
                        <span className="wh-hero-stat">
                          <CalendarIcon size={12} /> {activeDays} {activeDays === 1 ? 'day' : 'days'} · {formatHours(totalMinutes)}/week
                        </span>
                      </div>
                    </div>
                  </div>
                  {canEdit ? (
                    <button onClick={save} disabled={saving} className="wh-save-btn">
                      <Save size={14} /> {saving ? 'Saving…' : 'Save schedule'}
                    </button>
                  ) : null}
                </div>

                <div className="glass wh-days">
                  {schedule.map((s, idx) => (
                    <DayCard
                      key={s.dayOfWeek}
                      s={s}
                      idx={idx}
                      updateDay={updateDay}
                      readOnly={!canEdit}
                    />
                  ))}
                  <p className="wh-footer-tip">
                    {canEdit
                      ? 'Tip: leave a day inactive to opt out of the working-hours guard for that weekday — the calendar will not block bookings on that day.'
                      : 'View-only. Contact an admin or manager to change your weekly schedule.'}
                  </p>
                </div>
              </>
            ) : (
              <div className="glass" style={{ padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.9rem', textAlign: 'center' }}>
                Pick a staff member from the list to view or edit their schedule.
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function DayCard({ s, idx, updateDay, readOnly }) {
  const day = DAY_LABELS[s.dayOfWeek];
  const [sh, sm] = String(s.startTime || '0:0').split(':').map(Number);
  const [eh, em] = String(s.endTime || '0:0').split(':').map(Number);
  const minutes = (eh * 60 + em) - (sh * 60 + sm);
  return (
    <div className={`wh-day-card ${s.isActive ? 'is-active' : 'is-inactive'}`}>
      <div className="wh-day-label">{day}</div>
      <label className="wh-switch">
        <input
          type="checkbox"
          checked={s.isActive}
          disabled={readOnly}
          onChange={(e) => updateDay(idx, { isActive: e.target.checked })}
          aria-label={`${day} active`}
        />
        <span className="wh-switch-slider" />
      </label>
      <div className="wh-day-times">
        {s.isActive ? (
          <>
            <input
              type="time"
              value={s.startTime}
              disabled={readOnly}
              onChange={(e) => updateDay(idx, { startTime: e.target.value })}
              className="wh-time-input"
              aria-label={`${day} start time`}
            />
            <span className="wh-time-sep" aria-hidden>→</span>
            <input
              type="time"
              value={s.endTime}
              disabled={readOnly}
              onChange={(e) => updateDay(idx, { endTime: e.target.value })}
              className="wh-time-input"
              aria-label={`${day} end time`}
            />
          </>
        ) : (
          <>
            <input type="time" value={s.startTime} disabled aria-hidden="true" className="wh-time-input wh-time-hidden" tabIndex={-1} />
            <input type="time" value={s.endTime} disabled aria-hidden="true" className="wh-time-input wh-time-hidden" tabIndex={-1} />
            <span className="wh-day-off">Day off</span>
          </>
        )}
      </div>
      <div className="wh-day-duration">
        {s.isActive && minutes > 0 ? formatHours(minutes) : ''}
      </div>
    </div>
  );
}

function ChipButton({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`wh-chip ${active ? 'is-active' : ''}`}
    >
      {label}
    </button>
  );
}

const wellnessHoursStyles = `
.wh-editor { color: var(--text-primary); }

.wh-title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px; height: 36px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--primary-color, var(--accent-color)) 18%, transparent);
  color: var(--primary-color, var(--accent-color));
}

.wh-layout {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: flex-start;
}

.wh-sidebar {
  flex: 1 1 280px;
  min-width: 260px;
  max-width: 340px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.wh-sidebar-header {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}
.wh-count-badge {
  margin-left: auto;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary-color, var(--accent-color)) 15%, transparent);
  color: var(--primary-color, var(--accent-color));
}

.wh-search { position: relative; }
.wh-search-icon {
  position: absolute; left: 10px; top: 50%;
  transform: translateY(-50%);
  color: var(--text-secondary);
  pointer-events: none;
}
.wh-search-input {
  width: 100%;
  padding: 0.5rem 0.6rem 0.5rem 30px;
  border-radius: 10px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.1));
  background: rgba(255,255,255,0.03);
  color: var(--text-primary);
  font-size: 0.85rem;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  box-sizing: border-box;
}
.wh-search-input:focus {
  outline: none;
  border-color: var(--primary-color, var(--accent-color));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color, var(--accent-color)) 20%, transparent);
  background: rgba(255,255,255,0.05);
}
.wh-search-clear {
  position: absolute; right: 6px; top: 50%;
  transform: translateY(-50%);
  background: none; border: none; padding: 4px;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}
.wh-search-clear:hover { background: rgba(255,255,255,0.08); color: var(--text-primary); }

.wh-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.wh-chip {
  padding: 0.28rem 0.7rem;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: rgba(255,255,255,0.03);
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.wh-chip:hover { background: rgba(255,255,255,0.07); color: var(--text-primary); }
.wh-chip.is-active {
  background: var(--primary-color, var(--accent-color));
  border-color: var(--primary-color, var(--accent-color));
  color: #fff;
}

.wh-list {
  max-height: 520px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-right: 4px;
  margin-right: -4px;
}
.wh-list::-webkit-scrollbar { width: 6px; }
.wh-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 999px; }

.wh-no-match {
  font-size: 0.8rem;
  color: var(--text-secondary);
  padding: 1rem 0.5rem;
  text-align: center;
  font-style: italic;
}

.wh-group + .wh-group { margin-top: 0.4rem; }
.wh-group-head {
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 0.35rem 0.5rem 0.3rem;
  opacity: 0.75;
}
.wh-group-items { display: flex; flex-direction: column; gap: 2px; }

.wh-staff-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.55rem 0.45rem 0.7rem;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.85rem;
  cursor: pointer;
  border-radius: 8px;
  text-align: left;
  transition: background 0.15s;
  width: 100%;
}
.wh-staff-row::before {
  content: '';
  position: absolute;
  left: 0; top: 6px; bottom: 6px;
  width: 3px;
  border-radius: 3px;
  background: transparent;
  transition: background 0.15s;
}
.wh-staff-row:hover { background: rgba(255,255,255,0.05); }
.wh-staff-row.is-selected {
  background: color-mix(in srgb, var(--primary-color, var(--accent-color)) 14%, transparent);
  color: var(--text-primary);
  font-weight: 600;
}
.wh-staff-row.is-selected::before { background: var(--primary-color, var(--accent-color)); }
.wh-staff-row.is-selected .wh-avatar {
  background: var(--primary-color, var(--accent-color));
  color: #fff;
}

.wh-avatar {
  flex: 0 0 auto;
  width: 30px; height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--primary-color, var(--accent-color)) 18%, transparent);
  color: var(--primary-color, var(--accent-color));
  transition: background 0.15s, color 0.15s;
}
.wh-avatar-lg {
  width: 48px; height: 48px;
  font-size: 1rem;
  background: color-mix(in srgb, var(--primary-color, var(--accent-color)) 22%, transparent);
}

.wh-staff-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Right pane */
.wh-main {
  flex: 2 1 480px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.wh-hero {
  padding: 1.1rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.wh-hero-left {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  min-width: 0;
  flex: 1 1 auto;
}
.wh-hero-meta { min-width: 0; }
.wh-hero-name {
  font-size: 1.15rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wh-hero-sub {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.2rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  flex-wrap: wrap;
}
.wh-role-pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary-color, var(--accent-color)) 15%, transparent);
  color: var(--primary-color, var(--accent-color));
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: capitalize;
}
.wh-stat-dot { opacity: 0.4; }
.wh-hero-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.wh-save-btn {
  padding: 0.55rem 1.1rem;
  background: var(--primary-color, var(--accent-color));
  border: none;
  color: #fff;
  border-radius: 10px;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.85rem;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  transition: filter 0.15s, transform 0.05s;
}
.wh-save-btn:hover:not(:disabled) { filter: brightness(1.1); }
.wh-save-btn:active:not(:disabled) { transform: translateY(1px); }
.wh-save-btn:disabled { opacity: 0.6; cursor: not-allowed; }

.wh-days {
  padding: 0.65rem 0.5rem 0.4rem;
  display: flex;
  flex-direction: column;
}

.wh-day-card {
  display: grid;
  grid-template-columns: 60px 50px 1fr 70px;
  align-items: center;
  gap: 0.85rem;
  padding: 0.7rem 0.85rem;
  border-radius: 10px;
  transition: background 0.15s;
}
.wh-day-card:hover { background: rgba(255,255,255,0.03); }
.wh-day-card + .wh-day-card { border-top: 1px solid var(--border-color, rgba(255,255,255,0.06)); border-radius: 0; }
.wh-day-card.is-inactive .wh-day-label { opacity: 0.4; }
.wh-day-card.is-inactive .wh-day-duration { opacity: 0.4; }

.wh-day-label {
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.wh-day-times {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  flex-wrap: wrap;
}
.wh-time-sep {
  color: var(--text-secondary);
  font-size: 0.85rem;
  opacity: 0.5;
}
.wh-time-input {
  padding: 0.4rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: rgba(255,255,255,0.03);
  color: var(--text-primary);
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.wh-time-input:focus {
  outline: none;
  border-color: var(--primary-color, var(--accent-color));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color, var(--accent-color)) 18%, transparent);
}
.wh-time-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.wh-time-hidden {
  position: absolute;
  width: 1px; height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  pointer-events: none;
  opacity: 0;
}
.wh-day-off {
  color: var(--text-secondary);
  font-size: 0.82rem;
  font-style: italic;
  opacity: 0.7;
}
.wh-day-duration {
  text-align: right;
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* Toggle switch — wraps a real <input type="checkbox" aria-label> so the
   test's getByLabelText + toBeChecked + toBeDisabled assertions all hold.
   The input is visually hidden; the .wh-switch-slider draws the pill. */
.wh-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex: 0 0 auto;
}
.wh-switch input {
  opacity: 0;
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
  margin: 0;
  cursor: pointer;
  z-index: 2;
}
.wh-switch input:disabled { cursor: not-allowed; }
.wh-switch-slider {
  position: absolute;
  inset: 0;
  background: rgba(255,255,255,0.12);
  border-radius: 999px;
  transition: background 0.18s;
  pointer-events: none;
}
.wh-switch-slider::before {
  content: '';
  position: absolute;
  height: 14px; width: 14px;
  left: 3px; top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.18s;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.wh-switch input:checked + .wh-switch-slider {
  background: var(--primary-color, var(--accent-color));
}
.wh-switch input:checked + .wh-switch-slider::before {
  transform: translateX(16px);
}
.wh-switch input:disabled + .wh-switch-slider { opacity: 0.55; }

.wh-footer-tip {
  margin: 0.6rem 0.85rem 0.5rem;
  padding-top: 0.65rem;
  border-top: 1px solid var(--border-color, rgba(255,255,255,0.06));
  font-size: 0.75rem;
  color: var(--text-secondary);
}

@media (max-width: 720px) {
  .wh-day-card {
    grid-template-columns: 50px auto 1fr;
    grid-template-areas:
      'label switch times'
      'label switch duration';
    row-gap: 0.3rem;
  }
  .wh-day-label { grid-area: label; }
  .wh-switch { grid-area: switch; }
  .wh-day-times { grid-area: times; }
  .wh-day-duration { grid-area: duration; text-align: left; }
}
`;
