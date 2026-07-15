import { useEffect, useState, useCallback } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
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
import { RefreshCw, ListFilter } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { useNotify } from "../../utils/notify";
import CalendarRangePicker from "../../components/CalendarRangePicker";

const DAY_OPTIONS = [7, 14, 30, 90];
// Dark-mode categorical steps from the validated reference palette (8 slots,
// worst-adjacent CVD ΔE 10.3 — see dataviz skill's palette.md). "unknown" is
// a fallback/status color, not a categorical identity, so it's excluded from
// the 8-slot budget and doesn't compete with real providers for a hue.
const PROVIDER_COLORS = {
  gemini: "#3987e5", // blue
  openai: "#199e70", // aqua
  serpapi: "#c98500", // yellow
  anthropic: "#008300", // green
  tripgo: "#9085e9", // violet
  perplexity: "#e66767", // red
  zoom: "#d55181", // magenta
  razorpay: "#d95926", // orange
  groq: "#f2b82e", // 9th provider — reuses a non-adjacent existing hue rather than a generated color
  unknown: "#9aa0ab",
};
const colorFor = (p) => PROVIDER_COLORS[p] || "#9aa0ab";

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

function StatTile({ label, value, color, hint }) {
  return (
    <div style={{ flex: 1, minWidth: 120 }} title={hint}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-secondary, #9aa0ab)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, color: color || "inherit" }}>{value}</div>
    </div>
  );
}

function fmtCost(n) {
  if (n == null) return "—";
  return `$${Number(n).toFixed(n < 1 ? 6 : 2)}`;
}

