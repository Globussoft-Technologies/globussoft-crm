import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  Building2,
  Search,
  XCircle,
} from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { formatMoney } from "../../utils/money";

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

function badgeStyle(status) {
  const normalized = String(status || "none").toLowerCase();
  if (normalized === "active" || normalized === "crm-managed" || normalized === "byok") {
    return { background: "rgba(34,197,94,0.12)", border: "1px solid #22c55e", color: "#dcfce7" };
  }
  if (normalized === "scheduled" || normalized === "pending") {
    return { background: "rgba(245,158,11,0.12)", border: "1px solid #f59e0b", color: "#fde68a" };
  }
  return { background: "rgba(148,163,184,0.12)", border: "1px solid rgba(148,163,184,0.45)", color: "var(--text-primary)" };
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
  const [summary, setSummary] = useState({ totalTenants: 0, activePlatformSubs: 0, activeAiSubs: 0, totalLifetimeRevenue: 0 });
  const [search, setSearch] = useState(searchParams.get("search") || "");

  const load = async (nextSearch = search) => {
    setLoading(true);
    setMessage("");
    try {
      const res = await superAdminFetch(`/tenant-management/tenants${buildQuery({ search: nextSearch })}`);
      setTenants(Array.isArray(res?.tenants) ? res.tenants : []);
      setSummary(res?.summary || { totalTenants: 0, activePlatformSubs: 0, activeAiSubs: 0, totalLifetimeRevenue: 0 });
    } catch (err) {
      setMessage(err.message || "Failed to load tenant overview.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <header>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <Building2 size={24} color="var(--accent-color)" /> Tenant Management
        </h1>
        <p style={{ margin: "0.4rem 0 0 0", color: "var(--text-secondary)" }}>
          One place per organization: CRM platform subscription, AI credit snapshot, and lifetime revenue. Open any
          tenant to manage their subscription directly.
        </p>
      </header>

      {message && (
        <div className="card" style={{ padding: "0.85rem 1rem", borderLeft: `4px solid ${/failed|error/i.test(message) ? "#ef4444" : "#22c55e"}` }}>
          {message}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.85rem" }}>
        <SummaryCard label="Organizations" value={fmtNumber(summary.totalTenants)} />
        <SummaryCard label="Active platform subs" value={fmtNumber(summary.activePlatformSubs)} />
        <SummaryCard label="Active AI subs" value={fmtNumber(summary.activeAiSubs)} />
        <SummaryCard label="Total lifetime revenue" value={formatMoney(summary.totalLifetimeRevenue, { currency: "INR" })} />
      </div>

      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
        <div style={{ position: "relative" }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: 12, color: "var(--text-secondary)" }} />
          <input
            className="input-field"
            type="text"
            placeholder="Search organization, slug, or owner email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSearchParams({ search }, { replace: true });
                load(search);
              }
            }}
            style={{ paddingLeft: "2.2rem" }}
          />
        </div>
        <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={() => { setSearchParams({ search }, { replace: true }); load(search); }}>Search</button>
          <button
            className="btn-secondary"
            onClick={() => { setSearch(""); setSearchParams({}, { replace: true }); load(""); }}
          >
            Clear
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>Loading tenant overview...</div>
      ) : (
        <div style={{ display: "grid", gap: "0.85rem" }}>
          {tenants.map((tenant) => (
            <button
              key={tenant.tenantId}
              type="button"
              className="card"
              onClick={() => navigate(`/super-admin/tenant-management/${tenant.tenantId}`)}
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
                    Tenant #{tenant.tenantId} | {tenant.slug} | {tenant.ownerEmail || "no owner email"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <div style={{ padding: "0.28rem 0.7rem", borderRadius: 999, textTransform: "uppercase", fontSize: "0.72rem", fontWeight: 700, ...badgeStyle(tenant.platformSubscription?.status) }}>
                    {tenant.platformSubscription ? tenant.platformSubscription.status : "no plan"}
                  </div>
                  <div style={{ padding: "0.28rem 0.7rem", borderRadius: 999, textTransform: "uppercase", fontSize: "0.72rem", fontWeight: 700, ...badgeStyle(tenant.aiAccess.resolverAccess) }}>
                    AI: {tenant.aiAccess.resolverAccess}
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem", fontSize: "0.9rem" }}>
                <div><strong>Plan:</strong> {tenant.platformSubscription?.planName || "-"}</div>
                <div><strong>Renews:</strong> {fmtDate(tenant.platformSubscription?.renewalDate)}</div>
                <div><strong>AI credits left:</strong> {fmtNumber(tenant.aiAccess.balanceTokens)} tok</div>
                <div><strong>Lifetime revenue:</strong> {formatMoney(tenant.lifetimeRevenue, { currency: "INR" })}</div>
              </div>
            </button>
          ))}
          {!tenants.length && <div className="card" style={{ padding: "1rem" }}>No organizations match the current search.</div>}
        </div>
      )}
    </div>
  );
}

