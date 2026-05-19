// Closes #803 (Zylu-Gap ATT-002) — calendar view of leaves + attendance.
//
// Layout:
//   - Month navigator (prev / month-year label / next / Today)
//   - For managers: optional staff filter dropdown (default: caller's own user)
//   - Month grid (7 cols × 5-6 rows). Each cell shows:
//       • Date number (top-left)
//       • Leave indicator (top-right, when an APPROVED leave covers the day)
//       • Attendance status badge + clock-in time
//
// Backend deps (no new endpoints needed):
//   - GET /api/attendance/me?from=&to=        — self attendance rows
//   - GET /api/attendance/staff/:id?from=&to= — manager: any staff in tenant
//   - GET /api/leave/requests?status=APPROVED — leave requests (filtered client-
//     side to overlap month; status=APPROVED only — pending/rejected leaves
//     don't belong on a "what days am I out" calendar)
//   - GET /api/staff                          — manager: populate dropdown
//
// Cross-link: cells with a leave indicator link to /leave with the staff
// member's id preselected (URL query state `?userId=`).
//
// Theme: uses var(--primary-color, var(--accent-color)) so the calendar's
// today-highlight + active-tab styling stays on-brand under both wellness
// (teal) and generic (blue) verticals.

import { useEffect, useMemo, useState, useContext } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchApi } from '../../utils/api';
import { AuthContext } from '../../App';

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function ymd(d) {
  // Local-tz YYYY-MM-DD. Using ISO would shift dates near midnight to the
  // previous UTC day — calendars are about wall-clock days, not UTC.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function monthGridDates(monthDate) {
  // Returns the 7-col grid covering monthDate's month, padded with the leading
  // days from the prior month and trailing days from the next month so each
  // row stays length-7. Week starts Monday (typical clinic-scheduling layout).
  const first = startOfMonth(monthDate);
  const last = endOfMonth(monthDate);
  // Mon=0, Sun=6 (offset from JS's getDay() where Sun=0).
  const leading = (first.getDay() + 6) % 7;
  const days = [];
  for (let i = leading; i > 0; i -= 1) {
    const d = new Date(first);
    d.setDate(first.getDate() - i);
    days.push({ date: d, inMonth: false });
  }
  for (let d = 1; d <= last.getDate(); d += 1) {
    days.push({ date: new Date(monthDate.getFullYear(), monthDate.getMonth(), d), inMonth: true });
  }
  while (days.length % 7 !== 0) {
    const lastDay = days[days.length - 1].date;
    const next = new Date(lastDay);
    next.setDate(lastDay.getDate() + 1);
    days.push({ date: next, inMonth: false });
  }
  return days;
}

const STATUS_STYLE = {
  PRESENT:  { bg: '#e7f6ed', color: '#0a9050' },
  HALF_DAY: { bg: '#fff5dc', color: '#a36b00' },
  LATE:     { bg: '#fde7e7', color: '#a01a1a' },
  ABSENT:   { bg: '#eee',    color: '#666'    },
  HOLIDAY:  { bg: '#e7eefd', color: '#1a4ea0' },
};

