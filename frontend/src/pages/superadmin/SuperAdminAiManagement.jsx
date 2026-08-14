import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  Minus,
  PauseCircle,
  Plus,
  PlayCircle,
  Search,
} from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import CalendarRangePicker from "../../components/CalendarRangePicker";
import { creditsToTokens, tokensToCredits } from "../../utils/aiCredits";

function fmtDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "-";
  }
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString();
}

function badgeStyle(status, enabled) {
  const normalized = String(status || "none").toLowerCase();
  if (enabled || normalized === "active") {
    return {
      background: "rgba(34,197,94,0.12)",
      border: "1px solid #22c55e",
      color: "#dcfce7",
    };
  }
  if (normalized === "pending" || normalized === "awaiting_payment" || normalized === "reviewed") {
    return {
      background: "rgba(245,158,11,0.12)",
      border: "1px solid #f59e0b",
      color: "#fde68a",
    };
  }
  return {
    background: "rgba(148,163,184,0.12)",
    border: "1px solid rgba(148,163,184,0.45)",
    color: "var(--text-primary)",
  };
}

function buildQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== "") query.set(key, String(value));
  });
  const text = query.toString();
  return text ? `?${text}` : "";
}

function SummaryCard({ label, value, hint }) {
  return (
    <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.25rem" }}>
      <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{label}</div>
      <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{value}</div>
      {hint ? <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{hint}</div> : null}
    </div>
  );
}

