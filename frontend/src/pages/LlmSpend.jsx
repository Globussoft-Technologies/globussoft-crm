/**
 * LlmSpend.jsx — ADMIN-only LLM cost observability dashboard.
 *
 * Surfaces the per-tenant LLM call rollups produced by
 * backend/routes/admin.js GET /api/admin/llm-spend?days=N (commit f5c9518).
 * The 4 LLM-router consumers in this codebase — talking-points, form-vs-call,
 * itinerary-draft, religious-guidance — log every call to LlmCallLog; the
 * endpoint aggregates totals, byDay timeline, byTask + byModel breakdowns.
 * Without this page admins can only inspect spend via a direct DB query.
 *
 * Endpoint shape (from backend/routes/admin.js:340-356):
 *   {
 *     days, from (ISO), to (ISO),
 *     totals: { calls, promptTokens, completionTokens, totalTokens,
 *               costEstimate, stubCalls, realCalls },
 *     byDay:   [{ date: YYYY-MM-DD, calls, totalTokens, costEstimate }],
 *     byTask:  [{ task,  calls, totalTokens, costEstimate }],
 *     byModel: [{ model, calls, totalTokens, costEstimate }],
 *   }
 *
 * ?days valid range is 1..90; out-of-range → 400 INVALID_RANGE. The window
 * <select> is constrained to {7,14,30,60,90} so the 400 path is defensive
 * only. Non-numeric values silently fall back to the default (7) on the
 * backend — never sent from this UI.
 *
 * Stub-mode caveat: today the LLM router is in stub mode so costEstimate
 * is 0 for every call. The dashboard is forward-compatible with real-mode
 * pricing — costs render with 4 decimals so sub-cent real-mode totals are
 * legible.
 */
