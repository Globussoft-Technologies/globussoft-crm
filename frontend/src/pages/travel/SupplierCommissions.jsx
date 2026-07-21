// Travel CRM — Per-supplier commission ledger (PRD_TRAVEL_SUPPLIER_MASTER G045).
//
// Lands at /travel/suppliers/:id/commissions. Per-supplier ledger of
// supplier-side commissions EARNED (e.g. IATA inward commission for air
// bookings, hotel commission, RFU Umrah supplier kickbacks).
//
// Distinct from /travel/commission-profiles (B2B sub-agent commission shapes
// — that surface is in CommissionProfilesAdmin.jsx).
//
// Wires to:
//   GET    /api/travel/suppliers/:id/commission-entries
//   POST   /api/travel/suppliers/:id/commission-entries           (accrue)
//   POST   /api/travel/suppliers/:id/commission-entries/:eid/settle (ADMIN/MANAGER)
//   POST   /api/travel/suppliers/:id/commission-entries/:eid/reverse (ADMIN)
//   GET    /api/travel/suppliers/:id/commission-statement?fiscalYear=FY...
//   GET    /api/travel/suppliers/:id/commission-statement.csv?fiscalYear=FY...

import { useEffect, useState, useContext, useMemo } from "react";
import { useParams } from "react-router-dom";
import { TrendingUp, Plus, CheckCircle2, XCircle, Download, AlertTriangle } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import TopScrollSync from "../../components/TopScrollSync";

// Current FY label long-form e.g. "FY2026-27" (mirrors lib/travelFiscalYear.js).
function currentFyLong() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0=Jan
  const start = m >= 3 ? y : y - 1;
  const endTwo = String((start + 1) % 100).padStart(2, "0");
  return `FY${start}-${endTwo}`;
}

