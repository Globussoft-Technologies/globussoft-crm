import { useEffect, useState, useCallback } from "react";
import {
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import { RefreshCw } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";

const DAY_OPTIONS = [7, 14, 30, 90];
const STATUS_COLORS = { success: "#6fcf73", failed: "#f28b82", running: "#60a5fa" };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Custom tooltip for the runs-over-time bar chart — states plainly which
// statuses occurred (a flat-zero line for "failed"/"running" reads as
// invisible on the chart itself, so the exact counts need to live here) and
// flags today's bar as a partial/in-progress day so a lower bar there isn't
// misread as "activity dropped".
function RunsOverTimeTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  const isToday = label === todayKey();
  return (
    <div style={{ background: "#1a1d24", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12, padding: "0.5rem 0.65rem", borderRadius: 6 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        {label}
        {isToday && <span style={{ color: "#f2b82e", fontWeight: 400 }}> (today — still in progress)</span>}
      </div>
      <div style={{ color: STATUS_COLORS.success }}>Success: {row.success}</div>
      <div style={{ color: STATUS_COLORS.failed }}>Failed: {row.failed}</div>
      <div style={{ color: STATUS_COLORS.running }}>Running: {row.running}</div>
      <div style={{ marginTop: 2, fontWeight: 700 }}>Total: {row.total}</div>
    </div>
  );
}

function Card({ title, children, right }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
        borderRadius: 10,
        padding: "1rem 1.1rem",
        background: "var(--card-bg, rgba(255,255,255,0.02))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <h3 style={{ fontSize: "0.85rem", fontWeight: 700, margin: 0 }}>{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function StatTile({ label, value, color }) {
  return (
    <div style={{ flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-secondary, #9aa0ab)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, color: color || "inherit" }}>{value}</div>
    </div>
  );
}

export default function SuperAdminCronAnalytics() {
  const notify = useNotify();
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // "Runs over time" gets its OWN date range, independent of the page-level
  // selector above — that selector also drives the stat tiles, pie chart,
  // and per-cron table, so widening it just to see a longer trend line would
  // change every other number on the page too. Defaults to 30 days since a
  // 2-day window renders as noise (see the ≤2-day warning below).
  const [chartDays, setChartDays] = useState(30);
  const [chartData, setChartData] = useState(null);
  const [chartLoading, setChartLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await superAdminFetch(`/cron-analytics/overview?days=${days}`);
      setData(res);
    } catch (e) {
      notify.error(e.message);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const loadChart = useCallback(async () => {
    setChartLoading(true);
    try {
      const res = await superAdminFetch(`/cron-analytics/overview?days=${chartDays}`);
      setChartData(res);
    } catch (e) {
      notify.error(e.message);
    }
    setChartLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartDays]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadChart();
  }, [loadChart]);

  const pieData = data
    ? [
        { name: "Success", value: data.totals.success, color: STATUS_COLORS.success },
        { name: "Failed", value: data.totals.failed, color: STATUS_COLORS.failed },
        { name: "Running", value: data.totals.running, color: STATUS_COLORS.running },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <div>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>Cron Analytics</h1>
          <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.85rem", margin: "4px 0 0" }}>
            Run volume, success/failure rate, and duration trends across every cron engine.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select className="input-field" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 140 }}>
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
          <button className="btn-secondary" onClick={load} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </header>

      {loading && !data ? (
        <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>Loading…</p>
      ) : !data ? (
        <p style={{ color: "#f28b82" }}>Failed to load analytics.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <StatTile label="Total Runs" value={data.totals.runs} />
            <StatTile label="Success" value={data.totals.success} color={STATUS_COLORS.success} />
            <StatTile label="Failed" value={data.totals.failed} color={STATUS_COLORS.failed} />
            <StatTile label="Running" value={data.totals.running} color={STATUS_COLORS.running} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: "1rem" }}>
            <Card
              title="Runs over time"
              right={
                <select
                  className="input-field"
                  value={chartDays}
                  onChange={(e) => setChartDays(Number(e.target.value))}
                  style={{ width: 130, fontSize: "0.78rem", padding: "0.3rem 0.5rem" }}
                >
                  {DAY_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      Last {d} days
                    </option>
                  ))}
                </select>
              }
            >
              {chartLoading && !chartData ? (
                <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.8rem" }}>Loading…</p>
              ) : !chartData ? (
                <p style={{ color: "#f28b82", fontSize: "0.8rem" }}>Failed to load.</p>
              ) : (
                <>
                  {chartData.byDay.length <= 2 && (
                    <p style={{ fontSize: "0.75rem", color: "var(--text-secondary, #9aa0ab)", margin: "0 0 0.5rem" }}>
                      Only {chartData.byDay.length} day{chartData.byDay.length === 1 ? "" : "s"} of data in this window — pick a wider range above to see a real trend.
                    </p>
                  )}
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={chartData.byDay}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip content={<RunsOverTimeTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="success" name="Success" stackId="runs" fill={STATUS_COLORS.success} />
                      <Bar dataKey="failed" name="Failed" stackId="runs" fill={STATUS_COLORS.failed} />
                      <Bar dataKey="running" name="Running" stackId="runs" fill={STATUS_COLORS.running} />
                    </BarChart>
                  </ResponsiveContainer>
                </>
              )}
            </Card>

            <Card title="Status split">
              {pieData.length === 0 ? (
                <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.8rem" }}>No runs in this window.</p>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(e) => `${e.name}: ${e.value}`}>
                      {pieData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#1a1d24", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </Card>
          </div>

          <Card title="Per-cron summary">
            <ResponsiveContainer width="100%" height={Math.max(200, data.perCron.length * 32)}>
              <BarChart data={data.perCron} layout="vertical" margin={{ left: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="cronName" tick={{ fontSize: 10 }} width={160} />
                <Tooltip contentStyle={{ background: "#1a1d24", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="runs" fill="#60a5fa" name="Runs" />
                <Bar dataKey="failures" fill={STATUS_COLORS.failed} name="Failures" />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Average duration by cron (ms)">
            <TopScrollSync>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
                    <th style={{ textAlign: "left", padding: "0.4rem 0.6rem" }}>Cron</th>
                    <th style={{ textAlign: "right", padding: "0.4rem 0.6rem" }}>Runs</th>
                    <th style={{ textAlign: "right", padding: "0.4rem 0.6rem" }}>Failures</th>
                    <th style={{ textAlign: "right", padding: "0.4rem 0.6rem" }}>Avg Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perCron.map((c) => (
                    <tr key={c.cronName} style={{ borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.05))" }}>
                      <td style={{ padding: "0.4rem 0.6rem", fontWeight: 600 }}>{c.cronName}</td>
                      <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>{c.runs}</td>
                      <td style={{ padding: "0.4rem 0.6rem", textAlign: "right", color: c.failures > 0 ? STATUS_COLORS.failed : "inherit" }}>{c.failures}</td>
                      <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>{c.avgDurationMs != null ? `${c.avgDurationMs}ms` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TopScrollSync>
          </Card>
        </div>
      )}
    </div>
  );
}
