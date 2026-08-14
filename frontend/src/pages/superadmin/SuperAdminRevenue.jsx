import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { formatMoney } from "../../utils/money";
import CalendarRangePicker from "../../components/CalendarRangePicker";

function SummaryCard({ label, value, hint }) {
  return (
    <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.25rem" }}>
      <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{label}</div>
      <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{value}</div>
      {hint ? <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{hint}</div> : null}
    </div>
  );
}

function buildQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== "") query.set(key, String(value));
  });
  const text = query.toString();
  return text ? `?${text}` : "";
}

export default function SuperAdminRevenue() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [summary, setSummary] = useState(null);
  const [filters, setFilters] = useState({ from: "", to: "" });

  const load = async (nextFilters = filters) => {
    setLoading(true);
    setMessage("");
    try {
      const res = await superAdminFetch(`/tenant-management/revenue/summary${buildQuery(nextFilters)}`);
      setSummary(res);
    } catch (err) {
      setMessage(err.message || "Failed to load revenue analytics.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = summary?.totals || { platformRevenue: 0, aiRevenue: 0, combinedRevenue: 0, currentPlatformMRR: 0 };
  const monthlyTrend = summary?.monthlyTrend || [];
  const planMix = summary?.planMix || [];
  const topTenants = summary?.topTenants || [];

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <header>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <TrendingUp size={24} color="var(--accent-color)" /> Revenue Analytics
        </h1>
        <p style={{ margin: "0.4rem 0 0 0", color: "var(--text-secondary)" }}>
          Combined revenue from CRM platform subscriptions and AI credit purchases. Only real payments count —
          manually-granted subscriptions and manual AI credit adjustments are excluded automatically.
        </p>
      </header>

      {message && (
        <div className="card" style={{ padding: "0.85rem 1rem", borderLeft: `4px solid #ef4444` }}>
          {message}
        </div>
      )}

      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.75rem", overflow: "visible", position: "relative", zIndex: 20 }}>
        <div style={{ fontWeight: 700 }}>Date range</div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <CalendarRangePicker
            value={{ from: filters.from, to: filters.to }}
            onChange={(next) => setFilters({ from: next.from || "", to: next.to || "" })}
            label="All time"
          />
          <button className="btn-primary" onClick={() => load(filters)}>Apply</button>
          <button className="btn-secondary" onClick={() => { const next = { from: "", to: "" }; setFilters(next); load(next); }}>Clear</button>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>Loading revenue analytics...</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.85rem" }}>
            <SummaryCard label="Combined revenue" value={formatMoney(totals.combinedRevenue, { currency: "INR" })} hint="Window total, platform + AI" />
            <SummaryCard label="Current platform MRR" value={formatMoney(totals.currentPlatformMRR, { currency: "INR" })} hint="Normalized to 30-day periods, active subs only" />
            <SummaryCard label="Platform revenue" value={formatMoney(totals.platformRevenue, { currency: "INR" })} hint="Window total" />
            <SummaryCard label="AI credit revenue" value={formatMoney(totals.aiRevenue, { currency: "INR" })} hint="Window total" />
          </div>

          <div className="card" style={{ padding: "1rem", height: 360 }}>
            <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>Monthly Revenue Trend</div>
            <div style={{ height: 300, minWidth: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyTrend}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="month" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} domain={[0, "auto"]} />
                  <Tooltip
                    contentStyle={{ background: "rgba(15,23,42,0.95)", border: "1px solid #334155", borderRadius: 8 }}
                    formatter={(value) => formatMoney(value, { currency: "INR" })}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="platformRevenue" name="Platform" stroke="#3987e5" strokeWidth={2.5} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="aiRevenue" name="AI Credits" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {!monthlyTrend.length && (
              <div style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
                No revenue in this window yet.
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1rem" }}>
            <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.5rem" }}>
              <div style={{ fontWeight: 700 }}>Plan Mix (active platform subscriptions)</div>
              {planMix.map((p) => (
                <div key={p.planName} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem" }}>
                  <span>{p.planName}</span>
                  <span>{p.count}</span>
                </div>
              ))}
              {!planMix.length && <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No active subscriptions.</div>}
            </div>

            <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.5rem" }}>
              <div style={{ fontWeight: 700 }}>Top Tenants by Revenue</div>
              {topTenants.map((t, i) => (
                <div key={t.tenantId} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem" }}>
                  <span>{i + 1}. {t.tenantName}</span>
                  <span>{formatMoney(t.revenue, { currency: "INR" })}</span>
                </div>
              ))}
              {!topTenants.length && <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No revenue in this window yet.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
