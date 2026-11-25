import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Building2, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import "./SuperAdminOrganizationDeletion.css";

const ORGANIZATION_BATCH_SIZE = 25;

function normalizeConfirmationName(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
}

function organizationDetails(organization) {
  return [
    `Organization: ${organization.name}`,
    `Tenant ID: ${organization.id}`,
    `Slug: ${organization.slug}`,
    `Owner: ${organization.ownerEmail || "-"}`,
    `Vertical: ${organization.vertical || "generic"}`,
  ].join("\n");
}

export default function SuperAdminOrganizationDeletion() {
  const [query, setQuery] = useState("");
  const [organizations, setOrganizations] = useState([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const listRef = useRef(null);
  const requestVersion = useRef(0);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    const normalizedQuery = query.trim();
    const requestId = ++requestVersion.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadMoreError("");
    if (normalizedQuery.length > 0 && normalizedQuery.length < 2 && !/^\d+$/.test(normalizedQuery)) {
      setOrganizations([]);
      setTotal(0);
      setLoading(false);
      return undefined;
    }

    let current = true;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: String(ORGANIZATION_BATCH_SIZE), offset: "0" });
        if (normalizedQuery) params.set("q", normalizedQuery);
        const response = await superAdminFetch(`/tenant-management/organizations/search?${params.toString()}`);
        if (current && requestId === requestVersion.current) {
          setOrganizations(Array.isArray(response?.organizations) ? response.organizations : []);
          setTotal(Number(response?.total || 0));
        }
      } catch (err) {
        if (current && requestId === requestVersion.current) setError(err.message || "Organization search failed.");
      } finally {
        if (current && requestId === requestVersion.current) setLoading(false);
      }
    }, 250);

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const loadMoreOrganizations = async () => {
    if (loading || loadingMoreRef.current || organizations.length >= total) return;
    const requestId = requestVersion.current;
    const offset = organizations.length;
    const normalizedQuery = query.trim();
    const params = new URLSearchParams({ limit: String(ORGANIZATION_BATCH_SIZE), offset: String(offset) });
    if (normalizedQuery) params.set("q", normalizedQuery);

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const response = await superAdminFetch(`/tenant-management/organizations/search?${params.toString()}`);
      if (requestId === requestVersion.current) {
        const nextOrganizations = Array.isArray(response?.organizations) ? response.organizations : [];
        setOrganizations((current) => {
          const currentIds = new Set(current.map((organization) => organization.id));
          return [...current, ...nextOrganizations.filter((organization) => !currentIds.has(organization.id))];
        });
        setTotal(Number(response?.total ?? total));
      }
    } catch (err) {
      if (requestId === requestVersion.current) setLoadMoreError(err.message || "Could not load more organizations.");
    } finally {
      if (requestId === requestVersion.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  const handleListScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 120) loadMoreOrganizations();
  };

  const openConfirmation = (organization) => {
    setSelected(organization);
    setConfirmationName("");
    setReason("");
    setMessage("");
    setError("");
  };

  const closeConfirmation = () => {
    if (deleting) return;
    setSelected(null);
    setConfirmationName("");
    setReason("");
  };

  const handleDelete = async (event) => {
    event.preventDefault();
    if (!selected || normalizeConfirmationName(confirmationName) !== normalizeConfirmationName(selected.name) || reason.trim().length < 3) return;

    setDeleting(true);
    setError("");
    setMessage("");
    try {
      const response = await superAdminFetch(`/tenant-management/organizations/${selected.id}/hard-delete`, {
        method: "POST",
        body: JSON.stringify({ confirmationName: confirmationName.trim(), reason: reason.trim() }),
      });
      setMessage(`Organization “${response.organization}” was permanently deleted. ${Number(response.deletedRowCount || 0).toLocaleString()} tenant-scoped rows were removed, along with dependent records. Audit entry #${response.auditId} was saved.`);
      setOrganizations((current) => current.filter((organization) => organization.id !== selected.id));
      setTotal((current) => Math.max(0, current - 1));
      setSelected(null);
      setConfirmationName("");
      setReason("");
    } catch (err) {
      setError(err.message || "Organization deletion failed.");
    } finally {
      setDeleting(false);
    }
  };

  const confirmationMatches = selected && normalizeConfirmationName(confirmationName) === normalizeConfirmationName(selected.name);
  const hasMoreOrganizations = organizations.length < total;

  return (
    <div className="super-admin-organization-deletion">
      <header className="super-admin-organization-deletion__header">
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <Trash2 size={24} color="#ef4444" /> Permanently Delete Organization
        </h1>
        <p style={{ margin: "0.4rem 0 0", color: "var(--text-secondary)" }}>
          Search by organization name, slug, owner email, or tenant ID. Deletion permanently removes the organization and its tenant-owned database records.
        </p>
      </header>

      <div role="note" className="card super-admin-organization-deletion__warning">
        <AlertTriangle size={19} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
        <div>
          This cannot be undone. Financial, clinical, communication, and tenant audit records will be removed from the database. Uploaded files stored outside the database are not purged by this action. A separate platform audit record will remain. The platform default organization is protected.
        </div>
      </div>

      {message && <div role="status" className="card super-admin-organization-deletion__notice is-success">{message}</div>}
      {error && !selected && <div role="alert" className="card super-admin-organization-deletion__notice is-error">{error}</div>}

      <section className="card super-admin-organization-deletion__workspace" aria-label="Search organizations">
        <label htmlFor="organization-search">Find an organization</label>
        <div className="super-admin-organization-deletion__search">
          <Search size={17} aria-hidden="true" />
          <input
            id="organization-search"
            className="super-admin-organization-deletion__search-input"
            type="text"
            autoComplete="off"
            placeholder="Organization, slug, owner email, or tenant ID"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (listRef.current) listRef.current.scrollTop = 0;
              setOrganizations([]);
              setTotal(0);
              setMessage("");
              setError("");
            }}
          />
        </div>
        {!loading && query.trim().length === 1 && !/^\d+$/.test(query.trim()) && <div className="super-admin-organization-deletion__search-hint">Enter 2 characters or a tenant ID to search.</div>}

        <div className="super-admin-organization-deletion__results" ref={listRef} onScroll={handleListScroll} role="region" aria-label="Organization results" tabIndex={0}>
          <table className="super-admin-organization-deletion__table">
            <thead>
              <tr><th scope="col">Organization</th><th scope="col">Vertical</th><th scope="col">Action</th></tr>
            </thead>
            <tbody>
          {loading && organizations.length === 0 && (
            <tr><td colSpan="3"><div className="super-admin-organization-deletion__list-state" role="status"><LoaderCircle size={17} /> {query.trim() ? "Searching organizations..." : "Loading organizations..."}</div></td></tr>
          )}
          {!loading && organizations.length === 0 && !error && query.trim().length !== 1 && (
            <tr><td colSpan="3"><div className="super-admin-organization-deletion__list-state">{query.trim() ? "No organizations matched this search." : "No organizations are available."}</div></td></tr>
          )}
          {organizations.map((organization) => (
            <tr key={organization.id}>
              <td>
                <div className="super-admin-organization-deletion__name"><Building2 size={16} aria-hidden="true" /> {organization.name}</div>
                <div className="super-admin-organization-deletion__details">
                  ID {organization.id} · {organization.slug} · {organization.ownerEmail || "No owner email"}
                </div>
              </td>
              <td><span className="super-admin-organization-deletion__vertical">{organization.vertical || "generic"}</span></td>
              <td>
                {organization.id === 1 ? (
                  <span className="super-admin-organization-deletion__protected">Protected platform default</span>
                ) : (
                  <button type="button" className="super-admin-organization-deletion__delete-button" onClick={() => openConfirmation(organization)}>
                    <Trash2 size={15} /> Delete permanently
                  </button>
                )}
              </td>
            </tr>
          ))}
          {loadingMore && <tr><td colSpan="3"><div className="super-admin-organization-deletion__list-state" role="status"><LoaderCircle size={16} /> Loading more organizations...</div></td></tr>}
            </tbody>
          </table>
        </div>
        <footer className="super-admin-organization-deletion__list-footer" aria-live="polite">
          <span>Showing {organizations.length.toLocaleString()} of {total.toLocaleString()} organizations</span>
          {loadMoreError ? (
            <button type="button" onClick={loadMoreOrganizations} disabled={loadingMore} className="super-admin-organization-deletion__retry">Retry loading more</button>
          ) : hasMoreOrganizations ? (
            <span>{loadingMore ? "Loading more organizations..." : "Scroll down to load more"}</span>
          ) : (
            <span>All organizations loaded</span>
          )}
        </footer>
      </section>

      {selected && (
        <div
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeConfirmation(); }}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.72)", display: "grid", placeItems: "center", padding: "1rem" }}
        >
          <section role="dialog" aria-modal="true" aria-labelledby="delete-confirmation-title" className="card" style={{ width: "min(100%, 620px)", maxHeight: "90vh", overflow: "auto", padding: "1.25rem", display: "grid", gap: "0.9rem", border: "1px solid rgba(239,68,68,0.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
              <div>
                <h2 id="delete-confirmation-title" style={{ margin: 0, fontSize: "1.2rem", display: "flex", alignItems: "center", gap: 8, color: "#ef4444" }}><AlertTriangle size={20} /> Confirm permanent deletion</h2>
                <p style={{ margin: "0.55rem 0 0", color: "var(--text-secondary)" }}>This action will permanently delete this organization and its data. There is no recovery.</p>
              </div>
              <button type="button" onClick={closeConfirmation} disabled={deleting} aria-label="Close confirmation" className="btn-secondary" style={{ padding: "0.35rem", display: "grid", placeItems: "center" }}><X size={17} /></button>
            </div>

            <pre style={{ margin: 0, padding: "0.8rem", borderRadius: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit", fontSize: "0.84rem", background: "var(--input-bg, rgba(0,0,0,0.12))" }}>{organizationDetails(selected)}</pre>

            {error && <div role="alert" style={{ color: "#ef4444", fontSize: "0.88rem" }}>{error}</div>}

            <form onSubmit={handleDelete} style={{ display: "grid", gap: "0.8rem" }}>
              <label style={{ display: "grid", gap: "0.35rem", fontSize: "0.88rem" }}>
                Type <strong>{selected.name}</strong> to confirm
                <input className="input-field" autoFocus value={confirmationName} onChange={(event) => setConfirmationName(event.target.value)} autoComplete="off" />
              </label>
              <label style={{ display: "grid", gap: "0.35rem", fontSize: "0.88rem" }}>
                Reason for deletion (saved to the audit log)
                <textarea className="input-field" rows={3} maxLength={2000} required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Enter the reason for permanently deleting this organization" />
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", flexWrap: "wrap" }}>
                <button type="button" onClick={closeConfirmation} disabled={deleting} className="btn-secondary">Cancel</button>
                <button type="submit" disabled={deleting || !confirmationMatches || reason.trim().length < 3} style={{ border: "1px solid #ef4444", background: deleting || !confirmationMatches || reason.trim().length < 3 ? "rgba(239,68,68,0.35)" : "#dc2626", color: "white", borderRadius: 8, padding: "0.65rem 0.9rem", display: "inline-flex", alignItems: "center", gap: 7, cursor: deleting ? "wait" : "pointer" }}>
                  <Trash2 size={15} /> {deleting ? "Deleting organization..." : "Permanently delete organization"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
