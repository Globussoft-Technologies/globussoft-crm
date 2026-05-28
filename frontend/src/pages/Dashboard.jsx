/**
 * Dashboard — generic CRM landing page (vertical=generic).
 *
 * KPI tiles (Closed Revenue, Expected Revenue, Total Contacts, Conversion
 * Rate, Total Deals) read from `/api/deals/stats` so the numbers reflect the
 * FULL tenant population, not a paginated window. The "Recent Deals" widget
 * legitimately wants the newest, so it pulls `/api/deals?limit=10`.
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
import React, { useState, useEffect, useContext } from 'react';
import { Users, DollarSign, Activity, Calendar, TrendingUp, CheckSquare } from 'lucide-react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';
import { formatMoney, formatMoneyCompact } from '../utils/money';
import { formatPercent } from '../utils/percent';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { useNavigate } from 'react-router-dom';

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

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useContext(AuthContext) || {};
  // Secure-by-default: when AuthContext hasn't populated `user` yet (a one-
  // frame race during the login → navigate handoff, or a unit-test render
  // without a provider), treat the viewer as a USER so the org-wide P&L
  // tiles never leak. Mirrors the Sidebar's `user?.role || "USER"` pattern
  // ([Sidebar.jsx:91]). A real ADMIN/MANAGER login carries `user.role`
  // explicitly and flips into the appropriate variant on the next render.
  const role = user?.role || 'USER';
  const isUser = role === 'USER';
  const isManager = role === 'MANAGER';
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [recentDeals, setRecentDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [myPendingTasks, setMyPendingTasks] = useState([]);

  useEffect(() => {
    // KPI numbers — full-population aggregates from the server.
    // For role=USER the backend auto-scopes to ownerId=userId, so the same
    // call produces personal-pipeline numbers without a query change here.
    fetchApi('/api/deals/stats')
      .then((d) => setStats({ ...DEFAULT_STATS, ...(d || {}) }))
      .catch(() => setStats(DEFAULT_STATS));
    // Row list for the Recent Deals widget — newest 10 only.
    fetchApi('/api/deals?limit=10&orderBy=createdAt:desc')
      .then((d) => setRecentDeals(Array.isArray(d) ? d : []))
      .catch(() => setRecentDeals([]));
    // Contacts tile only matters for ADMIN/MANAGER's org-wide view; skip the
    // fetch for USER role since their tile set replaces it with My Tasks.
    if (!isUser) {
      fetchApi('/api/contacts')
        .then((d) => setContacts(Array.isArray(d) ? d : []))
        .catch(() => setContacts([]));
    }
    // Personal pending-tasks list — drives the "My Pending Tasks" tile and
    // the right-rail widget on the USER variant. ?mine=true is the canonical
    // self-scope filter (backend/routes/tasks.js:98).
    if (isUser) {
      fetchApi('/api/tasks?mine=true&status=Pending&limit=10')
        .then((d) => setMyPendingTasks(Array.isArray(d) ? d : []))
        .catch(() => setMyPendingTasks([]));
    }
  }, [isUser]);

  // KPIs derived purely from `stats` (server aggregates), not from any list.
  const totalRevenue = stats.wonValue || 0;
  const expectedRevenue = stats.expectedValue || 0;
  const activeLeads = contacts.length;
  // #639 — keep the raw numeric so formatPercent renders a 1-decimal "0.0%"
  // consistently. Pre-fix this was Math.round-d to an integer and rendered
  // as bare "0%" / "12%", out of sync with Funnel + Reports which used 1dp.
  const conversionRate = stats.totalDeals
    ? ((stats.wonCount || 0) / stats.totalDeals) * 100
    : 0;
  const dealCount = stats.totalDeals || 0;

  // Pipeline Analytics chart — fed by the server-side byStage aggregation so
  // the chart reflects the full tenant, not a paginated slice. We map the
  // four headline stages and fall back to 0 when a stage is empty.
  const stageValue = (name) => {
    const row = (stats.byStage || []).find((r) => r.stage === name);
    return row ? row.value : 0;
  };
  const chartData = [
    { name: 'Lead', value: stageValue('lead') },
    { name: 'Contacted', value: stageValue('contacted') },
    { name: 'Proposal', value: stageValue('proposal') },
    { name: 'Won', value: stageValue('won') },
  ];

  // Role-aware label set. ADMIN/MANAGER see org/team framing on the same
  // numbers; USER sees personal framing + the contacts tile is swapped for a
  // "My Pending Tasks" tile (more actionable for an individual contributor).
  const pendingTaskCount = myPendingTasks.length;
  const tiles = isUser
    ? [
        { label: 'My Closed Revenue',   value: formatMoney(totalRevenue),     icon: <DollarSign size={24} />,   color: 'var(--accent-color)' },
        { label: 'My Expected Revenue', value: formatMoney(expectedRevenue),  icon: <Activity size={24} />,     color: 'var(--success-color)' },
        { label: 'My Pending Tasks',    value: pendingTaskCount.toString(),   icon: <CheckSquare size={24} />,  color: '#3b82f6' },
        { label: 'My Win Rate',         value: formatPercent(conversionRate), icon: <TrendingUp size={24} />,   color: 'var(--warning-color)' },
        { label: 'My Open Deals',       value: dealCount.toString(),          icon: <Calendar size={24} />,     color: '#a855f7' },
      ]
    : [
        { label: 'Closed Revenue',   value: formatMoney(totalRevenue),     icon: <DollarSign size={24} />,  color: 'var(--accent-color)' },
        { label: 'Expected Revenue', value: formatMoney(expectedRevenue),  icon: <Activity size={24} />,    color: 'var(--success-color)' },
        { label: 'Total Contacts',   value: activeLeads.toString(),        icon: <Users size={24} />,       color: '#3b82f6' },
        { label: 'Conversion Rate',  value: formatPercent(conversionRate), icon: <TrendingUp size={24} />,  color: 'var(--warning-color)' },
        { label: 'Total Deals',      value: dealCount.toString(),          icon: <Calendar size={24} />,    color: '#a855f7' },
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
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', background: 'linear-gradient(to right, var(--text-primary), var(--text-secondary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {pageTitle}
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {pageSubtitle} Press <kbd style={{background:'var(--kbd-bg)', padding:'2px 6px', borderRadius:'4px', color:'var(--accent-color)'}}>{shortcutKey} K</kbd> to search globally.
          </p>
        </div>
        {/* #128: this button only navigates — rename so the label matches the action */}
        <button className="btn-primary" onClick={() => navigate(ctaPath)}>{ctaLabel}</button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem', marginBottom: '2.5rem' }}>
        {tiles.map((stat, i) => (
          <div key={i} className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: stat.color, border: `1px solid ${stat.color}40`, boxShadow: `0 0 15px ${stat.color}40` }}>
              {stat.icon}
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>{stat.label}</p>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{stat.value}</h2>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '1.5rem' }}>
        <div className="card" style={{ padding: '2rem', minHeight: '350px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '500' }}>{isUser ? 'My Pipeline' : 'Pipeline Analytics'}</h3>
          </div>
          <div style={{ width: '100%', height: '260px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => formatMoneyCompact(value)} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--tooltip-bg)', backdropFilter: 'blur(8px)', borderColor: 'rgba(59, 130, 246, 0.5)', borderRadius: '8px' }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                />
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <Area type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card" style={{ padding: '2rem' }}>
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
