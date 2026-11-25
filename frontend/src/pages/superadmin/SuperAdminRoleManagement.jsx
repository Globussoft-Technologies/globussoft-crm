import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Building2,
  Check,
  ChevronDown,
  CheckCircle2,
  CircleHelp,
  Filter,
  Leaf,
  Plane,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import "./super-admin.css";

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

function SortLabel({ children }) {
  return <span className="role-limit-sort-label">{children}</span>;
}

export default function SuperAdminRoleManagement() {
  const [tenants, setTenants] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [verticalFilter, setVerticalFilter] = useState("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [showVerticalOptions, setShowVerticalOptions] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [message, setMessage] = useState("");
  const verticalMenuRef = useRef(null);
  const verticalTriggerRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await superAdminFetch("/tenant-management/role-limits");
      const rows = Array.isArray(result?.tenants) ? result.tenants : [];
      setTenants(rows);
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

  useEffect(() => {
    if (!showVerticalOptions) return undefined;

    const closeOnOutsidePointer = (event) => {
      if (!verticalMenuRef.current?.contains(event.target)) setShowVerticalOptions(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setShowVerticalOptions(false);
        verticalTriggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showVerticalOptions]);

  const visibleTenants = useMemo(() => {
    const term = search.trim().toLowerCase();
    return tenants.filter((tenant) => {
      if (verticalFilter !== "all" && (tenant.vertical || "generic") !== verticalFilter) return false;
      if (!term) return true;
      return [tenant.organization, tenant.slug, tenant.ownerEmail, tenant.vertical, tenant.tenantId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [search, tenants, verticalFilter]);

  const visibleSummary = useMemo(() => ({
    totalTenants: visibleTenants.length,
    cappedTenants: visibleTenants.filter((tenant) => tenant.maxCustomRoles != null).length,
    totalCustomRoles: visibleTenants.reduce((total, tenant) => total + Number(tenant.customRoleCount || 0), 0),
    tenantsAtLimit: visibleTenants.filter((tenant) => tenant.roleLimitReached).length,
  }), [visibleTenants]);

  const searchSuggestions = useMemo(() => {
    const term = searchDraft.trim().toLowerCase();
    if (!term) return [];

    return tenants
      .filter((tenant) => {
        if (verticalFilter !== "all" && (tenant.vertical || "generic") !== verticalFilter) return false;
        return [tenant.organization, tenant.slug, tenant.ownerEmail, tenant.vertical, tenant.tenantId]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(term);
      })
      .slice(0, 6);
  }, [searchDraft, tenants, verticalFilter]);

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
    setSearchFocused(false);
  };

  const chooseVertical = (value) => {
    setVerticalFilter(value);
    setShowVerticalOptions(false);
    verticalTriggerRef.current?.focus();
  };

  const clearFilters = () => {
    setVerticalFilter("all");
    setSearchDraft("");
    setSearch("");
    setSearchFocused(false);
    setShowVerticalOptions(false);
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

      <section className="role-limit-filter-panel" aria-label="Role limit filters">
        <div className="role-limit-search-control">
          <label className="role-limit-search-filter">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="Search organizations"
              placeholder="Search organizations by name, slug, owner, or ID..."
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

        <div className="role-limit-vertical-menu" ref={verticalMenuRef}>
          <button
            type="button"
            ref={verticalTriggerRef}
            className={`role-limit-filter-trigger${verticalFilter !== "all" ? " is-active" : ""}`}
            aria-label={verticalFilter === "all" ? "Filter by vertical" : `Filter by vertical: ${verticalLabel(verticalFilter)}`}
            aria-expanded={showVerticalOptions}
            aria-controls="role-limit-vertical-options"
            onClick={() => setShowVerticalOptions((open) => !open)}
          >
            <Filter size={16} />
            <span>Filter</span>
            {verticalFilter !== "all" && <span className="role-limit-filter-active-value">{verticalLabel(verticalFilter)}</span>}
            <ChevronDown size={14} aria-hidden="true" />
          </button>

          {showVerticalOptions && (
            <div id="role-limit-vertical-options" className="role-limit-filter-popover" role="group" aria-label="Filter by vertical">
              <strong>Vertical</strong>
              {VERTICAL_FILTERS.map((filter) => (
                <button
                  type="button"
                  key={filter.value}
                  className={verticalFilter === filter.value ? "is-active" : ""}
                  aria-pressed={verticalFilter === filter.value}
                  onClick={() => chooseVertical(filter.value)}
                >
                  <span>{filter.label}</span>
                  {verticalFilter === filter.value && <Check size={15} aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="role-limit-filter-actions">
          {(verticalFilter !== "all" || searchDraft.trim() || search) && (
            <button type="button" className="role-limit-clear-button" onClick={clearFilters}>Clear</button>
          )}
          <button type="button" className="role-limit-refresh-button" onClick={load} disabled={loading} aria-label="Refresh role limits" title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </section>

      <section className="role-limit-summary-strip" aria-label="Role limit summary">
        <div className="role-limit-summary-item"><span>Organizations</span><strong>{fmtNumber(visibleSummary.totalTenants)}</strong></div>
        <div className="role-limit-summary-item"><span>Limited orgs</span><strong>{fmtNumber(visibleSummary.cappedTenants)}</strong></div>
        <div className="role-limit-summary-item"><span>Managed roles</span><strong>{fmtNumber(visibleSummary.totalCustomRoles)}</strong></div>
        <div className="role-limit-summary-item"><span>At role limit</span><strong>{fmtNumber(visibleSummary.tenantsAtLimit)}</strong></div>
      </section>

      {loading ? (
        <div className="role-limit-empty-state">Loading organizations...</div>
      ) : (
        <section className="role-limit-table-card" aria-label="Organizations role limits">
          <div className="role-limit-table-scroll" role="region" aria-label="Scrollable organization role limits" tabIndex={0}>
            <table className="super-admin-role-limits-table">
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
            <span className="role-limit-footer-hint">Use the vertical filters and search to narrow this list.</span>
          </footer>
        </section>
      )}
    </div>
  );
}
