import { useEffect, useState } from "react";
import { formatMoney } from "../../../utils/money";

const card = {
  background: "var(--card-bg, rgba(255,255,255,.04))",
  border: "1px solid var(--border-color, rgba(148,163,184,.2))",
  borderRadius: 14,
};
const th = {
  padding: "8px 9px",
  textAlign: "left",
  color: "var(--text-secondary)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".02em",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.16))",
  whiteSpace: "nowrap",
};
const td = {
  padding: "10px 9px",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.1))",
  fontSize: 13,
  verticalAlign: "top",
};
const moneyCell = {
  ...td,
  textAlign: "right",
  whiteSpace: "nowrap",
};

const formatDate = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

export default function BankLedgerView({ rows = [], ledger = "bank" }) {
  const isCashLedger = ledger === "cash";
  const credited = rows
    .filter((row) => row.direction !== "DEBIT")
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const debited = rows
    .filter((row) => row.direction === "DEBIT")
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const storageKey = `travel-tally-${isCashLedger ? "cash" : "bank"}-opening-balance`;
  const [opening, setOpening] = useState(() => { try { return Number(localStorage.getItem(storageKey) || 0); } catch { return 0; } });
  useEffect(() => { try { localStorage.setItem(storageKey, String(opening)); } catch { /* storage unavailable */ } }, [storageKey, opening]);
  const closing = opening + credited - debited;

  return (
    <div style={{ ...card, padding: 14, gridColumn: "1 / -1" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: "0.98rem" }}>
        {isCashLedger ? "Cash Ledger" : "Bank Ledger"}
      </h3>
      <p
        style={{
          margin: "0 0 10px",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        {isCashLedger
          ? "Cash customer receipts and cash supplier purchases recorded in this report."
          : "Bank-based customer receipts and supplier purchases recorded in this report."}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: 10, margin: "14px 0" }}>
        {[["Opening", opening, "var(--text-primary)"], ["Money In", credited, "#10b981"], ["Money Out", debited, "#f59e0b"], ["Closing", closing, closing >= 0 ? "#10b981" : "#c53030"]].map(([label, value, color]) => <div key={label} style={{ padding: 12, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 10 }}><small style={{ color: "var(--text-secondary)" }}>{label}</small>{label === "Opening" ? <input type="number" min="0" value={opening} onChange={(event) => setOpening(Number(event.target.value) || 0)} aria-label={`${isCashLedger ? "Cash" : "Bank"} opening balance`} style={{ display: "block", width: "100%", marginTop: 4, boxSizing: "border-box" }} /> : <strong style={{ display: "block", marginTop: 4, color }}>{formatMoney(value)}</strong>}</div>)}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Party / Reference</th>
              <th style={th}>Trip</th>
              <th style={th}>Payment Method</th>
              <th style={th}>Reference</th>
              <th style={{ ...th, textAlign: "right" }}>Credit</th>
              <th style={{ ...th, textAlign: "right" }}>Debit / Withdrawal</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              <>
                {rows.map((row, index) => (
                  <tr key={row.paymentId || row.id || index}>
                    <td style={td}>{formatDate(row.paidAt)}</td>
                    <td style={td}>
                      <strong>{row.customer || "Party"}</strong>
                      <small style={{ display: "block", color: "var(--text-secondary)" }}>
                        {row.invoice || "-"}
                      </small>
                      {row.transactionType === "purchase" && (
                        <small style={{ display: "block", color: "var(--text-secondary)" }}>
                          Supplier purchase
                          {row.description ? ` - ${row.description}` : ""}
                        </small>
                      )}
                    </td>
                    <td style={td}>{row.itineraryId ? `TRIP-${row.itineraryId}` : "-"}</td>
                    <td style={td}>{row.paymentMethod || "-"}</td>
                    <td style={td}>{row.reference || "-"}</td>
                    <td style={{ ...moneyCell, color: "#10b981" }}>
                      {row.direction !== "DEBIT"
                        ? formatMoney(row.amount || 0, {
                            currency: row.currency || "INR",
                          })
                        : "-"}
                    </td>
                    <td style={{ ...moneyCell, color: "#f59e0b" }}>
                      {row.direction === "DEBIT"
                        ? formatMoney(row.amount || 0, {
                            currency: row.currency || "INR",
                          })
                        : "-"}
                    </td>
                    <td style={td}>{row.status || "SUCCESS"}</td>
                  </tr>
                ))}
                <tr>
                  <td style={td} colSpan={5}>
                    <strong>Total</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(credited)}</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(debited)}</strong>
                  </td>
                  <td style={td} />
                </tr>
              </>
            ) : (
              <tr>
                <td style={td} colSpan={8}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    No {isCashLedger ? "cash" : "bank"} transactions found.
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
