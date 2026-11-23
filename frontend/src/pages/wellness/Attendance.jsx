// Wave 2 Agent JJ — Staff Attendance page (Google Doc audit, 8 May 2026).
//
// Layout:
//   - Today's punch card and working summary share the top row.
//   - Personal history and the manager-only team summary use separate tabs.
//   - Plain users only see their own attendance view.
//
// Uses /api/attendance/* endpoints. Dual-vertical (works under both wellness
// and generic verticals); the route is mounted at /wellness/attendance for
// the wellness sidebar but the page itself doesn't gate on tenant.vertical.
import { useEffect, useState, useContext } from 'react';
import { Clock, LogIn, LogOut, Calendar, Users, Upload } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import { DateRangeFilter, DateRangeModal, resolveDateRangeYmd } from '../../components/wellness/DateRangeFilter';
import TopScrollSync from '../../components/TopScrollSync';
import './Attendance.css';

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

function formatDateRangeLabel(from, to) {
  const format = (value) => new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${format(from)} – ${format(to)}`;
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
  const { user, tenant } = useContext(AuthContext) || {};
  const isManager = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const isWellnessTenant = tenant?.vertical === 'wellness';
  const [attendanceView, setAttendanceView] = useState('mine');

  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [geofenceLoading, setGeofenceLoading] = useState(isWellnessTenant);
  const [geofenceEnabled, setGeofenceEnabled] = useState(false);
  const [locationPermission, setLocationPermission] = useState('unknown');
  const [permissionLoading, setPermissionLoading] = useState(false);
  // Attendance requires a window — opt out of "All time" and default to last30
  // (matches the prior 30-day default).
  const [dateFilter, setDateFilter] = useState({ preset: 'last30', start: '', end: '' });
  const [from, to] = resolveDateRangeYmd(dateFilter);

  // Today's row (clockInAt/clockOutAt) — derived from history's first row.
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayRow = history.find((r) => (r.date || '').slice(0, 10) === todayKey) || null;
  const isClockedIn = todayRow && todayRow.clockInAt && !todayRow.clockOutAt;
  const isClockedOut = todayRow && todayRow.clockOutAt;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonthHistory = history.filter((r) => String(r.date || '').slice(0, 7) === currentMonth);
  const getMinutesTotal = (rows) => rows.reduce((sum, row) => sum + (Number(row.totalMinutes) || 0), 0);
  const visibleMinutes = getMinutesTotal(history);
  const monthMinutes = getMinutesTotal(thisMonthHistory);
  const attendanceDays = new Set(history.map((r) => String(r.date || '').slice(0, 10)).filter(Boolean)).size;
  const averageMinutes = attendanceDays ? Math.round(visibleMinutes / attendanceDays) : 0;
  const countStatus = (statuses) => history.filter((r) => statuses.includes(String(r.status || '').toUpperCase())).length;

  const load = () => {
    if (!from || !to) return;
    setLoading(true);
    fetchApi(`/api/attendance/me?from=${from}&to=${to}`)
      .then((rows) => setHistory(Array.isArray(rows) ? rows : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [from, to]);

  useEffect(() => {
    if (!isWellnessTenant) {
      setGeofenceEnabled(false);
      setGeofenceLoading(false);
      return undefined;
    }

    let active = true;
    setGeofenceLoading(true);
    fetchApi('/api/attendance/context')
      .then((data) => {
        if (!active) return;
        setGeofenceEnabled(Boolean(data?.geofence?.enabled));
      })
      .catch(() => {
        if (active) setGeofenceEnabled(false);
      })
      .finally(() => {
        if (active) setGeofenceLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isWellnessTenant]);

  useEffect(() => {
    if (!isWellnessTenant || !geofenceEnabled) {
      setLocationPermission('unknown');
      setPermissionLoading(false);
      return undefined;
    }
    if (!('geolocation' in navigator)) {
      setLocationPermission('unsupported');
      setPermissionLoading(false);
      return undefined;
    }
    if (!navigator.permissions?.query) {
      setLocationPermission('unknown');
      setPermissionLoading(false);
      return undefined;
    }

    let active = true;
    let permissionStatusRef = null;
    setPermissionLoading(true);
    const syncPermission = () => {
      if (active && permissionStatusRef) {
        setLocationPermission(permissionStatusRef.state || 'unknown');
        setPermissionLoading(false);
      }
    };

    navigator.permissions.query({ name: 'geolocation' })
      .then((permissionStatus) => {
        if (!active) return;
        permissionStatusRef = permissionStatus;
        syncPermission();
        permissionStatus.onchange = syncPermission;
      })
      .catch(() => {
        if (active) {
          setLocationPermission('unknown');
          setPermissionLoading(false);
        }
      });

    return () => {
      active = false;
      if (permissionStatusRef) permissionStatusRef.onchange = null;
    };
  }, [isWellnessTenant, geofenceEnabled]);

  const showLocationStatus = isWellnessTenant && (geofenceLoading || (geofenceEnabled && permissionLoading));
  const locationDenied = geofenceEnabled && locationPermission === 'denied';
  const showLocationWarning = geofenceEnabled && (locationPermission === 'denied' || locationPermission === 'prompt');

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
    <div className="wellness-attendance-page">
      <header className="attendance-page-header">
        <div>
          <h1><Clock size={27} aria-hidden="true" /> Attendance</h1>
          <p>Track attendance, working hours and team records.</p>
        </div>
        <div className="attendance-page-date">
          <Calendar size={16} aria-hidden="true" />
          Today, {now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ({now.toLocaleDateString(undefined, { weekday: 'short' })})
        </div>
      </header>

      <div className="attendance-overview-grid">
      {/* Today's punch card */}
      <section className="attendance-today-card" aria-labelledby="attendance-today-title">
        <div className="attendance-today-heading">
          <div>
            <h2 id="attendance-today-title">Today, {now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</h2>
          </div>
          <span className={`attendance-shift-status${isClockedIn ? ' is-active' : isClockedOut ? ' is-complete' : ''}`}>
            {isClockedIn ? 'Clocked in' : isClockedOut ? 'Clocked out' : 'Not clocked in'}
          </span>
        </div>

        <div className="attendance-today-metrics">
          <div className="attendance-today-metric">
            <span>Clock-in</span>
            <strong>{fmtTime(todayRow?.clockInAt)}</strong>
          </div>
          <div className="attendance-today-metric">
            <span>Clock-out</span>
            <strong>{fmtTime(todayRow?.clockOutAt)}</strong>
          </div>
          <div className="attendance-today-metric">
            <span>Total hours</span>
            <strong>{fmtMinutes(todayRow?.totalMinutes)}</strong>
          </div>
        </div>

        <div className="attendance-today-footer">
          {showLocationStatus && (
            <div className="attendance-location-note">Checking attendance location requirements...</div>
          )}
          {showLocationWarning && (
            <div
              role="alert"
              className={`attendance-location-warning${locationDenied ? ' is-denied' : ''}`}
            >
              {locationDenied ? (
                <>
                  <div>Location access is turned off. Enable location permission to mark attendance for wellness geofencing.</div>
                  <div className="attendance-location-help">To re-enable it, open your browser or device site settings and turn Location back on for this app.</div>
                </>
              ) : 'Location access will be requested when you mark attendance. Please allow it so wellness geofencing can verify your location.'}
            </div>
          )}
          <div className="attendance-punch-actions">
            <button
              type="button"
              className="attendance-punch-in"
              onClick={onClockIn}
              disabled={busy || isClockedIn || isClockedOut || locationDenied}
              aria-label="Punch In"
            >
              <LogIn size={17} aria-hidden /> Punch In
            </button>
            <button
              type="button"
              className="attendance-punch-out"
              onClick={onClockOut}
              disabled={busy || !isClockedIn || locationDenied}
              aria-label="Punch Out"
            >
              <LogOut size={17} aria-hidden /> Punch Out
            </button>
          </div>
        </div>
      </section>

      <section className="attendance-working-summary" aria-labelledby="attendance-working-summary-title">
        <h2 id="attendance-working-summary-title">Working Summary</h2>
        <dl>
          <div><dt>{dateFilter.preset === 'last30' ? `This Month (${now.toLocaleDateString(undefined, { month: 'short' })})` : 'This Month (selected period)'}</dt><dd>{fmtMinutes(monthMinutes)}</dd></div>
          <div><dt>{dateFilter.preset === 'last30' ? 'Last 30 Days' : 'Selected Period'}</dt><dd>{fmtMinutes(visibleMinutes)}</dd></div>
          <div><dt>Average per Day</dt><dd>{fmtMinutes(averageMinutes)}</dd></div>
        </dl>
      </section>
      </div>

      {/* My attendance history */}
      {isManager && (
        <div className="attendance-view-tabs" role="tablist" aria-label="Attendance views">
          <button id="attendance-tab-mine" type="button" role="tab" aria-selected={attendanceView === 'mine'} aria-controls="attendance-panel-mine" onClick={() => setAttendanceView('mine')}>
            <Calendar size={16} aria-hidden="true" /> My attendance
          </button>
          <button id="attendance-tab-team" type="button" role="tab" aria-selected={attendanceView === 'team'} aria-controls="attendance-panel-team" onClick={() => setAttendanceView('team')}>
            <Users size={16} aria-hidden="true" /> All Staff
          </button>
        </div>
      )}
      <section
        id="attendance-panel-mine"
        className="attendance-tab-panel"
        role={isManager ? 'tabpanel' : undefined}
        aria-labelledby={isManager ? 'attendance-tab-mine' : undefined}
        hidden={isManager && attendanceView !== 'mine'}
      >
        <section className="attendance-panel attendance-personal-overview">
          <div className="attendance-panel-header">
            <h2>My Attendance Overview</h2>
            <DateRangeFilter value={dateFilter} onChange={setDateFilter} label={null} includeAllOption={false} />
          </div>
          <div className="attendance-personal-stats">
            <div><strong>{countStatus(['PRESENT'])}</strong><span>Present</span></div>
            <div><strong>{countStatus(['ABSENT'])}</strong><span>Absent</span></div>
            <div><strong>{countStatus(['LATE'])}</strong><span>Late</span></div>
            <div><strong>{countStatus(['HALF_DAY'])}</strong><span>Half-day</span></div>
            <div><strong>{countStatus(['EARLY'])}</strong><span>Early</span></div>
            <div><strong>{visibleMinutes}</strong><span>Total Minutes</span></div>
          </div>
        </section>

        <section className="attendance-panel attendance-history-panel">
          <div className="attendance-panel-header">
            <div>
              <h2><Calendar size={19} aria-hidden="true" /> Attendance History</h2>
              <p>{dateFilter.preset === 'last30' ? 'My Last 30 Days' : 'Selected attendance period'}</p>
            </div>
          </div>
        {loading ? (
          <div className="attendance-empty-state" role="status">Loading&hellip;</div>
        ) : history.length === 0 ? (
          <div className="attendance-empty-state">No attendance rows yet. Clock in to get started.</div>
        ) : (
          <TopScrollSync>
          <table className="attendance-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Clock-in</th>
                <th>Clock-out</th>
                <th>Total</th>
                <th>Status</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => {
                const sc = statusClass(r.status);
                return (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date)}</td>
                    <td>{fmtTime(r.clockInAt)}</td>
                    <td>{fmtTime(r.clockOutAt)}</td>
                    <td>{fmtMinutes(r.totalMinutes)}</td>
                    <td>
                      <span className="attendance-status-badge" style={{ background: sc.bg, color: sc.color }}>
                        {r.status}
                      </span>
                    </td>
                    <td>{r.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </TopScrollSync>
        )}
        </section>
      </section>

      {/* Manager-only: today's staff snapshot */}
      {isManager && (
        <div
          id="attendance-panel-team"
          role="tabpanel"
          aria-labelledby="attendance-tab-team"
          hidden={attendanceView !== 'team'}
        >
          <ManagerStaffSnapshot />
        </div>
      )}
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
  const [exportDatePickerOpen, setExportDatePickerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchApi(`/api/attendance/summary?from=${exportFrom}&to=${exportTo}`)
      .then((data) => { if (active) setSummary(data); })
      .catch(() => { if (active) setSummary(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [exportFrom, exportTo]);

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

  // Attendance summary for the date range selected above.
  const present = summary?.present || 0;
  const halfDay = summary?.halfDay || 0;
  const late = summary?.late || 0;
  const absent = summary?.absent || 0;
  const early = summary?.early || 0;
  const onTime = summary?.onTime || 0;
  const total = summary?.totalRows ?? (present + halfDay + late + absent);
  const totalMinutes = summary?.totalMinutes || 0;

  return (
    <section className="attendance-panel attendance-team-panel">
      <div className="attendance-panel-header attendance-team-header">
        <div>
          <h2><Users size={19} aria-hidden="true" /> All Staff — Selected Period</h2>
          <p>Team attendance totals and payroll records for this period.</p>
        </div>
        <div className="attendance-team-actions">
          <button
            type="button"
            className="attendance-secondary-button"
            onClick={() => setExportDatePickerOpen(true)}
            aria-label="Select payroll date range"
          >
            <Calendar size={14} aria-hidden />
            {formatDateRangeLabel(exportFrom, exportTo)}
          </button>
          <button
            type="button"
            className="attendance-secondary-button"
            onClick={onExport}
            disabled={exporting}
          >
            <Upload size={14} /> Export Payroll CSV
          </button>
        </div>
      </div>
      {exportDatePickerOpen && (
        <DateRangeModal
          initialStart={exportFrom}
          initialEnd={exportTo}
          onClose={() => setExportDatePickerOpen(false)}
          onSave={(start, end) => {
            setExportFrom(start);
            setExportTo(end);
            setExportDatePickerOpen(false);
          }}
        />
      )}
      {loading ? (
        <div className="attendance-empty-state" role="status">Loading&hellip;</div>
      ) : !summary ? (
        <div className="attendance-empty-state">No data yet.</div>
      ) : (
        <div>
          <div className="attendance-summary-grid">
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
            <table className="attendance-table attendance-team-table">
              <thead>
                <tr>
                  <th>Staff member</th>
                  <th>Days</th>
                  <th>Minutes</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(summary.byUser)
                  .sort((a, b) => String(a.name || a.email || a.userId).localeCompare(String(b.name || b.email || b.userId)))
                  .map((u) => (
                  <tr key={u.userId}>
                    <td>
                      <div>{u.name || u.email || `User #${u.userId}`}</div>
                      {u.name && u.email && (
                        <div className="attendance-staff-email">{u.email}</div>
                      )}
                    </td>
                    <td>{u.days}</td>
                    <td>{u.minutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </TopScrollSync>
          ) : (
            <div className="attendance-empty-state attendance-team-empty">
              {exportFrom === todayKey && exportTo === todayKey
                ? 'Nobody clocked in today yet.'
                : 'No attendance rows for the selected period.'}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="attendance-summary-stat">
      <div>{label}</div>
      <strong>{value}</strong>
    </div>
  );
}
