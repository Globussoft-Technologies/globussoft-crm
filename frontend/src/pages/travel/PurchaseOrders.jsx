// Travel CRM — Supplier Purchase Orders (G035/G036).
//
// Lands at /travel/purchase-orders. ADMIN+MANAGER list of TravelPurchaseOrder
// rows scoped to the caller's tenant (and sub-brand via the backend's
// getSubBrandAccessSet gate). Lists the PO number, supplier, status,
// total amount, and offers transition buttons that advance the state
// machine (Send / Acknowledge / Fulfill / Cancel) inline.
//
// "Download PDF" hits GET /:id/pdf which returns application/pdf.
// State machine is driven by the backend; the UI just shows the
// appropriate next-step button based on current status.

import { useEffect, useState, useContext } from "react";
import { FileText, Plus, Send, CheckCircle, Truck, XCircle, Download, RefreshCw } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_COLOR = {
  draft: "#6b7280",
  sent: "#3b82f6",
  acknowledged: "#0ea5e9",
  fulfilled: "#10b981",
  cancelled: "#ef4444",
};

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function fmtMoney(amount, currency) {
  const v = Number(amount) || 0;
  const prefix = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "INR" ? "₹" : `${currency} `;
  return `${prefix}${v.toFixed(2)}`;
}

export default function PurchaseOrders() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user && (user.role === "ADMIN" || user.role === "MANAGER");
  const isAdmin = user && user.role === "ADMIN";

  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState({ supplierId: "", currency: "INR", notes: "" });
  const [selected, setSelected] = useState(null); // PO detail panel

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    qs.set("limit", "100");
    fetchApi(`/api/travel/purchase-orders?${qs.toString()}`)
      .then((res) => setPos(Array.isArray(res?.purchaseOrders) ? res.purchaseOrders : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load purchase orders");
        setPos([]);
      })
      .finally(() => setLoading(false));
  };

  const loadSuppliers = () => {
    fetchApi("/api/travel/suppliers?limit=200")
      .then((res) => setSuppliers(Array.isArray(res?.suppliers) ? res.suppliers : []))
      .catch(() => setSuppliers([]));
  };

  useEffect(load, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(loadSuppliers, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!form.supplierId) {
      notify.error("Supplier required");
      return;
    }
    try {
      await fetchApi("/api/travel/purchase-orders", {
        method: "POST",
        body: JSON.stringify({
          supplierId: Number(form.supplierId),
          currency: form.currency,
          notes: form.notes || undefined,
        }),
      });
      notify.success("Draft PO created");
      setForm({ supplierId: "", currency: "INR", notes: "" });
      setAdding(false);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to create PO");
    }
  };

  const transition = async (poId, action, body) => {
    try {
      const res = await fetchApi(`/api/travel/purchase-orders/${poId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body || {}),
      });
      notify.success(`PO ${action} succeeded`);
      // /fulfill returns { purchaseOrder, payablesCreated }; others return the PO directly.
      if (action === "fulfill" && res?.payablesCreated != null) {
        notify.info(`Auto-created ${res.payablesCreated} payable(s)`);
      }
      load();
    } catch (e) {
      notify.error(e?.body?.error || `Failed to ${action}`);
    }
  };

  const cancel = async (po) => {
    const reason = window.prompt("Cancellation reason:");
    if (!reason || !reason.trim()) return;
    transition(po.id, "cancel", { cancelReason: reason });
  };

  const downloadPdf = async (po) => {
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/travel/purchase-orders/${po.id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${po.poNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify.error(`Failed to download PDF: ${e.message}`);
    }
  };

  const loadDetail = async (po) => {
    try {
      const res = await fetchApi(`/api/travel/purchase-orders/${po.id}`);
      setSelected(res);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to load detail");
    }
  };

  return (
    <div style={{ padding: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "1.5rem", fontWeight: 600 }}>
          <FileText size={24} /> Supplier Purchase Orders
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} className="btn btn-secondary" title="Refresh">
            <RefreshCw size={16} />
          </button>
          {canWrite && (
            <button onClick={() => setAdding(true)} className="btn btn-primary">
              <Plus size={16} /> New PO
            </button>
          )}
        </div>
      </div>

      <div style={{ marginBottom: "1rem", display: "flex", gap: 8, alignItems: "center" }}>
        <label>Status filter:</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p>Loading purchase orders…</p>
      ) : pos.length === 0 ? (
        <p style={{ color: "#777" }}>No purchase orders yet. Click "New PO" to create one.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>
              <th style={{ padding: "0.5rem" }}>PO Number</th>
              <th style={{ padding: "0.5rem" }}>Supplier</th>
              <th style={{ padding: "0.5rem" }}>Status</th>
              <th style={{ padding: "0.5rem", textAlign: "right" }}>Total</th>
              <th style={{ padding: "0.5rem" }}>Created</th>
              <th style={{ padding: "0.5rem" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pos.map((po) => (
              <tr key={po.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem", fontFamily: "monospace" }}>
                  <button onClick={() => loadDetail(po)} style={{ background: "none", border: "none", color: "#3b82f6", cursor: "pointer", textDecoration: "underline" }}>
                    {po.poNumber}
                  </button>
                </td>
                <td style={{ padding: "0.5rem" }}>{po.supplier?.name || `#${po.supplierId}`}</td>
                <td style={{ padding: "0.5rem" }}>
                  <span style={{
                    background: STATUS_COLOR[po.status] || "#6b7280",
                    color: "#fff",
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: "0.85rem",
                  }}>{po.status}</span>
                </td>
                <td style={{ padding: "0.5rem", textAlign: "right" }}>
                  {fmtMoney(po.totalAmount, po.currency)}
                </td>
                <td style={{ padding: "0.5rem" }}>{fmt(po.createdAt)}</td>
                <td style={{ padding: "0.5rem", display: "flex", gap: 4 }}>
                  {canWrite && po.status === "draft" && (
                    <button onClick={() => transition(po.id, "send")} title="Send" className="btn-icon"><Send size={14} /></button>
                  )}
                  {canWrite && po.status === "sent" && (
                    <button onClick={() => transition(po.id, "acknowledge")} title="Acknowledge" className="btn-icon"><CheckCircle size={14} /></button>
                  )}
                  {canWrite && po.status === "acknowledged" && (
                    <button onClick={() => transition(po.id, "fulfill")} title="Fulfill" className="btn-icon"><Truck size={14} /></button>
                  )}
                  {isAdmin && (po.status === "draft" || po.status === "sent" || po.status === "acknowledged") && (
                    <button onClick={() => cancel(po)} title="Cancel" className="btn-icon" style={{ color: "#ef4444" }}><XCircle size={14} /></button>
                  )}
                  {canWrite && (
                    <button onClick={() => downloadPdf(po)} title="Download PDF" className="btn-icon"><Download size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* New PO modal */}
      {adding && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", padding: "1.5rem", borderRadius: 8, minWidth: 400 }}>
            <h2>New Purchase Order</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              <label>Supplier</label>
              <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">-- Choose supplier --</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.subBrand})</option>
                ))}
              </select>
              <label>Currency</label>
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                <option value="INR">INR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
                <option value="EUR">EUR</option>
                <option value="AED">AED</option>
              </select>
              <label>Notes (optional)</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => setAdding(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={create} className="btn btn-primary">Create Draft</button>
            </div>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", padding: "1.5rem", borderRadius: 8, minWidth: 600, maxWidth: 800, maxHeight: "80vh", overflow: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ fontFamily: "monospace" }}>{selected.poNumber}</h2>
              <button onClick={() => setSelected(null)} className="btn btn-secondary">Close</button>
            </div>
            <p>Status: <strong>{selected.status}</strong></p>
            <p>Supplier: <strong>{selected.supplier?.name}</strong></p>
            <p>Currency: {selected.currency}</p>
            {selected.notes && <p>Notes: {selected.notes}</p>}

            <h3 style={{ marginTop: 16 }}>Line Items</h3>
            {(selected.lines || []).length === 0 ? (
              <p style={{ color: "#777" }}>No lines on this PO yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #ddd" }}>
                    <th style={{ padding: "0.25rem", textAlign: "left" }}>Type</th>
                    <th style={{ padding: "0.25rem", textAlign: "left" }}>Description</th>
                    <th style={{ padding: "0.25rem", textAlign: "right" }}>Qty</th>
                    <th style={{ padding: "0.25rem", textAlign: "right" }}>Unit</th>
                    <th style={{ padding: "0.25rem", textAlign: "right" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.lines.map((l) => (
                    <tr key={l.id}>
                      <td style={{ padding: "0.25rem" }}>{l.lineType}</td>
                      <td style={{ padding: "0.25rem" }}>
                        {l.description}
                        {(l.pnr || l.bookingRef) && (
                          <div style={{ fontSize: "0.8rem", color: "#666" }}>
                            {l.pnr && `PNR ${l.pnr}`}
                            {l.pnr && l.bookingRef && " • "}
                            {l.bookingRef && `Ref ${l.bookingRef}`}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "0.25rem", textAlign: "right" }}>{l.quantity}</td>
                      <td style={{ padding: "0.25rem", textAlign: "right" }}>{fmtMoney(l.unitPrice, selected.currency)}</td>
                      <td style={{ padding: "0.25rem", textAlign: "right" }}>{fmtMoney(l.lineTotal, selected.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "1px solid #ddd", fontWeight: "bold" }}>
                    <td colSpan={4} style={{ padding: "0.25rem", textAlign: "right" }}>Total:</td>
                    <td style={{ padding: "0.25rem", textAlign: "right" }}>{fmtMoney(selected.totalAmount, selected.currency)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
