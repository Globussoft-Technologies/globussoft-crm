import React, { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';
import {
  Activity, AlertTriangle, BarChart3, CalendarCheck, GitBranch,
  MapPin, Plus, RefreshCw, Save, Target, Trash2, TrendingUp, X,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';
import { formatMoney } from '../utils/money';
import { formatPercent } from '../utils/percent';
import { formatDateMedium } from '../utils/date';
import { useNotify } from '../utils/notify';
import CalendarRangePicker from '../components/CalendarRangePicker';
import Pagination from '../components/ui/Pagination';

// Chart series colours. Recharts needs literal values (it writes them into
// SVG fill attributes, where CSS custom properties don't resolve), so these
// are picked to hold contrast on both the light and the dark card surface
// rather than being pulled from the theme tokens.
const COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];
const AXIS = 'var(--text-secondary)';
const GRID = 'var(--border-color)';
const TOOLTIP_STYLE = {
  background: 'var(--tooltip-bg)',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  color: 'var(--text-primary)',
};

// Tab order mirrors the lead lifecycle: what the team did → how good the
// leads were → what still needs chasing → where they came from → where they
// are → who we are meeting → who visited and didn't buy.
const TABS = [
  { key: 'productivity', label: 'Productivity', icon: Activity },
  { key: 'quality', label: 'Lead Quality', icon: Target },
  { key: 'followups', label: 'Follow-Ups', icon: AlertTriangle },
  { key: 'sources', label: 'Source Analysis', icon: TrendingUp },
  { key: 'funnel', label: 'Lead Funnel', icon: GitBranch },
  { key: 'visits', label: 'Meetings & Visits', icon: CalendarCheck },
  { key: 'notbooked', label: 'Visited · Not Booked', icon: MapPin },
];

const PERIODS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const VISIT_SCOPES = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'range', label: 'Custom range' },
];

const OUTCOME_LABELS = {
  booked: 'Booked',
  interested: 'Interested',
  not_interested: 'Not interested',
  reschedule: 'Reschedule',
  no_show: 'No show',
  pending: 'Awaiting outcome',
};

const pct = (n) => formatPercent(Number(n) || 0);
const num = (n) => (Number(n) || 0).toLocaleString();
const day = (d) => (d ? formatDateMedium(d) : '—');

// A zero count is neutral news, not an alarm — only tint the tile once the
// number is actually non-zero, so an empty tenant isn't a wall of red.
const toneIf = (value, tone) => ((Number(value) || 0) > 0 ? tone : undefined);

const truncateSourceLabel = (value, max = 18) => {
  const text = String(value || '').trim();
  if (!text) return 'Unknown';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
};

function Stat({ label, value, hint, tone }) {
  return (
    <div className="card">
      <p className="lead-reports-page__stat-label">{label}</p>
      <h3 className={`lead-reports-page__stat-value${tone ? ` lead-reports-page__stat-value--${tone}` : ''}`}>
        {value}
      </h3>
      {hint ? <p className="lead-reports-page__stat-hint">{hint}</p> : null}
    </div>
  );
}

function StatRow({ children }) {
  return <div className="lead-reports-page__stats">{children}</div>;
}

