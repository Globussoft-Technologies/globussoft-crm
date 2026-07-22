// Wave 2 Agent JJ — Staff Attendance page (Google Doc audit, 8 May 2026).
//
// Layout:
//   - Top card: today's clock-in/out with big Punch In / Punch Out buttons
//   - Below: "My Last 30 Days" attendance grid
//   - For ADMIN/MANAGER only: a "Today — All Staff" section listing every
//     staff row's status for the current day. Plain users don't see it.
//
// Uses /api/attendance/* endpoints. Dual-vertical (works under both wellness
// and generic verticals); the route is mounted at /wellness/attendance for
// the wellness sidebar but the page itself doesn't gate on tenant.vertical.
import { useEffect, useState, useContext } from 'react';
import { Clock, LogIn, LogOut, Calendar, Users } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import { DateRangeFilter, resolveDateRangeYmd } from '../../components/wellness/DateRangeFilter';
import TopScrollSync from '../../components/TopScrollSync';

// Wraps navigator.geolocation.getCurrentPosition in a promise. Resolves to
// null (never rejects) when geolocation is unsupported, denied, or times
// out — the backend's geofence check already fails open with LOCATION_REQUIRED
// when no coords are sent, so the punch flow degrades gracefully either way.
function getCurrentCoords() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  });
}

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString();
}

