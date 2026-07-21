// Travel CRM — Supplier statement reconciliation + invoice uploads
// (PRD_TRAVEL_SUPPLIER_MASTER G044 + G046).
//
// Lands at /travel/suppliers/:id/reconcile. Two-tab layout:
//   Tab 1: Reconciliation batches (G044)
//     - Pick / create a batch by statementMonth
//     - Paste-CSV OR add-line widget seeds the batch with statement lines
//     - "Auto-match" runs the PNR-keyed tolerance matcher backend-side
//     - Lines grid with per-row manual-match dropdown
//     - State machine buttons: Review → Reconcile (+ Dispute escape hatch)
//   Tab 2: Invoice uploads (G046)
//     - Multer file upload (PDF/CSV/PNG/JPG, 10 MB cap)
//     - List + match-to-payable dropdown
//     - ADMIN-only delete button
//
// Wires to:
//   GET    /api/travel/suppliers/:id
//   GET    /api/travel/suppliers/:id/reconciliation-batches
//   POST   /api/travel/suppliers/:id/reconciliation-batches
//   GET    /api/travel/suppliers/:id/reconciliation-batches/:batchId
//   POST   /api/travel/suppliers/:id/reconciliation-batches/:batchId/lines/bulk
//   POST   /api/travel/suppliers/:id/reconciliation-batches/:batchId/auto-match
//   POST   /api/travel/suppliers/:id/reconciliation-batches/:batchId/review
//   POST   /api/travel/suppliers/:id/reconciliation-batches/:batchId/reconcile
//   POST   /api/travel/suppliers/:id/reconciliation-batches/:batchId/dispute
//   POST   /api/travel/suppliers/:id/reconciliation-batches/:batchId/lines/:lineId/manual-match
//   GET    /api/travel/suppliers/:id/invoice-uploads
//   POST   /api/travel/suppliers/:id/invoice-uploads          (multipart)
//   POST   /api/travel/suppliers/:id/invoice-uploads/:uid/match
//   DELETE /api/travel/suppliers/:id/invoice-uploads/:uid
//   GET    /api/travel/suppliers/:id/payables                 (for match dropdown)

