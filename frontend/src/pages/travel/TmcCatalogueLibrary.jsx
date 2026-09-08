import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, CheckCircle2, Cloud, ExternalLink, FileText, Folder, Loader2, Search, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { Link } from "react-router-dom";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import Pagination from "../../components/ui/Pagination";

function cardStyle(extra = {}) {
  return {
    background: "var(--surface-color, #ffffff)",
    border: "1px solid var(--border-color, #303746)",
    borderRadius: 14,
    ...extra,
  };
}

export default function TmcCatalogueLibrary() {
  const notify = useNotify();
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [files, setFiles] = useState([]);
  const [itineraries, setItineraries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const cacheKey = "travel.tmcCatalogue.library.v1";
  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached?.files) {
        setConfig(cached.config || {});
        setStatus(cached.status || {});
        setFiles(cached.files);
        setItineraries(cached.itineraries || []);
        setLoading(false);
      }
    } catch { /* stale cache is non-critical */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, stat, indexed, itineraryRes] = await Promise.all([
        fetchApi("/api/travel/knowledge-base/config", { silent: true }),
        fetchApi("/api/travel/knowledge-base/status", { silent: true }),
        fetchApi("/api/travel/knowledge-base/files?subBrand=tmc&limit=200", { silent: true }),
        fetchApi("/api/travel/itineraries?subBrand=tmc&fields=summary&limit=200", { silent: true }),
      ]);
      let driveFiles = [];
      if (cfg?.rootFolderId) {
        const walk = async (parentId, path = "") => {
          const result = await fetchApi(`/api/travel/knowledge-base/browse?parentId=${encodeURIComponent(parentId)}`, { silent: true });
          for (const item of result?.items || []) {
            if (item.isFolder) await walk(item.id, path ? `${path}/${item.name}` : item.name);
            else if (item.mimeType === "application/pdf" || String(item.name || "").toLowerCase().endsWith(".pdf")) driveFiles.push({ ...item, folderPath: path });
          }
        };
        const root = await fetchApi(`/api/travel/knowledge-base/browse?parentId=${encodeURIComponent(cfg.rootFolderId)}`, { silent: true });
        const tmc = (root?.items || []).find((item) => item.isFolder && String(item.name).replace(/[^a-z0-9]/gi, "").toLowerCase() === "tmc");
        if (tmc) await walk(tmc.id, tmc.name);
      }
      setConfig(cfg || {});
      setStatus(stat || {});
      const indexedById = new Map((Array.isArray(indexed?.files) ? indexed.files : []).map((file) => [String(file.driveFileId), file]));
      setFiles(driveFiles.map((file) => ({ ...file, ...(indexedById.get(String(file.id)) || {}), driveFileId: file.id, fileName: file.name, indexed: indexedById.has(String(file.id)), driveViewLink: file.webViewLink || indexedById.get(String(file.id))?.driveViewLink || null, thumbnailLink: file.thumbnailLink || null })));
      setItineraries(Array.isArray(itineraryRes?.itineraries) ? itineraryRes.itineraries : []);
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ config: cfg || {}, status: stat || {}, files: driveFiles.map((file) => ({ ...file, ...(indexedById.get(String(file.id)) || {}), driveFileId: file.id, fileName: file.name, indexed: indexedById.has(String(file.id)), driveViewLink: file.webViewLink || indexedById.get(String(file.id))?.driveViewLink || null, thumbnailLink: file.thumbnailLink || null })), itineraries: Array.isArray(itineraryRes?.itineraries) ? itineraryRes.itineraries : [] }));
      } catch { /* cache is only a performance aid */ }
    } catch (e) {
      setError(e?.body?.error || e?.message || "Unable to load the TMC knowledge library");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      await fetchApi("/api/travel/knowledge-base/sync/jobs", { method: "POST", body: JSON.stringify({}) });
      notify.success("TMC knowledge sync started");
      await load();
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Unable to start sync");
    } finally {
      setSyncing(false);
    }
  };

  const uploadPdf = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      notify.error("Only PDF files can be added to the TMC catalogue");
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      await fetchApi("/api/travel/knowledge-base/tmc-catalogue/upload", { method: "POST", body });
      notify.success("PDF uploaded to TMC / CRM Itineraries");
      await load();
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Unable to upload PDF");
    } finally {
      setUploading(false);
    }
  };

  const deleteDriveFile = async (file) => {
    const confirmed = await notify.confirm({
      title: "Delete PDF?",
      message: `Delete "${file.fileName}" from TMC / CRM Itineraries? This cannot be undone.`,
      confirmText: "Delete PDF",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await fetchApi(`/api/travel/knowledge-base/tmc-catalogue/drive-files/${encodeURIComponent(file.driveFileId)}`, { method: "DELETE" });
      notify.success("PDF deleted from the TMC Drive folder");
      await load();
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Unable to delete PDF");
    }
  };

  const indexedFiles = useMemo(() => files.filter((file) => file.indexed), [files]);
  const indexedIds = useMemo(() => new Set(indexedFiles.map((file) => String(file.driveFileId))), [indexedFiles]);
  const generatedPending = itineraries.filter((it) => it.catalogueDriveFileId && !indexedIds.has(String(it.catalogueDriveFileId)));
  const generatedPendingCards = generatedPending.map((itinerary) => {
    const driveFileId = String(itinerary.catalogueDriveFileId);
    const scannedFile = files.find((file) => String(file.driveFileId) === driveFileId);
    return scannedFile || {
      driveFileId,
      fileName: `${itinerary.destination || "Itinerary"} PDF`,
      folderPath: "TMC/CRM Itineraries",
      driveViewLink: itinerary.catalogueDriveViewLink || null,
      indexed: false,
      thumbnailLink: null,
    };
  });
  const uploadedPendingCards = files.filter((file) => !file.indexed && /(^|\/)CRM Itineraries(\/|$)/i.test(String(file.folderPath || "")));
  const pendingCards = [
    ...uploadedPendingCards,
    ...generatedPendingCards.filter((pendingFile) => !uploadedPendingCards.some((file) => String(file.driveFileId) === String(pendingFile.driveFileId))),
  ];
  const catalogueFiles = [
    ...files,
    ...pendingCards.filter((pendingFile) => !files.some((file) => String(file.driveFileId) === String(pendingFile.driveFileId))),
  ];
  const visibleFiles = catalogueFiles.filter((file) => {
    const haystack = `${file.fileName} ${file.folderPath}`.toLowerCase();
    const matchesSearch = haystack.includes(query.trim().toLowerCase());
    const inCrmItineraries = /(^|\/)CRM Itineraries(\/|$)/i.test(String(file.folderPath || ""));
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "indexed" && file.indexed)
      || (statusFilter === "pending" && !file.indexed)
      || (statusFilter === "crm-itineraries" && inCrmItineraries);
    return matchesSearch && matchesStatus;
  });
  const pageSize = 24;
  const totalPages = Math.max(1, Math.ceil(visibleFiles.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageFiles = visibleFiles.slice((safePage - 1) * pageSize, safePage * pageSize);
  const connected = Boolean(config?.rootFolderId);
  const lastJob = status?.lastJob;

  return (
    <main style={{ minHeight: "100vh", padding: "32px clamp(18px, 4vw, 56px)", color: "var(--text-primary)", background: "var(--bg-color, #faf6ee)" }}>
      <div style={{ maxWidth: 1440, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 28 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#8fb8ff", fontSize: 12, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}><Sparkles size={15} /> TMC knowledge library</div>
            <h1 style={{ margin: "9px 0 8px", fontSize: "clamp(28px, 4vw, 46px)", letterSpacing: "-.04em" }}>Every trip, in one place.</h1>
            <p style={{ margin: 0, maxWidth: 700, color: "var(--text-secondary)", lineHeight: 1.6 }}>Browse the brochure PDFs that power TMC diagnostics, including new itineraries created from your approved templates.</p>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><Link to="/travel/trip-knowledge" style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "12px 17px", border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--surface-color, #fff)", color: "inherit", fontWeight: 700, textDecoration: "none" }}><BookOpen size={17} /> Go to Travel Knowledge</Link><label style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "12px 17px", borderRadius: 8, background: connected && !uploading ? "var(--accent-color, #4d63ee)" : "#394052", color: "#fff", fontWeight: 700, cursor: connected && !uploading ? "pointer" : "not-allowed" }}><UploadCloud size={17} /> {uploading ? "Uploading…" : "Add PDF"}<input type="file" accept="application/pdf,.pdf" onChange={uploadPdf} disabled={!connected || uploading} style={{ display: "none" }} /></label><button type="button" onClick={sync} disabled={!connected || syncing} style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "12px 17px", border: "1px solid var(--border-color)", borderRadius: 8, background: "transparent", color: "inherit", fontWeight: 700, cursor: connected && !syncing ? "pointer" : "not-allowed" }}><UploadCloud size={17} /> {syncing ? "Syncing…" : "Sync new files"}</button></div>
        </header>

        <section style={{ ...cardStyle({ padding: 18, marginBottom: 22 }), display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          <Stat label="Drive connection" value={connected ? "Connected" : "Not connected"} icon={<Cloud size={18} />} tone={connected ? "#54d39b" : "#f2b568"} />
          <Stat label="Selected RAG folder" value={connected ? "Configured in Travel Knowledge" : "Choose in Travel Knowledge"} icon={<Folder size={18} />} />
          <Stat label="Indexed TMC PDFs" value={indexedFiles.length.toLocaleString()} icon={<CheckCircle2 size={18} />} tone="#8fb8ff" />
          <Stat label="Awaiting sync" value={pendingCards.length.toLocaleString()} icon={<UploadCloud size={18} />} tone={pendingCards.length ? "#f2b568" : "#54d39b"} />
        </section>

        {pendingCards.length > 0 && <section style={{ ...cardStyle({ padding: 15, marginBottom: 22, borderColor: "rgba(190,126,22,.7)" }) }}><div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, fontWeight: 800 }}><UploadCloud size={17} color="#b7791f" /> Files waiting to be indexed</div><p style={{ margin: "0 0 11px", color: "var(--text-secondary)", fontSize: 13 }}>{pendingCards.length} PDF{pendingCards.length === 1 ? " is" : "s are"} in <strong>TMC / CRM Itineraries</strong> but not indexed yet.</p><div style={{ display: "grid", gap: 8 }}>{pendingCards.map((file) => <PendingFileRow key={`pending-${file.driveFileId}`} file={file} onDelete={deleteDriveFile} />)}</div></section>}

        {!connected && <section style={{ ...cardStyle({ padding: 22, marginBottom: 22, textAlign: "center" }) }}><Cloud size={30} color="#f2b568" /><h2 style={{ margin: "10px 0 6px", fontSize: 20 }}>Connect Drive in Travel Knowledge</h2><p style={{ margin: 0, color: "var(--text-secondary)" }}>This page uses the existing connection and RAG folder. There is no second setup for TMC.</p></section>}
        {error && <div role="alert" style={{ ...cardStyle({ padding: 16, marginBottom: 20, color: "#ffb5b5" }) }}>{error}</div>}

        <section style={{ ...cardStyle({ padding: 18 }) }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 18 }}><div><h2 style={{ margin: 0, fontSize: 22 }}>TMC brochures</h2><span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{lastJob?.status === "running" ? "Knowledge sync is running…" : `${visibleFiles.length} PDF${visibleFiles.length === 1 ? "" : "s"} in this view`}</span></div><div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}><select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter brochure files" style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: "9px 10px", background: "var(--surface-color, #20242c)", color: "inherit" }}><option value="all">All files</option><option value="indexed">Indexed</option><option value="pending">Waiting for sync</option><option value="crm-itineraries">CRM Itineraries</option></select><div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border-color)", borderRadius: 9, padding: "8px 11px", minWidth: 240 }}><Search size={15} color="var(--text-secondary)" /><input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search brochures…" style={{ border: 0, outline: 0, background: "transparent", color: "inherit", width: "100%" }} /></div></div></div>
          {loading && files.length === 0 ? <div role="status" aria-live="polite" style={{ padding: 50, textAlign: "center", color: "var(--text-secondary)" }}><Loader2 size={30} aria-hidden="true" style={{ display: "block", margin: "0 auto 12px", animation: "spin 0.9s linear infinite" }} /><strong style={{ display: "block", color: "var(--text-primary)", fontSize: 15 }}>Loading your brochure library…</strong><p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>This may take a few seconds while we check Drive and indexing status.</p></div> : visibleFiles.length === 0 ? <div style={{ padding: 50, textAlign: "center", color: "var(--text-secondary)" }}><FileText size={30} /><p>No PDFs match this filter.</p></div> : <><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 245px), 1fr))", gap: 16 }}>{pageFiles.map((file) => <PdfCard key={`${file.subBrand}-${file.driveFileId}`} file={file} onDelete={connected && /(^|\/)CRM Itineraries(\/|$)/i.test(String(file.folderPath || "")) ? deleteDriveFile : null} />)}</div>{totalPages > 1 && <Pagination page={safePage} pageSize={pageSize} total={visibleFiles.length} onChange={(p) => setPage(p)} showRangeLabel={false} style={{ margin: 0, marginTop: 20, padding: 0, justifyContent: "flex-end" }} />}</>}
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, icon, tone = "#8c95aa" }) { return <div style={{ display: "flex", gap: 11, alignItems: "center", minWidth: 0 }}><span style={{ width: 38, height: 38, display: "grid", placeItems: "center", borderRadius: 10, color: tone, background: `${tone}18` }}>{icon}</span><div style={{ minWidth: 0 }}><div style={{ color: "var(--text-secondary)", fontSize: 12 }}>{label}</div><strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 3 }}>{value}</strong></div></div>; }

