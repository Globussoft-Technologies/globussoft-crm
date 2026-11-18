import { useEffect, useState } from "react";
import { ExternalLink, FileText, Folder, Trash2 } from "lucide-react";
import { getAuthToken } from "../../utils/api";

function cardStyle(extra = {}) {
  return {
    background: "var(--tmc-surface, var(--surface-color, #ffffff))",
    border: "1px solid var(--tmc-border, var(--border-color, #303746))",
    borderRadius: 14,
    ...extra,
  };
}

export default function TmcCataloguePdfCard({
  file,
  onDelete,
  selected = false,
  onToggle,
  onOpen,
  thumbnailEndpoint,
  thumbnailToken,
}) {
  const indexed = file.indexed;
  const teacherSelection = typeof onToggle === "function";
  const driveUrl = file.driveViewLink || "#";
  return <article
    data-tmc-hover-card={teacherSelection ? "true" : undefined}
    style={{
      ...cardStyle({
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        overflow: "hidden",
        border: selected ? "1px solid var(--tmc-primary, var(--accent-color, #315c78))" : "1px solid var(--tmc-border, var(--border-color, #dfe7eb))",
        boxShadow: selected ? "0 0 0 2px color-mix(in srgb, var(--tmc-primary, #315c78) 13%, transparent)" : "0 1px 3px rgba(16, 38, 52, .05)",
        transition: "transform .2s ease, border-color .2s ease, box-shadow .2s ease",
      }),
    }}
  >
    <a
      href={onOpen ? "#preview" : driveUrl}
      target={onOpen ? undefined : "_blank"}
      rel={onOpen ? undefined : "noreferrer"}
      onClick={onOpen ? (event) => { event.preventDefault(); onOpen(file); } : undefined}
      aria-label={`Open ${file.fileName} PDF`}
      title={onOpen ? "Preview PDF" : "Open PDF in Drive"}
      style={{
        height: teacherSelection ? 150 : 158,
        flex: "0 0 auto",
        boxSizing: "border-box",
        overflow: "hidden",
        display: "grid",
        placeItems: "center",
        padding: 0,
        background: teacherSelection ? "#f3f6f8" : "var(--tmc-bg, var(--bg-color, #f6f8fb))",
        position: "relative",
        textDecoration: "none",
        cursor: "pointer",
        borderBottom: "1px solid var(--tmc-border, var(--border-color, #e2e8ee))",
      }}
    >
      <FileText size={40} color="var(--tmc-link, var(--accent-color, #8fb8ff))" style={{ position: "absolute" }} />
      {file.thumbnailLink && <PdfThumbnail fileId={file.driveFileId} endpoint={thumbnailEndpoint} token={thumbnailToken} fit="cover" />}
      {!teacherSelection && <>
        <span style={{ position: "absolute", top: 10, left: 10, padding: "5px 8px", borderRadius: 6, background: indexed ? "rgba(5,8,14,.78)" : "#4b1820", color: indexed ? "#9ee3bf" : "#ffb2bb", fontSize: 11, fontWeight: 700 }}>{indexed ? "Indexed" : "Unindexed"}</span>
        <span style={{ position: "absolute", right: 10, bottom: 10, display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 7, background: "rgba(5,8,14,.82)", color: "#fff" }}><ExternalLink size={15} /></span>
      </>}
    </a>
    <div style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0, padding: teacherSelection ? "12px 14px 10px" : 14 }}>
      <h3 title={file.fileName} style={{ minWidth: 0, minHeight: teacherSelection ? 38 : undefined, display: teacherSelection ? "-webkit-box" : undefined, WebkitBoxOrient: teacherSelection ? "vertical" : undefined, WebkitLineClamp: teacherSelection ? 2 : undefined, margin: 0, fontSize: teacherSelection ? 14 : 15, lineHeight: 1.35, color: "var(--tmc-text, var(--text-primary, inherit))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: teacherSelection ? undefined : "nowrap", overflowWrap: "anywhere" }}>{file.fileName}</h3>
      <p title={file.folderPath} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, margin: teacherSelection ? "5px 0 8px" : "7px 0 14px", color: "var(--tmc-muted, var(--text-secondary, #71808a))", fontSize: 12, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {teacherSelection && <Folder size={13} aria-hidden style={{ flex: "0 0 auto" }} />}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{teacherSelection ? file.folderPath || "TMC catalogue" : <><strong style={{ color: "inherit" }}>Path:</strong> {file.folderPath || "TMC"}</>}</span>
      </p>
      {teacherSelection ? <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 36, marginTop: "auto", paddingTop: 8, borderTop: "1px solid var(--tmc-border, #e6ebef)" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, color: selected ? "var(--tmc-primary, #315c78)" : "var(--tmc-text, #31495a)", fontSize: 13, fontWeight: selected ? 750 : 600, cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={selected} onChange={() => onToggle(file)} aria-label={`Select ${file.fileName}`} style={{ width: 17, height: 17, margin: 0, flex: "0 0 auto", accentColor: "var(--tmc-primary, #315c78)", cursor: "pointer" }} />
          <span>{selected ? "Selected" : "Select catalogue"}</span>
        </label>
        <button type="button" onClick={() => onOpen(file)} aria-label={`Preview ${file.fileName}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flex: "0 0 auto", border: "1px solid var(--tmc-border, #d7e0e6)", borderRadius: 7, padding: "7px 9px", background: "var(--tmc-surface, #fff)", color: "var(--tmc-text, #31495a)", fontSize: 12, fontWeight: 650, cursor: "pointer" }}>
          Preview <ExternalLink size={13} aria-hidden />
        </button>
      </div> : <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
        <a href={driveUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent-color, #9dbdff)", fontSize: 12, textDecoration: "none" }}>Open PDF <ExternalLink size={13} /></a>
        {onDelete && <button type="button" onClick={() => onDelete(file)} aria-label={`Delete ${file.fileName}`} title="Delete from TMC Drive" style={{ border: "1px solid #8f3f4b", background: "transparent", color: "#ff9da8", borderRadius: 6, padding: 6, cursor: "pointer" }}><Trash2 size={14} /></button>}
      </div>}
    </div>
  </article>;
}

function PdfThumbnail({ fileId, endpoint, token, fit = "cover" }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = null;
    fetch(endpoint || `/api/travel/knowledge-base/tmc-catalogue/drive-files/${encodeURIComponent(fileId)}/thumbnail`, { headers: { Authorization: `Bearer ${token || getAuthToken()}` }, signal: controller.signal })
      .then((response) => response.ok ? response.blob() : null)
      .then((blob) => { if (blob) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } })
      .catch(() => {});
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [endpoint, fileId, token]);
  return src ? <img src={src} alt="" decoding="async" style={{ position: "absolute", inset: 0, boxSizing: "border-box", display: "block", width: "100%", height: "100%", objectFit: fit, objectPosition: "center 48%", background: "var(--tmc-surface, var(--surface-color, #ffffff))" }} /> : null;
}