import { useContext, useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { Activity } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';

const DAYS_OPTIONS = [7, 14, 30, 60, 90];

// Brand-aligned palette: teal primary (matches wellness theme & generic
// accent fallback) for the cost axis; warm gold (matches travel theme) for
// the calls overlay. Bar charts use the same two so the eye reads them as
// "cost vs calls" consistently across sections.
const COLOR_COST = '#265855';
const COLOR_CALLS = '#C89A4E';

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function formatCost(n) {
  return `$${Number(n || 0).toFixed(4)}`;
}

function formatIso(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function Tile({ label, value, sub }) {
  return (
    <div
      style={{
        background: 'var(--surface-color, rgba(255,255,255,0.04))',
        border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
        borderRadius: 10,
        padding: '1rem 1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.6rem',
          fontWeight: 600,
          fontFamily: 'var(--font-family, inherit)',
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, children, empty, emptyMessage }) {
  return (
    <div
      style={{
        background: 'var(--surface-color, rgba(255,255,255,0.04))',
        border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
        borderRadius: 10,
        padding: '1rem 1.25rem',
        minWidth: 0,
      }}
    >
      <h3
        style={{
          margin: 0,
          marginBottom: '0.75rem',
          fontSize: '0.95rem',
          fontWeight: 600,
        }}
      >
        {title}
      </h3>
      {empty ? (
        <div
          style={{
            padding: '2rem 0',
            textAlign: 'center',
            color: 'var(--text-secondary)',
            fontSize: '0.9rem',
          }}
        >
          {emptyMessage}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export default function LlmSpend() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchApi(`/api/admin/llm-spend?days=${days}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg =
          err?.body?.error ||
          err?.message ||
          'Failed to load LLM spend summary';
        notify.error(msg);
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // notify is stable from useNotify(); intentionally omit to avoid re-fetch loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  if (!isAdmin) {
    return (
      <div style={{ padding: '2rem' }}>
        LLM Spend requires admin access.
      </div>
    );
  }

  const totals = data?.totals || {};
  const byDay = data?.byDay || [];
  const byTask = data?.byTask || [];
  const byModel = data?.byModel || [];

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      {/* Header bar */}
      <header
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Activity size={28} color={COLOR_COST} aria-hidden="true" />
          <div>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--font-family, inherit)',
                fontSize: '1.75rem',
                fontWeight: 600,
              }}
            >
              LLM Spend
            </h1>
            <p
              style={{
                margin: 0,
                marginTop: '0.25rem',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
                maxWidth: 640,
              }}
            >
              Per-tenant LLM call rollups. Stub-mode calls have $0 cost; the
              dashboard is forward-compatible with real-mode pricing.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <label
            htmlFor="llm-spend-days"
            style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}
          >
            Window
          </label>
          <select
            id="llm-spend-days"
            aria-label="Days window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{
              padding: '0.45rem 0.6rem',
              background: 'var(--surface-color, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
              borderRadius: 8,
              color: 'var(--text-primary)',
              fontSize: '0.9rem',
            }}
          >
            {DAYS_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} days
              </option>
            ))}
          </select>
        </div>
      </header>

      {loading && !data ? (
        <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>
          Loading LLM spend…
        </div>
      ) : !data ? (
        <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>
          Could not load LLM spend summary.
        </div>
      ) : (
        <>
          {/* Summary tiles row */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: '1rem',
              marginBottom: '1.5rem',
            }}
          >
            <Tile
              label="Total calls"
              value={formatNumber(totals.calls)}
              sub={`${formatNumber(totals.realCalls)} real, ${formatNumber(
                totals.stubCalls,
              )} stub`}
            />
            <Tile
              label="Total tokens"
              value={formatNumber(totals.totalTokens)}
              sub={`Prompt ${formatNumber(
                totals.promptTokens,
              )} · Completion ${formatNumber(totals.completionTokens)}`}
            />
            <Tile
              label="Cost estimate"
              value={formatCost(totals.costEstimate)}
              sub="Stub-mode calls cost $0"
            />
            <Tile
              label="Window"
              value={`${data.days} days`}
              sub={`${formatIso(data.from)} → ${formatIso(data.to)}`}
            />
          </div>

          {/* Daily timeline chart */}
          <ChartCard
            title="Daily activity"
            empty={byDay.length === 0}
            emptyMessage="No LLM activity in the selected window."
          >
            <div style={{ width: '100%', height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={byDay}
                  margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="llmCostGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLOR_COST} stopOpacity={0.55} />
                      <stop offset="95%" stopColor={COLOR_COST} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="llmCallsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLOR_CALLS} stopOpacity={0.55} />
                      <stop offset="95%" stopColor={COLOR_CALLS} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(127,127,127,0.18)"
                  />
                  <XAxis
                    dataKey="date"
                    stroke="var(--text-secondary)"
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    yAxisId="cost"
                    orientation="left"
                    stroke={COLOR_COST}
                    tick={{ fontSize: 11 }}
                    domain={[0, 'auto']}
                    tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                  />
                  <YAxis
                    yAxisId="calls"
                    orientation="right"
                    stroke={COLOR_CALLS}
                    tick={{ fontSize: 11 }}
                    domain={[0, 'auto']}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(20,20,25,0.95)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 8,
                      color: '#fff',
                    }}
                    formatter={(value, name) => {
                      if (name === 'Cost estimate') return [formatCost(value), name];
                      return [formatNumber(value), name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area
                    yAxisId="cost"
                    type="monotone"
                    name="Cost estimate"
                    dataKey="costEstimate"
                    stroke={COLOR_COST}
                    fill="url(#llmCostGrad)"
                  />
                  <Area
                    yAxisId="calls"
                    type="monotone"
                    name="Calls"
                    dataKey="calls"
                    stroke={COLOR_CALLS}
                    fill="url(#llmCallsGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          {/* By task + by model side-by-side */}
          <div
            style={{
              marginTop: '1.5rem',
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
              gap: '1rem',
            }}
          >
            <ChartCard
              title="By task"
              empty={byTask.length === 0}
              emptyMessage="No task breakdown for this window."
            >
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={byTask}
                    margin={{ top: 8, right: 16, left: 0, bottom: 24 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(127,127,127,0.18)"
                    />
                    <XAxis
                      dataKey="task"
                      stroke="var(--text-secondary)"
                      tick={{ fontSize: 11 }}
                      interval={0}
                      angle={-15}
                      textAnchor="end"
                      height={48}
                    />
                    <YAxis
                      stroke="var(--text-secondary)"
                      tick={{ fontSize: 11 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'rgba(20,20,25,0.95)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 8,
                        color: '#fff',
                      }}
                      formatter={(value, name, item) => {
                        const row = item?.payload || {};
                        return [
                          `${formatNumber(value)} calls · ${formatNumber(
                            row.totalTokens,
                          )} tokens · ${formatCost(row.costEstimate)}`,
                          'Activity',
                        ];
                      }}
                    />
                    <Bar dataKey="calls" name="Calls" fill={COLOR_CALLS} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <ChartCard
              title="By model"
              empty={byModel.length === 0}
              emptyMessage="No model breakdown for this window."
            >
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={byModel}
                    margin={{ top: 8, right: 16, left: 0, bottom: 24 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(127,127,127,0.18)"
                    />
                    <XAxis
                      dataKey="model"
                      stroke="var(--text-secondary)"
                      tick={{ fontSize: 11 }}
                      interval={0}
                      angle={-15}
                      textAnchor="end"
                      height={48}
                    />
                    <YAxis
                      stroke="var(--text-secondary)"
                      tick={{ fontSize: 11 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'rgba(20,20,25,0.95)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 8,
                        color: '#fff',
                      }}
                      formatter={(value, name, item) => {
                        const row = item?.payload || {};
                        return [
                          `${formatNumber(value)} calls · ${formatNumber(
                            row.totalTokens,
                          )} tokens · ${formatCost(row.costEstimate)}`,
                          'Activity',
                        ];
                      }}
                    />
                    <Bar dataKey="calls" name="Calls" fill={COLOR_COST} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