// Custom tooltip for "Cost by model" — shows the EXACT model id (the raw
// string stored on LlmCallLog.model, e.g. "gemini-2.5-flash-lite" vs the
// shorter "gemini-flash" bucket) plus provider/calls/tokens/cost together,
// since the default Recharts formatter only ever shows the one hovered series.
function ModelCostTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: "#1a1d24", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12, padding: "0.5rem 0.65rem", borderRadius: 6 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Model ID: {row.model}</div>
      <div>
        Provider: <span style={{ color: colorFor(row.provider), fontWeight: 700 }}>{row.provider}</span>
      </div>
      <div>Calls: {row.calls}</div>
      <div>Tokens: {row.tokens.toLocaleString()}</div>
      <div>Failures: {row.failures}</div>
      <div style={{ color: "#f2b82e", fontWeight: 700, marginTop: 2 }}>Cost: {fmtCost(row.cost)}</div>
    </div>
  );
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export default function SuperAdminApiAnalytics() {
  const notify = useNotify();
  const [tab, setTab] = useState("overview"); // 'overview' | 'calls' | 'settings'
  const [days, setDays] = useState(14);
  // A custom date/range from the calendar picker always overrides `days`
  // entirely — set together as one piece of state so "pick a range" and
  // "pick a preset" can't disagree about which one is active.
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [filterOptions, setFilterOptions] = useState({ providers: [], models: [] });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateRange.from || dateRange.to) {
        if (dateRange.from) params.set("from", dateRange.from);
        if (dateRange.to) params.set("to", dateRange.to);
      } else {
        params.set("days", String(days));
      }
      if (providerFilter) params.set("provider", providerFilter);
      if (modelFilter) params.set("model", modelFilter);
      const res = await superAdminFetch(`/api-analytics/overview?${params.toString()}`);
      setData(res);
    } catch (e) {
      notify.error(e.message);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, dateRange, providerFilter, modelFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (providerFilter) params.set("provider", providerFilter);
    superAdminFetch(`/api-analytics/filters?${params.toString()}`)
      .then((opts) => {
        setFilterOptions(opts);
        // If the currently-selected model doesn't belong to the newly
        // scoped list (e.g. provider changed to "openai" while "gemini-flash"
        // was selected), clear it rather than silently querying an
        // impossible combination that always returns zero results.
        setModelFilter((current) => (current && !opts.models.includes(current) ? "" : current));
      })
      .catch(() => {}); // non-fatal — dropdowns just stay empty
  }, [providerFilter]);

  const providerPie = data ? data.byProvider.map((p) => ({ name: p.provider, value: p.calls, color: colorFor(p.provider) })) : [];

  return (
    <div>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>API Analytics</h1>
          <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.85rem", margin: "4px 0 0" }}>
            Every external API call (Gemini, OpenAI, Anthropic, Perplexity, Groq, SerpApi, TripGo, Zoom, Razorpay) — tokens, cost, and failures.
          </p>
        </div>
        {tab === "overview" && (
          <button className="btn-secondary" onClick={load} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <RefreshCw size={15} /> Refresh
          </button>
        )}
      </header>

      {tab === "overview" && (
        // Filter row — one row, above everything, scopes every chart/stat
        // below it so the numbers always agree with each other.
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: "1rem" }}>
          <select
            className="input-field"
            value={dateRange.from || dateRange.to ? "" : days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setDateRange({ from: "", to: "" }); // preset always wins over a custom range
            }}
            style={{ width: 140 }}
          >
            {(dateRange.from || dateRange.to) && <option value="">Custom range</option>}
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
          <CalendarRangePicker value={dateRange} onChange={setDateRange} label="Pick date / range" />
          <select className="input-field" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} style={{ width: 170 }}>
            <option value="">All providers</option>
            {filterOptions.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select className="input-field" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} style={{ width: 200 }}>
            <option value="">All models</option>
            {filterOptions.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {(providerFilter || modelFilter || dateRange.from || dateRange.to) && (
            <button
              className="btn-secondary"
              onClick={() => {
                setProviderFilter("");
                setModelFilter("");
                setDateRange({ from: "", to: "" });
              }}
              style={{ fontSize: "0.8rem" }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: "1rem", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
        {[
          { key: "overview", label: "Overview" },
          { key: "calls", label: "Call Log" },
          { key: "settings", label: "Log Retention" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t.key ? "2px solid var(--accent-color, #3b82f6)" : "2px solid transparent",
              color: tab === t.key ? "var(--accent-color, #3b82f6)" : "var(--text-primary, #fff)",
              padding: "0.6rem 0.9rem",
              fontSize: "0.85rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" &&
        (loading && !data ? (
          <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>Loading…</p>
        ) : !data ? (
          <p style={{ color: "#f28b82" }}>Failed to load analytics.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              <StatTile label="Total Calls" value={data.totals.calls} />
              <StatTile label="Success" value={data.totals.success} color="#6fcf73" />
              <StatTile label="Failures" value={data.totals.failures} color="#f28b82" />
              <StatTile label="Total Tokens" value={data.totals.tokens.toLocaleString()} />
              <StatTile label="Estimated Cost" value={fmtCost(data.totals.cost)} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: "1rem" }}>
              <Card title="Calls over time">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.byDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "#1a1d24", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="total" name="Calls" stroke="#60a5fa" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="failed" name="Failed" stroke="#f28b82" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Cost over time">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.byDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtCost(v)} />
                    <Tooltip contentStyle={{ background: "#1a1d24", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} formatter={(v) => fmtCost(v)} />
                    <Line type="monotone" dataKey="cost" name="Cost" stroke="#f2b82e" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Calls by provider">
                {providerPie.length === 0 ? (
                  <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.8rem" }}>No calls in this window.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie data={providerPie} dataKey="value" nameKey="name" cx="40%" cy="50%" outerRadius={90} label={false}>
                        {providerPie.map((d) => (
                          <Cell key={d.name} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: "#1a1d24", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} />
                      <Legend
                        layout="vertical"
                        align="right"
                        verticalAlign="middle"
                        formatter={(value, entry) => (
                          <span style={{ color: entry.color, fontSize: 12 }}>{`${value}: ${entry.payload.value}`}</span>
                        )}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </Card>
            </div>

            <Card title="Cost by model">
              {data.byModel.length === 0 ? (
                <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.8rem" }}>No real (non-stub) LLM calls in this window.</p>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={Math.max(200, data.byModel.length * 32)}>
                    <BarChart data={data.byModel} layout="vertical" margin={{ left: 40 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="model" tick={{ fontSize: 10 }} width={180} />
                      <Tooltip content={<ModelCostTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="cost" fill="#f2b82e" name="cost" />
                    </BarChart>
                  </ResponsiveContainer>

                  <div style={{ overflowX: "auto", marginTop: "0.85rem" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
                          <th style={{ textAlign: "left", padding: "0.4rem 0.6rem" }}>Model</th>
                          <th style={{ textAlign: "left", padding: "0.4rem 0.6rem" }}>Provider</th>
                          <th style={{ textAlign: "right", padding: "0.4rem 0.6rem" }}>Hits (calls)</th>
                          <th style={{ textAlign: "right", padding: "0.4rem 0.6rem" }}>Tokens</th>
                          <th style={{ textAlign: "right", padding: "0.4rem 0.6rem" }}>Failures</th>
                          <th style={{ textAlign: "right", padding: "0.4rem 0.6rem" }}>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byModel.map((m) => (
                          <tr key={m.model} style={{ borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.05))" }}>
                            <td style={{ padding: "0.4rem 0.6rem", fontWeight: 600 }}>{m.model}</td>
                            <td style={{ padding: "0.4rem 0.6rem", color: colorFor(m.provider), fontWeight: 700 }}>{m.provider}</td>
                            <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>{m.calls}</td>
                            <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>{m.tokens.toLocaleString()}</td>
                            <td style={{ padding: "0.4rem 0.6rem", textAlign: "right", color: m.failures > 0 ? "#f28b82" : "inherit" }}>{m.failures}</td>
                            <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>{fmtCost(m.cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>

            <Card title="Recent failures — what & why">
              {data.recentFailures.length === 0 ? (
                <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.8rem" }}>No failures in this window.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
                        <th style={{ textAlign: "left", padding: "0.4rem 0.6rem" }}>When</th>
                        <th style={{ textAlign: "left", padding: "0.4rem 0.6rem" }}>Provider</th>
                        <th style={{ textAlign: "left", padding: "0.4rem 0.6rem" }}>Model / Endpoint</th>
                        <th style={{ textAlign: "left", padding: "0.4rem 0.6rem" }}>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentFailures.map((f, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.05))" }}>
                          <td style={{ padding: "0.4rem 0.6rem", whiteSpace: "nowrap" }}>{fmtDate(f.createdAt)}</td>
                          <td style={{ padding: "0.4rem 0.6rem" }}>
                            <span style={{ color: colorFor(f.provider), fontWeight: 700 }}>{f.provider}</span>
                          </td>
                          <td style={{ padding: "0.4rem 0.6rem" }}>{f.model || "—"}</td>
                          <td style={{ padding: "0.4rem 0.6rem", color: "#f28b82", maxWidth: 400 }}>{f.errorMessage || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ))}

      {tab === "calls" && <CallLogTab />}
      {tab === "settings" && <RetentionSettingsTab />}
    </div>
  );
}

function CallLogTab() {
  const notify = useNotify();
  const [calls, setCalls] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ provider: "", model: "", status: "", search: "", from: "", to: "" });
  const [filterOptions, setFilterOptions] = useState({ providers: [], models: [] });
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      const data = await superAdminFetch(`/api-analytics/calls?${params.toString()}`);
      setCalls(data.calls || []);
      setTotal(data.total || 0);
    } catch (e) {
      notify.error(e.message);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filters]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.provider) params.set("provider", filters.provider);
    superAdminFetch(`/api-analytics/filters?${params.toString()}`)
      .then((opts) => {
        setFilterOptions(opts);
        // Same rule as the Overview tab — a model belonging to a different
        // provider than the one now selected would silently 0-result the query.
        setFilters((f) => (f.model && !opts.models.includes(f.model) ? { ...f, model: "" } : f));
      })
      .catch(() => {});
  }, [filters.provider]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "1rem", alignItems: "center" }}>
        <ListFilter size={15} color="var(--text-secondary, #9aa0ab)" />
        <select
          className="input-field"
          style={{ width: 160 }}
          value={filters.provider}
          onChange={(e) => {
            setFilters((f) => ({ ...f, provider: e.target.value }));
            setPage(1);
          }}
        >
          <option value="">All providers</option>
          {filterOptions.providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="input-field"
          style={{ width: 200 }}
          value={filters.model}
          onChange={(e) => {
            setFilters((f) => ({ ...f, model: e.target.value }));
            setPage(1);
          }}
        >
          <option value="">All models</option>
          {filterOptions.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          className="input-field"
          style={{ width: 140 }}
          value={filters.status}
          onChange={(e) => {
            setFilters((f) => ({ ...f, status: e.target.value }));
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
        <input
          className="input-field"
          style={{ width: 220 }}
          placeholder="Search model/task/error…"
          value={filters.search}
          onChange={(e) => {
            setFilters((f) => ({ ...f, search: e.target.value }));
            setPage(1);
          }}
        />
      </div>

      {loading ? (
        <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>Loading…</p>
      ) : calls.length === 0 ? (
        <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>No calls match these filters.</p>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid var(--border-color, rgba(255,255,255,0.08))", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead style={{ background: "rgba(107,114,128,0.08)" }}>
              <tr>
                {["When", "Source", "Provider", "Model/Endpoint", "Status", "Tokens", "Cost", "Error"].map((h) => (
                  <th key={h} style={{ padding: "0.5rem 0.6rem", textAlign: "left", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
                  <td style={{ padding: "0.45rem 0.6rem", whiteSpace: "nowrap" }}>{fmtDate(c.createdAt)}</td>
                  <td style={{ padding: "0.45rem 0.6rem" }}>{c.source === "llm" ? "LLM" : "API"}</td>
                  <td style={{ padding: "0.45rem 0.6rem", color: colorFor(c.provider), fontWeight: 700 }}>{c.provider}</td>
                  <td style={{ padding: "0.45rem 0.6rem" }}>{c.model || "—"}</td>
                  <td style={{ padding: "0.45rem 0.6rem" }}>
                    <span style={{ color: c.status === "failed" ? "#f28b82" : "#6fcf73", fontWeight: 700 }}>{c.status}</span>
                    {c.stub && <span style={{ marginLeft: 6, fontSize: "0.65rem", color: "#9aa0ab" }}>STUB</span>}
                  </td>
                  <td style={{ padding: "0.45rem 0.6rem" }}>{c.totalTokens || "—"}</td>
                  <td style={{ padding: "0.45rem 0.6rem" }}>{fmtCost(c.cost)}</td>
                  <td style={{ padding: "0.45rem 0.6rem", color: "#f28b82", maxWidth: 300 }}>{c.errorMessage || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: "0.75rem", fontSize: "0.8rem" }}>
        <span>{total} total calls</span>
        <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Prev
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

function RetentionSettingsTab() {
  const notify = useNotify();
  const [retainDays, setRetainDays] = useState(30);
  const [custom, setCustom] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const presets = [7, 15, 30, 60, 90];

  useEffect(() => {
    superAdminFetch("/api-analytics/settings/log-retention")
      .then((d) => setRetainDays(d.retainDays))
      .finally(() => setLoading(false));
  }, []);

  const save = async (days) => {
    setSaving(true);
    setSaved(false);
    try {
      await superAdminFetch("/api-analytics/settings/log-retention", {
        method: "PUT",
        body: JSON.stringify({ retainDays: days }),
      });
      setRetainDays(days);
      setSaved(true);
    } catch (e) {
      notify.error(e.message);
    }
    setSaving(false);
  };

  if (loading) return <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>Loading…</p>;

  return (
    <div style={{ maxWidth: 480 }}>
      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary, #9aa0ab)" }}>
        LLM + API call logs older than this window are purged automatically by the daily retention sweep (03:20).
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "1rem" }}>
        {presets.map((d) => (
          <button key={d} className={retainDays === d ? "btn-primary" : "btn-secondary"} onClick={() => save(d)} disabled={saving}>
            {d} days
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="input-field"
          type="number"
          min={1}
          max={3650}
          placeholder="Custom (1-3650)"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          style={{ width: 180 }}
        />
        <button
          className="btn-secondary"
          disabled={saving || !custom}
          onClick={() => {
            const n = parseInt(custom, 10);
            if (Number.isFinite(n)) save(n);
          }}
        >
          Save custom
        </button>
      </div>
      <p style={{ fontSize: "0.8rem", marginTop: "0.75rem" }}>
        Current setting: <strong>{retainDays} days</strong>
        {saved && <span style={{ color: "#6fcf73", marginLeft: 8 }}>Saved</span>}
      </p>
    </div>
  );
}