function fmtTime(s) {
  if (!s) return '—';
  return new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtMinutes(m) {
  if (m === null || m === undefined) return '—';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

// Turns the backend's geofence error codes (see lib/attendanceGeofence.js)
// into a friendlier message. fetchApi (utils/api.js) attaches `code` and
// `serverMessage` directly on the thrown Error — NOT `e.body.code` /
// `e.body.error`, which don't exist on this error shape (a prior version of
// this helper read those and silently always fell through to the generic
// fallback, because e.body was always undefined).
//
// For OUTSIDE_RADIUS and ACCURACY_TOO_LOW specifically, the SERVER's message
// is already the best copy — lib/attendanceGeofence.js builds it with the
// actual clinic name, live distance, and required radius baked in (e.g.
// "You're 3400m from Ranchi — outside the allowed range. Move closer and
// try again."). Don't replace that with a generic string; only LOCATION_REQUIRED
// needs frontend-authored copy, since the server's version of that message
// doesn't mention the browser-permission angle.
function geofenceErrorMessage(e) {
  const code = e && e.code;
  const serverMsg = e && e.serverMessage;
  if (code === 'LOCATION_REQUIRED') {
    return 'Location access is required to clock in/out here. Please allow location access in your browser and try again.';
  }
  return serverMsg;
}

function statusClass(s) {
  switch (s) {
    case 'PRESENT': return { color: '#0a9050', bg: '#e7f6ed' };
    case 'HALF_DAY': return { color: '#a36b00', bg: '#fff5dc' };
    case 'LATE': return { color: '#a01a1a', bg: '#fde7e7' };
    case 'ABSENT': return { color: '#666', bg: '#eee' };
    case 'HOLIDAY': return { color: '#1a4ea0', bg: '#e7eefd' };
    default: return { color: '#444', bg: '#eee' };
  }
}

export default function Attendance() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isManager = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Attendance requires a window — opt out of "All time" and default to last30
  // (matches the prior 30-day default).
  const [dateFilter, setDateFilter] = useState({ preset: 'last30', start: '', end: '' });
  const [from, to] = resolveDateRangeYmd(dateFilter);

  // Today's row (clockInAt/clockOutAt) — derived from history's first row.
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayRow = history.find((r) => (r.date || '').slice(0, 10) === todayKey) || null;
  const isClockedIn = todayRow && todayRow.clockInAt && !todayRow.clockOutAt;
  const isClockedOut = todayRow && todayRow.clockOutAt;

  const load = () => {
    if (!from || !to) return;
    setLoading(true);
    fetchApi(`/api/attendance/me?from=${from}&to=${to}`)
      .then((rows) => setHistory(Array.isArray(rows) ? rows : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [from, to]);

  const onClockIn = async () => {
    setBusy(true);
    try {
      const coords = await getCurrentCoords();
      // silent: true — fetchApi's default auto-toast would show the raw
      // server error alongside our friendlier geofenceErrorMessage below,
      // stacking two red banners for one failure. We handle the toast
      // ourselves here so there's exactly one.
      await fetchApi('/api/attendance/clock-in', { method: 'POST', body: JSON.stringify(coords || {}), silent: true });
      notify.success('Clocked in');
      load();
    } catch (e) {
      notify.error(geofenceErrorMessage(e) || 'Clock-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onClockOut = async () => {
    setBusy(true);
    try {
      const coords = await getCurrentCoords();
      await fetchApi('/api/attendance/clock-out', { method: 'POST', body: JSON.stringify(coords || {}), silent: true });
      notify.success('Clocked out');
      load();
    } catch (e) {
      notify.error(geofenceErrorMessage(e) || 'Clock-out failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Clock size={28} aria-hidden /> Attendance
      </h1>

      {/* Today's punch card */}
      <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 24 }}>
        <h2 style={{ marginTop: 0 }}>Today, {new Date().toLocaleDateString()}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 16, marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Clock-in</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtTime(todayRow?.clockInAt)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Clock-out</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtTime(todayRow?.clockOutAt)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Total</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtMinutes(todayRow?.totalMinutes)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Status</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{todayRow?.status || 'Not clocked in'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          <button
            type="button"
            onClick={onClockIn}
            disabled={busy || isClockedIn || isClockedOut}
            aria-label="Punch In"
            style={{
              padding: '14px 28px', fontSize: 16, fontWeight: 600,
              background: isClockedIn || isClockedOut ? '#ccc' : 'var(--primary-color, var(--accent-color))',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: (busy || isClockedIn || isClockedOut) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <LogIn size={18} aria-hidden /> Punch In
          </button>
          <button
            type="button"
            onClick={onClockOut}
            disabled={busy || !isClockedIn}
            aria-label="Punch Out"
            style={{
              padding: '14px 28px', fontSize: 16, fontWeight: 600,
              background: !isClockedIn ? '#ccc' : '#a01a1a',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: (busy || !isClockedIn) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <LogOut size={18} aria-hidden /> Punch Out
          </button>
        </div>
      </section>

      {/* My attendance history */}
      <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: 4 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={20} aria-hidden /> My attendance
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <DateRangeFilter value={dateFilter} onChange={setDateFilter} label={null} includeAllOption={false} />
          </div>
        </div>
        {dateFilter.preset === 'last30' && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginBottom: 12 }}>My Last 30 Days</div>
        )}
        {loading ? (
          <div>Loading&hellip;</div>
        ) : history.length === 0 ? (
          <div style={{ color: 'var(--text-secondary, #888)', padding: 20, textAlign: 'center' }}>No attendance rows yet. Clock in to get started.</div>
        ) : (
          <TopScrollSync>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Date</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Clock-in</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Clock-out</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Total</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Status</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Source</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => {
                const sc = statusClass(r.status);
                return (
                  <tr key={r.id}>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtDate(r.date)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtTime(r.clockInAt)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtTime(r.clockOutAt)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtMinutes(r.totalMinutes)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)', fontSize: 12, color: 'var(--text-secondary, #666)' }}>{r.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </section>

      {/* Manager-only: today's staff snapshot */}
      {isManager && <ManagerStaffSnapshot />}
    </div>
  );
}

function ManagerStaffSnapshot() {
  const notify = useNotify();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const todayKey = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const [exportFrom, setExportFrom] = useState(thirtyDaysAgo);
  const [exportTo, setExportTo] = useState(todayKey);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetchApi(`/api/attendance/summary?from=${todayKey}&to=${todayKey}`)
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onExport = async () => {
    setExporting(true);
    try {
      const data = await fetchApi(`/api/attendance/summary?from=${exportFrom}&to=${exportTo}`);
      const rows = Object.values((data && data.byUser) || {});
      const header = ['User ID', 'Days', 'Minutes', 'Late', 'Absent', 'Leaves'];
      const lines = [header.join(',')];
      for (const r of rows) {
        lines.push([
          r.userId ?? '',
          r.days ?? 0,
          r.minutes ?? 0,
          r.late ?? 0,
          r.absent ?? 0,
          r.leaves ?? 0,
        ].join(','));
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-${exportFrom}-to-${exportTo}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify.success(`Payroll CSV exported (${rows.length} rows)`);
    } catch (e) {
      const msg = e && e.body && e.body.error;
      notify.error(msg || 'Payroll CSV export failed');
    } finally {
      setExporting(false);
    }
  };

  // Zylu-spec KPI numbers — backend may not emit early/onTime yet; default to 0.
  const present = summary?.present || 0;
  const halfDay = summary?.halfDay || 0;
  const late = summary?.late || 0;
  const absent = summary?.absent || 0;
  const early = summary?.early || 0;
  const onTime = summary?.onTime || 0;
  const total = present + halfDay + late + absent;
  const totalMinutes = summary?.totalMinutes || 0;

  return (
    <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Users size={20} aria-hidden /> Today &mdash; All Staff
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)', display: 'flex', alignItems: 'center', gap: 4 }}>
            From
            <input
              type="date"
              aria-label="Payroll CSV from date"
              value={exportFrom}
              onChange={(e) => setExportFrom(e.target.value)}
              style={{ padding: '4px 6px' }}
            />
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)', display: 'flex', alignItems: 'center', gap: 4 }}>
            To
            <input
              type="date"
              aria-label="Payroll CSV to date"
              value={exportTo}
              onChange={(e) => setExportTo(e.target.value)}
              style={{ padding: '4px 6px' }}
            />
          </label>
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid var(--border-color, #ddd)',
              background: 'var(--surface-color, #fff)', color: 'var(--text-primary)',
              cursor: exporting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
            }}
          >
            Export Payroll CSV
          </button>
        </div>
      </div>
      {loading ? (
        <div>Loading&hellip;</div>
      ) : !summary ? (
        <div style={{ color: 'var(--text-secondary, #888)' }}>No data yet.</div>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 12, marginBottom: 16 }}>
            <Stat label="Total" value={total} />
            <Stat label="Absent" value={absent} />
            <Stat label="Present" value={present} />
            <Stat label="Early" value={early} />
            <Stat label="On-Time" value={onTime} />
            <Stat label="Late" value={late} />
            <Stat label="Half-day" value={halfDay} />
            <Stat label="Total minutes" value={totalMinutes} />
          </div>
          {Object.keys(summary.byUser || {}).length > 0 ? (
            <TopScrollSync>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>User</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Days</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Minutes</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(summary.byUser).map((u) => (
                  <tr key={u.userId}>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>User #{u.userId}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{u.days}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{u.minutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </TopScrollSync>
          ) : (
            <div style={{ color: 'var(--text-secondary, #888)' }}>Nobody clocked in today yet.</div>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background: 'var(--subtle-bg, #f7f7f7)', borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