function TenantDetailView() {
  const navigate = useNavigate();
  const { tenantId } = useParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState(null);
  const [plans, setPlans] = useState([]);
  const [grantForm, setGrantForm] = useState({ planId: "", reason: "", customAmount: "", customDurationDays: "" });
  const [cancelReason, setCancelReason] = useState("");

  const load = async () => {
    setLoading(true);
    setMessage("");
    try {
      const [detailRes, plansRes] = await Promise.all([
        superAdminFetch(`/tenant-management/tenants/${tenantId}`),
        superAdminFetch(`/tenant-management/plans`),
      ]);
      setDetail(detailRes);
      setPlans(Array.isArray(plansRes?.plans) ? plansRes.plans : []);
    } catch (err) {
      setMessage(err.message || "Failed to load tenant details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const handleGrant = async (e) => {
    e.preventDefault();
    if (!grantForm.planId) {
      setMessage("Choose a plan to grant.");
      return;
    }
    if (!grantForm.reason.trim()) {
      setMessage("A reason is required for a manual subscription grant.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await superAdminFetch(`/tenant-management/tenants/${tenantId}/subscription/grant`, {
        method: "POST",
        body: JSON.stringify({
          planId: Number(grantForm.planId),
          reason: grantForm.reason.trim(),
          customAmount: grantForm.customAmount === "" ? undefined : Number(grantForm.customAmount),
          customDurationDays: grantForm.customDurationDays === "" ? undefined : Number(grantForm.customDurationDays),
        }),
      });
      setMessage("Subscription granted successfully.");
      setGrantForm({ planId: "", reason: "", customAmount: "", customDurationDays: "" });
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to grant subscription.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async () => {
    if (!cancelReason.trim()) {
      setMessage("A reason is required to cancel the active subscription.");
      return;
    }
    if (!window.confirm("Cancel this tenant's active platform subscription?")) return;
    setSaving(true);
    setMessage("");
    try {
      await superAdminFetch(`/tenant-management/tenants/${tenantId}/subscription/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      setMessage("Subscription cancelled.");
      setCancelReason("");
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to cancel subscription.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="card" style={{ padding: "2rem", textAlign: "center" }}>Loading organization details...</div>;
  }

  if (!detail) {
    return (
      <div style={{ display: "grid", gap: "1rem" }}>
        <button className="btn-secondary" onClick={() => navigate("/super-admin/tenant-management")} style={{ width: "fit-content" }}>
          <ArrowLeft size={15} /> Back
        </button>
        <div className="card" style={{ padding: "1rem" }}>{message || "Organization details are unavailable."}</div>
      </div>
    );
  }

  const activeSubscription = detail.platformSubscriptions.find((s) => s.status === "ACTIVE");

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <button
        className="btn-secondary"
        onClick={() => navigate("/super-admin/tenant-management")}
        style={{ width: "fit-content", display: "inline-flex", alignItems: "center", gap: "0.45rem" }}
      >
        <ArrowLeft size={15} /> Back to organizations
      </button>

      <header className="card" style={{ padding: "1.2rem", display: "grid", gap: "0.6rem" }}>
        <div style={{ fontSize: "1.5rem", fontWeight: 800 }}>{detail.organization}</div>
        <div style={{ color: "var(--text-secondary)" }}>
          Tenant #{detail.tenantId} | {detail.slug} | Owner: {detail.ownerEmail || "-"} | Vertical: {detail.vertical || "-"}
        </div>
        <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>
          <span>Platform revenue: {formatMoney(detail.revenue.platformTotal, { currency: "INR" })}</span>
          <span>AI revenue: {formatMoney(detail.revenue.aiTotal, { currency: "INR" })}</span>
          <span>Combined: {formatMoney(detail.revenue.combinedTotal, { currency: "INR" })}</span>
        </div>
      </header>

      {message && (
        <div className="card" style={{ padding: "0.85rem 1rem", borderLeft: `4px solid ${/failed|error|required/i.test(message) ? "#ef4444" : "#22c55e"}` }}>
          {message}
        </div>
      )}

      {/* AI snapshot — read-only here; actions live on the existing AI Management page */}
      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.6rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Bot size={16} color="var(--accent-color)" /> AI Access Snapshot
          </div>
          <button className="btn-secondary" onClick={() => navigate(`/super-admin/ai-management/${detail.tenantId}`)}>
            Manage AI &rarr;
          </button>
        </div>
        <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>
          Access: {detail.aiState.resolverAccess} | Credits remaining: {fmtNumber(detail.aiState.creditWallet.balanceTokens)} tok
          ({detail.aiState.creditWallet.percentRemaining}%) | {detail.aiState.friendlyMessage}
        </div>
      </div>

      {/* Users */}
      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.6rem" }}>
        <div style={{ fontWeight: 700 }}>Users ({detail.users.length})</div>
        <div style={{ display: "grid", gap: "0.4rem" }}>
          {detail.users.map((u) => (
            <div key={u.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.35rem" }}>
              <div>{u.name} &lt;{u.email}&gt;</div>
              <div style={{ color: "var(--text-secondary)" }}>{u.role} | {u.userType} | {u.subscriptionStatus}</div>
            </div>
          ))}
          {!detail.users.length && <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No users found.</div>}
        </div>
      </div>

      {/* Platform subscription history */}
      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.6rem" }}>
        <div style={{ fontWeight: 700 }}>Platform Subscription History</div>
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {detail.platformSubscriptions.map((s) => (
            <div key={s.id} style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", fontSize: "0.85rem", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.4rem" }}>
              <div>
                <strong>{s.planName}</strong> &middot; {formatMoney(s.amount, { currency: s.currency })}
                {s.isManualGrant && (
                  <span style={{ marginLeft: "0.5rem", padding: "0.1rem 0.5rem", borderRadius: 999, fontSize: "0.7rem", fontWeight: 700, background: "rgba(245,158,11,0.15)", border: "1px solid #f59e0b", color: "#fde68a" }}>
                    Manually granted
                  </span>
                )}
              </div>
              <div style={{ color: "var(--text-secondary)" }}>
                {s.status} | {fmtDate(s.startDate)} &rarr; {fmtDate(s.endDate)}
              </div>
            </div>
          ))}
          {!detail.platformSubscriptions.length && <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>No platform subscription history yet.</div>}
        </div>
      </div>

      {/* Grant subscription */}
      <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.75rem", overflow: "visible", position: "relative", zIndex: 10 }}>
        <div style={{ fontWeight: 700 }}>Manually Grant / Correct Subscription</div>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          Use for comp accounts, payments collected outside Razorpay, or correcting a billing mistake. This supersedes
          (cancels) any existing active subscription rather than queueing behind it, and is fully audit-logged.
        </p>
        <form onSubmit={handleGrant} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem" }}>
          <select
            className="input-field"
            value={grantForm.planId}
            onChange={(e) => setGrantForm((p) => ({ ...p, planId: e.target.value }))}
            style={{ background: "var(--input-bg)" }}
          >
            <option value="">Select a plan</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>{plan.name} — {formatMoney(plan.price, { currency: plan.currency })}</option>
            ))}
          </select>
          <input
            className="input-field"
            type="number"
            min="0"
            step="0.01"
            placeholder="Custom amount (optional)"
            value={grantForm.customAmount}
            onChange={(e) => setGrantForm((p) => ({ ...p, customAmount: e.target.value }))}
          />
          <input
            className="input-field"
            type="number"
            min="1"
            placeholder="Custom duration in days (optional)"
            value={grantForm.customDurationDays}
            onChange={(e) => setGrantForm((p) => ({ ...p, customDurationDays: e.target.value }))}
          />
          <div style={{ gridColumn: "1 / -1" }}>
            <textarea
              className="input-field"
              rows={2}
              placeholder="Reason (required — e.g. 'Comp account per sales agreement with Acme')"
              value={grantForm.reason}
              onChange={(e) => setGrantForm((p) => ({ ...p, reason: e.target.value }))}
            />
          </div>
          <div>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Saving..." : "Grant Subscription"}
            </button>
          </div>
        </form>
      </div>

      {/* Cancel active subscription */}
      {activeSubscription && (
        <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.6rem" }}>
          <div style={{ fontWeight: 700 }}>Cancel Active Subscription</div>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-start" }}>
            <textarea
              className="input-field"
              rows={2}
              placeholder="Reason (required — e.g. 'Fraud hold', 'Duplicate account')"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              style={{
                padding: "0.75rem 1rem", borderRadius: 8, border: "1px solid #ef4444",
                background: "rgba(239, 68, 68, 0.1)", color: "#ef4444",
                display: "inline-flex", alignItems: "center", gap: "0.4rem",
              }}
            >
              <XCircle size={16} /> {saving ? "Cancelling..." : "Cancel Subscription"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SuperAdminTenantManagement() {
  const { tenantId } = useParams();
  return tenantId ? <TenantDetailView /> : <TenantListView />;
}
