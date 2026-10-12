import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  CircleHelp,
  Leaf,
  LockKeyhole,
  Plane,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import "./super-admin.css";

const EMPTY_SUMMARY = {
  totalTenants: 0,
  cappedTenants: 0,
  totalCustomRoles: 0,
  tenantsAtLimit: 0,
};

const VERTICAL_FILTERS = [
  { value: "all", label: "All" },
  { value: "generic", label: "Generic CRM" },
  { value: "wellness", label: "Wellness" },
  { value: "travel", label: "Travel" },
];

function fmtNumber(value) {
  return Number(value || 0).toLocaleString();
}

function verticalLabel(vertical) {
  if (vertical === "wellness") return "Wellness";
  if (vertical === "travel") return "Travel";
  return "Generic CRM";
}

function ownerDisplayName(email) {
  if (!email) return "Not available";
  const localPart = email.split("@")[0].replace(/[._-]+/g, " ");
  return localPart.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function RoleIcon({ vertical }) {
  if (vertical === "wellness") return <Leaf size={19} />;
  if (vertical === "travel") return <Plane size={19} />;
  return <Building2 size={19} />;
}

function roleState(tenant) {
  if (tenant.status !== "active") return { label: "Disabled", tone: "neutral", icon: AlertCircle };
  if (tenant.maxCustomRoles != null && tenant.customRoleCount >= tenant.maxCustomRoles) {
    return { label: "Limit reached", tone: "danger", icon: AlertCircle };
  }
  if (tenant.maxCustomRoles == null) return { label: "No limit", tone: "neutral", icon: CheckCircle2 };
  return { label: "Within limit", tone: "success", icon: CheckCircle2 };
}

function rolePercentage(tenant) {
  if (tenant.maxCustomRoles == null) return 0;
  if (tenant.maxCustomRoles === 0) return 100;
  return Math.min(Math.round((tenant.customRoleCount / tenant.maxCustomRoles) * 100), 100);
}

function SummaryCard({ label, value, icon: Icon, tone }) {
  return (
    <div className={`role-limit-kpi role-limit-kpi-${tone}`}>
      <div className="role-limit-kpi-icon"><Icon size={22} /></div>
      <div>
        <div className="role-limit-kpi-label">{label}</div>
        <strong className="role-limit-kpi-value">{value}</strong>
      </div>
    </div>
  );
}

function SortLabel({ children }) {
  return <span className="role-limit-sort-label">{children}</span>;
}

export default function SuperAdminRoleManagement() {
  const [tenants, setTenants] = useState([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [drafts, setDrafts] = useState({});
  const [organizationFilter, setOrganizationFilter] = useState("all");
  const [verticalFilter, setVerticalFilter] = useState("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [message, setMessage] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const result = await superAdminFetch("/tenant-management/role-limits");
      const rows = Array.isArray(result?.tenants) ? result.tenants : [];
      setTenants(rows);
      setSummary(result?.summary || EMPTY_SUMMARY);
      setDrafts(Object.fromEntries(rows.map((tenant) => [
        tenant.tenantId,
        tenant.maxCustomRoles == null ? "" : String(tenant.maxCustomRoles),
      ])));
    } catch (err) {
      setMessage(err.message || "Failed to load custom role limits.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const visibleTenants = useMemo(() => {
    const term = search.trim().toLowerCase();
    return tenants.filter((tenant) => {
      if (organizationFilter !== "all" && String(tenant.tenantId) !== organizationFilter) return false;
      if (verticalFilter !== "all" && (tenant.vertical || "generic") !== verticalFilter) return false;
      if (!term) return true;
      return [tenant.organization, tenant.slug, tenant.ownerEmail, tenant.vertical, tenant.tenantId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [organizationFilter, search, tenants, verticalFilter]);

  const searchSuggestions = useMemo(() => {
    const term = searchDraft.trim().toLowerCase();
    if (!term) return [];

    return tenants
      .filter((tenant) => [tenant.organization, tenant.slug, tenant.ownerEmail, tenant.vertical, tenant.tenantId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term))
      .slice(0, 6);
  }, [searchDraft, tenants]);

  const saveLimit = async (tenant) => {
    const raw = String(drafts[tenant.tenantId] ?? "").trim();
    const maxCustomRoles = raw === "" ? null : Number(raw);
    if (maxCustomRoles !== null && (!Number.isInteger(maxCustomRoles) || maxCustomRoles < 0 || maxCustomRoles > 100000)) {
      setMessage("Role limit must be a whole number from 0 to 100,000, or blank for unlimited.");
      return;
    }

    setSavingId(tenant.tenantId);
    setMessage("");
    try {
      await superAdminFetch(`/tenant-management/tenants/${tenant.tenantId}/role-limit`, {
        method: "PUT",
        body: JSON.stringify({ maxCustomRoles }),
      });
      setMessage(`Role limit updated for ${tenant.organization}.`);
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to update role limit.");
    } finally {
      setSavingId(null);
    }
  };

  const applySearch = () => setSearch(searchDraft.trim());
  const chooseSearchSuggestion = (tenant) => {
    setSearchDraft(tenant.organization);
    setSearch(tenant.organization);
    setOrganizationFilter(String(tenant.tenantId));
    setSearchFocused(false);
  };

  const clearFilters = () => {
    setOrganizationFilter("all");
    setVerticalFilter("all");
    setSearchDraft("");
    setSearch("");
    setSearchFocused(false);
  };

  return (
    <div className="super-admin-role-management">
      <header className="role-limit-page-header">
        <div>
          <h1><ShieldCheck size={28} /> Role Management</h1>
          <p>Manage the maximum number of roles each organization can create. Built-in system roles are not counted, and staff assignments remain unlimited.</p>
        </div>
        <button type="button" className="role-limit-help-button" onClick={() => setShowHelp((visible) => !visible)} aria-expanded={showHelp}>
          <CircleHelp size={17} /> How it works?
        </button>
      </header>

      {showHelp && (
        <div className="role-limit-help-panel" role="note">
          <strong>Organization role limits</strong>
          <span>Active tenant-managed roles count toward the limit, including roles created before this control was added. Built-in system roles are excluded. Leave Role Limit blank for unlimited creation, or enter 0 to block new role creation.</span>
        </div>
      )}

      {message && (
        <div className={`role-limit-message ${/failed|error|must|whole/i.test(message) ? "is-error" : "is-success"}`} role="status">
          {message}
        </div>
      )}

      <section className="role-limit-filter-panel" aria-label="Organization filters">
        <label className="role-limit-organization-filter">
          <span>Organization</span>
          <span className="role-limit-select-wrap">
            <Building2 size={17} aria-hidden="true" />
            <select aria-label="Organization" value={organizationFilter} onChange={(event) => setOrganizationFilter(event.target.value)}>
              <option value="all">All organizations</option>
              {tenants.map((tenant) => <option key={tenant.tenantId} value={tenant.tenantId}>{tenant.organization}</option>)}
            </select>
          </span>
        </label>

        <fieldset className="role-limit-vertical-filter">
          <legend>Vertical</legend>
          <div className="role-limit-filter-pills">
            {VERTICAL_FILTERS.map((filter) => (
              <button
                type="button"
                key={filter.value}
                className={verticalFilter === filter.value ? "is-active" : ""}
                aria-pressed={verticalFilter === filter.value}
                onClick={() => setVerticalFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="role-limit-search-control">
          <label className="role-limit-search-filter">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="Search organizations"
              placeholder="Search by organization name, slug, or owner..."
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
              onKeyDown={(event) => { if (event.key === "Enter") applySearch(); }}
            />
            <button type="button" className="role-limit-search-button" onClick={applySearch} aria-label="Search organizations">
              <Search size={16} />
            </button>
          </label>
          {searchFocused && searchDraft.trim() ? (
            <div className="role-limit-search-suggestions" role="listbox" aria-label="Organization suggestions">
              {searchSuggestions.length ? searchSuggestions.map((tenant) => (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={tenant.tenantId}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseSearchSuggestion(tenant);
                  }}
                >
                  <span className="role-limit-suggestion-main">{tenant.organization}</span>
                  <span className="role-limit-suggestion-meta">#{tenant.tenantId} · {tenant.ownerEmail || "No owner email"} · {verticalLabel(tenant.vertical)}</span>
                </button>
              )) : (
                <div className="role-limit-no-suggestions">No matching organizations</div>
              )}
            </div>
          ) : null}
        </div>

        <div className="role-limit-filter-actions">
          <button type="button" className="role-limit-clear-button" onClick={clearFilters}>Clear</button>
          <button type="button" className="role-limit-refresh-button" onClick={load} disabled={loading} aria-label="Refresh role limits" title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </section>

      <section className="role-limit-kpi-grid" aria-label="Role limit summary">
        <SummaryCard label="Total organizations" value={fmtNumber(summary.totalTenants)} icon={Building2} tone="blue" />
        <SummaryCard label="With role limit" value={fmtNumber(summary.cappedTenants)} icon={ShieldCheck} tone="green" />
        <SummaryCard label="Total managed roles" value={fmtNumber(summary.totalCustomRoles)} icon={UsersRound} tone="purple" />
        <SummaryCard label="Blocked from creating more" value={fmtNumber(summary.tenantsAtLimit)} icon={LockKeyhole} tone="red" />
      </section>

      {loading ? (
        <div className="role-limit-empty-state">Loading organizations...</div>
      ) : (
        <section className="role-limit-table-card" aria-label="Organizations role limits">
          <div className="role-limit-table-scroll">
            <table className="stable-table super-admin-role-limits-table">
              <colgroup>
                <col className="role-limit-organization-column" />
                <col className="role-limit-vertical-column" />
                <col className="role-limit-owner-column" />
                <col className="role-limit-current-column" />
                <col className="role-limit-limit-column" />
                <col className="role-limit-status-column" />
                <col className="role-limit-action-column" />
              </colgroup>
              <thead>
                <tr>
                  <th><SortLabel>Organization</SortLabel></th>
                  <th><SortLabel>Vertical</SortLabel></th>
                  <th><SortLabel>Owner</SortLabel></th>
                  <th><SortLabel>Current roles</SortLabel></th>
                  <th><SortLabel>Role limit</SortLabel></th>
                  <th><SortLabel>Status</SortLabel></th>
                  <th><SortLabel>Actions</SortLabel></th>
                </tr>
              </thead>
              <tbody>
                {visibleTenants.map((tenant) => {
                  const state = roleState(tenant);
                  const StateIcon = state.icon;
                  const percentage = rolePercentage(tenant);
                  const hasLimit = tenant.maxCustomRoles != null;
                  return (
                    <tr key={tenant.tenantId}>
                      <td>
                        <div className="role-limit-organization-cell">
                          <div className={`role-limit-organization-icon role-limit-organization-icon-${tenant.vertical || "generic"}`}><RoleIcon vertical={tenant.vertical} /></div>
                          <div className="role-limit-organization-copy">
                            <strong>{tenant.organization}</strong>
                            <span>#{tenant.tenantId} · {tenant.ownerEmail || "No owner email"}</span>
                          </div>
                        </div>
                      </td>
                      <td><span className={`role-limit-vertical-badge role-limit-vertical-${tenant.vertical || "generic"}`}>{verticalLabel(tenant.vertical)}</span></td>
                      <td>
                        <div className="role-limit-owner-name">{ownerDisplayName(tenant.ownerEmail)}</div>
                        <div className="role-limit-owner-email">{tenant.ownerEmail || "—"}</div>
                      </td>
                      <td>
                        <div className="role-limit-current-value"><strong>{fmtNumber(tenant.customRoleCount)}</strong> / {hasLimit ? fmtNumber(tenant.maxCustomRoles) : "unlimited"}</div>
                        <div className="role-limit-progress-row">
                          <span className={`role-limit-progress ${state.tone}`}><span style={{ width: `${percentage}%` }} /></span>
                          {hasLimit ? <small>{`${percentage}%`}</small> : null}
                        </div>
                      </td>
                      <td>
                        <input
                          className="role-limit-input"
                          type="number"
                          min="0"
                          max="100000"
                          step="1"
                          aria-label={`Role limit for ${tenant.organization}`}
                          placeholder="Unlimited"
                          value={drafts[tenant.tenantId] ?? ""}
                          onChange={(event) => setDrafts((previous) => ({ ...previous, [tenant.tenantId]: event.target.value }))}
                        />
                      </td>
                      <td>
                        <span className={`role-limit-status-badge ${state.tone}`}><StateIcon size={13} /> {state.label}</span>
                      </td>
                      <td>
                        <div className="role-limit-action-group">
                          <button type="button" className="role-limit-save-button" onClick={() => saveLimit(tenant)} disabled={savingId === tenant.tenantId} title={`Save role limit for ${tenant.organization}`} aria-label={`Save role limit for ${tenant.organization}`}>
                            {savingId === tenant.tenantId ? "Saving..." : "Save"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!visibleTenants.length && (
                  <tr><td colSpan="7" className="role-limit-no-results">No organizations match the selected filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <footer className="role-limit-table-footer">
            <span>Showing {visibleTenants.length} of {tenants.length} organizations</span>
            <span className="role-limit-footer-hint">Select an organization above to focus on one account.</span>
          </footer>
        </section>
      )}
    </div>
  );
}
