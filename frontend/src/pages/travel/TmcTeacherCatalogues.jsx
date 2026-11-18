import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileText, Loader2, Search, X } from "lucide-react";
import Pagination from "../../components/ui/Pagination";
import TmcCataloguePdfCard from "../../components/travel/TmcCataloguePdfCard";
import { useNotify } from "../../utils/notify";

const PAGE_SIZE = 20;
const API_ROOT = "/api/portal/tmc/teacher/catalogues";

async function portalRequest(path, { token, method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), {
      status: response.status,
      body: data,
    });
  }
  return data;
}

function cardStyle(extra = {}) {
  return {
    background: "var(--tmc-surface, #fff)",
    border: "1px solid var(--tmc-border, #dfe7eb)",
    borderRadius: 12,
    color: "var(--tmc-text, #172b3a)",
    ...extra,
  };
}

export default function TmcTeacherCatalogues({ token, onSessionExpired }) {
  const notify = useNotify();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [responseStorageAvailable, setResponseStorageAvailable] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [submittedAt, setSubmittedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    portalRequest(API_ROOT, { token })
      .then((result) => {
        if (!active) return;
        setConnected(Boolean(result.connected));
        setResponseStorageAvailable(result.responseStorageAvailable !== false);
        const catalogues = Array.isArray(result.catalogues) ? result.catalogues : [];
        setFiles(catalogues);
        const availableIds = new Set(catalogues.map((file) => String(file.driveFileId)));
        const selected = Array.isArray(result.response?.selectedCatalogues)
          ? result.response.selectedCatalogues
          : [];
        setSelectedIds(new Set(selected
          .map((file) => String(file.driveFileId))
          .filter((fileId) => availableIds.has(fileId))));
        setSubmittedAt(result.response?.submittedAt || null);
      })
      .catch((requestError) => {
        if (!active) return;
        if ([401, 403, 404].includes(requestError.status)) {
          onSessionExpired?.("Your teacher session is no longer available. Please sign in again.");
          return;
        }
        setError(requestError.body?.error || requestError.message || "Unable to load TMC catalogues");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [onSessionExpired, token]);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

  const visibleFiles = useMemo(() => files.filter((file) => {
    const text = `${file.fileName || ""} ${file.folderPath || ""}`.toLowerCase();
    const matchesQuery = text.includes(query.trim().toLowerCase());
    const inCrmItineraries = /(^|\/)CRM Itineraries(\/|$)/i.test(String(file.folderPath || ""));
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "indexed" && file.indexed)
      || (statusFilter === "pending" && !file.indexed)
      || (statusFilter === "crm-itineraries" && inCrmItineraries);
    return matchesQuery && matchesStatus;
  }), [files, query, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(visibleFiles.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageFiles = visibleFiles.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const toggleSelection = (file) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const id = String(file.driveFileId);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openPdf = async (file) => {
    setPreview({ file, loading: true, url: null });
    try {
      const response = await fetch(`${API_ROOT}/${encodeURIComponent(file.driveFileId)}/file`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Unable to open this PDF");
      }
      const url = URL.createObjectURL(await response.blob());
      setPreview({ file, loading: false, url });
    } catch (openError) {
      setPreview(null);
      notify.error(openError.message || "Unable to open this PDF");
    }
  };

  const submitSelection = async () => {
    if (!responseStorageAvailable) {
      notify.error("Catalogue responses are not ready yet. Please contact your travel administrator.");
      return;
    }
    if (selectedIds.size === 0) {
      notify.error("Select at least one catalogue before submitting.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await portalRequest(`${API_ROOT}/response`, {
        token,
        method: "POST",
        body: { selectedFileIds: [...selectedIds] },
      });
      setSubmittedAt(result.response?.submittedAt || new Date().toISOString());
      notify.success("Your catalogue selection has been submitted.");
    } catch (submitError) {
      if ([401, 403, 404].includes(submitError.status)) {
        onSessionExpired?.("Your teacher session is no longer available. Please sign in again.");
      } else {
        const message = submitError.body?.error || submitError.message || "Unable to submit your selection";
        setError(message);
        notify.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const closePreview = () => setPreview(null);

  return (
    <section
      data-tmc-catalogue-page="true"
      style={{
        display: "flex",
        flex: "1 1 0",
        flexDirection: "column",
        gap: 16,
        width: "100%",
        minWidth: 0,
        minHeight: 0,
        color: "var(--tmc-text, #172b3a)",
      }}
    >
      <div data-tmc-catalogue-fixed-header="true" style={{ display: "grid", flex: "0 0 auto", gap: 14 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
        <div>
          <div style={{ color: "var(--tmc-primary, #315c78)", fontSize: 12, fontWeight: 800, letterSpacing: ".1em", textTransform: "uppercase" }}>TMC brochures</div>
          <h2 style={{ margin: "8px 0", fontSize: "clamp(24px, 3vw, 34px)", color: "var(--tmc-heading, #173b50)" }}>TMC Catalogues</h2>
          <p style={{ margin: 0, color: "var(--tmc-muted, #71808a)", lineHeight: 1.55, maxWidth: 700 }}>
            Browse the available trip brochures and preview the PDFs. Use the checkbox on each brochure card to select the catalogues you would like the travel team to review.
          </p>
        </div>
        <button type="button" onClick={submitSelection} disabled={saving || loading || selectedIds.size === 0 || !responseStorageAvailable} style={{ display: "inline-flex", alignItems: "center", gap: 8, border: 0, borderRadius: 8, padding: "11px 16px", background: "var(--tmc-primary, #315c78)", color: "var(--tmc-primary-contrast, #fff)", fontWeight: 800, cursor: saving || loading || selectedIds.size === 0 || !responseStorageAvailable ? "not-allowed" : "pointer", opacity: saving || loading || selectedIds.size === 0 || !responseStorageAvailable ? 0.65 : 1 }}>
          {saving ? <Loader2 size={16} className="tmc-catalogue-spin" /> : <CheckCircle2 size={16} />}
          {saving ? "Submitting…" : submittedAt ? "Update selection" : "Submit selection"}
        </button>
      </header>

      <div style={{ ...cardStyle({ padding: "13px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }) }}>
        <span><strong>{selectedIds.size}</strong> catalogue{selectedIds.size === 1 ? "" : "s"} selected</span>
        <span style={{ color: "var(--tmc-muted, #71808a)", fontSize: 13 }}>{submittedAt ? `Last submitted ${new Date(submittedAt).toLocaleString()}` : "Your selection has not been submitted yet."}</span>
      </div>

      {!connected && !loading && !error && <div role="status" style={{ ...cardStyle({ padding: 14, color: "var(--tmc-muted, #71808a)" }) }}>The TMC brochure library is not connected yet. Please contact your travel administrator.</div>}
      {!responseStorageAvailable && !loading && <div role="status" style={{ ...cardStyle({ padding: 14, color: "var(--tmc-error-text, #b42318)" }) }}>You can browse the brochures, but catalogue responses are not ready yet. Please contact your travel administrator.</div>}
      {error && <div role="alert" style={{ ...cardStyle({ padding: 14, color: "var(--tmc-error-text, #b42318)" }) }}>{error}</div>}
      </div>

      <section
        data-tmc-catalogue-browser="true"
        style={cardStyle({
          display: "flex",
          flex: "1 1 0",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          padding: 16,
        })}
      >
        <div style={{ display: "flex", flex: "0 0 auto", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", paddingBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 20 }}>Available catalogues</h3>
            <span style={{ color: "var(--tmc-muted, #71808a)", fontSize: 13 }}>{loading ? "Loading brochures…" : `${visibleFiles.length} PDF${visibleFiles.length === 1 ? "" : "s"}`}</span>
          </div>
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} aria-label="Filter catalogue files" style={{ border: "1px solid var(--tmc-border, #dfe7eb)", borderRadius: 8, padding: "9px 10px", background: "var(--tmc-surface, #fff)", color: "inherit" }}>
              <option value="all">All files</option><option value="indexed">Indexed</option><option value="pending">Waiting for sync</option><option value="crm-itineraries">CRM Itineraries</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 7, border: "1px solid var(--tmc-border, #dfe7eb)", borderRadius: 8, padding: "8px 10px", minWidth: 220 }}>
              <Search size={15} aria-hidden />
              <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search catalogues…" aria-label="Search catalogues" style={{ minWidth: 0, width: "100%", border: 0, outline: 0, background: "transparent", color: "inherit" }} />
            </label>
          </div>
        </div>
        <div
          data-tmc-catalogue-scroll="true"
          style={{ flex: "1 1 0", minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", paddingRight: 4 }}
        >

        {loading ? <div role="status" style={{ padding: 36, textAlign: "center", color: "var(--tmc-muted, #71808a)" }}><Loader2 size={24} className="tmc-catalogue-spin" style={{ display: "block", margin: "0 auto 9px" }} />Loading the TMC brochure library…</div>
          : pageFiles.length === 0 ? <div style={{ padding: 34, textAlign: "center", color: "var(--tmc-muted, #71808a)" }}><FileText size={28} /><p>No brochures match this filter.</p></div>
            : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", alignItems: "stretch", gap: 18 }}>
              {pageFiles.map((file) => <TmcCataloguePdfCard
                key={file.driveFileId}
                file={file}
                selected={selectedIds.has(String(file.driveFileId))}
                onToggle={toggleSelection}
                onOpen={openPdf}
                thumbnailEndpoint={`${API_ROOT}/${encodeURIComponent(file.driveFileId)}/thumbnail`}
                thumbnailToken={token}
              />)}
            </div>}
        {visibleFiles.length > PAGE_SIZE && <Pagination page={safePage} pageSize={PAGE_SIZE} total={visibleFiles.length} onChange={setPage} showRangeLabel={false} style={{ marginTop: 18, padding: 0, justifyContent: "flex-end" }} />}
        </div>
      </section>

      {preview && <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }} style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 18, background: "rgba(12, 22, 33, .72)" }}>
        <section role="dialog" aria-modal="true" aria-label={`PDF preview: ${preview.file.fileName}`} style={{ ...cardStyle({ width: "min(1100px, 100%)", height: "min(90vh, 900px)", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "var(--tmc-shadow)" }) }}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--tmc-border, #dfe7eb)" }}>
            <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.file.fileName}</strong>
            <button type="button" onClick={closePreview} aria-label="Close PDF preview" style={{ display: "grid", placeItems: "center", width: 34, height: 34, border: "1px solid var(--tmc-border, #dfe7eb)", borderRadius: 7, color: "inherit", background: "transparent", cursor: "pointer" }}><X size={17} /></button>
          </header>
          {preview.loading ? <div role="status" style={{ flex: 1, display: "grid", placeItems: "center" }}><Loader2 size={28} className="tmc-catalogue-spin" /></div>
            : <iframe title={`PDF preview: ${preview.file.fileName}`} src={preview.url} style={{ flex: 1, width: "100%", border: 0, background: "#f4f6f8" }} />}
        </section>
      </div>}
      <style>{"@keyframes tmc-catalogue-spin { to { transform: rotate(360deg); } } .tmc-catalogue-spin { animation: tmc-catalogue-spin 1s linear infinite; }"}</style>
    </section>
  );
}
