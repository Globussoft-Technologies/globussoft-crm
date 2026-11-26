import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, Search, X } from "lucide-react";
import TmcCataloguePdfCard from "../../components/travel/TmcCataloguePdfCard";
import { useNotify } from "../../utils/notify";

const DEFAULT_BATCH_SIZE = 20;
const MAX_CUSTOM_BATCH_SIZE = 500;
const API_ROOT = "/api/portal/tmc/teacher/catalogues";
const CATALOGUE_CACHE_PREFIX = "tmcTeacherCatalogueLibrary.v1";

function getCatalogueCacheKey(token) {
  try {
    const payloadSegment = String(token || "").split(".")[1];
    if (!payloadSegment) return null;
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    if (claims.type !== "PORTAL" || claims.tenantId == null || claims.contactId == null) return null;
    return `${CATALOGUE_CACHE_PREFIX}:${claims.tenantId}:${claims.contactId}`;
  } catch {
    return null;
  }
}

function readCatalogueCache(cacheKey) {
  if (!cacheKey) return null;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (!cached || !Array.isArray(cached.catalogues)) return null;
    const availableIds = new Set(cached.catalogues.map((file) => String(file.driveFileId)));
    return {
      connected: Boolean(cached.connected),
      catalogues: cached.catalogues,
      selectedIds: (Array.isArray(cached.selectedIds) ? cached.selectedIds : [])
        .map(String)
        .filter((fileId) => availableIds.has(fileId)),
      submittedAt: cached.submittedAt || null,
    };
  } catch {
    return null;
  }
}

function writeCatalogueCache(cacheKey, value) {
  if (!cacheKey) return;
  try {
    localStorage.setItem(cacheKey, JSON.stringify({
      connected: value.connected,
      catalogues: value.catalogues,
      selectedIds: [...value.selectedIds],
      submittedAt: value.submittedAt,
      cachedAt: Date.now(),
    }));
  } catch {
    // The browser cache is only a performance aid; quota/private-mode failures are non-fatal.
  }
}

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

function pageButtonStyle(active) {
  return {
    border: `1px solid ${active ? "var(--tmc-primary, #315c78)" : "var(--tmc-border, #d7e0e6)"}`,
    borderRadius: 7,
    minWidth: 30,
    height: 30,
    padding: "0 7px",
    background: active ? "var(--tmc-primary, #315c78)" : "var(--tmc-surface, #fff)",
    color: active ? "var(--tmc-primary-contrast, #fff)" : "inherit",
    font: "inherit",
    cursor: "pointer",
  };
}