function TenantListView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [tenants, setTenants] = useState([]);
  const [summary, setSummary] = useState({ totalTenants: 0, activeRequestCount: 0, crmEnabledCount: 0, byokCount: 0 });
  const [filters, setFilters] = useState({
    search: searchParams.get("search") || "",
    requestStatus: searchParams.get("requestStatus") || "all",
    from: searchParams.get("from") || "",
    to: searchParams.get("to") || "",
  });

  const load = async (nextFilters = filters) => {
    setLoading(true);
    setMessage("");
    try {
      const res = await superAdminFetch(`/ai-management/tenants${buildQuery(nextFilters)}`);
      setTenants(Array.isArray(res?.tenants) ? res.tenants : []);
      setSummary(res?.summary || { totalTenants: 0, activeRequestCount: 0, crmEnabledCount: 0, byokCount: 0 });
    } catch (err) {
      setMessage(err.message || "Failed to load AI tenant overview.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const statusOptions = useMemo(
    () => ["all", "none", "pending", "reviewed", "awaiting_payment", "active", "suspended", "disabled", "cancelled", "rejected"],
    [],
  );

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <header>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <Bot size={24} color="var(--accent-color)" /> AI Management
        </h1>
        <p style={{ margin: "0.4rem 0 0 0", color: "var(--text-secondary)" }}>
          Review organizations using real AI usage data, then open any organization for pricing and lifecycle control.
        </p>
      </header>

      {message && (
        <div className="card" style={{ padding: "0.85rem 1rem", borderLeft: `4px solid ${/failed|error/i.test(message) ? "#ef4444" : "#22c55e"}` }}>
          {message}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.85rem" }}>
        <SummaryCard label="Organizations" value={fmtNumber(summary.totalTenants)} />
        <SummaryCard label="Active requests" value={fmtNumber(summary.activeRequestCount)} />
        <SummaryCard label="CRM AI enabled" value={fmtNumber(summary.crmEnabledCount)} />
        <SummaryCard label="Own API keys" value={fmtNumber(summary.byokCount)} />
      </div>

      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.85rem", overflow: "visible", position: "relative", zIndex: 20 }}>
        <div style={{ fontWeight: 700 }}>Filters</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem" }}>
          <div style={{ position: "relative" }}>
            <Search size={15} style={{ position: "absolute", left: 12, top: 12, color: "var(--text-secondary)" }} />
            <input
              className="input-field"
              type="text"
              placeholder="Search organization"
              value={filters.search}
              onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
              style={{ paddingLeft: "2.2rem" }}
            />
          </div>
          <select
            className="input-field"
            value={filters.requestStatus}
            onChange={(e) => setFilters((prev) => ({ ...prev, requestStatus: e.target.value }))}
            style={{ background: "var(--input-bg)" }}
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status === "all" ? "All statuses" : status.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <CalendarRangePicker
            value={{ from: filters.from, to: filters.to }}
            onChange={(next) => setFilters((prev) => ({ ...prev, from: next.from || "", to: next.to || "" }))}
            label="All time"
          />
        </div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          {filters.from || filters.to
            ? "The selected calendar range filters the organization list."
            : "Showing all-time data by default until you pick a date range."}
        </div>
        <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={() => { setSearchParams(filters, { replace: true }); load(filters); }}>Apply Filters</button>
          <button
            className="btn-secondary"
            onClick={() => {
              const next = { search: "", requestStatus: "all", from: "", to: "" };
              setFilters(next);
              setSearchParams(next, { replace: true });
              load(next);
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>Loading AI tenant overview...</div>
      ) : (
        <div style={{ display: "grid", gap: "0.85rem" }}>
          {tenants.map((tenant) => (
            <button
              key={tenant.tenantId}
              type="button"
              className="card"
              onClick={() => navigate(`/super-admin/ai-management/${tenant.tenantId}${buildQuery(filters)}`)}
              style={{
                padding: "1rem",
                display: "grid",
                gap: "0.75rem",
                textAlign: "left",
                border: "1px solid var(--border-color)",
                background: "var(--card-bg, rgba(255,255,255,0.02))",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: "1rem", fontWeight: 700 }}>{tenant.organization}</div>
                  <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                    Tenant #{tenant.tenantId} | {tenant.slug}
                  </div>
                </div>
                <div style={{ padding: "0.28rem 0.7rem", borderRadius: 999, textTransform: "uppercase", fontSize: "0.75rem", fontWeight: 700, ...badgeStyle(tenant.requestStatus, tenant.crmAiEnabled) }}>
                  {tenant.requestStatus || "none"}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem", fontSize: "0.9rem" }}>
                <div><strong>Requests:</strong> {fmtNumber(tenant.monthlyUsage)}</div>
                <div><strong>Avg tokens:</strong> {fmtNumber(tenant.averageTokens)}</div>
                <div><strong>Max tokens:</strong> {fmtNumber(tenant.maxTokens)}</div>
                <div><strong>Daily avg hits:</strong> {tenant.dailyAverageHits}</div>
                <div><strong>Monthly avg hits:</strong> {tenant.monthlyAverageHits}</div>
                <div><strong>Last activity:</strong> {fmtDate(tenant.lastActivityAt)}</div>
              </div>
            </button>
          ))}
          {!tenants.length && <div className="card" style={{ padding: "1rem" }}>No organizations match the current filters.</div>}
        </div>
      )}
    </div>
  );
}

function TenantDetailView() {
  const navigate = useNavigate();
  const { tenantId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const baseListQuery = Object.fromEntries(searchParams.entries());
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState(null);
  const [filters, setFilters] = useState({
    from: searchParams.get("from") || "",
    to: searchParams.get("to") || "",
  });
  const [adjustForm, setAdjustForm] = useState({ credits: "", direction: "credit", reason: "" });

  const load = async (nextFilters = filters) => {
    setLoading(true);
    setMessage("");
    try {
      const res = await superAdminFetch(`/ai-management/tenants/${tenantId}${buildQuery(nextFilters)}`);
      setDetail(res);
    } catch (err) {
      setMessage(err.message || "Failed to load tenant AI details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const handleAdjustCredits = async () => {
    const credits = Number(adjustForm.credits);
    if (!(credits > 0)) {
      setMessage("Enter a positive credit amount to adjust.");
      return;
    }
    setSavingId("adjust");
    setMessage("");
    try {
      // The API still stores/expects raw tokens — convert the admin's
      // credit input (1 credit = 1,000 tokens) before sending.
      await superAdminFetch(`/ai-management/tenants/${tenantId}/credits/adjust`, {
        method: "POST",
        body: JSON.stringify({
          tokens: creditsToTokens(credits),
          direction: adjustForm.direction,
          reason: adjustForm.reason,
        }),
      });
      setMessage(`Credits ${adjustForm.direction === "debit" ? "deducted" : "granted"} successfully.`);
      setAdjustForm({ credits: "", direction: "credit", reason: "" });
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to adjust AI credits.");
    } finally {
      setSavingId(null);
    }
  };

  const handleLifecycle = async (action) => {
    setSavingId(action);
    setMessage("");
    try {
      await superAdminFetch(`/ai-management/tenants/${tenantId}/${action}`, { method: "POST" });
      setMessage(`Tenant updated successfully.`);
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to update tenant AI access.");
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return <div className="card" style={{ padding: "2rem", textAlign: "center" }}>Loading organization details...</div>;
  }

  if (!detail) {
    return (
      <div style={{ display: "grid", gap: "1rem" }}>
        <button className="btn-secondary" onClick={() => navigate(`/super-admin/ai-management${buildQuery(Object.fromEntries(searchParams.entries()))}`)} style={{ width: "fit-content" }}>
          <ArrowLeft size={15} /> Back
        </button>
        <div className="card" style={{ padding: "1rem" }}>{message || "Organization details are unavailable."}</div>
      </div>
    );
  }

  const usage = detail.usage || {};
  const statusPill = badgeStyle(detail.requestStatus, detail.crmAiEnabled);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn-secondary"
          onClick={() => navigate(`/super-admin/ai-management${buildQuery(Object.fromEntries(searchParams.entries()))}`)}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}
        >
          <ArrowLeft size={15} /> Back to organizations
        </button>
        <div style={{ padding: "0.28rem 0.7rem", borderRadius: 999, textTransform: "uppercase", fontSize: "0.75rem", fontWeight: 700, ...statusPill }}>
          {detail.requestStatus || "none"}
        </div>
      </div>

      <header className="card" style={{ padding: "1.2rem", display: "grid", gap: "0.6rem" }}>
        <div style={{ fontSize: "1.5rem", fontWeight: 800 }}>{detail.organization}</div>
        <div style={{ color: "var(--text-secondary)" }}>
          Tenant #{detail.tenantId} | {detail.slug} | Owner: {detail.ownerEmail || "-"}
        </div>
        <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
          BYOK: {detail.ownApiKey ? "Yes" : "No"} | CRM AI enabled: {detail.crmAiEnabled ? "Yes" : "No"} | Last activity: {fmtDate(usage.lastActivityAt)}
        </div>
      </header>

      {message && (
        <div className="card" style={{ padding: "0.85rem 1rem", borderLeft: `4px solid ${/failed|error/i.test(message) ? "#ef4444" : "#22c55e"}` }}>
          {message}
        </div>
      )}

      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.85rem", overflow: "visible", position: "relative", zIndex: 20 }}>
        <div style={{ fontWeight: 700 }}>Usage window</div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <CalendarRangePicker
            value={{ from: filters.from, to: filters.to }}
            onChange={(next) => setFilters({ from: next.from || "", to: next.to || "" })}
            label="All time"
          />
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            {filters.from || filters.to
              ? "This usage view is scoped to the selected calendar range."
              : "Showing all-time usage first. Pick a range only when you want to narrow it."}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap" }}>
          <button
            className="btn-primary"
            onClick={() => {
              const nextQuery = { ...baseListQuery, ...filters };
              setSearchParams(nextQuery, { replace: true });
              load(filters);
            }}
          >
            Apply Date Filter
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              const next = { from: "", to: "" };
              setFilters(next);
              setSearchParams({ ...baseListQuery, ...next }, { replace: true });
              load(next);
            }}
          >
            Reset Dates
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.85rem" }}>
        <SummaryCard label="Remaining credits" value={fmtNumber(tokensToCredits(detail.credits?.balanceTokens))} />
        <SummaryCard label="Total credits" value={fmtNumber(tokensToCredits(detail.credits?.totalPurchasedTokens))} />
        <SummaryCard label="Credits consumed" value={fmtNumber(tokensToCredits(detail.credits?.totalUsedTokens))} />
        <SummaryCard label="% remaining" value={`${detail.credits?.percentRemaining ?? 0}%`} />
        <SummaryCard label="Requests" value={fmtNumber(usage.totalRequests)} />
        <SummaryCard label="Prompt tokens" value={fmtNumber(usage.promptTokens)} />
        <SummaryCard label="Completion tokens" value={fmtNumber(usage.completionTokens)} />
        <SummaryCard label="Total tokens used" value={fmtNumber(usage.totalTokens)} />
      </div>

      {detail.subscription && (
        <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.4rem" }}>
          <div style={{ fontWeight: 700 }}>Active subscription</div>
          <div style={{ fontSize: "0.9rem" }}>
            {detail.subscription.planName} — started {fmtDate(detail.subscription.startDate)}
            {detail.subscription.endDate ? `, expires ${fmtDate(detail.subscription.endDate)}` : ""}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.85rem", overflow: "visible", position: "relative", zIndex: 20 }}>
        <div style={{ fontWeight: 700 }}>Manual credit adjustment</div>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          Grant or deduct AI credits for this organization. Every adjustment is audit-logged with your username and the
          reason you enter here.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem" }}>
          <select
            className="input-field"
            value={adjustForm.direction}
            onChange={(e) => setAdjustForm((prev) => ({ ...prev, direction: e.target.value }))}
            style={{ background: "var(--input-bg)" }}
          >
            <option value="credit">Grant credits</option>
            <option value="debit">Deduct credits</option>
          </select>
          <input
            className="input-field"
            type="number"
            min="1"
            placeholder="Credits (1 credit = 1,000 tokens)"
            value={adjustForm.credits}
            onChange={(e) => setAdjustForm((prev) => ({ ...prev, credits: e.target.value }))}
          />
        </div>
        <textarea
          className="input-field"
          rows={2}
          placeholder="Reason for this adjustment"
          value={adjustForm.reason}
          onChange={(e) => setAdjustForm((prev) => ({ ...prev, reason: e.target.value }))}
        />
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={handleAdjustCredits} disabled={savingId === "adjust"} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
            {adjustForm.direction === "debit" ? <Minus size={15} /> : <Plus size={15} />}
            {savingId === "adjust" ? "Saving..." : "Apply Adjustment"}
          </button>
          <button className="btn-secondary" onClick={() => handleLifecycle("suspend")} disabled={savingId === "suspend"} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
            <PauseCircle size={15} /> Suspend Access
          </button>
          <button className="btn-secondary" onClick={() => handleLifecycle("resume")} disabled={savingId === "resume"} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
            <PlayCircle size={15} /> Resume Access
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "0.85rem" }}>
        <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
          <div style={{ fontWeight: 700 }}>Provider breakdown</div>
          {(usage.providerBreakdown || []).map((row) => (
            <div key={row.provider} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", fontSize: "0.9rem" }}>
              <span>{row.provider}</span>
              <span>{fmtNumber(row.requests)} req | {fmtNumber(row.totalTokens)} tokens</span>
            </div>
          ))}
          {!usage.providerBreakdown?.length && <div style={{ color: "var(--text-secondary)" }}>No usage in this window.</div>}
        </div>
        <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
          <div style={{ fontWeight: 700 }}>Task breakdown</div>
          {(usage.taskBreakdown || []).map((row) => (
            <div key={row.task} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", fontSize: "0.9rem" }}>
              <span>{row.task}</span>
              <span>{fmtNumber(row.requests)} req | {fmtNumber(row.totalTokens)} tokens</span>
            </div>
          ))}
          {!usage.taskBreakdown?.length && <div style={{ color: "var(--text-secondary)" }}>No task activity in this window.</div>}
        </div>
      </div>

      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.85rem", overflow: "visible", position: "relative", zIndex: 20 }}>
        <div style={{ fontWeight: 700 }}>Daily usage</div>
        {(usage.daily || []).length ? (
          <div style={{ display: "grid", gap: "0.55rem" }}>
            {usage.daily.map((row) => (
              <div key={row.date} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: "0.75rem", fontSize: "0.9rem", padding: "0.65rem 0.75rem", borderRadius: 8, background: "rgba(255,255,255,0.02)" }}>
                <div>{row.date}</div>
                <div>{fmtNumber(row.requests)} requests</div>
                <div>{fmtNumber(row.totalTokens)} tokens</div>
                <div>{fmtNumber(row.promptTokens)} prompt</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: "var(--text-secondary)" }}>No daily usage found for the selected dates.</div>
        )}
      </div>
    </div>
  );
}

export default function SuperAdminAiManagement() {
  const { tenantId } = useParams();
  return tenantId ? <TenantDetailView /> : <TenantListView />;
}



