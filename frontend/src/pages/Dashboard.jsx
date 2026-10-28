/**
 * Dashboard — generic CRM landing page (vertical=generic).
 *
 * Deal KPI tiles read from `/api/deals/stats`, and Total Contacts reads from
 * `/api/contacts?count=1`, so neither total depends on a paginated row list.
 * The "Recent Deals" widget pulls `/api/deals?limit=10`.
 *
 * #567 fix: previously this page computed KPIs client-side by reducing over
 * `/api/deals?limit=100`. On large tenants (5,381 deals / 375 won / $5B
 * aggregate on demo), only 1 won deal sat in the newest-100 window →
 * "Closed Revenue $0" permanently. The split below lets the server compute
 * aggregates correctly while the client only paginates the row-list view
 * that genuinely needs paging.
 *
 * Role-aware variants: the page renders three label/widget sets driven by
 * `user.role` from AuthContext:
 *   - ADMIN   → "Enterprise Overview" (org-wide P&L, current behaviour)
 *   - MANAGER → "Team Overview" (same data, framed as team)
 *   - USER    → "My Work" (personal pipeline + my pending tasks tile)
 * Backend already auto-scopes `/api/deals/stats` and `/api/deals` to
 * `ownerId = req.user.userId` for role=USER (backend/routes/deals.js:57,98),
 * so swapping tile labels + adding a `/api/tasks?mine=true` widget is enough
 * to produce a coherent personal dashboard without any backend change.
 */
import { useState, useEffect, useContext, useRef, useMemo } from 'react';
import { Users, Activity, Calendar, TrendingUp, CheckSquare } from 'lucide-react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';
import { formatMoney, formatMoneyCompact, currencySymbol } from '../utils/money';
import { formatPercent } from '../utils/percent';
import { AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import CalendarRangePicker from '../components/CalendarRangePicker';
import { readDateRange, setDateRangeParams, pathWithDateRange, readSavedDashboardFilter, saveDashboardFilter } from '../utils/dateRangeNavigation';
import './Dashboard.css';

const DEFAULT_STATS = {
  totalDeals: 0,
  totalValue: 0,
  wonCount: 0,
  wonValue: 0,
  lostCount: 0,
  lostValue: 0,
  expectedValue: 0,
  winRate: 0,
  byStage: [],
};

const DASHBOARD_DATE_PRESETS = [
  ['all', 'All time'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'],
  ['thisQuarter', 'This quarter'], ['lastQuarter', 'Last quarter'],
];

function dateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dashboardPresetRange(preset, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === 'all') return { from: '', to: '' };
  if (preset === 'last30') return { from: dateValue(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)), to: dateValue(today) };
  if (preset === 'thisQuarter') {
    const startMonth = Math.floor(today.getMonth() / 3) * 3;
    return { from: dateValue(new Date(today.getFullYear(), startMonth, 1)), to: dateValue(today) };
  }
  if (preset === 'lastQuarter') {
    const startMonth = Math.floor(today.getMonth() / 3) * 3;
    return { from: dateValue(new Date(today.getFullYear(), startMonth - 3, 1)), to: dateValue(new Date(today.getFullYear(), startMonth, 0)) };
  }
  return { from: dateValue(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)), to: dateValue(today) };
}