function fmtTime(s) {
  if (!s) return '';
  return new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function leaveCoversDate(req, day) {
  // Leave request covers a date when day >= startDate AND day <= endDate
  // (inclusive). startDate/endDate stored as ISO datetimes; we compare the
  // YYYY-MM-DD portion to avoid TZ drift around midnight.
  const dayKey = ymd(day);
  const startKey = (req.startDate || '').slice(0, 10);
  const endKey = (req.endDate || req.startDate || '').slice(0, 10);
  return startKey && dayKey >= startKey && dayKey <= endKey;
}

export default function AttendanceCalendar() {
  const { user } = useContext(AuthContext) || {};
  const isManager = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  // monthDate's day-of-month is irrelevant; only year+month matter.
  const [monthDate, setMonthDate] = useState(() => startOfMonth(new Date()));
  // For managers: which staff member's calendar are we viewing? Defaults to
  // self so the calendar opens to the manager's own data and they tab to
  // other staff intentionally.
  const [staffFilter, setStaffFilter] = useState(user?.userId || null);
  const [staffList, setStaffList] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const monthStart = ymd(startOfMonth(monthDate));
  const monthEnd = ymd(endOfMonth(monthDate));
  const monthLabel = monthDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  // Manager-side: load /api/staff once so the filter dropdown can render
  // names. Plain users skip this — they only ever see their own calendar.
  useEffect(() => {
    if (!isManager) return;
    fetchApi('/api/staff')
      .then((rows) => setStaffList(Array.isArray(rows) ? rows : []))
      .catch(() => setStaffList([]));
  }, [isManager]);

  // Re-fetch attendance + leaves whenever month or staff filter changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    const targetUserId = isManager ? staffFilter : user?.userId;
    const attendanceUrl = (isManager && targetUserId && targetUserId !== user?.userId)
      ? `/api/attendance/staff/${targetUserId}?from=${monthStart}&to=${monthEnd}`
      : `/api/attendance/me?from=${monthStart}&to=${monthEnd}`;

    Promise.all([
      fetchApi(attendanceUrl),
      // Leave list filter: API doesn't expose from/to — we filter client-side.
      // status=APPROVED keeps the calendar focused on confirmed absences. Adding
      // a userId narrows the list when a manager is viewing another staff's
      // calendar; for self-view it's omitted (server scopes to caller).
      fetchApi(`/api/leave/requests?status=APPROVED${
        isManager && targetUserId ? `&userId=${targetUserId}` : ''
      }`),
    ])
      .then(([attRows, leaveRows]) => {
        setAttendance(Array.isArray(attRows) ? attRows : []);
        setLeaves(Array.isArray(leaveRows) ? leaveRows : []);
      })
      .catch((e) => {
        const msg = e && e.body && e.body.error;
        setError(msg || 'Failed to load calendar data');
        setAttendance([]);
        setLeaves([]);
      })
      .finally(() => setLoading(false));
  }, [monthStart, monthEnd, isManager, staffFilter, user?.userId]);

  // Index attendance rows by YYYY-MM-DD for O(1) cell lookup.
  const attendanceByDate = useMemo(() => {
    const m = {};
    for (const r of attendance) {
      const key = (r.date || '').slice(0, 10);
      if (key) m[key] = r;
    }
    return m;
  }, [attendance]);

  const grid = useMemo(() => monthGridDates(monthDate), [monthDate]);
  const todayKey = ymd(new Date());

  const goPrev = () => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1));
  const goNext = () => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1));
  const goToday = () => setMonthDate(startOfMonth(new Date()));

  // Cross-link target for leave bars: drops the user into the Leave module
  // with the staff member preselected. Falls back to plain /leave for self.
  const leaveLinkFor = (uid) => (uid && uid !== user?.userId ? `/leave?userId=${uid}` : '/leave');

  return (
    <div>
      {/* Toolbar: month nav + staff filter */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap',
        gap: 12, marginBottom: 16,
      }}>
        <button
          type="button"
          onClick={goPrev}
          aria-label="Previous month"
          style={{
            padding: '6px 10px', border: '1px solid var(--border-color, #ddd)',
            borderRadius: 6, background: 'var(--surface-color, #fff)',
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
          }}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <div style={{ fontSize: 18, fontWeight: 600, minWidth: 180, textAlign: 'center' }}>
          {monthLabel}
        </div>
        <button
          type="button"
          onClick={goNext}
          aria-label="Next month"
          style={{
            padding: '6px 10px', border: '1px solid var(--border-color, #ddd)',
            borderRadius: 6, background: 'var(--surface-color, #fff)',
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
          }}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={goToday}
          aria-label="Jump to today"
          style={{
            padding: '6px 14px', border: '1px solid var(--border-color, #ddd)',
            borderRadius: 6, background: 'var(--surface-color, #fff)',
            cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}
        >
          Today
        </button>

        {isManager && staffList.length > 0 && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <label htmlFor="staff-filter" style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>
              Staff
            </label>
            <select
              id="staff-filter"
              value={staffFilter || ''}
              onChange={(e) => setStaffFilter(parseInt(e.target.value, 10))}
              style={{
                padding: '6px 10px', border: '1px solid var(--border-color, #ddd)',
                borderRadius: 6, background: 'var(--surface-color, #fff)', minWidth: 180,
              }}
            >
              {user?.userId && <option value={user.userId}>Me ({user.name || user.email})</option>}
              {staffList
                .filter((s) => s.id !== user?.userId)
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.name || s.email}</option>
                ))}
            </select>
          </div>
        )}
      </div>

      {/* Weekday headers */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: 4, marginBottom: 4,
      }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div
            key={d}
            style={{
              fontSize: 11, fontWeight: 600,
              color: 'var(--text-secondary, #888)',
              textAlign: 'center', padding: '4px 0',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
          Loading calendar&hellip;
        </div>
      ) : error ? (
        <div role="alert" style={{
          padding: 16, borderRadius: 6, background: '#fde7e7',
          color: '#a01a1a', fontSize: 13,
        }}>
          {error}
        </div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: 4,
        }}>
          {grid.map(({ date, inMonth }) => {
            const key = ymd(date);
            const att = attendanceByDate[key];
            const leave = leaves.find((r) => leaveCoversDate(r, date));
            const isToday = key === todayKey;
            const status = att?.status;
            const sc = status ? STATUS_STYLE[status] : null;
            const targetUserId = isManager ? staffFilter : user?.userId;
            return (
              <div
                key={key}
                aria-label={[
                  date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                  status && `status ${status}`,
                  leave && 'on leave',
                ].filter(Boolean).join(', ')}
                style={{
                  minHeight: 92,
                  padding: 6,
                  borderRadius: 8,
                  border: isToday
                    ? '2px solid var(--primary-color, var(--accent-color))'
                    : '1px solid var(--border-color, #eee)',
                  background: inMonth
                    ? 'var(--surface-color, #fff)'
                    : 'var(--subtle-bg, #f7f7f7)',
                  opacity: inMonth ? 1 : 0.55,
                  display: 'flex', flexDirection: 'column', gap: 4,
                  fontSize: 12, lineHeight: 1.3,
                  position: 'relative',
                }}
              >
                {/* Day number + leave indicator */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <span style={{
                    fontWeight: isToday ? 700 : 500,
                    color: isToday ? 'var(--primary-color, var(--accent-color))' : 'inherit',
                  }}>
                    {date.getDate()}
                  </span>
                  {leave && (
                    <Link
                      to={leaveLinkFor(targetUserId)}
                      title={`On leave: ${leave.policy?.name || leave.policy?.leaveType || 'leave'}${leave.reason ? ` — ${leave.reason}` : ''}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                        padding: '1px 6px', borderRadius: 10,
                        background: '#fde7e7', color: '#a01a1a',
                        fontSize: 10, fontWeight: 600, textDecoration: 'none',
                      }}
                      aria-label={`On leave — open Leave module`}
                    >
                      Leave <ExternalLink size={10} aria-hidden />
                    </Link>
                  )}
                </div>

                {/* Attendance badge */}
                {sc && (
                  <span
                    style={{
                      alignSelf: 'flex-start',
                      background: sc.bg, color: sc.color,
                      padding: '1px 6px', borderRadius: 4,
                      fontSize: 10, fontWeight: 600,
                    }}
                  >
                    {status}
                  </span>
                )}

                {/* Clock-in time, when present. Helpful at-a-glance signal for
                    managers reviewing a staff month for tardiness patterns. */}
                {att?.clockInAt && (
                  <span style={{ color: 'var(--text-secondary, #666)', fontSize: 10 }}>
                    in {fmtTime(att.clockInAt)}
                    {att.clockOutAt ? ` · out ${fmtTime(att.clockOutAt)}` : ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Legend */}
      <div style={{
        marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 12,
        fontSize: 11, color: 'var(--text-secondary, #888)',
      }}>
        {Object.entries(STATUS_STYLE).map(([label, sc]) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              display: 'inline-block', width: 10, height: 10, borderRadius: 2,
              background: sc.bg, border: `1px solid ${sc.color}`,
            }} />
            {label}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: 2,
            background: '#fde7e7', border: '1px solid #a01a1a',
          }} />
          On leave
        </span>
      </div>
    </div>
  );
}