export default function TmcTeacherCatalogues({ token, onSessionExpired }) {
  const notify = useNotify();
  const cacheKey = getCatalogueCacheKey(token);
  const initialCacheRef = useRef(undefined);
  if (initialCacheRef.current === undefined) initialCacheRef.current = readCatalogueCache(cacheKey);
  const initialCache = initialCacheRef.current;
  const [files, setFiles] = useState(() => initialCache?.catalogues || []);
  const [loading, setLoading] = useState(() => !initialCache);
  const [refreshing, setRefreshing] = useState(() => Boolean(initialCache));
  const [hasLibrarySnapshot, setHasLibrarySnapshot] = useState(() => Boolean(initialCache));
  const [connected, setConnected] = useState(() => Boolean(initialCache?.connected));
  const [responseStorageAvailable, setResponseStorageAvailable] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set(initialCache?.selectedIds || []));
  const [submittedAt, setSubmittedAt] = useState(() => initialCache?.submittedAt || null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [batchSizeOption, setBatchSizeOption] = useState(String(DEFAULT_BATCH_SIZE));
  const [customBatchSize, setCustomBatchSize] = useState("100");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const catalogueScrollRef = useRef(null);
  const selectionTouchedRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(!initialCache);
    setRefreshing(Boolean(initialCache));
    setError("");
    portalRequest(API_ROOT, { token })
      .then((result) => {
        if (!active) return;
        setConnected(Boolean(result.connected));
        setResponseStorageAvailable(result.responseStorageAvailable !== false);
        const catalogues = Array.isArray(result.catalogues) ? result.catalogues : [];
        setFiles(catalogues);
        setHasLibrarySnapshot(true);
        const availableIds = new Set(catalogues.map((file) => String(file.driveFileId)));
        const selected = Array.isArray(result.response?.selectedCatalogues)
          ? result.response.selectedCatalogues
          : [];
        const serverSelectedIds = selected
          .map((file) => String(file.driveFileId))
          .filter((fileId) => availableIds.has(fileId));
        if (!selectionTouchedRef.current) setSelectedIds(new Set(serverSelectedIds));
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
      .finally(() => {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => { active = false; };
  }, [onSessionExpired, token]);

  useEffect(() => {
    if (!hasLibrarySnapshot) return;
    writeCatalogueCache(cacheKey, { connected, catalogues: files, selectedIds, submittedAt });
  }, [cacheKey, connected, files, hasLibrarySnapshot, selectedIds, submittedAt]);

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

  const totalPages = Math.max(1, Math.ceil(visibleFiles.length / batchSize));
  const safePage = Math.min(page, totalPages);
  const pageFiles = visibleFiles.slice((safePage - 1) * batchSize, safePage * batchSize);
  const firstVisible = visibleFiles.length === 0 ? 0 : (safePage - 1) * batchSize + 1;
  const lastVisible = Math.min(safePage * batchSize, visibleFiles.length);

  useEffect(() => {
    if (catalogueScrollRef.current) catalogueScrollRef.current.scrollTop = 0;
  }, [safePage, query, statusFilter, batchSize]);

  const pageControls = useMemo(() => {
    const start = Math.max(1, Math.min(safePage - 2, totalPages - 4));
    const end = Math.min(totalPages, start + 4);
    const middle = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    const pages = [...new Set([1, ...middle, totalPages])];
    return pages.map((pageNumber, index) => ({
      pageNumber,
      gapBefore: index > 0 && pageNumber - pages[index - 1] > 1,
    }));
  }, [safePage, totalPages]);

  const changeBatchSize = (nextOption, customValue = customBatchSize) => {
    setBatchSizeOption(nextOption);
    if (nextOption === "custom") {
      const parsed = Number.parseInt(customValue, 10);
      if (!Number.isInteger(parsed) || parsed < 1) return;
      const nextSize = Math.min(parsed, MAX_CUSTOM_BATCH_SIZE);
      setBatchSize(nextSize);
      setPage(1);
      return;
    }
    const nextSize = Number.parseInt(nextOption, 10);
    setBatchSize(nextSize);
    setPage(1);
  };

  const updateSearch = (value) => {
    setQuery(value);
    setPage(1);
  };

  const updateStatusFilter = (value) => {
    setStatusFilter(value);
    setPage(1);
  };

  const goToPage = (nextPage) => {
    setPage(Math.max(1, Math.min(nextPage, totalPages)));
  };

  const toggleSelection = (file) => {
    selectionTouchedRef.current = true;
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
        gap: 10,
        width: "100%",
        minWidth: 0,
        minHeight: 0,
        color: "var(--tmc-text, #172b3a)",
      }}
    >
      <div data-tmc-catalogue-fixed-header="true" style={{ display: "grid", flex: "0 0 auto", gap: 10 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ color: "var(--tmc-primary, #315c78)", fontSize: 11, fontWeight: 800, letterSpacing: ".1em", textTransform: "uppercase" }}>TMC brochures</div>
          <h2 style={{ margin: "3px 0 4px", fontSize: "clamp(22px, 2.5vw, 29px)", lineHeight: 1.2, color: "var(--tmc-heading, #173b50)" }}>TMC Catalogues</h2>
          <p style={{ margin: 0, color: "var(--tmc-muted, #71808a)", fontSize: 13, lineHeight: 1.4, maxWidth: 950 }}>
            Browse the available trip brochures and preview the PDFs. Use the checkbox on each brochure card to select the catalogues you would like the travel team to review.
          </p>
        </div>
        <button type="button" onClick={submitSelection} disabled={saving || loading || selectedIds.size === 0 || !responseStorageAvailable} style={{ display: "inline-flex", alignItems: "center", gap: 8, border: 0, borderRadius: 8, padding: "9px 13px", background: "var(--tmc-primary, #315c78)", color: "var(--tmc-primary-contrast, #fff)", fontWeight: 800, cursor: saving || loading || selectedIds.size === 0 || !responseStorageAvailable ? "not-allowed" : "pointer", opacity: saving || loading || selectedIds.size === 0 || !responseStorageAvailable ? 0.65 : 1 }}>
          {saving ? <Loader2 size={16} className="tmc-catalogue-spin" /> : <CheckCircle2 size={16} />}
          {saving ? "Submitting…" : submittedAt ? "Update selection" : "Submit selection"}
        </button>
      </header>

      <div style={{ ...cardStyle({ padding: "9px 13px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13 }) }}>
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
          padding: 12,
        })}
      >
        <div style={{ display: "flex", flex: "0 0 auto", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", paddingBottom: 9 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18 }}>Available catalogues</h3>
            <span style={{ color: "var(--tmc-muted, #71808a)", fontSize: 13 }}>{loading ? "Loading brochures…" : `${visibleFiles.length} PDF${visibleFiles.length === 1 ? "" : "s"}${refreshing ? " · Updating library…" : ""}`}</span>
          </div>
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            <select value={statusFilter} onChange={(event) => updateStatusFilter(event.target.value)} aria-label="Filter catalogue files" style={{ border: "1px solid var(--tmc-border, #dfe7eb)", borderRadius: 8, padding: "8px 9px", background: "var(--tmc-surface, #fff)", color: "inherit" }}>
              <option value="all">All files</option><option value="indexed">Indexed</option><option value="pending">Waiting for sync</option><option value="crm-itineraries">CRM Itineraries</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 7, border: "1px solid var(--tmc-border, #dfe7eb)", borderRadius: 8, padding: "7px 9px", minWidth: 210 }}>
              <Search size={15} aria-hidden />
              <input value={query} onChange={(event) => updateSearch(event.target.value)} placeholder="Search catalogues…" aria-label="Search catalogues" style={{ minWidth: 0, width: "100%", border: 0, outline: 0, background: "transparent", color: "inherit" }} />
            </label>
          </div>
        </div>
        <div
          data-tmc-catalogue-scroll="true"
          ref={catalogueScrollRef}
          style={{ flex: "1 1 0", minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", paddingRight: 4 }}
        >

        {loading ? <div role="status" style={{ padding: 36, textAlign: "center", color: "var(--tmc-muted, #71808a)" }}><Loader2 size={24} className="tmc-catalogue-spin" style={{ display: "block", margin: "0 auto 9px" }} />Loading the TMC brochure library…</div>
          : visibleFiles.length === 0 ? <div style={{ padding: 30, textAlign: "center", color: "var(--tmc-muted, #71808a)" }}><FileText size={28} /><p>No brochures match this filter.</p></div>
            : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 230px), 1fr))", alignItems: "stretch", gap: 10 }}>
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
        </div>
        <footer data-tmc-catalogue-pagination="true" style={{ display: "flex", flex: "0 0 auto", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", borderTop: "1px solid var(--tmc-border, #e6ebef)", marginTop: 8, paddingTop: 9, color: "var(--tmc-muted, #71808a)", fontSize: 12 }}>
          <span aria-live="polite">{loading ? "Loading catalogues…" : `Showing ${firstVisible}–${lastVisible} of ${visibleFiles.length} catalogues${totalPages > 1 ? ` · Page ${safePage} of ${totalPages}` : ""}${refreshing ? " · Updating library…" : ""}`}</span>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <label htmlFor="tmc-catalogue-batch-size">Per page:</label>
            <select id="tmc-catalogue-batch-size" aria-label="Catalogues per page" value={batchSizeOption} onChange={(event) => changeBatchSize(event.target.value)} style={{ border: "1px solid var(--tmc-border, #dfe7eb)", borderRadius: 7, padding: "6px 8px", background: "var(--tmc-surface, #fff)", color: "inherit" }}>
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="custom">Custom</option>
            </select>
            {batchSizeOption === "custom" && <input aria-label="Custom catalogues per page" type="number" min="1" max={MAX_CUSTOM_BATCH_SIZE} step="1" value={customBatchSize} onChange={(event) => { const value = event.target.value; const parsed = Number.parseInt(value, 10); const nextValue = Number.isInteger(parsed) && parsed > MAX_CUSTOM_BATCH_SIZE ? String(MAX_CUSTOM_BATCH_SIZE) : value; setCustomBatchSize(nextValue); changeBatchSize("custom", nextValue); }} style={{ boxSizing: "border-box", width: 76, border: "1px solid var(--tmc-border, #dfe7eb)", borderRadius: 7, padding: "6px 8px", background: "var(--tmc-surface, #fff)", color: "inherit" }} />}
            <nav aria-label="Catalogue pages" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button type="button" onClick={() => goToPage(safePage - 1)} disabled={safePage <= 1} aria-label="Previous catalogue page" style={{ border: "1px solid var(--tmc-border, #d7e0e6)", borderRadius: 7, minWidth: 30, height: 30, padding: "0 7px", background: "var(--tmc-surface, #fff)", color: "inherit", cursor: safePage <= 1 ? "not-allowed" : "pointer", opacity: safePage <= 1 ? 0.5 : 1 }}>‹</button>
              {pageControls.map(({ pageNumber, gapBefore }) => <span key={pageNumber} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {gapBefore && <span aria-hidden="true" style={{ padding: "0 2px" }}>…</span>}
                <button type="button" onClick={() => goToPage(pageNumber)} aria-label={`Catalogue page ${pageNumber}`} aria-current={pageNumber === safePage ? "page" : undefined} style={pageButtonStyle(pageNumber === safePage)}>{pageNumber}</button>
              </span>)}
              <button type="button" onClick={() => goToPage(safePage + 1)} disabled={safePage >= totalPages} aria-label="Next catalogue page" style={{ border: "1px solid var(--tmc-border, #d7e0e6)", borderRadius: 7, minWidth: 30, height: 30, padding: "0 7px", background: "var(--tmc-surface, #fff)", color: "inherit", cursor: safePage >= totalPages ? "not-allowed" : "pointer", opacity: safePage >= totalPages ? 0.5 : 1 }}>›</button>
            </nav>
          </div>
        </footer>
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
