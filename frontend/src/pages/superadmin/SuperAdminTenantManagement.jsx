import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  Building2,
  Check,
  ChevronDown,
  CreditCard,
  Filter,
  IndianRupee,
  Minimize2,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  XCircle,
} from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { formatMoney } from "../../utils/money";
import "./SuperAdminTenantManagement.css";

const TENANT_BATCH_SIZE = 20;
const TENANT_USERS_BATCH_SIZE = 10;
const TENANT_SUBSCRIPTIONS_BATCH_SIZE = 5;
const VERTICAL_FILTERS = [
  { value: "all", label: "All verticals" },
  { value: "generic", label: "Generic CRM" },
  { value: "wellness", label: "Wellness" },
  { value: "travel", label: "Travel" },
];

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
    return {
      background: "var(--tenant-status-success-bg)",
      border: "1px solid var(--tenant-status-success-border)",
      color: "var(--tenant-status-success-ink)",
    };
  }
  if (normalized === "scheduled" || normalized === "pending") {
    return {
      background: "var(--tenant-status-warning-bg)",
      border: "1px solid var(--tenant-status-warning-border)",
      color: "var(--tenant-status-warning-ink)",
    };
  }
  return {
    background: "var(--tenant-status-neutral-bg)",
    border: "1px solid var(--tenant-status-neutral-border)",
    color: "var(--tenant-status-neutral-ink)",
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

function SummaryMetric({ icon: Icon, label, value }) {
  return (
    <div className="tenant-management-metric">
      <span className="tenant-management-metric__icon"><Icon size={19} aria-hidden="true" /></span>
      <span className="tenant-management-metric__copy"><span>{label}</span><strong>{value}</strong></span>
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
  const [activeTab, setActiveTab] = useState("organizations");
  const [verticalFilter, setVerticalFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const tableScrollRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(TENANT_BATCH_SIZE);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ organizationName: "", name: "", email: "", password: "", vertical: "generic", themePreference: "system" });

  const load = async (nextSearch = search) => {
    setLoading(true);
    setMessage("");
    try {
      const res = await superAdminFetch(`/tenant-management/tenants${buildQuery({ search: nextSearch })}`);
      setTenants(Array.isArray(res?.tenants) ? res.tenants : []);
      setSummary(res?.summary || { totalTenants: 0, activePlatformSubs: 0, activeAiSubs: 0, totalLifetimeRevenue: 0 });
      setVisibleCount(TENANT_BATCH_SIZE);
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

  useEffect(() => {
    if (!filterOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!filterRef.current?.contains(event.target)) setFilterOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterOpen]);

  const handleCreate = async (event) => {
    event.preventDefault();
    setCreating(true);
    setMessage("");
    try {
      const result = await superAdminFetch("/tenant-management/organizations", {
        method: "POST",
        body: JSON.stringify(createForm),
      });
      setCreateForm({ organizationName: "", name: "", email: "", password: "", vertical: "generic", themePreference: "system" });
      setSearch("");
      setVerticalFilter("all");
      setSearchParams({}, { replace: true });
      await load("");
      setMessage(`Organization "${result.organization.name}" created for ${result.owner.email}.`);
      setActiveTab("organizations");
    } catch (err) {
      setMessage(err.message || "Failed to create organization.");
    } finally {
      setCreating(false);
    }
  };

  const handleSearch = (event) => {
    event.preventDefault();
    setSearchParams(search.trim() ? { search: search.trim() } : {}, { replace: true });
    setVisibleCount(TENANT_BATCH_SIZE);
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0;
    load(search.trim());
  };

  const clearFilters = () => {
    setSearch("");
    setVerticalFilter("all");
    setFilterOpen(false);
    setSearchParams({}, { replace: true });
    setVisibleCount(TENANT_BATCH_SIZE);
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0;
    load("");
  };

  const filteredTenants = tenants.filter((tenant) => (
    verticalFilter === "all" || (tenant.vertical || "generic") === verticalFilter
  ));
  const visibleTenants = filteredTenants.slice(0, visibleCount);
  const selectedVertical = VERTICAL_FILTERS.find((filter) => filter.value === verticalFilter)?.label || "All verticals";

  const handleTableScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    const nearBottom = scrollHeight - scrollTop - clientHeight < 120;
    if (nearBottom && visibleCount < filteredTenants.length) {
      setVisibleCount((current) => Math.min(current + TENANT_BATCH_SIZE, filteredTenants.length));
    }
  };

  return (
    <div className="tenant-management-page">
      <header className="tenant-management-header">
        <h1><Building2 size={25} aria-hidden="true" /> Tenant Management</h1>
        <p>Manage organizations, subscriptions, AI usage, and revenue in one place.</p>
      </header>

      {message && (
        <div className={`tenant-management-message${/failed|error/i.test(message) ? " is-error" : ""}`} role="status">
          {message}
        </div>
      )}

      <section className="tenant-management-summary" aria-label="Tenant summary">
        <SummaryMetric icon={Building2} label="Organizations" value={fmtNumber(summary.totalTenants)} />
        <SummaryMetric icon={CreditCard} label="Active platform subscriptions" value={fmtNumber(summary.activePlatformSubs)} />
        <SummaryMetric icon={Sparkles} label="Active AI subscriptions" value={fmtNumber(summary.activeAiSubs)} />
        <SummaryMetric icon={IndianRupee} label="Lifetime revenue" value={formatMoney(summary.totalLifetimeRevenue, { currency: "INR" })} />
      </section>

      <section className="tenant-management-workspace" aria-label="Tenant management workspace">
        <div className="tenant-management-tabs" role="group" aria-label="Tenant management views">
          <button
            type="button"
            aria-pressed={activeTab === "organizations"}
            className={activeTab === "organizations" ? "is-active" : ""}
            onClick={() => setActiveTab("organizations")}
          >
            <Building2 size={16} /> Organizations
          </button>
          <button
            type="button"
            aria-pressed={activeTab === "create"}
            className={activeTab === "create" ? "is-active" : ""}
            onClick={() => setActiveTab("create")}
          >
            <Plus size={16} /> Create organization
          </button>
        </div>

        {activeTab === "organizations" ? (
          <div className="tenant-management-panel" role="region" aria-label="Organizations">
            <div className="tenant-management-toolbar">
              <form className="tenant-management-search" onSubmit={handleSearch} role="search">
                <Search size={17} aria-hidden="true" />
                <input
                  type="text"
                  aria-label="Search organizations"
                  placeholder="Search by organization, slug, owner email, or ID..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <button type="submit" aria-label="Search organizations" title="Search"><Search size={16} /></button>
              </form>

              <div className="tenant-management-filter" ref={filterRef}>
                <button
                  type="button"
                  className={`tenant-management-filter-trigger${verticalFilter !== "all" ? " is-active" : ""}`}
                  aria-expanded={filterOpen}
                  aria-controls="tenant-vertical-filter-options"
                  onClick={() => setFilterOpen((open) => !open)}
                >
                  <Filter size={16} /> Filters
                  {verticalFilter !== "all" && <span>{selectedVertical}</span>}
                  <ChevronDown size={14} />
                </button>
                {filterOpen && (
                  <div className="tenant-management-filter-menu" id="tenant-vertical-filter-options" role="group" aria-label="Filter organizations by vertical">
                    <strong>Vertical</strong>
                    {VERTICAL_FILTERS.map((filter) => (
                      <button
                        type="button"
                        key={filter.value}
                        aria-pressed={verticalFilter === filter.value}
                        className={verticalFilter === filter.value ? "is-active" : ""}
                        onClick={() => {
                          setVerticalFilter(filter.value);
                          setFilterOpen(false);
                          setVisibleCount(TENANT_BATCH_SIZE);
                          if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0;
                        }}
                      >
                        {filter.label}
                        {verticalFilter === filter.value && <Check size={15} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="tenant-management-toolbar-actions">
                {(search || verticalFilter !== "all") && <button type="button" className="tenant-management-button tenant-management-button--secondary" onClick={clearFilters}>Clear</button>}
                <button type="button" className="tenant-management-button tenant-management-button--primary" onClick={() => { setFilterOpen(false); setActiveTab("create"); }}>
                  <Plus size={16} /> Create organization
                </button>
              </div>
            </div>

            {loading ? (
              <div className="tenant-management-state" role="status">Loading tenant overview...</div>
            ) : (
              <>
                <div className="tenant-management-table-scroll" ref={tableScrollRef} onScroll={handleTableScroll}>
                  <table className="tenant-management-table">
                    <thead>
                      <tr>
                        <th scope="col">Organization</th>
                        <th scope="col">Plan</th>
                        <th scope="col">Subscription</th>
                        <th scope="col">AI credits</th>
                        <th scope="col">Lifetime revenue</th>
                        <th scope="col">Status</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTenants.map((tenant) => (
                        <tr key={tenant.tenantId}>
                          <td>
                            <div className="tenant-management-organization">
                              <span className="tenant-management-organization__icon"><Building2 size={18} /></span>
                              <span className="tenant-management-organization__copy">
                                <strong>{tenant.organization}</strong>
                                <small>#{tenant.tenantId} · {tenant.slug || "no slug"} · {tenant.ownerEmail || "No owner email"}</small>
                                <small className="tenant-management-vertical-label">{tenant.vertical === "wellness" ? "Wellness" : tenant.vertical === "travel" ? "Travel" : "Generic CRM"}</small>
                              </span>
                            </div>
                          </td>
                          <td>{tenant.platformSubscription?.planName || <span className="tenant-management-muted">—</span>}</td>
                          <td>{tenant.platformSubscription?.renewalDate ? fmtDate(tenant.platformSubscription.renewalDate) : <span className="tenant-management-muted">—</span>}</td>
                          <td>
                            <span className="tenant-management-credit-value">{fmtNumber(tenant.aiAccess.balanceTokens)} tok</span>
                            <span className="tenant-management-credit-mode">{tenant.aiAccess.resolverAccess || "none"}</span>
                          </td>
                          <td>{formatMoney(tenant.lifetimeRevenue, { currency: "INR" })}</td>
                          <td>
                            <span className="super-admin-tenant-status-badge" style={badgeStyle(tenant.platformSubscription?.status)}>
                              {tenant.platformSubscription?.status || "No plan"}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="tenant-management-action-button"
                              aria-label={`Manage ${tenant.organization}`}
                              title={`Manage ${tenant.organization}`}
                              onClick={() => navigate(`/super-admin/tenant-management/${tenant.tenantId}`)}
                            >
                              <MoreHorizontal size={18} />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!filteredTenants.length && <tr><td colSpan="7" className="tenant-management-empty">No organizations match the current filters.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <footer className="tenant-management-list-footer" aria-live="polite">
                  <span>Showing {visibleTenants.length} of {filteredTenants.length} organizations</span>
                  {visibleTenants.length < filteredTenants.length && <span>Scroll down to load more</span>}
                </footer>
              </>
            )}
          </div>
        ) : (
          <div className="tenant-management-panel" role="region" aria-label="Create organization">
            <div className="tenant-management-create-heading">
              <div>
                <span>NEW ORGANIZATION</span>
                <h2>Create organization for customer</h2>
                <p>Super Admin creation does not require customer email OTP. Customer self-registration is unchanged.</p>
              </div>
              <button type="button" className="tenant-management-button tenant-management-button--secondary" onClick={() => setActiveTab("organizations")}>
                <Minimize2 size={15} /> Minimize
              </button>
            </div>
            <form className="tenant-management-create-form" onSubmit={handleCreate}>
              <input className="input-field" aria-label="Organization name" placeholder="Organization name" required value={createForm.organizationName} onChange={(event) => setCreateForm((previous) => ({ ...previous, organizationName: event.target.value }))} />
              <input className="input-field" aria-label="Customer full name" placeholder="Customer full name" required value={createForm.name} onChange={(event) => setCreateForm((previous) => ({ ...previous, name: event.target.value }))} />
              <input className="input-field" aria-label="Customer email" type="email" placeholder="Customer email" required value={createForm.email} onChange={(event) => setCreateForm((previous) => ({ ...previous, email: event.target.value }))} />
              <input className="input-field" aria-label="Temporary password" type="password" minLength={8} placeholder="Temporary password" required value={createForm.password} onChange={(event) => setCreateForm((previous) => ({ ...previous, password: event.target.value }))} />
              <select className="input-field" aria-label="Organization vertical" value={createForm.vertical} onChange={(event) => setCreateForm((previous) => ({ ...previous, vertical: event.target.value }))}>
                <option value="generic">Generic CRM</option>
                <option value="wellness">Wellness</option>
                <option value="travel">Travel</option>
              </select>
              <select className="input-field" aria-label="Organization theme" value={createForm.themePreference} onChange={(event) => setCreateForm((previous) => ({ ...previous, themePreference: event.target.value }))}>
                <option value="system">System theme</option>
                <option value="light">Light theme</option>
                <option value="dark">Dark theme</option>
              </select>
              <div className="tenant-management-create-actions">
                <button className="tenant-management-button tenant-management-button--primary" type="submit" disabled={creating}>
                  <Plus size={16} /> {creating ? "Creating..." : "Create organization"}
                </button>
                <span>All fields are required. Temporary passwords must be at least 8 characters.</span>
              </div>
            </form>
          </div>
        )}
      </section>
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
  const [visibleUsersCount, setVisibleUsersCount] = useState(TENANT_USERS_BATCH_SIZE);
  const [visibleSubscriptionsCount, setVisibleSubscriptionsCount] = useState(TENANT_SUBSCRIPTIONS_BATCH_SIZE);
  const usersScrollRef = useRef(null);
  const subscriptionsScrollRef = useRef(null);
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
      setVisibleUsersCount(TENANT_USERS_BATCH_SIZE);
      setVisibleSubscriptionsCount(TENANT_SUBSCRIPTIONS_BATCH_SIZE);
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
  const visibleUsers = detail.users.slice(0, visibleUsersCount);
  const visibleSubscriptions = detail.platformSubscriptions.slice(0, visibleSubscriptionsCount);

  const handleUsersScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 80 && visibleUsersCount < detail.users.length) {
      setVisibleUsersCount((current) => Math.min(current + TENANT_USERS_BATCH_SIZE, detail.users.length));
    }
  };

  const handleSubscriptionsScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 80 && visibleSubscriptionsCount < detail.platformSubscriptions.length) {
      setVisibleSubscriptionsCount((current) => Math.min(current + TENANT_SUBSCRIPTIONS_BATCH_SIZE, detail.platformSubscriptions.length));
    }
  };

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
      <section className="card tenant-management-users-card" aria-label="Tenant users">
        <div className="tenant-management-users-heading">Users ({detail.users.length})</div>
        <div
          className="tenant-management-users-scroll"
          ref={usersScrollRef}
          onScroll={handleUsersScroll}
          role="region"
          aria-label={`${detail.organization} users`}
          tabIndex={0}
        >
          <div className="tenant-management-users-list" role="list">
            {visibleUsers.map((u) => (
              <div key={u.id} className="tenant-management-user-row" role="listitem">
                <div className="tenant-management-user-identity">{u.name} &lt;{u.email}&gt;</div>
                <div className="tenant-management-user-meta">{u.role} | {u.userType} | {u.subscriptionStatus}</div>
              </div>
            ))}
            {!detail.users.length && <div className="tenant-management-users-empty">No users found.</div>}
          </div>
        </div>
        <footer className="tenant-management-users-footer" aria-live="polite">
          <span>Showing {visibleUsers.length} of {detail.users.length} users</span>
          {visibleUsers.length < detail.users.length && <span>Scroll down to load more</span>}
        </footer>
      </section>

      {/* Platform subscription history */}
      <section className="card tenant-management-subscriptions-card" aria-label="Platform subscription history">
        <div className="tenant-management-users-heading">Platform Subscription History ({detail.platformSubscriptions.length})</div>
        <div
          className="tenant-management-subscriptions-scroll"
          ref={subscriptionsScrollRef}
          onScroll={handleSubscriptionsScroll}
          role="region"
          aria-label={`${detail.organization} subscription history`}
          tabIndex={0}
        >
          <div className="tenant-management-subscriptions-list" role="list">
            {visibleSubscriptions.map((s) => (
              <div key={s.id} className="tenant-management-subscription-row" role="listitem">
                <div>
                  <strong>{s.planName}</strong> &middot; {formatMoney(s.amount, { currency: s.currency })}
                  {s.isManualGrant && (
                    <span style={{ marginLeft: "0.5rem", padding: "0.1rem 0.5rem", borderRadius: 999, fontSize: "0.7rem", fontWeight: 700, background: "rgba(245,158,11,0.15)", border: "1px solid #f59e0b", color: "#fde68a" }}>
                      Manually granted
                    </span>
                  )}
                </div>
                <div className="tenant-management-subscription-meta">
                  {s.status} | {fmtDate(s.startDate)} &rarr; {fmtDate(s.endDate)}
                </div>
              </div>
            ))}
            {!detail.platformSubscriptions.length && <div className="tenant-management-users-empty">No platform subscription history yet.</div>}
          </div>
        </div>
        <footer className="tenant-management-users-footer" aria-live="polite">
          <span>Showing {visibleSubscriptions.length} of {detail.platformSubscriptions.length} subscriptions</span>
          {visibleSubscriptions.length < detail.platformSubscriptions.length && <span>Scroll down to load more</span>}
        </footer>
      </section>

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
        <div className="card tenant-management-cancel-card">
          <div style={{ fontWeight: 700 }}>Cancel Active Subscription</div>
          <div className="tenant-management-cancel-controls">
            <textarea
              className="input-field tenant-management-cancel-reason"
              rows={2}
              placeholder="Reason (required — e.g. 'Fraud hold', 'Duplicate account')"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
            <button
              type="button"
              className="tenant-management-cancel-button"
              onClick={handleCancel}
              disabled={saving}
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