function PdfCard({ file, onDelete }) {
  const indexed = file.indexed;
  const driveUrl = file.driveViewLink || "#";
  return <article style={{ ...cardStyle({ overflow: "hidden", transition: "transform .2s ease, border-color .2s ease" }) }}>
    <a href={driveUrl} target="_blank" rel="noreferrer" aria-label={`Open ${file.fileName} PDF`} title="Open PDF in Drive" style={{ height: 158, display: "grid", placeItems: "center", background: "var(--bg-color, #f6f8fb)", position: "relative", textDecoration: "none" }}>
      <FileText size={44} color="var(--accent-color, #8fb8ff)" style={{ position: "absolute" }} />
      {file.thumbnailLink && <PdfThumbnail fileId={file.driveFileId} />}
      <span style={{ position: "absolute", top: 10, left: 10, padding: "5px 8px", borderRadius: 6, background: indexed ? "rgba(5,8,14,.78)" : "#4b1820", color: indexed ? "#9ee3bf" : "#ffb2bb", fontSize: 11, fontWeight: 700 }}>{indexed ? "Indexed" : "Unindexed"}</span>
      <span style={{ position: "absolute", right: 10, bottom: 10, display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 7, background: "rgba(5,8,14,.82)", color: "#fff" }}><ExternalLink size={15} /></span>
    </a>
    <div style={{ padding: 14 }}>
      <h3 title={file.fileName} style={{ margin: 0, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.fileName}</h3>
      <p title={file.folderPath} style={{ margin: "7px 0 14px", color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}><strong style={{ color: "inherit" }}>Path:</strong> {file.folderPath || "TMC"}</p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <a href={driveUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent-color, #9dbdff)", fontSize: 12, textDecoration: "none" }}>Open PDF <ExternalLink size={13} /></a>
        {onDelete && <button type="button" onClick={() => onDelete(file)} aria-label={`Delete ${file.fileName}`} title="Delete from TMC Drive" style={{ border: "1px solid #8f3f4b", background: "transparent", color: "#ff9da8", borderRadius: 6, padding: 6, cursor: "pointer" }}><Trash2 size={14} /></button>}
      </div>
    </div>
  </article>;
}

function PdfThumbnail({ fileId }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = null;
    fetch(`/api/travel/knowledge-base/tmc-catalogue/drive-files/${encodeURIComponent(fileId)}/thumbnail`, { headers: { Authorization: `Bearer ${getAuthToken()}` }, signal: controller.signal })
      .then((response) => response.ok ? response.blob() : null)
      .then((blob) => { if (blob) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } })
      .catch(() => {});
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId]);
  return src ? <img src={src} alt="" decoding="async" style={{ position: "relative", width: "100%", height: "100%", objectFit: "cover", background: "var(--surface-color, #20242c)" }} /> : null;
}