function Panel({ title, subtitle, children, actions }) {
  return (
    <div className="card lead-reports-page__panel">
      <div className="lead-reports-page__panel-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="lead-reports-page__panel-title">{title}</h3>
          {subtitle ? <p className="lead-reports-page__panel-sub">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function Chart({ height = 300, children }) {
  return (
    <div className="lead-reports-page__chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

// Rows per page across every report table. Small on purpose: it keeps each
// panel a predictable height so a tenant with 40 sources doesn't push the
// panels below it off the screen.
const ROWS_PER_PAGE = 4;

function Table({ columns, rows, renderRow, minWidth, pageSize = ROWS_PER_PAGE, empty = 'No records for this period.' }) {
  const [page, setPage] = useState(1);
  const total = rows?.length || 0;

  // Switching tab / date range / owner swaps the row set underneath us —
  // without this, page 3 of the old data renders as an empty page 3 of the new.
  useEffect(() => { setPage(1); }, [total]);

  const paginate = pageSize > 0 && total > pageSize;
  const totalPages = paginate ? Math.ceil(total / pageSize) : 1;
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visible = paginate ? rows.slice((safePage - 1) * pageSize, safePage * pageSize) : rows;

  if (total === 0) {
    return <p className="lead-reports-page__empty">{empty}</p>;
  }

  return (
    <>
      {/* The scroll container wraps ONLY the table — the pager sits outside it
          so it stays put while the columns scroll horizontally. */}
      <div className="lead-reports-page__table-shell">
        <table style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.numeric ? 'is-numeric' : undefined}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>{visible.map(renderRow)}</tbody>
        </table>
      </div>
      {pageSize > 0 && (
        <Pagination
          className="lead-reports-page__pager"
          page={safePage}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          // The component's default 1rem side margin indents it away from the
          // table edge inside a panel that already has its own padding.
          style={{ margin: 0 }}
        />
      )}
    </>
  );
}

function Pill({ children, tone = 'neutral' }) {
  return <span className={`report-pill report-pill--${tone}`}>{children}</span>;
}

// ─── Drill-down links ────────────────────────────────────────────────
//
// Every number on this page represents a set of records, so every number
// should be able to hand you that set. Each link carries `returnTo` so the
// destination can offer a way back — a report that drops you into a filtered
// list with no route home is a dead end.

const RETURN_QS = `returnTo=${encodeURIComponent('/lead-reports')}`;

function drillUrl(path, params = {}, label = 'Lead Reports') {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  qs.set('returnLabel', label);
  return `${path}?${qs.toString()}&${RETURN_QS}`;
}

// Leads only ever lists status=Lead rows, so a stage that matches on call
// status drills into /leads, while one matching a lifecycle status
// (Prospect / Customer / Churned) has to drill into /contacts instead.
function stageDrillUrl(stageDef, label) {
  if (!stageDef) return null;
  if (stageDef.callStatuses?.length) {
    return drillUrl('/leads', { callStatus: stageDef.callStatuses[0] }, label);
  }
  const status = (stageDef.statuses || [])[0];
  if (!status) return null;
  if (String(status).toLowerCase() === 'lead') return drillUrl('/leads', {}, label);
  const titled = String(status).charAt(0).toUpperCase() + String(status).slice(1).toLowerCase();
  return drillUrl('/contacts', { status: titled }, label);
}

// A table cell that navigates. Rendered as a real <Link> (not an onClick row)
// so middle-click / open-in-new-tab / keyboard focus all behave normally.
function DrillCell({ to, children, title }) {
  if (!to) return <>{children}</>;
  return (
    <Link to={to} className="lead-reports-page__drill" title={title || 'Open the matching records'}>
      {children}
    </Link>
  );
}

// This report reads the Task Queue, so the way to add a meeting or a site
// visit is to create the task. Link straight into the create drawer with the
// type pre-selected rather than leaving the reader to work that out — an empty
// report with no entry point is a dead end.
function ScheduleVisitLink({ type = 'Site Visit', className = 'btn-secondary', children }) {
  return (
    <Link
      to={`/tasks?create=1&type=${encodeURIComponent(type)}`}
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', textDecoration: 'none' }}
    >
      <Plus size={15} /> {children || `Schedule a ${type.toLowerCase()}`}
    </Link>
  );
}

export default function LeadReports() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [tab, setTab] = useState('productivity');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [period, setPeriod] = useState('daily');
  const [visitScope, setVisitScope] = useState('today');
  const [ownerId, setOwnerId] = useState('');

  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [owners, setOwners] = useState([]);

  // Stage builder (Funnel tab)
  const [stages, setStages] = useState([]);
  const [stageDefaults, setStageDefaults] = useState([]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [savingStages, setSavingStages] = useState(false);

  const qs = useCallback((extra = {}) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (ownerId) params.set('ownerId', ownerId);
    Object.entries(extra).forEach(([k, v]) => { if (v) params.set(k, v); });
    const s = params.toString();
    return s ? `?${s}` : '';
  }, [from, to, ownerId]);

  const endpoint = useMemo(() => {
    switch (tab) {
      case 'productivity': return `/api/lead-reports/productivity${qs({ period })}`;
      case 'quality': return `/api/lead-reports/lead-quality${qs()}`;
      case 'followups': return `/api/lead-reports/follow-up-tracking${qs()}`;
      case 'sources': return `/api/lead-reports/source-analysis${qs()}`;
      case 'funnel': return `/api/lead-reports/stage-funnel${qs()}`;
      case 'visits': return `/api/lead-reports/visits${qs({ scope: visitScope })}`;
      case 'notbooked': return `/api/lead-reports/visit-done-not-booked${qs()}`;
      default: return null;
    }
  }, [tab, qs, period, visitScope]);

  // Cache is keyed by the full endpoint URL, not by tab: switching back to a
  // tab you've already viewed under the same filters renders instantly from
  // cache while the request revalidates in the background. Blanking the page
  // to "Loading report…" on every tab click was most of the perceived lag —
  // the data was already in hand.
  const cached = data[endpoint];

  useEffect(() => {
    if (!endpoint) return undefined;
    let cancelled = false;
    // Only show the spinner when there is nothing to show. A revalidation of
    // already-rendered data must not tear the page down.
    if (data[endpoint] === undefined) setLoading(true);
    setError('');
    fetchApi(endpoint)
      .then((res) => {
        if (cancelled) return;
        setData((prev) => ({ ...prev, [endpoint]: res }));
        if (tab === 'productivity' && Array.isArray(res?.users)) setOwners(res.users);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Could not load this report.');
        setLoading(false);
      });
    return () => { cancelled = true; };
    // `data` is deliberately not a dep — including it would re-run the fetch
    // on every cache write and loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, tab]);

  // Stage config is only needed by the Funnel tab's builder.
  useEffect(() => {
    if (tab !== 'funnel') return;
    fetchApi('/api/lead-reports/stages')
      .then((res) => {
        setStages(Array.isArray(res?.stages) ? res.stages : []);
        setStageDefaults(Array.isArray(res?.defaults) ? res.defaults : []);
      })
      .catch(() => { /* funnel still renders on the server-side defaults */ });
  }, [tab]);

  const current = cached;

  const saveStages = async () => {
    setSavingStages(true);
    try {
      const res = await fetchApi('/api/lead-reports/stages', {
        method: 'PUT',
        body: JSON.stringify({ stages }),
      });
      setStages(Array.isArray(res?.stages) ? res.stages : stages);
      setBuilderOpen(false);
      notify.success('Lead stages saved. Reloading the funnel…');
      // Re-pull the funnel so the chart reflects the new stage definitions.
      // Cache under the endpoint URL — the same key the fetch effect uses.
      const funnelUrl = `/api/lead-reports/stage-funnel${qs()}`;
      const refreshed = await fetchApi(funnelUrl);
      setData((prev) => ({ ...prev, [funnelUrl]: refreshed }));
    } catch (err) {
      notify.error(err?.message || 'Could not save the lead stages.');
    } finally {
      setSavingStages(false);
    }
  };

  const updateStage = (index, patch) => {
    setStages((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const csvList = (v) => (Array.isArray(v) ? v.join(', ') : '');
  const parseCsv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

  return (
    <div className="lead-reports-page">
      <header className="lead-reports-page__header">
        <div className="lead-reports-page__title-group">
          <BarChart3 size={28} color="var(--primary-color, var(--accent-color))" />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, margin: 0 }}>Lead Reports</h1>
            <p className="lead-reports-page__panel-sub">
              Productivity, lead quality, follow-ups, sources, funnel stages, and visit outcomes.
            </p>
          </div>
        </div>

        <div className="lead-reports-page__filters">
          {tab === 'productivity' && (
            <select className="input-field" aria-label="Reporting period" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          )}
          {tab === 'visits' && (
            <select className="input-field" aria-label="Visit window" value={visitScope} onChange={(e) => setVisitScope(e.target.value)}>
              {VISIT_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          )}
          {owners.length > 0 && (
            <select className="input-field" aria-label="Owner filter" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">All owners</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          {/* Shared calendar popover — one pill instead of two native date
              inputs. It commits `from`/`to` together and orders them itself, so
              an inverted range is unreachable from the UI (the backend still
              rejects one, for direct API callers). Double-clicking a day picks
              a single-day range, i.e. from === to. */}
          <CalendarRangePicker
            label="Date range"
            // Right-anchored: this pill is the last control in a right-aligned
            // toolbar, so a left-anchored popover runs off the viewport.
            align="right"
            value={{ from, to }}
            onChange={(next) => {
              setFrom(next?.from || '');
              setTo(next?.to || '');
            }}
          />
        </div>
      </header>

      <div className="lead-reports-page__tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={active}
              className={`lead-reports-page__tab${active ? ' lead-reports-page__tab--active' : ''}`}
            >
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      {loading && <p className="lead-reports-page__status">Loading report…</p>}
      {!loading && error && <p className="report-error-text" style={{ margin: 0 }}>{error}</p>}
      {!loading && !error && current?.truncated && (
        <p className="lead-reports-page__warn">
          This period exceeds the reporting row cap — narrow the date range for exact figures.
        </p>
      )}

      {!loading && !error && current && (
        <>
          {tab === 'productivity' && <ProductivityTab d={current} period={period} />}
          {tab === 'quality' && <QualityTab d={current} />}
          {tab === 'followups' && <FollowUpsTab d={current} />}
          {tab === 'sources' && <SourcesTab d={current} />}
          {tab === 'funnel' && (
            <FunnelTab
              d={current}
              stages={stages}
              stageDefaults={stageDefaults}
              isAdmin={isAdmin}
              builderOpen={builderOpen}
              setBuilderOpen={setBuilderOpen}
              setStages={setStages}
              updateStage={updateStage}
              saveStages={saveStages}
              savingStages={savingStages}
              csvList={csvList}
              parseCsv={parseCsv}
              notify={notify}
            />
          )}
          {tab === 'visits' && <VisitsTab d={current} />}
          {tab === 'notbooked' && <NotBookedTab d={current} />}
        </>
      )}
    </div>
  );
}

// ─── 5. Daily / Weekly / Monthly productivity ────────────────────────

function ProductivityTab({ d, period }) {
  const t = d.totals || {};
  const periodLabel = period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : 'Monthly';
  return (
    <div className="lead-reports-page__sections">
      <StatRow>
        <Stat label="Leads created" value={num(t.leadsCreated)} />
        <Stat label="Calls made" value={num(t.calls)} />
        <Stat label="Emails sent" value={num(t.emails)} />
        <Stat label="Meetings / visits" value={num(t.meetings)} />
        <Stat label="Tasks completed" value={num(t.tasksCompleted)} hint={`${num(t.tasksCreated)} created`} />
        <Stat label="Deals won" value={num(t.dealsWon)} tone={toneIf(t.dealsWon, 'success')} hint={formatMoney(t.revenue || 0)} />
      </StatRow>

      <Panel title={`${periodLabel} activity`} subtitle="Every period in the range is shown, including quiet ones.">
        <Chart height={300}>
          <LineChart data={d.series || []} margin={{ top: 10, right: 24, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={false} fontSize={11} />
            <YAxis stroke={AXIS} tickLine={false} axisLine={false} domain={[0, 'auto']} fontSize={11} width={40} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
            <Line type="monotone" dataKey="leadsCreated" name="Leads" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="calls" name="Calls" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="emails" name="Emails" stroke="#a855f7" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="tasksCompleted" name="Tasks done" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </Chart>
      </Panel>

      <Panel title="Productivity by team member" subtitle="Totals across the selected range.">
        <Table
          minWidth="960px"
          columns={[
            { key: 'name', label: 'Team member' },
            { key: 'leads', label: 'Leads', numeric: true },
            { key: 'calls', label: 'Calls', numeric: true },
            { key: 'emails', label: 'Emails', numeric: true },
            { key: 'meetings', label: 'Meetings', numeric: true },
            { key: 'touches', label: 'Total touches', numeric: true },
            { key: 'tasks', label: 'Tasks done', numeric: true },
            { key: 'completion', label: 'Task completion', numeric: true },
            { key: 'won', label: 'Deals won', numeric: true },
            { key: 'revenue', label: 'Revenue', numeric: true },
          ]}
          rows={d.byUser || []}
          renderRow={(u) => (
            <tr key={u.userId || 'unassigned'}>
              <td className="is-strong">
                <DrillCell to={drillUrl('/leads', { assignee: u.userId || 'unassigned' }, 'Productivity')} title={`Show ${u.name}'s leads`}>
                  {u.name}
                </DrillCell>
              </td>
              <td className="is-numeric">{num(u.leadsCreated)}</td>
              <td className="is-numeric">{num(u.calls)}</td>
              <td className="is-numeric">{num(u.emails)}</td>
              <td className="is-numeric">{num(u.meetings)}</td>
              <td className="is-numeric is-strong">{num(u.touches)}</td>
              <td className="is-numeric">{num(u.tasksCompleted)}</td>
              <td className="is-numeric">{pct(u.taskCompletionRate)}</td>
              <td className="is-numeric">{num(u.dealsWon)}</td>
              <td className="is-numeric is-success">{formatMoney(u.revenue || 0)}</td>
            </tr>
          )}
          empty="No recorded activity in this period."
        />
      </Panel>
    </div>
  );
}

// ─── 6. Lead quality performance ─────────────────────────────────────

function QualityTab({ d }) {
  const t = d.totals || {};
  return (
    <div className="lead-reports-page__sections">
      <StatRow>
        <Stat label="Total leads" value={num(t.totalLeads)} />
        <Stat label="Qualified" value={num(t.qualified)} tone={toneIf(t.qualified, 'success')} hint={pct(t.qualificationRate)} />
        <Stat label="Junk" value={num(t.junk)} tone={toneIf(t.junk, 'danger')} hint={pct(t.junkRate)} />
        <Stat label="Unreachable (DNP)" value={num(t.dnp)} tone={toneIf(t.dnp, 'warning')} />
        <Stat label="Not yet worked" value={num(t.untouched)} />
        <Stat label="Converted" value={num(t.converted)} tone={toneIf(t.converted, 'success')} hint={pct(t.conversionRate)} />
        <Stat label="Average score" value={`${t.avgScore ?? 0}/100`} />
      </StatRow>

      <div className="lead-reports-page__split">
        <Panel title="Score band distribution" subtitle="Does a higher lead score actually convert better?">
          <Chart height={260}>
            <BarChart data={d.scoreBands || []} margin={{ top: 10, right: 20, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="band" stroke={AXIS} tickLine={false} axisLine={false} fontSize={11} />
              <YAxis stroke={AXIS} tickLine={false} axisLine={false} domain={[0, 'auto']} fontSize={11} width={40} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--subtle-bg)' }} />
              <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
              <Bar dataKey="count" name="Leads" fill="#3b82f6" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="converted" name="Converted" fill="#10b981" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </Chart>
        </Panel>

        <Panel title="Quality by source" subtitle="Which channels send leads worth working?">
          <Table
            minWidth="560px"
            columns={[
              { key: 'source', label: 'Source' },
              { key: 'total', label: 'Leads', numeric: true },
              { key: 'qual', label: 'Qualified', numeric: true },
              { key: 'junk', label: 'Junk', numeric: true },
              { key: 'score', label: 'Avg score', numeric: true },
              { key: 'conv', label: 'Conversion', numeric: true },
            ]}
            rows={d.bySource || []}
            renderRow={(s) => (
              <tr key={s.source}>
                <td>
                  <DrillCell to={drillUrl('/leads', { source: s.source }, 'Lead Quality')} title={`Show leads from ${s.source}`}>
                    {s.source}
                  </DrillCell>
                </td>
                <td className="is-numeric">{num(s.total)}</td>
                <td className="is-numeric">
                  {num(s.qualified)} <span className="lead-reports-page__muted">({pct(s.qualificationRate)})</span>
                </td>
                <td className="is-numeric">{num(s.junk)}</td>
                <td className="is-numeric">{s.avgScore}</td>
                <td className="is-numeric">{pct(s.conversionRate)}</td>
              </tr>
            )}
          />
        </Panel>
      </div>

      <Panel title="Quality by owner" subtitle="Qualification and conversion rates per team member.">
        <Table
          minWidth="840px"
          columns={[
            { key: 'name', label: 'Owner' },
            { key: 'total', label: 'Leads', numeric: true },
            { key: 'qual', label: 'Qualified', numeric: true },
            { key: 'qualRate', label: 'Qualification rate', numeric: true },
            { key: 'junk', label: 'Junk', numeric: true },
            { key: 'conv', label: 'Converted', numeric: true },
            { key: 'convRate', label: 'Conversion rate', numeric: true },
            { key: 'score', label: 'Avg score', numeric: true },
          ]}
          rows={d.byOwner || []}
          renderRow={(o) => (
            <tr key={o.userId || 'unassigned'}>
              <td className="is-strong">
                <DrillCell to={drillUrl('/leads', { assignee: o.userId || 'unassigned' }, 'Lead Quality')} title={`Show ${o.name}'s leads`}>
                  {o.name}
                </DrillCell>
              </td>
              <td className="is-numeric">{num(o.total)}</td>
              <td className="is-numeric">{num(o.qualified)}</td>
              <td className="is-numeric">{pct(o.qualificationRate)}</td>
              <td className="is-numeric">{num(o.junk)}</td>
              <td className="is-numeric">{num(o.converted)}</td>
              <td className="is-numeric">{pct(o.conversionRate)}</td>
              <td className="is-numeric">{o.avgScore}</td>
            </tr>
          )}
        />
      </Panel>
    </div>
  );
}

// ─── 7. Follow-up tracking ───────────────────────────────────────────

function FollowUpsTab({ d }) {
  const s = d.summary || {};
  return (
    <div className="lead-reports-page__sections">
      <StatRow>
        <Stat label="Open follow-ups" value={num(s.openFollowUps)} />
        <Stat label="Overdue" value={num(s.overdue)} tone={toneIf(s.overdue, 'danger')} />
        <Stat label="Due today" value={num(s.dueToday)} tone={toneIf(s.dueToday, 'warning')} />
        <Stat label="Upcoming" value={num(s.upcoming)} />
        <Stat label="No due date" value={num(s.undated)} hint="Scheduled work with no date set" />
        <Stat label="Completed in period" value={num(s.completedInPeriod)} tone={toneIf(s.completedInPeriod, 'success')} />
        <Stat label="Awaiting first response" value={num(s.awaitingFirstResponse)} tone={toneIf(s.awaitingFirstResponse, 'danger')} hint={`${num(s.slaBreached)} past SLA`} />
        <Stat label={`Silent ${s.staleDays ?? 7}+ days`} value={num(s.staleLeads)} tone={toneIf(s.staleLeads, 'warning')} />
      </StatRow>

      <Panel title="Follow-up load by owner" subtitle="Who is behind, and by how much.">
        <Table
          minWidth="720px"
          columns={[
            { key: 'name', label: 'Owner' },
            { key: 'open', label: 'Open', numeric: true },
            { key: 'overdue', label: 'Overdue', numeric: true },
            { key: 'today', label: 'Due today', numeric: true },
            { key: 'upcoming', label: 'Upcoming', numeric: true },
            { key: 'avg', label: 'Avg days late', numeric: true },
            { key: 'ontime', label: 'On time', numeric: true },
          ]}
          rows={d.byOwner || []}
          renderRow={(o) => (
            <tr key={o.userId || 'unassigned'}>
              <td className="is-strong">{o.name}</td>
              <td className="is-numeric">{num(o.open)}</td>
              <td className={`is-numeric${o.overdue > 0 ? ' is-danger' : ''}`}>{num(o.overdue)}</td>
              <td className="is-numeric">{num(o.dueToday)}</td>
              <td className="is-numeric">{num(o.upcoming)}</td>
              <td className="is-numeric">{o.avgOverdueDays}</td>
              <td className="is-numeric">{pct(o.onTimeRate)}</td>
            </tr>
          )}
          empty="No open follow-ups."
        />
      </Panel>

      <Panel
        title="Overdue follow-ups"
        subtitle="Built from the Task Queue — any open task past its due date. Oldest first; these are the calls that never happened."
        actions={<ScheduleVisitLink type="Follow Up">Book a follow-up</ScheduleVisitLink>}
      >
        <Table
          minWidth="760px"
          columns={[
            { key: 'contact', label: 'Lead' },
            { key: 'task', label: 'Follow-up' },
            { key: 'owner', label: 'Owner' },
            { key: 'due', label: 'Was due', numeric: true },
            { key: 'late', label: 'Days late', numeric: true },
          ]}
          rows={d.overdue || []}
          renderRow={(r) => (
            <tr key={r.taskId}>
              <td>
                <div className="is-strong">{r.contactName || '—'}</div>
                {r.contactPhone ? <div className="lead-reports-page__muted">{r.contactPhone}</div> : null}
              </td>
              <td>
                {r.title}
                {r.type ? <> <Pill tone="info">{r.type}</Pill></> : null}
              </td>
              <td>{r.owner}</td>
              <td className="is-numeric">{day(r.dueDate)}</td>
              <td className="is-numeric is-strong is-danger">{r.overdueDays}</td>
            </tr>
          )}
          empty="Nothing overdue — the queue is clean."
        />
      </Panel>

      <Panel title="Leads awaiting a first response" subtitle="No activity has ever been logged against these leads.">
        <Table
          minWidth="760px"
          columns={[
            { key: 'name', label: 'Lead' },
            { key: 'source', label: 'Source' },
            { key: 'owner', label: 'Owner' },
            { key: 'created', label: 'Created', numeric: true },
            { key: 'waiting', label: 'Waiting (days)', numeric: true },
            { key: 'sla', label: 'SLA' },
          ]}
          rows={d.awaitingFirstResponse || []}
          renderRow={(r) => (
            <tr key={r.contactId}>
              <td className="is-strong">{r.name}</td>
              <td>{r.source || '—'}</td>
              <td>{r.owner}</td>
              <td className="is-numeric">{day(r.createdAt)}</td>
              <td className="is-numeric">{r.waitingDays}</td>
              <td>{r.breached ? <Pill tone="danger">Breached</Pill> : <Pill tone="warning">Pending</Pill>}</td>
            </tr>
          )}
          empty="Every lead has had a first response."
        />
      </Panel>

      <Panel title={`Leads with no activity for ${s.staleDays ?? 7}+ days`} subtitle="Still open, but going cold.">
        <Table
          minWidth="700px"
          columns={[
            { key: 'name', label: 'Lead' },
            { key: 'source', label: 'Source' },
            { key: 'owner', label: 'Owner' },
            { key: 'last', label: 'Last activity', numeric: true },
            { key: 'silent', label: 'Days silent', numeric: true },
          ]}
          rows={d.stale || []}
          renderRow={(r) => (
            <tr key={r.contactId}>
              <td className="is-strong">{r.name}</td>
              <td>{r.source || '—'}</td>
              <td>{r.owner}</td>
              <td className="is-numeric">{r.lastActivityAt ? day(r.lastActivityAt) : 'Never'}</td>
              <td className="is-numeric is-strong">{r.daysSinceLastActivity}</td>
            </tr>
          )}
          empty="No leads have gone quiet."
        />
      </Panel>
    </div>
  );
}

// ─── 8. Lead source analysis ─────────────────────────────────────────

function SourcesTab({ d }) {
  const t = d.totals || {};
  const pie = (d.sources || []).slice(0, 8).map((s) => ({ name: s.source, value: s.leads }));
  const pieTotal = pie.reduce((sum, slice) => sum + Number(slice?.value || 0), 0);
  const pieLabel = ({ name, percent = 0 }) => {
    if (percent < 0.06) return '';
    return `${truncateSourceLabel(name)} ${Math.round(percent * 100)}%`;
  };
  return (
    <div className="lead-reports-page__sections">
      <StatRow>
        <Stat label="Leads" value={num(t.leads)} />
        <Stat label="Active sources" value={num(t.sourceCount)} />
        <Stat label="Qualified" value={num(t.qualified)} hint={pct(t.qualificationRate)} />
        <Stat label="Converted" value={num(t.converted)} tone={toneIf(t.converted, 'success')} hint={pct(t.conversionRate)} />
        <Stat label="Deals won" value={num(t.dealsWon)} />
        <Stat label="Revenue" value={formatMoney(t.revenue || 0)} tone={toneIf(t.revenue, 'success')} />
      </StatRow>

      <div className="lead-reports-page__split">
        <Panel title="Lead volume by source">
          {pie.length === 0 ? (
            <p className="lead-reports-page__empty">No leads in this period.</p>
          ) : (
            <Chart height={280}>
              <PieChart>
                <Pie
                  data={pie}
                  dataKey="value"
                  isAnimationActive={false}
                  innerRadius={58}
                  outerRadius={92}
                  cx="38%"
                  cy="50%"
                  paddingAngle={3}
                  stroke="none"
                  label={pieLabel}
                  labelLine={false}
                >
                  {pie.map((entry, i) => <Cell key={entry.name} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend
                  layout="vertical"
                  align="right"
                  verticalAlign="middle"
                  wrapperStyle={{ fontSize: '0.75rem', paddingLeft: 12 }}
                  formatter={(value, _entry, index) => {
                    const slice = pie[index] || null;
                    const count = Number(slice?.value || 0);
                    const percent = pieTotal > 0 ? Math.round((count / pieTotal) * 100) : 0;
                    return `${truncateSourceLabel(value, 22)}${pieTotal > 0 ? ` (${percent}%)` : ''}`;
                  }}
                />
              </PieChart>
            </Chart>
          )}
        </Panel>

        <Panel title="First touch vs last touch" subtitle="Which channel opened the relationship, and which closed the loop.">
          <div className="lead-reports-page__touchlists">
            <div>
              <p className="lead-reports-page__stat-label" style={{ marginBottom: '0.5rem' }}>First touch</p>
              {(d.firstTouch || []).slice(0, 6).map((r) => (
                <div key={r.source} className="lead-reports-page__touchrow">
                  <span>{r.source}</span><span>{num(r.count)}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="lead-reports-page__stat-label" style={{ marginBottom: '0.5rem' }}>Last touch</p>
              {(d.lastTouch || []).slice(0, 6).map((r) => (
                <div key={r.source} className="lead-reports-page__touchrow">
                  <span>{r.source}</span><span>{num(r.count)}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Source performance" subtitle="Volume is only half the story — conversion and revenue per lead decide the budget.">
        <Table
          minWidth="1000px"
          columns={[
            { key: 'source', label: 'Source' },
            { key: 'leads', label: 'Leads', numeric: true },
            { key: 'qual', label: 'Qualified', numeric: true },
            { key: 'conv', label: 'Converted', numeric: true },
            { key: 'convRate', label: 'Conversion', numeric: true },
            { key: 'won', label: 'Deals won', numeric: true },
            { key: 'rev', label: 'Revenue', numeric: true },
            { key: 'rpl', label: 'Revenue / lead', numeric: true },
            { key: 'cycle', label: 'Avg days to win', numeric: true },
          ]}
          rows={d.sources || []}
          renderRow={(s) => (
            <tr key={s.source}>
              <td className="is-strong">
                <DrillCell to={drillUrl('/leads', { source: s.source }, 'Source Analysis')} title={`Show leads from ${s.source}`}>
                  {s.source}
                </DrillCell>
              </td>
              <td className="is-numeric">{num(s.leads)}</td>
              <td className="is-numeric">{num(s.qualified)}</td>
              <td className="is-numeric">{num(s.converted)}</td>
              <td className="is-numeric">{pct(s.conversionRate)}</td>
              <td className="is-numeric">{num(s.dealsWon)}</td>
              <td className="is-numeric is-success">{formatMoney(s.revenue || 0)}</td>
              <td className="is-numeric">{formatMoney(s.revenuePerLead || 0)}</td>
              <td className="is-numeric">{s.avgDaysToWin || '—'}</td>
            </tr>
          )}
        />
      </Panel>
    </div>
  );
}

// ─── 9. Lead-stage funnel + builder ──────────────────────────────────

function FunnelTab({
  d, stages, stageDefaults, isAdmin, builderOpen, setBuilderOpen,
  setStages, updateStage, saveStages, savingStages, csvList, parseCsv, notify,
}) {
  const t = d.totals || {};
  const rows = d.stages || [];
  // The funnel response carries only counts; the match rules live in the
  // stage config. Index it so each row can build its own drill-down link.
  const stageByKey = useMemo(
    () => Object.fromEntries((stages || []).map((s) => [s.key, s])),
    [stages],
  );
  // The horizontal bar chart needs room per stage or the bars squash into
  // each other once an operator adds stages beyond the default five.
  const chartHeight = Math.max(220, rows.length * 54 + 60);
  return (
    <div className="lead-reports-page__sections">
      <StatRow>
        <Stat label="Leads in range" value={num(t.totalLeads)} />
        <Stat label="In funnel" value={num(t.inFunnel)} />
        <Stat label="Dropped out" value={num(t.leaked)} tone={toneIf(t.leaked, 'danger')} />
        <Stat label="Unclassified" value={num(t.unclassified)} tone={toneIf(t.unclassified, 'warning')} hint="Matches no stage rule" />
        <Stat label="End-to-end conversion" value={pct(t.overallConversion)} tone={toneIf(t.overallConversion, 'success')} />
      </StatRow>

      <Panel
        title="Lead stage funnel"
        subtitle="Each bar counts everyone who reached that stage or beyond."
        actions={isAdmin ? (
          <button type="button" className="btn-secondary" onClick={() => setBuilderOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <GitBranch size={15} /> Edit stages
          </button>
        ) : null}
      >
        {rows.length === 0 ? (
          <p className="lead-reports-page__empty">No leads matched the configured stages in this period.</p>
        ) : (
          <>
            <Chart height={chartHeight}>
              <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 40, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
                <XAxis type="number" stroke={AXIS} tickLine={false} axisLine={false} domain={[0, 'auto']} fontSize={11} allowDecimals={false} />
                <YAxis type="category" dataKey="label" stroke={AXIS} tickLine={false} axisLine={false} width={110} fontSize={12} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--subtle-bg)' }} />
                <Bar dataKey="entered" name="Reached this stage" radius={[0, 6, 6, 0]} barSize={26} isAnimationActive={false}>
                  {rows.map((s, i) => <Cell key={s.key} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </Chart>

            <Table
              minWidth="680px"
              columns={[
                { key: 'stage', label: 'Stage' },
                { key: 'current', label: 'Sitting here', numeric: true },
                { key: 'entered', label: 'Reached', numeric: true },
                { key: 'next', label: 'To next stage', numeric: true },
                { key: 'share', label: 'Share of funnel', numeric: true },
              ]}
              rows={rows}
              renderRow={(s) => (
                <tr key={s.key}>
                  <td className="is-strong">
                    <DrillCell to={stageDrillUrl(stageByKey[s.key], 'Lead Funnel')} title={`Show the leads in ${s.label}`}>
                      {s.label}
                    </DrillCell>
                  </td>
                  <td className="is-numeric">{num(s.current)}</td>
                  <td className="is-numeric">{num(s.entered)}</td>
                  <td className="is-numeric">{s.conversionToNext === null ? '—' : pct(s.conversionToNext)}</td>
                  <td className="is-numeric">{pct(s.shareOfTop)}</td>
                </tr>
              )}
            />
          </>
        )}
      </Panel>

      <Panel title="Drop-outs" subtitle="Leads parked outside the funnel.">
        <Table
          minWidth="360px"
          columns={[{ key: 'label', label: 'Bucket' }, { key: 'count', label: 'Leads', numeric: true }]}
          rows={d.leaks || []}
          renderRow={(s) => (
            <tr key={s.key}>
              <td>
                <DrillCell to={stageDrillUrl(stageByKey[s.key], 'Lead Funnel')} title={`Show the leads in ${s.label}`}>
                  {s.label}
                </DrillCell>
              </td>
              <td className={`is-numeric${s.count > 0 ? ' is-danger' : ''}`}>{num(s.count)}</td>
            </tr>
          )}
          empty="No drop-out buckets configured."
        />
      </Panel>

      {builderOpen && (
        <StageBuilder
          stages={stages}
          stageDefaults={stageDefaults}
          setStages={setStages}
          updateStage={updateStage}
          onSave={saveStages}
          saving={savingStages}
          onClose={() => setBuilderOpen(false)}
          csvList={csvList}
          parseCsv={parseCsv}
          notify={notify}
        />
      )}
    </div>
  );
}

// Plain-English restatement of a stage's rules, shown under each row. The
// three inputs are OR'd together, which isn't obvious from three side-by-side
// boxes — spelling it out is cheaper than expecting the reader to infer it.
function describeStage(s) {
  const parts = [];
  if (s.statuses?.length) parts.push(`status is ${s.statuses.join(' or ')}`);
  if (s.callStatuses?.length) parts.push(`call status is ${s.callStatuses.join(' or ')}`);
  if (Number.isFinite(Number(s.minScore))) parts.push(`score is ${s.minScore} or higher`);
  if (!parts.length) return '';
  return `Matches a lead when ${parts.join(', or when ')}.`;
}

function StageBuilder({ stages, stageDefaults, setStages, updateStage, onSave, saving, onClose, csvList, parseCsv, notify }) {
  const addStage = () => setStages([...stages, { key: `stage_${stages.length + 1}`, label: '', statuses: [], callStatuses: [], leak: false }]);
  const removeStage = (i) => setStages(stages.filter((_, idx) => idx !== i));
  // Resetting throws away a config the operator may have spent time on, and
  // there's no undo — confirm first.
  const onReset = async () => {
    const ok = await notify.confirm(
      'Reset the lead funnel to the default stages? Your current stage configuration will be replaced.',
    );
    if (!ok) return;
    setStages(stageDefaults.map((s) => ({ ...s })));
  };
  const move = (i, delta) => {
    const next = [...stages];
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setStages(next);
  };

  return (
    <div className="lead-reports-builder" role="dialog" aria-modal="true" aria-label="Lead funnel builder">
      <div className="lead-reports-builder__panel">
        {/* Sticky: the ordering rule is the one thing a reader must keep in
            mind while editing, and with 8 stages it would otherwise scroll
            out of view on the first drag of the scrollbar. */}
        <div className="lead-reports-builder__head">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>Lead funnel builder</h3>
            <p className="lead-reports-page__panel-sub">
              A lead lands in the <strong>last</strong> stage it matches — so order them shallow → deep and keep drop-out buckets at the bottom.
            </p>
          </div>
          <button type="button" className="lead-reports-builder__close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="lead-reports-builder__list">
          {stages.map((s, i) => (
            <div
              key={`${s.key}-${i}`}
              className={`lead-reports-builder__stage${s.leak ? ' is-leak' : ''}`}
            >
              <div className="lead-reports-builder__stage-row">
                {/* Position is load-bearing (last match wins), so show it. */}
                <span className="lead-reports-builder__order" aria-hidden="true">{i + 1}</span>
                <label className="lead-reports-builder__field lead-reports-builder__stage-name">
                  <span>Stage name</span>
                  <input
                    className="input-field"
                    placeholder="e.g. Site Visited"
                    aria-label={`Stage ${i + 1} name`}
                    value={s.label}
                    onChange={(e) => updateStage(i, { label: e.target.value })}
                  />
                </label>
                <label
                  className="lead-reports-builder__field lead-reports-builder__stage-key"
                  title="Internal identifier. Not shown on the report — only used to tell stages apart."
                >
                  <span>Key</span>
                  <input
                    className="input-field"
                    placeholder="e.g. site_visited"
                    aria-label={`Stage ${i + 1} key`}
                    value={s.key}
                    onChange={(e) => updateStage(i, { key: e.target.value })}
                  />
                </label>
                <label className="lead-reports-builder__leak" title="Drop-out stages are reported beside the funnel instead of inside its conversion ladder.">
                  <input type="checkbox" checked={Boolean(s.leak)} onChange={(e) => updateStage(i, { leak: e.target.checked })} />
                  Drop-out
                </label>
                <button type="button" className="lead-reports-builder__iconbtn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${s.label || 'stage'} up`}>↑</button>
                <button type="button" className="lead-reports-builder__iconbtn" onClick={() => move(i, 1)} disabled={i === stages.length - 1} aria-label={`Move ${s.label || 'stage'} down`}>↓</button>
                <button type="button" className="lead-reports-builder__delete" onClick={() => removeStage(i)} aria-label={`Remove ${s.label || 'stage'}`}>
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="lead-reports-builder__rules">
                {/* Placeholders carry an "e.g." prefix on purpose. They used to
                    read "Lead, Prospect" / "qualified, connected", which are
                    plausible real rules — on a config screen whose whole job is
                    showing what IS set, an empty field that looks filled is a
                    trap. */}
                <label>
                  Contact statuses
                  <input className="input-field" placeholder="e.g. Lead, Prospect" value={csvList(s.statuses)} onChange={(e) => updateStage(i, { statuses: parseCsv(e.target.value) })} />
                </label>
                <label>
                  Call statuses
                  <input className="input-field" placeholder="e.g. qualified, connected" value={csvList(s.callStatuses)} onChange={(e) => updateStage(i, { callStatuses: parseCsv(e.target.value) })} />
                </label>
                <label>
                  Minimum lead score
                  <input
                    type="number"
                    min="0"
                    max="100"
                    className="input-field"
                    placeholder="e.g. 70"
                    value={s.minScore ?? ''}
                    onChange={(e) => updateStage(i, { minScore: e.target.value === '' ? undefined : Number(e.target.value) })}
                  />
                </label>
              </div>
              <p className="lead-reports-builder__summary">
                {describeStage(s) || 'No rule yet — this stage will be rejected on save.'}
              </p>
            </div>
          ))}
        </div>

        {/* Sticky: with 8 stages the Save button sat below the fold, so saving
            meant scrolling past every stage to find it. */}
        <div className="lead-reports-builder__foot">
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn-secondary" onClick={addStage} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <Plus size={15} /> Add stage
            </button>
            <button type="button" className="btn-secondary" onClick={onReset} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <RefreshCw size={15} /> Reset to defaults
            </button>
          </div>
          <button type="button" className="btn-primary" onClick={onSave} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            <Save size={15} /> {saving ? 'Saving…' : 'Save stages'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 10. Daily meetings & site visits ────────────────────────────────

function VisitsTab({ d }) {
  const s = d.summary || {};
  return (
    <div className="lead-reports-page__sections">
      <StatRow>
        <Stat label="Scheduled" value={num(s.scheduled)} />
        <Stat label="Completed" value={num(s.completed)} tone={toneIf(s.completed, 'success')} hint={pct(s.completionRate)} />
        <Stat label="Still pending" value={num(s.pending)} tone={toneIf(s.pending, 'warning')} />
        <Stat label="Overdue" value={num(s.overdue)} tone={toneIf(s.overdue, 'danger')} />
        <Stat label="Booked" value={num(s.booked)} tone={toneIf(s.booked, 'success')} hint={`${pct(s.bookingRate)} of completed`} />
        <Stat label="No shows" value={num(s.noShow)} tone={toneIf(s.noShow, 'danger')} />
        <Stat label="Awaiting outcome" value={num(s.awaitingOutcome)} tone={toneIf(s.awaitingOutcome, 'warning')} hint="Visit done, result not logged" />
        {Number(s.untyped) > 0 && (
          <Stat label="No Type set" value={num(s.untyped)} tone="warning" hint="Matched on title — set Type for exact counts" />
        )}
      </StatRow>

      <Panel
        title="Meetings & site visits"
        subtitle="Built from the Task Queue — any task whose Type is Meeting or Site Visit, due inside the selected window. Older tasks with no Type set are matched on their title."
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <ScheduleVisitLink type="Site Visit" />
            <ScheduleVisitLink type="Meeting" />
          </div>
        }
      >
        <Table
          minWidth="980px"
          columns={[
            { key: 'when', label: 'When', numeric: true },
            { key: 'type', label: 'Type' },
            { key: 'title', label: 'Purpose' },
            { key: 'contact', label: 'Client' },
            { key: 'owner', label: 'Owner' },
            { key: 'state', label: 'State' },
            { key: 'outcome', label: 'Outcome' },
          ]}
          rows={d.visits || []}
          renderRow={(v) => (
            <tr key={v.taskId}>
              <td className="is-numeric">{day(v.dueDate)}</td>
              <td>
                {/* An inferred type is a guess from the title, not a fact —
                    render it muted with a tooltip so it doesn't read as though
                    someone set it. */}
                <span title={v.visitTypeSource === 'inferred' ? 'Type not set on this task — matched on its title' : undefined}>
                  <Pill tone={v.visitTypeSource === 'inferred' ? 'neutral' : 'info'}>
                    {v.visitType}{v.visitTypeSource === 'inferred' ? ' ?' : ''}
                  </Pill>
                </span>
              </td>
              <td>{v.title}</td>
              <td>
                <div className="is-strong">{v.contactName || '—'}</div>
                {v.contactPhone ? <div className="lead-reports-page__muted">{v.contactPhone}</div> : null}
              </td>
              <td>{v.owner}</td>
              <td>
                {v.state === 'completed' ? <Pill tone="success">Done</Pill>
                  : v.state === 'overdue' ? <Pill tone="danger">Overdue</Pill>
                    : v.state === 'due_today' ? <Pill tone="warning">Today</Pill>
                      : <Pill tone="neutral">Scheduled</Pill>}
              </td>
              <td>{OUTCOME_LABELS[v.outcome] || v.outcome}</td>
            </tr>
          )}
          empty="No meetings or site visits due in this window. Widen the window with the dropdown above, or schedule one from the Task Queue."
        />
      </Panel>

      <Panel title="By owner">
        <Table
          minWidth="640px"
          columns={[
            { key: 'name', label: 'Owner' },
            { key: 'scheduled', label: 'Scheduled', numeric: true },
            { key: 'completed', label: 'Completed', numeric: true },
            { key: 'overdue', label: 'Overdue', numeric: true },
            { key: 'booked', label: 'Booked', numeric: true },
            { key: 'rate', label: 'Booking rate', numeric: true },
          ]}
          rows={d.byOwner || []}
          renderRow={(o) => (
            <tr key={o.userId || 'unassigned'}>
              <td className="is-strong">{o.name}</td>
              <td className="is-numeric">{num(o.scheduled)}</td>
              <td className="is-numeric">{num(o.completed)}</td>
              <td className={`is-numeric${o.overdue > 0 ? ' is-danger' : ''}`}>{num(o.overdue)}</td>
              <td className="is-numeric">{num(o.booked)}</td>
              <td className="is-numeric">{pct(o.bookingRate)}</td>
            </tr>
          )}
          empty="No visits assigned in this window."
        />
      </Panel>
    </div>
  );
}

// ─── 11. Visit done, not booked ──────────────────────────────────────

function NotBookedTab({ d }) {
  const s = d.summary || {};
  return (
    <div className="lead-reports-page__sections">
      <StatRow>
        <Stat label="Visits completed" value={num(s.visitsDone)} />
        <Stat label="Booked" value={num(s.booked)} tone={toneIf(s.booked, 'success')} hint={pct(s.bookingRate)} />
        <Stat label="Not booked" value={num(s.notBooked)} tone={toneIf(s.notBooked, 'danger')} />
        <Stat label="In a nurture sequence" value={num(s.inNurture)} tone={toneIf(s.inNurture, 'success')} hint={`${pct(s.nurtureCoverage)} coverage`} />
        <Stat label="Not being nurtured" value={num(s.notNurtured)} tone={toneIf(s.notNurtured, 'warning')} />
        <Stat label="No follow-up booked" value={num(s.noFollowUpScheduled)} tone={toneIf(s.noFollowUpScheduled, 'danger')} />
      </StatRow>

      <Panel
        title="Visited but did not book"
        subtitle="The recovery queue — longest since the visit first. Enrol these in a sequence from Sequences, or book the next follow-up from the Task Queue."
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <ScheduleVisitLink type="Follow Up">Book a follow-up</ScheduleVisitLink>
            <Link
              to="/sequences"
              className="btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', textDecoration: 'none' }}
            >
              <RefreshCw size={15} /> Nurture sequences
            </Link>
          </div>
        }
      >
        <Table
          minWidth="1080px"
          columns={[
            { key: 'name', label: 'Client' },
            { key: 'owner', label: 'Owner' },
            { key: 'visit', label: 'Visited', numeric: true },
            { key: 'since', label: 'Days since', numeric: true },
            { key: 'outcome', label: 'Visit outcome' },
            { key: 'last', label: 'Last activity', numeric: true },
            { key: 'next', label: 'Next follow-up', numeric: true },
            { key: 'nurture', label: 'Nurturing' },
          ]}
          rows={d.leads || []}
          renderRow={(r) => (
            <tr key={r.contactId}>
              <td>
                <div className="is-strong">{r.name}</div>
                {r.phone || r.email ? <div className="lead-reports-page__muted">{r.phone || r.email}</div> : null}
              </td>
              <td>{r.owner}</td>
              <td className="is-numeric">{day(r.lastVisitAt)}</td>
              <td className="is-numeric is-strong">{r.daysSinceVisit}</td>
              <td>{OUTCOME_LABELS[r.visitOutcome] || r.visitOutcome}</td>
              <td className="is-numeric">{r.lastActivityAt ? day(r.lastActivityAt) : 'Never'}</td>
              <td className="is-numeric">
                {r.nextFollowUpAt ? day(r.nextFollowUpAt) : <span className="is-danger">None</span>}
              </td>
              <td>
                {r.inNurture
                  ? <Pill tone="success">{r.nurtureSequence || 'Active'}</Pill>
                  : <Pill tone="warning">Not enrolled</Pill>}
              </td>
            </tr>
          )}
          empty="Every completed visit converted, or no visits were completed in this period."
        />
      </Panel>

      <Panel title="By owner">
        <Table
          minWidth="580px"
          columns={[
            { key: 'name', label: 'Owner' },
            { key: 'visits', label: 'Visits', numeric: true },
            { key: 'booked', label: 'Booked', numeric: true },
            { key: 'notBooked', label: 'Not booked', numeric: true },
            { key: 'rate', label: 'Booking rate', numeric: true },
          ]}
          rows={d.byOwner || []}
          renderRow={(o) => (
            <tr key={o.userId || 'unassigned'}>
              <td className="is-strong">{o.name}</td>
              <td className="is-numeric">{num(o.visits)}</td>
              <td className="is-numeric">{num(o.booked)}</td>
              <td className={`is-numeric${o.notBooked > 0 ? ' is-danger' : ''}`}>{num(o.notBooked)}</td>
              <td className="is-numeric">{pct(o.bookingRate)}</td>
            </tr>
          )}
          empty="No completed visits in this period."
        />
      </Panel>
    </div>
  );
}
