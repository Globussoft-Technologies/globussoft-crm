import { useEffect, useMemo, useState } from "react";
import { Building2, Check, Eye, EyeOff, RefreshCw, Save, Search, ShieldCheck } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import "./super-admin.css";

const surfaceStyle = {
  border: "1px solid var(--border-color, rgba(148,163,184,0.25))",
  borderRadius: 14,
  background: "var(--surface-color, rgba(255,255,255,0.04))",
};

const REQUIRED_PAGE_PATHS = new Set(["/home", "/dashboard", "/wellness", "/travel"]);

function buildQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== "") query.set(key, String(value));
  });
  const text = query.toString();
  return text ? `?${text}` : "";
}

function verticalLabel(vertical) {
  if (vertical === "wellness") return "Wellness";
  if (vertical === "travel") return "Travel";
  return "Generic CRM";
}

function groupPages(pages) {
  return pages.reduce((groups, page) => {
    const category = page.category || "Other";
    if (!groups[category]) groups[category] = [];
    groups[category].push(page);
    return groups;
  }, {});
}

export default function SuperAdminPageVisibility() {
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState("");
  const [visibility, setVisibility] = useState(null);
  const [hiddenPaths, setHiddenPaths] = useState(new Set());
  const [search, setSearch] = useState("");
  const [loadingTenants, setLoadingTenants] = useState(true);
  const [loadingVisibility, setLoadingVisibility] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const loadTenants = async () => {
    setLoadingTenants(true);
    try {
      const result = await superAdminFetch(`/tenant-management/tenants${buildQuery({ search: "" })}`);
      const rows = Array.isArray(result?.tenants) ? result.tenants : [];
      setTenants(rows);
      setTenantId((current) => current || (rows[0] ? String(rows[0].tenantId) : ""));
    } catch (err) {
      setMessage(err.message || "Failed to load organizations.");
    } finally {
      setLoadingTenants(false);
    }
  };

  const loadVisibility = async (nextTenantId = tenantId) => {
    if (!nextTenantId) {
      setVisibility(null);
      setHiddenPaths(new Set());
      return;
    }
    setLoadingVisibility(true);
    setMessage("");
    try {
      const result = await superAdminFetch(`/tenant-management/tenants/${nextTenantId}/page-visibility`);
      setVisibility(result);
      setHiddenPaths(new Set(Array.isArray(result?.hiddenPaths) ? result.hiddenPaths : []));
    } catch (err) {
      setMessage(err.message || "Failed to load page visibility.");
      setVisibility(null);
      setHiddenPaths(new Set());
    } finally {
      setLoadingVisibility(false);
    }
  };

  useEffect(() => {
    loadTenants();
  }, []);

  useEffect(() => {
    loadVisibility();
    // The selected tenant is the only dependency; the initial load chooses it
    // asynchronously from the organization overview response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const pages = useMemo(
    () => (Array.isArray(visibility?.pages) ? visibility.pages : []),
    [visibility?.pages],
  );
  const filteredPages = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return pages;
    return pages.filter((page) => [page.label, page.description, page.category, page.path]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(term));
  }, [pages, search]);
  const groups = useMemo(() => groupPages(filteredPages), [filteredPages]);
  const enabledCount = pages.filter((page) => !hiddenPaths.has(page.path)).length;
  const selectedTenant = tenants.find((tenant) => String(tenant.tenantId) === String(tenantId));

  const togglePage = (path) => {
    setHiddenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleGroup = (groupPagesList) => {
    const configurablePages = groupPagesList.filter((page) => !REQUIRED_PAGE_PATHS.has(page.path));
    const allEnabled = configurablePages.every((page) => !hiddenPaths.has(page.path));
    setHiddenPaths((current) => {
      const next = new Set(current);
      configurablePages.forEach((page) => {
        if (allEnabled) next.add(page.path);
        else next.delete(page.path);
      });
      return next;
    });
  };

  const save = async () => {
    if (!tenantId) return;
    setSaving(true);
    setMessage("");
    try {
      await superAdminFetch(`/tenant-management/tenants/${tenantId}/page-visibility`, {
        method: "PUT",
        body: JSON.stringify({ hiddenPaths: Array.from(hiddenPaths) }),
      });
      setMessage(`Page visibility updated for ${visibility?.tenant?.name || selectedTenant?.organization || "the organization"}.`);
      await loadVisibility(tenantId);
      // The regular CRM session listens for this event when this screen is
      // embedded in the same browser context; a fresh login also gets the
      // server-filtered catalog automatically.
      window.dispatchEvent(new CustomEvent("sidebar:pages-changed", { detail: { tenantId } }));
      window.dispatchEvent(new CustomEvent("tenant:page-visibility-changed", { detail: { tenantId } }));
      try {
        localStorage.setItem("globuscrm:tenant-page-visibility-updated", JSON.stringify({ tenantId, at: Date.now() }));
      } catch {
        // Storage is optional; the in-window event above is sufficient.
      }
    } catch (err) {
      setMessage(err.message || "Failed to save page visibility.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="super-admin-page-visibility" style={{ display: "grid", gap: "1rem", color: "var(--text-primary, #f8fafc)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <Eye size={25} color="var(--accent-color, #8aa8ff)" /> Organization Page Visibility
          </h1>
          <p style={{ margin: "0.45rem 0 0", color: "var(--text-secondary, #aab5ca)", maxWidth: 760 }}>
            Choose which CRM pages each organization can use. Hidden pages are removed from navigation, global page search, and tenant role-permission mapping for every user in that organization.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => { loadTenants(); if (tenantId) loadVisibility(tenantId); }} disabled={loadingTenants || loadingVisibility}>
          <RefreshCw size={15} /> Refresh
        </button>
      </header>

      {message && (
        <div style={{ ...surfaceStyle, padding: "0.85rem 1rem", color: /failed|error/i.test(message) ? "#fca5a5" : "#86efac" }} role="status">
          {message}
        </div>
      )}

      <section style={{ ...surfaceStyle, padding: "1rem", display: "grid", gap: "0.85rem" }}>
        <label style={{ display: "grid", gap: "0.4rem", maxWidth: 520 }}>
          <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-secondary, #aab5ca)" }}>Organization</span>
          <span style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
            <Building2 size={17} color="var(--accent-color, #8aa8ff)" aria-hidden="true" />
            <select className="input-field" value={tenantId} onChange={(event) => setTenantId(event.target.value)} disabled={loadingTenants || !tenants.length} style={{ flex: 1 }}>
              {!tenants.length && <option value="">No organizations found</option>}
              {tenants.map((tenant) => <option key={tenant.tenantId} value={tenant.tenantId}>{tenant.organization} · {verticalLabel(tenant.vertical)}</option>)}
            </select>
          </span>
        </label>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ color: "var(--text-secondary, #aab5ca)", fontSize: "0.84rem" }}>
            {visibility ? <><strong style={{ color: "var(--text-primary)" }}>{enabledCount}</strong> of {pages.length} pages enabled for {visibility.tenant?.name || selectedTenant?.organization}.</> : "Select an organization to configure its pages."}
          </div>
          <button type="button" className="btn-primary" onClick={save} disabled={!visibility || loadingVisibility || saving}>
            <Save size={15} /> {saving ? "Saving..." : "Save visibility"}
          </button>
        </div>
      </section>

      {visibility && (
        <section style={{ ...surfaceStyle, padding: "1rem", display: "grid", gap: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", maxWidth: 560 }}>
            <Search size={17} color="var(--text-secondary)" aria-hidden="true" />
            <input className="input-field" placeholder="Search pages by name, path, or category..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ flex: 1 }} />
          </div>

          {loadingVisibility ? <div style={{ color: "var(--text-secondary)" }}>Loading page catalog...</div> : Object.keys(groups).length === 0 ? <div style={{ color: "var(--text-secondary)" }}>No pages match this search.</div> : Object.entries(groups).map(([category, categoryPages]) => {
            const allEnabled = categoryPages.every((page) => !hiddenPaths.has(page.path));
            return (
              <div key={category} style={{ display: "grid", gap: "0.55rem" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                  <h2 style={{ margin: 0, fontSize: "0.95rem" }}>{category}</h2>
                  <button type="button" className="btn-secondary" onClick={() => toggleGroup(categoryPages)} style={{ fontSize: "0.75rem", padding: "0.35rem 0.55rem" }}>
                    {allEnabled ? "Hide all" : "Enable all"}
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: "0.55rem" }}>
                  {categoryPages.map((page) => {
                    const enabled = !hiddenPaths.has(page.path);
                    const required = REQUIRED_PAGE_PATHS.has(page.path);
                    return (
                      <button
                        type="button"
                        key={page.path}
                        onClick={() => { if (!required) togglePage(page.path); }}
                        disabled={required}
                        aria-pressed={enabled}
                        title={required ? "A landing page is required as a safe fallback." : page.description}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "auto 1fr auto",
                          gap: "0.7rem",
                          alignItems: "center",
                          textAlign: "left",
                          padding: "0.75rem",
                          borderRadius: 10,
                          border: `1px solid ${enabled ? "rgba(34,197,94,0.45)" : "var(--border-color, rgba(148,163,184,0.3))"}`,
                          background: enabled ? "rgba(34,197,94,0.08)" : "rgba(148,163,184,0.06)",
                          color: "var(--text-primary)",
                          cursor: required ? "not-allowed" : "pointer",
                          opacity: required ? 0.75 : 1,
                        }}
                      >
                        <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center", background: enabled ? "rgba(34,197,94,0.16)" : "rgba(148,163,184,0.13)" }}>
                          {enabled ? <Check size={15} color="#4ade80" /> : <EyeOff size={15} color="var(--text-secondary)" />}
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ display: "block", fontSize: "0.84rem" }}>{page.label}</strong>
                          <small style={{ display: "block", color: "var(--text-secondary)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{page.path}</small>
                        </span>
                        {required ? <ShieldCheck size={15} color="var(--text-secondary)" aria-label="Required fallback page" /> : enabled ? <Eye size={15} color="#4ade80" /> : <EyeOff size={15} color="var(--text-secondary)" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