function dashboardStageLabel(stage) {
  return String(stage || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .replace(/^Closed /, '') || 'Other';
}

function dashboardPresetForRange(range) {
  return DASHBOARD_DATE_PRESETS.find(([preset]) => {
    const candidate = dashboardPresetRange(preset);
    return candidate.from === range.from && candidate.to === range.to;
  })?.[0] || 'custom';
}

function isClosedDashboardStage(stage) {
  const key = String(stage || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
  return key === 'won' || key === 'closed-won' || key === 'lost' || key === 'closed-lost';
}

function isLostDashboardStage(stage) {
  const key = String(stage || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
  return key === 'lost' || key === 'closed-lost';
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, tenant } = useContext(AuthContext) || {};
  const currency = tenant?.defaultCurrency || 'USD';
  const locale = tenant?.locale || (currency === 'INR' ? 'en-IN' : 'en-US');
  const moneyOptions = { currency, locale };
  const revenueIcon = <span aria-hidden="true" style={{ fontSize: 24, fontWeight: 700 }}>{currencySymbol(currency)}</span>;
  // Secure-by-default: when AuthContext hasn't populated `user` yet (a one-
  // frame race during the login → navigate handoff, or a unit-test render
  // without a provider), treat the viewer as a USER so the org-wide P&L
  // tiles never leak. Mirrors the Sidebar's `user?.role || "USER"` pattern
  // ([Sidebar.jsx:91]). A real ADMIN/MANAGER login carries `user.role`
  // explicitly and flips into the appropriate variant on the next render.
  const role = user?.role || 'USER';
  const isUser = role === 'USER';
  const isManager = role === 'MANAGER';
  const dashboardStorageScope = useMemo(() => ({ tenantId: tenant?.id ?? tenant?.tenantId, userId: user?.id ?? user?.userId }), [tenant?.id, tenant?.tenantId, user?.id, user?.userId]);
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [recentDeals, setRecentDeals] = useState([]);
  const [contactCount, setContactCount] = useState(0);
  const [myPendingTasks, setMyPendingTasks] = useState([]);
  const [dashboardTasks, setDashboardTasks] = useState([]);
  const [attributionStats, setAttributionStats] = useState({ byChannel: [] });
  const [allTimeExpectedRevenue, setAllTimeExpectedRevenue] = useState(undefined);
  const [dashboardDateRange, setDashboardDateRange] = useState(() => {
    const range = readDateRange(searchParams);
    return range.from || range.to ? range : readSavedDashboardFilter(dashboardStorageScope)?.range || { from: '', to: '' };
  });
  const [datePreset, setDatePreset] = useState(() => {
    const range = readDateRange(searchParams);
    return range.from || range.to ? dashboardPresetForRange(range) : readSavedDashboardFilter(dashboardStorageScope)?.preset || 'all';
  });
  const [calendarOpenRequest, setCalendarOpenRequest] = useState(0);
  const pipelineChartRef = useRef(null);
  const [pipelineChartWidth, setPipelineChartWidth] = useState(900);
  useEffect(() => {
    const range = readDateRange(searchParams);
    if (range.from || range.to) {
      setDatePreset(dashboardPresetForRange(range));
      setDashboardDateRange(range);
      return;
    }
    const saved = readSavedDashboardFilter(dashboardStorageScope);
    setDatePreset(saved?.preset || 'all');
    setDashboardDateRange(saved?.range || { from: '', to: '' });
  }, [dashboardStorageScope, searchParams]);
  useEffect(() => {
    const element = pipelineChartRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const updateWidth = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      if (width > 0) setPipelineChartWidth(width);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const updateDateRange = (range) => {
    setDatePreset('custom');
    setDashboardDateRange(range);
    saveDashboardFilter(dashboardStorageScope, { preset: 'custom', range });
    setSearchParams(setDateRangeParams(searchParams, range), { replace: true });
  };
  const dateQuery = dashboardDateRange.from || dashboardDateRange.to
    ? `${dashboardDateRange.from ? `&from=${encodeURIComponent(dashboardDateRange.from)}` : ''}${dashboardDateRange.to ? `&to=${encodeURIComponent(`${dashboardDateRange.to}T23:59:59.999Z`)}` : ''}`
    : '';

  useEffect(() => {
    let active = true;
    // KPI numbers — full-population aggregates from the server.
    // For role=USER the backend auto-scopes to ownerId=userId, so the same
    // call produces personal-pipeline numbers without a query change here.
    fetchApi(`/api/deals/stats?currency=${encodeURIComponent(currency)}${dateQuery}`)
      .then((d) => {
        if (!active) return;
        setStats({ ...DEFAULT_STATS, ...(d || {}) });
        if (!dateQuery) setAllTimeExpectedRevenue(d?.expectedValue);
      })
      .catch(() => { if (active) setStats(DEFAULT_STATS); });
    // Expected Revenue is intentionally independent of the dashboard date
    // filter: it represents the current all-time pending/open forecast.
    if (dateQuery) {
      fetchApi(`/api/deals/stats?currency=${encodeURIComponent(currency)}`)
        .then((d) => { if (active) setAllTimeExpectedRevenue(d?.expectedValue); })
        .catch(() => { if (active) setAllTimeExpectedRevenue(undefined); });
    }
    // Row list for the Recent Deals widget — newest 10 only.
    fetchApi(`/api/deals?limit=10&orderBy=createdAt:desc${dateQuery}`)
      .then((d) => { if (active) setRecentDeals(Array.isArray(d) ? d : []); })
      .catch(() => { if (active) setRecentDeals([]); });
    // Count contacts created in the selected period, not just the API's
    // default first page of 100. USER's tile set replaces this with My Tasks.
    if (!isUser) {
      fetchApi(`/api/contacts?count=1${dateQuery}`)
        .then((d) => setContactCount(Number.isFinite(d?.total) ? d.total : 0))
        .catch(() => setContactCount(0));
      fetchApi(`/api/attribution/stats${dateQuery ? `?${dateQuery.slice(1)}` : ''}`)
        .then((d) => setAttributionStats({ byChannel: Array.isArray(d?.byChannel) ? d.byChannel : [] }))
        .catch(() => setAttributionStats({ byChannel: [] }));
    }
    // Personal pending-tasks list — drives the "My Pending Tasks" tile and
    // the right-rail widget on the USER variant. ?mine=true is the canonical
    // self-scope filter (backend/routes/tasks.js:98).
    if (isUser) {
      fetchApi('/api/tasks?mine=true&status=Pending&limit=10')
        .then((d) => setMyPendingTasks(Array.isArray(d) ? d : []))
        .catch(() => setMyPendingTasks([]));
    } else {
      fetchApi('/api/tasks?status=Pending&limit=5')
        .then((d) => setDashboardTasks(Array.isArray(d) ? d : []))
        .catch(() => setDashboardTasks([]));
    }
    return () => { active = false; };
  }, [isUser, currency, dateQuery]);

  // KPIs derived purely from `stats` (server aggregates), not from any list.
  const totalRevenue = stats.wonValue;
  const expectedRevenue = allTimeExpectedRevenue !== undefined ? allTimeExpectedRevenue : stats.expectedValue;
  const displayRevenue = (value) => value === null ? 'Unavailable' : formatMoneyCompact(value, moneyOptions);
  // #639 — keep the raw numeric so formatPercent renders a 1-decimal "0.0%"
  // consistently. Pre-fix this was Math.round-d to an integer and rendered
  // as bare "0%" / "12%", out of sync with Funnel + Reports which used 1dp.
  const conversionRate = stats.totalDeals
    ? ((stats.wonCount || 0) / stats.totalDeals) * 100
    : 0;
  const dealCount = stats.totalDeals || 0;
  const openDealCount = Math.max(0, dealCount - (stats.wonCount || 0) - (stats.lostCount || 0));

  // Pipeline Analytics uses probability-weighted values for open stages, and
  // the actual closed value for Won. Lost is excluded from the forecast view.
  const chartData = (Array.isArray(stats.byStage) ? stats.byStage : [])
    .filter((row) => !isLostDashboardStage(row.stage))
    .map((row) => ({
      name: dashboardStageLabel(row.stage),
      // Older API deployments expose only byStage.value. Prefer the
      // probability-weighted stage forecast when present, but do not turn
      // the chart blank while a compatible backend is being rolled out.
      value: isClosedDashboardStage(row.stage)
        ? Number(row.value) || 0
        : row.expectedValue !== null && row.expectedValue !== undefined && Number.isFinite(Number(row.expectedValue))
        ? Number(row.expectedValue)
        : Number(row.value) || 0,
    }))
    .filter((row) => row.name !== 'Other' || row.value > 0);
  const hasPipelineData = chartData.some((row) => row.value > 0);

  // Role-aware label set. ADMIN/MANAGER see org/team framing on the same
  // numbers; USER sees personal framing + the contacts tile is swapped for a
  // "My Pending Tasks" tile (more actionable for an individual contributor).
  const pendingTaskCount = myPendingTasks.length;
  const focusTasks = isUser ? myPendingTasks : dashboardTasks;
  const revenueTarget = Number(tenant?.settings?.revenueTarget || tenant?.revenueTarget || 0);
  const revenueProgressTarget = revenueTarget > 0 ? revenueTarget : Math.max(0, totalRevenue + expectedRevenue);
  const revenueProgress = revenueProgressTarget > 0 ? Math.min(100, (totalRevenue / revenueProgressTarget) * 100) : 0;
  const leadChannels = (attributionStats.byChannel || []).slice(0, 4);
  const maxLeadChannelCount = Math.max(1, ...leadChannels.map((row) => Number(row.count) || 0));
  const tiles = isUser
    ? [
        { label: 'My Closed Revenue', value: displayRevenue(totalRevenue), icon: revenueIcon, color: 'var(--accent-color)', path: '/reports', },
      {
        label: 'My Expected Revenue', value: displayRevenue(expectedRevenue), icon: <Activity size={24} />, color: 'var(--success-color)',
        path: '/pipeline',
      },
      {
        label: 'My Pending Tasks', value: pendingTaskCount.toString(), icon: <CheckSquare size={24} />, color: '#3b82f6',
        path: '/tasks',
      },
      {
        label: 'My Win Rate', value: formatPercent(stats.winRate || 0), icon: <TrendingUp size={24} />, color: 'var(--warning-color)',
        path: '/reports',
      },
      {
        label: 'My Open Deals', value: openDealCount.toString(), icon: <Calendar size={24} />, color: '#a855f7',
        path: '/pipeline',
      },
    ]
    : [
      {
        label: 'Closed Revenue', value: displayRevenue(totalRevenue), icon: revenueIcon, color: 'var(--accent-color)',
        path: '/reports',
      },
      {
        label: 'Expected Revenue', value: displayRevenue(expectedRevenue), icon: <Activity size={24} />, color: 'var(--success-color)',
        path: '/pipeline',
      },
      {
        label: 'Total Contacts', value: contactCount.toLocaleString(), icon: <Users size={24} />, color: '#3b82f6',
        path: '/contacts',
      },
      {
        label: 'Conversion Rate', value: formatPercent(conversionRate), icon: <TrendingUp size={24} />, color: 'var(--warning-color)',
        path: '/reports',
      },
      {
        label: 'Total Deals', value: dealCount.toString(), icon: <Calendar size={24} />, color: '#a855f7',
        path: '/pipeline',
      },
    ];

  // Header copy varies by role. We keep the same chrome (gradient h1, search
  // hint, primary CTA) so the visual hierarchy doesn't shift between roles.
  const pageTitle = isUser ? 'My Work' : isManager ? 'Team Overview' : 'Enterprise Overview';
  const pageSubtitle = isUser
    ? "Your pipeline at a glance."
    : isManager
      ? "Your team's pipeline at a glance."
      : "Here's your business at a glance.";
  const ctaLabel = isUser ? 'My Tasks' : 'View Reports';
  const ctaPath = isUser ? '/tasks' : '/reports';

  // #128: Cmd-K is macOS; show Ctrl-K on Windows/Linux. navigator.platform is
  // deprecated but still the most-supported way to detect this client-side.
  const isMac = typeof navigator !== 'undefined' &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
  const shortcutKey = isMac ? 'Cmd' : 'Ctrl';

  return (
    <div className="dashboard-page" style={{ padding: 0, width: '100%', minWidth: 0, boxSizing: 'border-box', animation: 'fadeIn 0.5s ease-out' }}>
      <header data-tour="dashboard-header" style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', background: 'linear-gradient(to right, var(--text-primary), var(--text-secondary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {pageTitle}
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {pageSubtitle} Press <kbd style={{ background: 'var(--kbd-bg)', padding: '2px 6px', borderRadius: '4px', color: 'var(--accent-color)' }}>{shortcutKey} K</kbd> to search globally.
          </p>
        </div>
        {/* #128: this button only navigates — rename so the label matches the action */}
        <div className="dashboard-header-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '0.75rem', marginLeft: 'auto', maxWidth: '100%' }}>
          <select aria-label="Dashboard date preset" value={datePreset} onChange={(event) => {
            const preset = event.target.value;
            setDatePreset(preset);
            if (preset === 'custom') {
              setCalendarOpenRequest((request) => request + 1);
              saveDashboardFilter(dashboardStorageScope, { preset, range: dashboardDateRange });
            } else {
              const range = dashboardPresetRange(preset);
              setDashboardDateRange(range);
              saveDashboardFilter(dashboardStorageScope, { preset, range });
              setSearchParams(setDateRangeParams(searchParams, range), { replace: true });
            }
          }} className="input-field dashboard-date-preset" style={{ width: 150, height: 38, minWidth: 0, maxWidth: '100%', flex: '0 0 150px', boxSizing: 'border-box', padding: '0 12px', lineHeight: 'normal', cursor: 'pointer', fontSize: 13 }}>
            {DASHBOARD_DATE_PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            <option value="custom">Custom range</option>
          </select>
          <CalendarRangePicker value={dashboardDateRange} onChange={updateDateRange} label="Dashboard date range" align="right" compact width={190} height={38} openRequest={calendarOpenRequest} />
          <button className="btn-primary" onClick={() => navigate(ctaPath)}>{ctaLabel}</button>
        </div>
      </header>

      {stats.fx?.missingRateCount > 0 && (
        <p role="alert" style={{ color: 'var(--warning-color)', marginBottom: '1rem' }}>
          {stats.fx.missingRateCount} deal(s) have no exchange rate for {currency}. Affected revenue totals are unavailable.
        </p>
      )}

      <div className="dashboard-kpis" data-tour="dashboard-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem', marginBottom: '2.5rem' }}>
        {tiles.map((stat, i) => (
          <Link key={i}
            to={(stat.path === '/pipeline' || stat.path === '/reports') && !stat.label.includes('Expected Revenue') ? pathWithDateRange(stat.path, dashboardDateRange) : stat.path}
            style={{
              textDecoration: 'none',
              color: 'inherit',
              display: 'block',
            }}>
            <div className="card dashboard-kpi-card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: stat.color, border: `1px solid ${stat.color}40`, boxShadow: `0 0 15px ${stat.color}40` }}>
                {stat.icon}
              </div>
              <div className="dashboard-kpi-copy" style={{ minWidth: 0, flex: 1 }}>
                <p title={stat.label} style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>{stat.label}</p>
                <h2 title={stat.label.includes('Revenue') && stat.value !== 'Unavailable' ? formatMoney(stat.label.includes('Expected') ? expectedRevenue : totalRevenue, moneyOptions) : stat.value} style={{ fontSize: 'clamp(1.15rem, 1.5vw, 1.5rem)', fontWeight: 'bold', lineHeight: 1.2, overflowWrap: 'anywhere' }}>{stat.value}</h2>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="dashboard-panels" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '1.5rem' }}>
        <div className="card dashboard-pipeline-card" data-tour="dashboard-pipeline" style={{ padding: '2rem', minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '500' }}>{isUser ? 'My Pipeline' : 'Pipeline Analytics'}</h3>
          </div>
          <div ref={pipelineChartRef} className="dashboard-pipeline-chart" style={{ width: '100%', height: '260px', minWidth: 0, minHeight: '260px' }}>
            {!hasPipelineData ? (
              <div className="dashboard-empty-copy" style={{ display: 'grid', height: '100%', placeItems: 'center', textAlign: 'center' }}>
                Pipeline stage values are not available for this range.
              </div>
            ) : <AreaChart width={pipelineChartWidth} height={260} style={{ width: '100%', height: '260px' }} data={chartData} margin={{ top: 10, right: 80, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                {/* INR crore labels can be much wider than the default axis,
                    especially for large pipelines (for example ₹3,800.00Cr).
                    Reserve enough room so Recharts does not clip the leading
                    digits and currency symbol. */}
                <YAxis width={88} stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value) => formatMoneyCompact(value, moneyOptions)} />
                <Tooltip
                  allowEscapeViewBox={{ x: false, y: false }}
                  wrapperStyle={{ zIndex: 20, pointerEvents: 'none', maxWidth: 'calc(100% - 8px)' }}
                  contentStyle={{ backgroundColor: 'var(--tooltip-bg)', backdropFilter: 'blur(8px)', borderColor: 'rgba(59, 130, 246, 0.5)', borderRadius: '8px', fontSize: '14px', lineHeight: 1.4, minWidth: '130px', padding: '10px 12px' }}
                  labelStyle={{ color: 'var(--text-primary)', fontSize: '13px', marginBottom: '4px' }}
                  itemStyle={{ color: 'var(--text-primary)', fontSize: '14px' }}
                  formatter={(value) => formatMoney(value, moneyOptions)}
                />
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <Area type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
              </AreaChart>}
          </div>
        </div>

        <div className="card dashboard-recent-card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '500', marginBottom: '1.5rem' }}>
            {isUser ? 'My Pending Tasks' : 'Recent Deals'}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {isUser ? (
              <>
                {myPendingTasks.slice(0, 4).map((task) => (
                  <div
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate('/tasks')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/tasks'); } }}
                    className="table-row-hover"
                    style={{ display: 'flex', alignItems: 'center', gap: '1rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '8px', userSelect: 'none' }}
                    title={`Open task: ${task.title}`}
                  >
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: task.priority === 'Critical' ? 'var(--danger-color)' : 'var(--accent-color)', boxShadow: `0 0 8px ${task.priority === 'Critical' ? 'var(--danger-color)' : 'var(--accent-color)'}` }} />
                    <div>
                      <p style={{ fontSize: '0.875rem', fontWeight: '500' }}>{task.title}</p>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        Priority: {(task.priority || 'Normal').toUpperCase()}
                        {task.dueDate ? ` • Due ${new Date(task.dueDate).toLocaleDateString()}` : ''}
                      </p>
                    </div>
                  </div>
                ))}
                {myPendingTasks.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No pending tasks. 🎉</p>}
              </>
            ) : (
              <>
                {recentDeals.slice(0, 4).map((deal) => (
                  // #466: row was wrapped in a div with onClick → navigate('/pipeline')
                  // but reporters experienced it as "not clickable" because the
                  // hand-cursor only appeared on the inner text, not on the gap
                  // between bullet and label, and the destination was a generic
                  // pipeline page with no context for the clicked deal. Switch to a
                  // role="button" with explicit cursor:pointer covering the entire
                  // row, pass the deal id via ?dealId so Pipeline can scroll/focus.
                  <div
                    key={deal.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/pipeline?dealId=${deal.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/pipeline?dealId=${deal.id}`); } }}
                    className="table-row-hover"
                    style={{ display: 'flex', alignItems: 'center', gap: '1rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '8px', userSelect: 'none' }}
                    title={`Open ${deal.title} in pipeline`}
                  >
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)', boxShadow: `0 0 8px ${deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)'}` }} />
                    <div>
                      <p style={{ fontSize: '0.875rem', fontWeight: '500' }}>{deal.title}</p>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Status: {deal.stage.toUpperCase()}</p>
                    </div>
                  </div>
                ))}
                {recentDeals.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No deals in pipeline.</p>}
              </>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
