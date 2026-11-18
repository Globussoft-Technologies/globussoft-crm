import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import Pagination from "../../components/ui/Pagination";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const PAGE_SIZE = 20;

function cardStyle(extra = {}) {
  return {
    background: "var(--surface-color, #fff)",
    border: "1px solid var(--border-color, #dfe7eb)",
    borderRadius: 10,
    ...extra,
  };
}

export default function TmcCatalogueResponses() {
  const notify = useNotify();
  const [responses, setResponses] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      const result = await fetchApi(`/api/travel/tmc-catalogue-responses?${params.toString()}`);
      setResponses(Array.isArray(result?.responses) ? result.responses : []);
      setTotal(Number(result?.total) || 0);
    } catch (error) {
      setResponses([]);
      setTotal(0);
      notify.error(error?.body?.error || error?.message || "Failed to load teacher catalogue responses");
    } finally {
      setLoading(false);
    }
  }, [notify, page]);

  useEffect(() => { load(); }, [load, reloadTick]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);

  return (
    <section aria-label="TMC teacher catalogue responses" style={{ marginTop: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 21 }}>Teacher catalogue responses</h2>
          <p style={{ margin: "5px 0 0", color: "var(--text-secondary)", fontSize: 13 }}>Latest catalogue selections submitted from the TMC teacher portal.</p>
        </div>
        <button type="button" onClick={() => setReloadTick((value) => value + 1)} disabled={loading} style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid var(--border-color)", borderRadius: 8, padding: "8px 11px", background: "var(--surface-color)", color: "inherit", fontWeight: 700, cursor: loading ? "wait" : "pointer" }}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </div>

      <div style={cardStyle({ overflow: "hidden" })}>
        {loading && responses.length === 0 ? <div role="status" style={{ padding: 28, color: "var(--text-secondary)" }}>Loading teacher responses…</div>
          : responses.length === 0 ? <div style={{ padding: 28, color: "var(--text-secondary)" }}>No teacher catalogue selections have been submitted yet.</div>
            : <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }} aria-label="TMC teacher catalogue responses">
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color)" }}>
                    <th scope="col" aria-label="Expand response" style={{ width: 58, padding: 0, textAlign: "center", verticalAlign: "middle" }} />
                    <th scope="col" style={{ padding: "12px 14px" }}>Teacher</th>
                    <th scope="col" style={{ padding: "12px 14px" }}>Selected catalogues</th>
                    <th scope="col" style={{ padding: "12px 14px" }}>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {responses.map((response) => {
                    const expanded = expandedId === response.id;
                    const selected = Array.isArray(response.selectedCatalogues) ? response.selectedCatalogues : [];
                    return <ResponseRows
                      key={response.id}
                      response={response}
                      selected={selected}
                      expanded={expanded}
                      onToggle={() => setExpandedId((current) => current === response.id ? null : response.id)}
                    />;
                  })}
                </tbody>
              </table>
            </div>}
        {total > PAGE_SIZE && <Pagination page={safePage} pageSize={PAGE_SIZE} total={total} onChange={(nextPage) => { setPage(nextPage); setExpandedId(null); }} showRangeLabel style={{ margin: 0, borderTop: "1px solid var(--border-color)" }} />}
      </div>
    </section>
  );
}

function ResponseRows({ response, selected, expanded, onToggle }) {
  const teacher = response.teacher || {};
  return <>
    <tr style={{ borderTop: "1px solid var(--border-light, #edf1f3)" }}>
      <td style={{ width: 58, padding: 0, textAlign: "center", verticalAlign: "middle" }}>
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "View"} catalogues selected by ${teacher.name || teacher.email || "teacher"}`} style={{ width: 32, height: 32, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", padding: 0, border: "1px solid var(--border-color)", borderRadius: 6, background: "var(--surface-color)", color: "inherit", cursor: "pointer" }}>
          {expanded ? <ChevronDown size={15} aria-hidden style={{ display: "block", flex: "0 0 auto" }} /> : <ChevronRight size={15} aria-hidden style={{ display: "block", flex: "0 0 auto" }} />}
        </button>
      </td>
      <td style={{ padding: "11px 14px" }}>
        <strong style={{ display: "block" }}>{teacher.name || "TMC teacher"}</strong>
        {teacher.email && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{teacher.email}</span>}
      </td>
      <td style={{ padding: "11px 14px" }}>{selected.length} catalogue{selected.length === 1 ? "" : "s"}</td>
      <td style={{ padding: "11px 14px", whiteSpace: "nowrap" }}>{response.submittedAt ? new Date(response.submittedAt).toLocaleString() : "—"}</td>
    </tr>
    {expanded && <tr style={{ background: "var(--bg-color, #f8fafb)" }}>
      <td colSpan={4} style={{ padding: "4px 18px 16px 62px", whiteSpace: "normal" }}>
        {selected.length === 0 ? <span style={{ color: "var(--text-secondary)" }}>No catalogue details were saved.</span>
          : <ul style={{ display: "grid", width: "100%", minWidth: 0, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 8, listStyle: "none", padding: 0, margin: 0, whiteSpace: "normal" }}>
            {selected.map((file) => {
              const url = typeof file.driveViewLink === "string" && /^https:\/\//i.test(file.driveViewLink) ? file.driveViewLink : null;
              return <li key={file.driveFileId || file.fileName} style={{ minWidth: 0, maxWidth: "100%", boxSizing: "border-box", overflow: "hidden", whiteSpace: "normal", ...cardStyle({ padding: "10px 12px" }) }}>
                {url ? <a href={url} target="_blank" rel="noreferrer" title={file.fileName || "TMC brochure"} style={{ display: "flex", width: "100%", minWidth: 0, maxWidth: "100%", alignItems: "center", gap: 7, color: "var(--accent-color, #315c78)", textDecoration: "none", fontWeight: 700 }}>
                  <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.fileName || "TMC brochure"}</span><ExternalLink size={13} aria-hidden style={{ flex: "0 0 13px" }} />
                </a> : <strong title={file.fileName || "TMC brochure"} style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.fileName || "TMC brochure"}</strong>}
                <div style={{ minWidth: 0, maxWidth: "100%", marginTop: 4, color: "var(--text-secondary)", fontSize: 12, whiteSpace: "normal", overflowWrap: "anywhere" }}>{file.folderPath || "TMC"}</div>
              </li>;
            })}
          </ul>}
      </td>
    </tr>}
  </>;
}