// Build a 6-FY dropdown ending with the current FY.
function fyChoices() {
  const cur = currentFyLong();
  const startYear = parseInt(cur.match(/^FY(\d{4})/)[1], 10);
  const choices = [];
  for (let i = -3; i <= 2; i++) {
    const s = startYear + i;
    const endTwo = String((s + 1) % 100).padStart(2, "0");
    choices.push(`FY${s}-${endTwo}`);
  }
  return choices;
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
    accrued: { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
    settled: { bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
    reversed: { bg: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
  };
  const s = styles[status] || { bg: "#e5e7eb", color: "#374151", border: "#d1d5db" };
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

export default function SupplierCommissions() {
  const { id } = useParams();
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";
  const isManager = user?.role === "MANAGER";
  const canSettle = isAdmin || isManager;
  const canReverse = isAdmin;
  const canAccrue = isAdmin || isManager;

  const [supplier, setSupplier] = useState(null);
  const [fy, setFy] = useState(currentFyLong());
  const [entries, setEntries] = useState([]);
  const [statement, setStatement] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accruing, setAccruing] = useState(false);
  const [form, setForm] = useState({
    baseAmount: "",
    commissionPercent: "",
    tdsPercent: "5",
    notes: "",
  });

  const fyOptions = useMemo(() => fyChoices(), []);

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/travel/suppliers/${id}`).catch(() => null),
      fetchApi(`/api/travel/suppliers/${id}/commission-entries?fiscalYear=${fy}`).catch(() => ({ entries: [] })),
      fetchApi(`/api/travel/suppliers/${id}/commission-statement?fiscalYear=${fy}`).catch(() => null),
    ])
      .then(([sup, list, stmt]) => {
        setSupplier(sup);
        setEntries(Array.isArray(list?.entries) ? list.entries : []);
        setStatement(stmt);
      })
      .finally(() => setLoading(false));
  };

  useEffect(loadAll, [id, fy]); // eslint-disable-line react-hooks/exhaustive-deps

  const accrue = async () => {
    if (!form.baseAmount) {
      notify.error("baseAmount required");
      return;
    }
    setAccruing(true);
    try {
      await fetchApi(`/api/travel/suppliers/${id}/commission-entries`, {
        method: "POST",
        body: JSON.stringify({
          baseAmount: Number(form.baseAmount),
          commissionPercent: form.commissionPercent ? Number(form.commissionPercent) : undefined,
          tdsPercent: form.tdsPercent === "" ? undefined : Number(form.tdsPercent),
          fiscalYear: fy,
          notes: form.notes || undefined,
        }),
        headers: { "Content-Type": "application/json" },
      });
      notify.success("Commission accrued");
      setForm({ baseAmount: "", commissionPercent: "", tdsPercent: "5", notes: "" });
      loadAll();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to accrue commission");
    } finally {
      setAccruing(false);
    }
  };

  const settle = async (entryId) => {
    try {
      await fetchApi(`/api/travel/suppliers/${id}/commission-entries/${entryId}/settle`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      });
      notify.success("Entry settled");
      loadAll();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to settle");
    }
  };

  const reverse = async (entryId) => {
    const reason = window.prompt("Reversal reason:");
    if (!reason || !reason.trim()) return;
    try {
      await fetchApi(`/api/travel/suppliers/${id}/commission-entries/${entryId}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reversalReason: reason.trim() }),
        headers: { "Content-Type": "application/json" },
      });
      notify.success("Entry reversed");
      loadAll();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to reverse");
    }
  };

  const exportCsv = () => {
    const url = `/api/travel/suppliers/${id}/commission-statement.csv?fiscalYear=${fy}`;
    const token = localStorage.getItem("token");
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((blob) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `commission-statement-${id}-${fy}.csv`;
        link.click();
      })
      .catch((e) => notify.error(e?.message || "Failed to export"));
  };

  const currency = supplier?.creditCurrency || "INR";

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <TrendingUp size={28} color="var(--primary-color, var(--accent-color))" />
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Supplier Commissions</h1>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
            {supplier ? `${supplier.name} — ${supplier.subBrand}` : "Loading…"}
          </div>
        </div>
      </div>

      {/* FY selector + export */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: "#374151" }}>Fiscal year</label>
        <select
          value={fy}
          onChange={(e) => setFy(e.target.value)}
          style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4 }}
        >
          {fyOptions.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <button
          onClick={exportCsv}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          <Download size={14} />
          Export CSV
        </button>
      </div>

      {/* Statement rollup */}
      {statement && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
            gap: 12,
            marginBottom: 20,
          }}
        >
          <Tile label="Accrued" value={fmtMoney(statement.totals.accruedCommission, currency)} count={statement.counts.accrued} />
          <Tile label="Settled" value={fmtMoney(statement.totals.settledCommission, currency)} count={statement.counts.settled} />
          <Tile label="Reversed" value={fmtMoney(statement.totals.reversedCommission, currency)} count={statement.counts.reversed} />
          <Tile label="TDS deducted" value={fmtMoney(statement.totals.tdsDeducted, currency)} />
          <Tile label="Net payable" value={fmtMoney(statement.totals.netPayable, currency)} />
          <Tile label="Net settled" value={fmtMoney(statement.totals.netSettled, currency)} />
        </div>
      )}

      {/* Accrual form */}
      {canAccrue && (
        <div
          style={{
            background: "#fafafa",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Accrue commission</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", gap: 10 }}>
            <input
              type="number"
              placeholder="Base amount"
              value={form.baseAmount}
              onChange={(e) => setForm({ ...form, baseAmount: e.target.value })}
              style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4 }}
            />
            <input
              type="number"
              placeholder={supplier?.commissionPercent ? `% (default ${supplier.commissionPercent})` : "Commission %"}
              value={form.commissionPercent}
              onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })}
              style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4 }}
            />
            <input
              type="number"
              placeholder="TDS % (default 5)"
              value={form.tdsPercent}
              onChange={(e) => setForm({ ...form, tdsPercent: e.target.value })}
              style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4 }}
            />
            <input
              type="text"
              placeholder="Notes (optional)"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4 }}
            />
            <button
              onClick={accrue}
              disabled={accruing || !form.baseAmount}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                background: "var(--primary-color, var(--accent-color))",
                color: "#fff",
                border: 0,
                borderRadius: 4,
                fontSize: 13,
                cursor: accruing || !form.baseAmount ? "not-allowed" : "pointer",
                opacity: accruing || !form.baseAmount ? 0.6 : 1,
              }}
            >
              <Plus size={14} />
              {accruing ? "Accruing…" : "Accrue"}
            </button>
          </div>
        </div>
      )}

      {/* Entries table */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "#6b7280",
            border: "1px dashed #d1d5db",
            borderRadius: 6,
          }}
        >
          <AlertTriangle size={32} style={{ marginBottom: 8 }} />
          <div>No commission entries for {fy}.</div>
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 6 }}>
        <TopScrollSync>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ background: "#f9fafb" }}>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Status</th>
                <th style={th}>Base</th>
                <th style={th}>%</th>
                <th style={th}>Commission</th>
                <th style={th}>TDS</th>
                <th style={th}>Net</th>
                <th style={th}>Notes</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={td}>{fmtDate(e.accruedAt)}</td>
                  <td style={td}>
                    <span style={statusBadge(e.status)}>{e.status}</span>
                  </td>
                  <td style={td}>{fmtMoney(e.baseAmount, e.currency)}</td>
                  <td style={td}>{e.commissionPercent || "—"}</td>
                  <td style={td}>{fmtMoney(e.commissionAmount, e.currency)}</td>
                  <td style={td}>{fmtMoney(e.tdsAmount, e.currency)}</td>
                  <td style={td}>{fmtMoney(e.netAmount, e.currency)}</td>
                  <td style={{ ...td, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.notes || "—"}
                  </td>
                  <td style={td}>
                    {e.status === "accrued" && canSettle && (
                      <button
                        onClick={() => settle(e.id)}
                        title="Settle"
                        style={iconBtn}
                      >
                        <CheckCircle2 size={16} color="#10b981" />
                      </button>
                    )}
                    {e.status !== "reversed" && canReverse && (
                      <button
                        onClick={() => reverse(e.id)}
                        title="Reverse"
                        style={iconBtn}
                      >
                        <XCircle size={16} color="#ef4444" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TopScrollSync>
        </div>
      )}
    </div>
  );
}

const th = { textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 12, color: "#6b7280" };
const td = { padding: "8px 12px" };
const iconBtn = {
  background: "transparent",
  border: 0,
  padding: 4,
  cursor: "pointer",
  marginRight: 4,
};

function Tile({ label, value, count }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{value}</div>
      {count != null && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{count} entries</div>}
    </div>
  );
}