function PendingFileRow({ file, onDelete }) {
  const driveUrl = file.driveViewLink || "#";
  return <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, padding: "10px 12px", border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--bg-color, #111318)" }}>
    <FileText size={22} color="#ffb2bb" style={{ flex: "0 0 auto" }} />
    <div style={{ minWidth: 0, flex: 1 }}>
      <strong title={file.fileName} style={{ display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.fileName}</strong>
      <span title={file.folderPath} style={{ display: "block", marginTop: 3, color: "var(--text-secondary)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Path: {file.folderPath}</span>
    </div>
    <span style={{ padding: "4px 7px", borderRadius: 5, background: "#4b1820", color: "#ffb2bb", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>Unindexed</span>
    <a href={driveUrl} target="_blank" rel="noreferrer" title="Open PDF" aria-label={`Open ${file.fileName}`} style={{ display: "grid", placeItems: "center", width: 30, height: 30, border: "1px solid var(--border-color)", borderRadius: 6, color: "var(--accent-color, #9dbdff)" }}><ExternalLink size={15} /></a>
    <button type="button" onClick={() => onDelete(file)} aria-label={`Delete ${file.fileName}`} title="Delete from TMC / CRM Itineraries" style={{ display: "grid", placeItems: "center", width: 30, height: 30, border: "1px solid #8f3f4b", background: "transparent", color: "#ff9da8", borderRadius: 6, cursor: "pointer" }}><Trash2 size={14} /></button>
  </div>;
}
