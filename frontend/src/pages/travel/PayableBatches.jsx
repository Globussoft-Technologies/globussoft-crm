// PRD_TRAVEL_BILLING G022 (FR-3.5.e) — supplier-payable batch ops surface.
//
// Read-only-ish operator page for the batch ledger. Lists batches with
// filters by status, opens a detail panel showing linked payables, and
// surfaces the "Download CSV" button for the bank-friendly export. State
// transitions (approve / send-to-bank / settle / cancel) live behind
// confirmation buttons.

import { useCallback, useEffect, useState } from "react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "sent_to_bank", label: "Sent to bank" },
  { value: "settled", label: "Settled" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_COLOURS = {
  draft: "#6b7280",
  approved: "#2563eb",
  sent_to_bank: "#7c3aed",
  settled: "#16a34a",
  cancelled: "#dc2626",
};

function formatMoney(n) {
  if (n == null) return "—";
  return `₹${Number(n).toLocaleString()}`;
}

export default function PayableBatches() {
  const notify = useNotify();
  const [status, setStatus] = useState("");
  const [batches, setBatches] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    return fetchApi(`/api/travel/payable-batches?${params.toString()}`)
      .then((res) => setBatches(res.payableBatches || []))
      .catch((err) => notify.error?.(err?.message || "Failed to load batches"))
      .finally(() => setLoading(false));
  }, [status, notify]);

  useEffect(() => {
    let cancelled = false;
    loadList().then(() => {
      if (cancelled) setBatches([]);
    });
    return () => {
      cancelled = true;
    };
  }, [loadList]);

  const loadDetail = useCallback(
    async (batchId) => {
      try {
        const detail = await fetchApi(`/api/travel/payable-batches/${batchId}`);
        setSelected(detail);
      } catch (err) {
        notify.error?.(err?.message || "Failed to load batch detail");
      }
    },
    [notify],
  );

  const transition = useCallback(
    async (batch, action, body) => {
      try {
        await fetchApi(`/api/travel/payable-batches/${batch.id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        notify.success?.(`Batch ${action.replace(/-/g, " ")}`);
        await loadList();
        await loadDetail(batch.id);
      } catch (err) {
        notify.error?.(err?.message || `Failed to ${action}`);
      }
    },
    [loadList, loadDetail, notify],
  );

  const downloadCsv = useCallback(
    async (batch) => {
      const token = getAuthToken();
      const res = await fetch(`/api/travel/payable-batches/${batch.id}/payment-csv`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        notify.error?.("CSV download failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${batch.batchNumber}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [notify],
  );

  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Payable batches</h1>
        <p style={{ color: "var(--text-secondary, #6b7280)", fontSize: 14 }}>
          Bundle supplier payables into a single bank-transfer run. Approve → send → settle.
        </p>
      </header>

      <section style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary, #6b7280)" }}>Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={inputStyle}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </section>

      <section style={{ border: "1px solid var(--border-color, #e5e7eb)", borderRadius: 8 }}>
        {loading && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary, #6b7280)" }}>
            Loading…
          </div>
        )}
        {!loading && batches.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary, #6b7280)" }}>
            No batches in this view.
          </div>
        )}
        {!loading && batches.length > 0 && (
          <TopScrollSync>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Batch #</th>
                <th style={th}>Status</th>
                <th style={th}>Payables</th>
                <th style={th}>Total</th>
                <th style={th}>Method</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} style={{ borderTop: "1px solid var(--border-color, #f3f4f6)" }}>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => loadDetail(b.id)}
                      style={{ background: "transparent", border: "none", color: "var(--primary-color, #2563eb)", cursor: "pointer", padding: 0 }}
                    >
                      {b.batchNumber}
                    </button>
                  </td>
                  <td style={td}>
                    <span style={{ ...statusPill, background: STATUS_COLOURS[b.status] || "#9ca3af" }}>
                      {b.status}
                    </span>
                  </td>
                  <td style={td}>{b.payableCount}</td>
                  <td style={td}>{formatMoney(b.totalAmount)}</td>
                  <td style={td}>{b.paymentMethod || "—"}</td>
                  <td style={td}>
                    <button type="button" onClick={() => downloadCsv(b)} style={smallBtn}>
                      CSV
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </section>

      {selected && (
        <aside style={{ marginTop: 16, padding: 16, border: "1px solid var(--border-color, #e5e7eb)", borderRadius: 8 }}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>
              {selected.batchNumber} — {selected.status}
            </h2>
            <button type="button" onClick={() => setSelected(null)} style={smallBtn}>Close</button>
          </header>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {selected.status === "draft" && (
              <button type="button" onClick={() => transition(selected, "approve")} style={primaryBtn}>
                Approve
              </button>
            )}
            {selected.status === "approved" && (
              <button type="button" onClick={() => transition(selected, "send-to-bank")} style={primaryBtn}>
                Send to bank
              </button>
            )}
            {selected.status === "sent_to_bank" && (
              <button type="button" onClick={() => transition(selected, "settle")} style={primaryBtn}>
                Settle
              </button>
            )}
            {["draft", "approved", "sent_to_bank"].includes(selected.status) && (
              <button
                type="button"
                onClick={() => {
                  const reason = window.prompt("Cancel reason?");
                  if (reason) transition(selected, "cancel", { cancelReason: reason });
                }}
                style={dangerBtn}
              >
                Cancel batch
              </button>
            )}
            <button type="button" onClick={() => downloadCsv(selected)} style={smallBtn}>
              Download payment CSV
            </button>
          </div>
          {selected.payables && selected.payables.length > 0 ? (
            <TopScrollSync>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={th}>ID</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Description</th>
                  <th style={th}>Amount</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {selected.payables.map((p) => (
                  <tr key={p.id} style={{ borderTop: "1px solid var(--border-color, #f3f4f6)" }}>
                    <td style={td}>{p.id}</td>
                    <td style={td}>{p.supplier ? p.supplier.name : `Supplier ${p.supplierId}`}</td>
                    <td style={td}>{p.description}</td>
                    <td style={td}>{formatMoney(p.amount)}</td>
                    <td style={td}>{p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </TopScrollSync>
          ) : (
            <p style={{ color: "var(--text-secondary, #6b7280)" }}>No payables attached yet.</p>
          )}
        </aside>
      )}
    </div>
  );
}

const inputStyle = {
  padding: "6px 10px",
  border: "1px solid var(--border-color, #d1d5db)",
  borderRadius: 6,
  background: "var(--surface-bg, #fff)",
};
const th = { textAlign: "left", padding: "8px 12px", fontSize: 12, color: "var(--text-secondary, #6b7280)", fontWeight: 500 };
const td = { padding: "8px 12px", fontSize: 13 };
const statusPill = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 12,
  fontSize: 11,
  color: "#fff",
  textTransform: "uppercase",
};
const smallBtn = {
  padding: "4px 10px",
  border: "1px solid var(--border-color, #d1d5db)",
  background: "var(--surface-bg, #fff)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const primaryBtn = {
  ...smallBtn,
  background: "var(--primary-color, var(--accent-color, #2563eb))",
  color: "#fff",
  border: "none",
};
const dangerBtn = {
  ...smallBtn,
  background: "#dc2626",
  color: "#fff",
  border: "none",
};
