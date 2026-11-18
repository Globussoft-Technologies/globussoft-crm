import { useEffect, useState } from "react";
import { AlertTriangle, Building2, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";

const ORGANIZATION_PAGE_SIZE = 50;

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
  const [offset, setOffset] = useState(0);
  const [organizations, setOrganizations] = useState([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const normalizedQuery = query.trim();
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
        const params = new URLSearchParams({ limit: String(ORGANIZATION_PAGE_SIZE), offset: String(offset) });
        if (normalizedQuery) params.set("q", normalizedQuery);
        const response = await superAdminFetch(`/tenant-management/organizations/search?${params.toString()}`);
        if (current) {
          setOrganizations(Array.isArray(response?.organizations) ? response.organizations : []);
          setTotal(Number(response?.total || 0));
        }
      } catch (err) {
        if (current) setError(err.message || "Organization search failed.");
      } finally {
        if (current) setLoading(false);
      }
    }, 250);

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [offset, query]);

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
      if (organizations.length === 1 && offset > 0) setOffset(Math.max(0, offset - ORGANIZATION_PAGE_SIZE));
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
  const listStart = total === 0 ? 0 : offset + 1;
  const listEnd = Math.min(offset + organizations.length, total);

  return (
    <div style={{ display: "grid", gap: "1rem", width: "100%", minWidth: 0 }}>
      <header>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <Trash2 size={24} color="#ef4444" /> Permanently Delete Organization
        </h1>
        <p style={{ margin: "0.4rem 0 0", color: "var(--text-secondary)" }}>
          Search by organization name, slug, owner email, or tenant ID. Deletion permanently removes the organization and its tenant-owned database records.
        </p>
      </header>

      <div role="note" className="card" style={{ padding: "1rem", display: "flex", alignItems: "flex-start", gap: "0.75rem", borderLeft: "4px solid #f59e0b" }}>
        <AlertTriangle size={19} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
          This cannot be undone. Financial, clinical, communication, and tenant audit records will be removed from the database. Uploaded files stored outside the database are not purged by this action. A separate platform audit record will remain. The platform default organization is protected.
        </div>
      </div>

      {message && <div role="status" className="card" style={{ padding: "0.85rem 1rem", borderLeft: "4px solid #22c55e" }}>{message}</div>}
      {error && !selected && <div role="alert" className="card" style={{ padding: "0.85rem 1rem", borderLeft: "4px solid #ef4444" }}>{error}</div>}

      <section className="card" style={{ padding: "1rem", display: "grid", gap: "0.85rem" }} aria-label="Search organizations">
        <label htmlFor="organization-search" style={{ fontWeight: 700 }}>Find an organization</label>
        <div style={{ position: "relative" }}>
          <Search size={16} style={{ position: "absolute", left: 12, top: 13, color: "var(--text-secondary)" }} />
          <input
            id="organization-search"
            className="input-field"
            type="search"
            autoComplete="off"
            placeholder="Organization, slug, owner email, or tenant ID"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
              setOrganizations([]);
              setTotal(0);
              setMessage("");
              setError("");
            }}
            style={{ width: "100%", paddingLeft: "2.35rem" }}
          />
        </div>
        {loading && <div style={{ color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 8 }}><LoaderCircle size={16} /> {query.trim() ? "Searching organizations..." : "Loading organizations..."}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", paddingTop: "0.25rem" }}>
          <strong>{query.trim() ? "Search results" : "All organizations"}</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: "0.82rem" }}>{total.toLocaleString()} {total === 1 ? "organization" : "organizations"}</span>
        </div>
        {!loading && query.trim().length === 1 && !/^\d+$/.test(query.trim()) && <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Enter 2 characters or a tenant ID to search.</div>}
        {!loading && organizations.length === 0 && !error && <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>{query.trim() ? "No organizations matched this search." : "No organizations are available."}</div>}

        <div style={{ display: "grid", gap: "0.65rem" }}>
          {organizations.map((organization) => (
            <article key={organization.id} style={{ padding: "0.85rem", border: "1px solid var(--border-color)", borderRadius: 10, display: "flex", gap: "1rem", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, display: "grid", gap: "0.25rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}><Building2 size={16} /> {organization.name}</div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.82rem", overflowWrap: "anywhere" }}>
                  ID {organization.id} · {organization.slug} · {organization.ownerEmail || "No owner email"} · {organization.vertical || "generic"}
                </div>
              </div>
              {organization.id === 1 ? (
                <span style={{ color: "var(--text-secondary)", fontSize: "0.82rem" }}>Protected platform default</span>
              ) : (
                <button type="button" onClick={() => openConfirmation(organization)} style={{ border: "1px solid #ef4444", background: "rgba(239,68,68,0.1)", color: "#ef4444", borderRadius: 8, padding: "0.55rem 0.8rem", display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                  <Trash2 size={15} /> Delete permanently
                </button>
              )}
            </article>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", borderTop: "1px solid var(--border-color)", paddingTop: "0.75rem", color: "var(--text-secondary)", fontSize: "0.82rem" }}>
          <span>Showing {listStart}-{listEnd} of {total.toLocaleString()}</span>
          <div style={{ display: "flex", gap: "0.55rem" }}>
            <button type="button" className="btn-secondary" disabled={offset === 0 || loading} onClick={() => setOffset((current) => Math.max(0, current - ORGANIZATION_PAGE_SIZE))}>Previous</button>
            <button type="button" className="btn-secondary" disabled={offset + ORGANIZATION_PAGE_SIZE >= total || loading} onClick={() => setOffset((current) => current + ORGANIZATION_PAGE_SIZE)}>Next</button>
          </div>
        </div>
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