import { useEffect, useState, useContext, useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  CheckCircle2,
  XCircle,
  Plus,
  Upload,
  Trash2,
  Link as LinkIcon,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import TopScrollSync from "../../components/TopScrollSync";

// Current statementMonth YYYY-MM
function currentStatementMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function fmtMoney(v, currency = "INR") {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(n);
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function statusBadge(status) {
  const styles = {
    draft: { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
    reviewed: { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
    reconciled: { bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
    disputed: { bg: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
    unmatched: { bg: "#e5e7eb", color: "#374151", border: "#d1d5db" },
    auto_matched: { bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
    manual_matched: { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
    matched: { bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
    resolved: { bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
  };
  const s = styles[status] || {
    bg: "#e5e7eb",
    color: "#374151",
    border: "#d1d5db",
  };
  return {
    display: "inline-block",
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 4,
    background: s.bg,
    color: s.color,
    border: `1px solid ${s.border}`,
  };
}

// Parse a 2-column CSV (pnr, amount) on the browser side. Tolerates a
// header row + blank lines. Returns an array of { pnr, supplierAmount }.
function parseCsv(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 2) continue;
    // skip a header row that doesn't look like a number in column 2.
    if (out.length === 0 && !/^-?\d+(\.\d+)?$/.test(parts[1])) continue;
    const amount = Number(parts[1]);
    if (!Number.isFinite(amount)) continue;
    out.push({ pnr: parts[0], supplierAmount: amount });
  }
  return out;
}

export default function SupplierReconciliation() {
  const { id } = useParams();
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const isManager = user?.role === "MANAGER";
  const canWrite = isAdmin || isManager;
  const canReconcile = isAdmin;
  const canDelete = isAdmin;

  const [tab, setTab] = useState("recon"); // 'recon' | 'invoices'
  const [supplier, setSupplier] = useState(null);
  const [batches, setBatches] = useState([]);
  const [activeBatchId, setActiveBatchId] = useState(null);
  const [activeBatch, setActiveBatch] = useState(null);
  const [activeLines, setActiveLines] = useState([]);
  const [loading, setLoading] = useState(true);

  // Create-batch form
  const [newBatchForm, setNewBatchForm] = useState({
    statementMonth: currentStatementMonth(),
    tolerancePct: "1",
    notes: "",
  });

  // Bulk-add lines (CSV paste)
  const [csvText, setCsvText] = useState("");

  // G046 — invoice uploads
  const [uploads, setUploads] = useState([]);
  const [uploadForm, setUploadForm] = useState({
    file: null,
    supplierInvoiceNumber: "",
    invoiceDate: "",
    invoiceAmount: "",
    notes: "",
  });

  // Payables list for the match dropdown
  const [payables, setPayables] = useState([]);

  const currency = supplier?.creditCurrency || "INR";

  const loadSupplier = () =>
    fetchApi(`/api/travel/suppliers/${id}`).catch(() => null);

  const loadBatches = () =>
    fetchApi(`/api/travel/suppliers/${id}/reconciliation-batches`).catch(
      () => ({ batches: [] }),
    );

  const loadBatchDetail = (batchId) =>
    fetchApi(
      `/api/travel/suppliers/${id}/reconciliation-batches/${batchId}`,
    ).catch(() => null);

  const loadUploads = () =>
    fetchApi(`/api/travel/suppliers/${id}/invoice-uploads`).catch(() => ({
      uploads: [],
    }));

  const loadPayables = () =>
    fetchApi(`/api/travel/suppliers/${id}/payables?limit=200`).catch(() => ({
      payables: [],
    }));

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [sup, batchesResp, upsResp, payResp] = await Promise.all([
        loadSupplier(),
        loadBatches(),
        loadUploads(),
        loadPayables(),
      ]);
      setSupplier(sup);
      setBatches(Array.isArray(batchesResp?.batches) ? batchesResp.batches : []);
      setUploads(Array.isArray(upsResp?.uploads) ? upsResp.uploads : []);
      setPayables(Array.isArray(payResp?.payables) ? payResp.payables : []);
      // Pre-select the newest batch if none is selected.
      if (!activeBatchId && batchesResp?.batches?.length > 0) {
        setActiveBatchId(batchesResp.batches[0].id);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Load active batch detail when activeBatchId changes.
  useEffect(() => {
    if (!activeBatchId) return;
    loadBatchDetail(activeBatchId).then((detail) => {
      if (detail) {
        setActiveBatch(detail.batch);
        setActiveLines(detail.lines || []);
      }
    });
  }, [activeBatchId, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadActiveBatch = async () => {
    if (!activeBatchId) return;
    const detail = await loadBatchDetail(activeBatchId);
    if (detail) {
      setActiveBatch(detail.batch);
      setActiveLines(detail.lines || []);
    }
    const batchesResp = await loadBatches();
    setBatches(Array.isArray(batchesResp?.batches) ? batchesResp.batches : []);
  };

  // ─── Batch CRUD ─────────────────────────────────────────────────────

  const createBatch = async () => {
    if (!newBatchForm.statementMonth) {
      notify.error("statementMonth required");
      return;
    }
    try {
      const created = await fetchApi(
        `/api/travel/suppliers/${id}/reconciliation-batches`,
        {
          method: "POST",
          body: JSON.stringify({
            statementMonth: newBatchForm.statementMonth,
            tolerancePct: newBatchForm.tolerancePct
              ? Number(newBatchForm.tolerancePct)
              : undefined,
            notes: newBatchForm.notes || undefined,
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      notify.success(`Batch created for ${created.statementMonth}`);
      setNewBatchForm({
        statementMonth: currentStatementMonth(),
        tolerancePct: "1",
        notes: "",
      });
      const batchesResp = await loadBatches();
      setBatches(Array.isArray(batchesResp?.batches) ? batchesResp.batches : []);
      setActiveBatchId(created.id);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to create batch");
    }
  };

  const bulkAddLines = async () => {
    if (!activeBatchId) return;
    const parsed = parseCsv(csvText);
    if (parsed.length === 0) {
      notify.error("No valid lines found in pasted CSV");
      return;
    }
    try {
      const resp = await fetchApi(
        `/api/travel/suppliers/${id}/reconciliation-batches/${activeBatchId}/lines/bulk`,
        {
          method: "POST",
          body: JSON.stringify({ lines: parsed }),
          headers: { "Content-Type": "application/json" },
        },
      );
      notify.success(`Added ${resp.added} lines`);
      setCsvText("");
      reloadActiveBatch();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add lines");
    }
  };

  const autoMatch = async () => {
    if (!activeBatchId) return;
    try {
      const resp = await fetchApi(
        `/api/travel/suppliers/${id}/reconciliation-batches/${activeBatchId}/auto-match`,
        {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        },
      );
      notify.success(
        `Auto-matched ${resp.autoMatched} of ${resp.attempted} lines`,
      );
      reloadActiveBatch();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to auto-match");
    }
  };

  const manualMatch = async (lineId, poLineId, payableId) => {
    if (!activeBatchId) return;
    try {
      await fetchApi(
        `/api/travel/suppliers/${id}/reconciliation-batches/${activeBatchId}/lines/${lineId}/manual-match`,
        {
          method: "POST",
          body: JSON.stringify({
            poLineId: poLineId || undefined,
            payableId: payableId || undefined,
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      notify.success("Manual match recorded");
      reloadActiveBatch();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to manual-match");
    }
  };

  const transition = async (verb) => {
    if (!activeBatchId) return;
    try {
      await fetchApi(
        `/api/travel/suppliers/${id}/reconciliation-batches/${activeBatchId}/${verb}`,
        {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        },
      );
      notify.success(`Batch ${verb}d`);
      reloadActiveBatch();
    } catch (e) {
      notify.error(e?.body?.error || `Failed to ${verb}`);
    }
  };

  // ─── Invoice uploads (G046) ───────────────────────────────────────

  const uploadInvoice = async () => {
    if (!uploadForm.file) {
      notify.error("Select a file first");
      return;
    }
    const fd = new FormData();
    fd.append("file", uploadForm.file);
    if (uploadForm.supplierInvoiceNumber)
      fd.append("supplierInvoiceNumber", uploadForm.supplierInvoiceNumber);
    if (uploadForm.invoiceDate) fd.append("invoiceDate", uploadForm.invoiceDate);
    if (uploadForm.invoiceAmount)
      fd.append("invoiceAmount", uploadForm.invoiceAmount);
    if (uploadForm.notes) fd.append("notes", uploadForm.notes);
    const token = localStorage.getItem("token");
    try {
      const r = await fetch(
        `/api/travel/suppliers/${id}/invoice-uploads`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `Upload failed (${r.status})`);
      }
      notify.success("Invoice uploaded");
      setUploadForm({
        file: null,
        supplierInvoiceNumber: "",
        invoiceDate: "",
        invoiceAmount: "",
        notes: "",
      });
      const upsResp = await loadUploads();
      setUploads(Array.isArray(upsResp?.uploads) ? upsResp.uploads : []);
    } catch (e) {
      notify.error(e?.message || "Failed to upload");
    }
  };

  const matchUploadToPayable = async (uploadId, payableId) => {
    if (!payableId) return;
    try {
      await fetchApi(
        `/api/travel/suppliers/${id}/invoice-uploads/${uploadId}/match`,
        {
          method: "POST",
          body: JSON.stringify({ payableId: Number(payableId) }),
          headers: { "Content-Type": "application/json" },
        },
      );
      notify.success("Linked to payable");
      const upsResp = await loadUploads();
      setUploads(Array.isArray(upsResp?.uploads) ? upsResp.uploads : []);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to match");
    }
  };

  const deleteUpload = async (uploadId) => {
    if (!window.confirm("Delete this invoice upload? (audit-logged)")) return;
    try {
      await fetchApi(
        `/api/travel/suppliers/${id}/invoice-uploads/${uploadId}`,
        { method: "DELETE" },
      );
      notify.success("Upload deleted");
      const upsResp = await loadUploads();
      setUploads(Array.isArray(upsResp?.uploads) ? upsResp.uploads : []);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete");
    }
  };

  const variance = useMemo(() => {
    if (!activeBatch) return 0;
    return (
      Number(activeBatch.totalSupplierAmount) -
      Number(activeBatch.totalOursAmount)
    );
  }, [activeBatch]);

  const isBatchFinal = activeBatch && activeBatch.status === "reconciled";

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <FileText size={28} color="var(--primary-color, var(--accent-color))" />
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Supplier reconciliation</h1>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
            {supplier
              ? `${supplier.name} — ${supplier.subBrand}`
              : loading
                ? "Loading…"
                : "Supplier not found"}
          </div>
        </div>
      </div>

      {/* Tab strip */}
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid #e5e7eb",
          marginBottom: 20,
        }}
      >
        {[
          { key: "recon", label: "Statement reconciliation (G044)" },
          { key: "invoices", label: "Invoice uploads (G046)" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              background: tab === t.key ? "#fff" : "transparent",
              border: "1px solid #e5e7eb",
              borderBottom:
                tab === t.key ? "1px solid #fff" : "1px solid #e5e7eb",
              borderRadius: "6px 6px 0 0",
              cursor: "pointer",
              fontWeight: tab === t.key ? 600 : 400,
              color: tab === t.key ? "var(--primary-color, var(--accent-color))" : "#374151",
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "recon" && (
        <>
          {/* Create batch */}
          {canWrite && (
            <div
              style={{
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: 16,
                marginBottom: 20,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 12 }}>
                Create new reconciliation batch
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
                  gap: 12,
                }}
              >
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280" }}>
                    Statement month (YYYY-MM)
                  </label>
                  <input
                    type="text"
                    value={newBatchForm.statementMonth}
                    onChange={(e) =>
                      setNewBatchForm({
                        ...newBatchForm,
                        statementMonth: e.target.value,
                      })
                    }
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      border: "1px solid #d1d5db",
                      borderRadius: 4,
                      minWidth: 0,
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280" }}>
                    Tolerance %
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={newBatchForm.tolerancePct}
                    onChange={(e) =>
                      setNewBatchForm({
                        ...newBatchForm,
                        tolerancePct: e.target.value,
                      })
                    }
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      border: "1px solid #d1d5db",
                      borderRadius: 4,
                      minWidth: 0,
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280" }}>Notes</label>
                  <input
                    type="text"
                    value={newBatchForm.notes}
                    onChange={(e) =>
                      setNewBatchForm({ ...newBatchForm, notes: e.target.value })
                    }
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      border: "1px solid #d1d5db",
                      borderRadius: 4,
                      minWidth: 0,
                    }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <button
                    onClick={createBatch}
                    style={{
                      padding: "8px 16px",
                      background: "var(--primary-color, var(--accent-color))",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    <Plus size={14} style={{ display: "inline", marginRight: 4 }} />
                    Create batch
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Batch picker */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, color: "#374151", marginRight: 8 }}>
              Active batch
            </label>
            <select
              value={activeBatchId || ""}
              onChange={(e) =>
                setActiveBatchId(e.target.value ? Number(e.target.value) : null)
              }
              style={{
                padding: "6px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 4,
              }}
            >
              <option value="">— Select a batch —</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.statementMonth} ({b.status})
                </option>
              ))}
            </select>
          </div>

          {/* Active-batch panel */}
          {activeBatch && (
            <div
              style={{
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: 16,
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                  flexWrap: "wrap",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>
                    Batch — {activeBatch.statementMonth}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <span style={statusBadge(activeBatch.status)}>
                      {activeBatch.status}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {canWrite && activeBatch.status === "draft" && (
                    <button
                      onClick={() => transition("review")}
                      style={btnSecondary}
                    >
                      <CheckCircle2 size={14} style={{ marginRight: 4 }} />
                      Mark reviewed
                    </button>
                  )}
                  {canReconcile && activeBatch.status === "reviewed" && (
                    <button
                      onClick={() => transition("reconcile")}
                      style={btnPrimary}
                    >
                      <CheckCircle2 size={14} style={{ marginRight: 4 }} />
                      Reconcile (final)
                    </button>
                  )}
                  {canWrite &&
                    (activeBatch.status === "draft" ||
                      activeBatch.status === "reviewed") && (
                      <button
                        onClick={() => transition("dispute")}
                        style={btnDanger}
                      >
                        <AlertTriangle size={14} style={{ marginRight: 4 }} />
                        Dispute
                      </button>
                    )}
                </div>
              </div>

              {/* Totals tiles */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <Tile
                  label="Supplier total"
                  value={fmtMoney(activeBatch.totalSupplierAmount, currency)}
                />
                <Tile
                  label="Our total (matched)"
                  value={fmtMoney(activeBatch.totalOursAmount, currency)}
                />
                <Tile
                  label="Variance"
                  value={fmtMoney(variance, currency)}
                  warn={Math.abs(variance) > 0}
                />
                <Tile
                  label="Tolerance %"
                  value={`${Number(activeBatch.tolerancePct)}%`}
                />
              </div>

              {/* Bulk-add CSV */}
              {canWrite && !isBatchFinal && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>
                    Paste statement CSV (pnr, amount)
                  </div>
                  <textarea
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                    placeholder={"PNR123,1500\nPNR456,2200"}
                    style={{
                      width: "100%",
                      minHeight: 80,
                      padding: 8,
                      border: "1px solid #d1d5db",
                      borderRadius: 4,
                      fontFamily: "monospace",
                      fontSize: 12,
                      boxSizing: "border-box",
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <button onClick={bulkAddLines} style={btnSecondary}>
                      <Plus size={14} style={{ marginRight: 4 }} />
                      Add lines
                    </button>
                    <button onClick={autoMatch} style={btnPrimary}>
                      Auto-match
                    </button>
                  </div>
                </div>
              )}

              {/* Lines grid */}
              <TopScrollSync>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <thead style={{ background: "#f9fafb" }}>
                    <tr>
                      <th style={th}>PNR</th>
                      <th style={th}>Supplier amount</th>
                      <th style={th}>Match status</th>
                      <th style={th}>Variance</th>
                      <th style={th}>PO line</th>
                      {canWrite && !isBatchFinal && <th style={th}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {activeLines.length === 0 && (
                      <tr>
                        <td
                          colSpan={canWrite && !isBatchFinal ? 6 : 5}
                          style={{
                            padding: 12,
                            textAlign: "center",
                            color: "#9ca3af",
                          }}
                        >
                          No lines yet — paste CSV above
                        </td>
                      </tr>
                    )}
                    {activeLines.map((l) => (
                      <tr key={l.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                        <td style={td}>{l.pnr || "—"}</td>
                        <td style={td}>{fmtMoney(l.supplierAmount, currency)}</td>
                        <td style={td}>
                          <span style={statusBadge(l.matchStatus)}>
                            {l.matchStatus}
                          </span>
                        </td>
                        <td style={td}>
                          {l.varianceAmount != null
                            ? fmtMoney(l.varianceAmount, currency)
                            : "—"}
                        </td>
                        <td style={td}>{l.matchedPoLineId || "—"}</td>
                        {canWrite && !isBatchFinal && (
                          <td style={td}>
                            <ManualMatchButton
                              line={l}
                              payables={payables}
                              onMatch={(payableId) =>
                                manualMatch(l.id, null, payableId)
                              }
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TopScrollSync>
            </div>
          )}
        </>
      )}

      {tab === "invoices" && (
        <>
          {canWrite && (
            <div
              style={{
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: 16,
                marginBottom: 20,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 12 }}>
                Upload supplier invoice (PDF / CSV / PNG / JPG, 10 MB max)
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
                  gap: 12,
                }}
              >
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280" }}>File</label>
                  <input
                    type="file"
                    accept=".pdf,.csv,.png,.jpg,.jpeg"
                    onChange={(e) =>
                      setUploadForm({
                        ...uploadForm,
                        file: e.target.files?.[0] || null,
                      })
                    }
                    style={{ width: "100%", minWidth: 0 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280" }}>
                    Invoice number
                  </label>
                  <input
                    type="text"
                    value={uploadForm.supplierInvoiceNumber}
                    onChange={(e) =>
                      setUploadForm({
                        ...uploadForm,
                        supplierInvoiceNumber: e.target.value,
                      })
                    }
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280" }}>Date</label>
                  <input
                    type="date"
                    value={uploadForm.invoiceDate}
                    onChange={(e) =>
                      setUploadForm({
                        ...uploadForm,
                        invoiceDate: e.target.value,
                      })
                    }
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280" }}>Amount</label>
                  <input
                    type="number"
                    step="0.01"
                    value={uploadForm.invoiceAmount}
                    onChange={(e) =>
                      setUploadForm({
                        ...uploadForm,
                        invoiceAmount: e.target.value,
                      })
                    }
                    style={inputStyle}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <button onClick={uploadInvoice} style={btnPrimary}>
                    <Upload size={14} style={{ marginRight: 4 }} />
                    Upload
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Uploads list */}
          <TopScrollSync>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
              }}
            >
              <thead style={{ background: "#f9fafb" }}>
                <tr>
                  <th style={th}>Filename</th>
                  <th style={th}>Invoice #</th>
                  <th style={th}>Date</th>
                  <th style={th}>Amount</th>
                  <th style={th}>Match status</th>
                  <th style={th}>Linked payable</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {uploads.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      style={{
                        padding: 12,
                        textAlign: "center",
                        color: "#9ca3af",
                      }}
                    >
                      No uploads yet
                    </td>
                  </tr>
                )}
                {uploads.map((u) => (
                  <tr key={u.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={td}>
                      <a
                        href={u.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "var(--primary-color, var(--accent-color))" }}
                      >
                        {u.filename}
                      </a>
                    </td>
                    <td style={td}>{u.supplierInvoiceNumber || "—"}</td>
                    <td style={td}>{fmtDate(u.invoiceDate)}</td>
                    <td style={td}>{fmtMoney(u.invoiceAmount, u.currency)}</td>
                    <td style={td}>
                      <span style={statusBadge(u.matchStatus)}>
                        {u.matchStatus}
                      </span>
                    </td>
                    <td style={td}>
                      {u.payableId ? (
                        `#${u.payableId}`
                      ) : canWrite ? (
                        <select
                          value=""
                          onChange={(e) =>
                            matchUploadToPayable(u.id, e.target.value)
                          }
                          style={{
                            padding: "4px 6px",
                            border: "1px solid #d1d5db",
                            borderRadius: 4,
                            fontSize: 12,
                          }}
                        >
                          <option value="">— Link payable —</option>
                          {payables.map((p) => (
                            <option key={p.id} value={p.id}>
                              #{p.id} {p.description?.slice(0, 30) || ""}{" "}
                              ({fmtMoney(p.amount, p.currency)})
                            </option>
                          ))}
                        </select>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={td}>
                      {canDelete && (
                        <button
                          onClick={() => deleteUpload(u.id)}
                          title="Delete (audit-logged)"
                          style={{
                            background: "#fee2e2",
                            color: "#991b1b",
                            border: "1px solid #fca5a5",
                            borderRadius: 4,
                            padding: "4px 8px",
                            cursor: "pointer",
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TopScrollSync>
        </>
      )}
    </div>
  );
}

// ─── Small UI atoms ───────────────────────────────────────────────────

function Tile({ label, value, warn }) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${warn ? "#fca5a5" : "#e5e7eb"}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: warn ? "#991b1b" : "#111827" }}>
        {value}
      </div>
    </div>
  );
}

function ManualMatchButton({ line, payables, onMatch }) {
  const [show, setShow] = useState(false);
  if (line.matchStatus === "auto_matched" || line.matchStatus === "manual_matched") {
    return <span style={{ fontSize: 11, color: "#6b7280" }}>Matched</span>;
  }
  if (!show) {
    return (
      <button onClick={() => setShow(true)} style={{ ...btnSecondary, padding: "4px 8px", fontSize: 11 }}>
        <LinkIcon size={11} style={{ marginRight: 4 }} />
        Match…
      </button>
    );
  }
  return (
    <select
      autoFocus
      onChange={(e) => {
        if (e.target.value) onMatch(e.target.value);
        setShow(false);
      }}
      onBlur={() => setShow(false)}
      style={{ padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 11 }}
    >
      <option value="">— Pick payable —</option>
      {payables.map((p) => (
        <option key={p.id} value={p.id}>
          #{p.id} ({p.amount})
        </option>
      ))}
    </select>
  );
}

const th = {
  textAlign: "left",
  padding: "8px 12px",
  fontWeight: 600,
  fontSize: 12,
  color: "#374151",
  borderBottom: "1px solid #e5e7eb",
};
const td = { padding: "8px 12px", verticalAlign: "middle" };
const inputStyle = {
  width: "100%",
  padding: "6px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  minWidth: 0,
};
const btnPrimary = {
  padding: "8px 16px",
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
};
const btnSecondary = {
  padding: "8px 16px",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
};
const btnDanger = {
  padding: "8px 16px",
  background: "#fee2e2",
  color: "#991b1b",
  border: "1px solid #fca5a5",
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
};
