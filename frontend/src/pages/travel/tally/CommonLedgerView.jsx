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

export default function CommonLedgerView({ rows, title = "Common Ledger", description = "Office expenses and non-supplier common accounting entries.", showOutstanding = false, showCustomerTotals = false }) {
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const paid = showOutstanding ? rows.filter((row) => String(row.status).toLowerCase() === "paid").reduce((sum, row) => sum + Number(row.amount || 0), 0) : 0;
  const outstanding = showOutstanding ? total - paid : 0;
  const customerSales = showCustomerTotals ? rows.reduce((sum, row) => sum + Number(row.invoiceTotal || row.amount || 0), 0) : 0;
  const customerReceived = showCustomerTotals ? rows.reduce((sum, row) => sum + Number(row.amount || 0), 0) : 0;
  const customerOutstanding = showCustomerTotals ? rows.reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0) : 0;

  return (
    <div style={{ ...card, padding: 14, gridColumn: "1 / -1" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: "0.98rem" }}>
        {title}
      </h3>
      <p
        style={{
          margin: "0 0 10px",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        {description}
      </p>
      {showOutstanding && <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 10, marginBottom: 14 }}>{[["Purchase", total], ["Paid", paid], ["Outstanding", outstanding]].map(([label, value]) => <div key={label} style={{ padding: 12, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 10 }}><small style={{ color: "var(--text-secondary)" }}>{label}</small><strong style={{ display: "block", marginTop: 4 }}>{formatMoney(value)}</strong></div>)}</div>}
      {showCustomerTotals && <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 10, marginBottom: 14 }}>{[["Sales", customerSales], ["Received", customerReceived], ["Outstanding", customerOutstanding]].map(([label, value]) => <div key={label} style={{ padding: 12, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 10 }}><small style={{ color: "var(--text-secondary)" }}>{label}</small><strong style={{ display: "block", marginTop: 4 }}>{formatMoney(value)}</strong></div>)}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Entry</th>
              <th style={th}>Trip</th>
              <th style={th}>Reference</th>
              <th style={th}>Category</th>
              <th style={th}>Date</th>
              <th style={{ ...th, textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              <>
                {rows.map((row) => (
                  <tr key={row.id || row.reference}>
                    <td style={td}>
                      <details>
                        <summary style={{ cursor: "pointer", color: "var(--accent-color, #5b7cfa)" }}>
                          {row.name || "Office expense"}
                        </summary>
                        <small style={{ display: "grid", gap: 3, marginTop: 6, color: "var(--text-secondary)" }}>
                          <span>Reference: {row.reference || "-"}</span>
                          <span>Category: {row.category || "-"}</span>
                          <span>Date: {formatDate(row.transactionDate || row.createdAt || row.date)}</span>
                          {row.description && <span>{row.description}</span>}
                        </small>
                      </details>
                    </td>
                    <td style={td}>{row.tripName || "Common"}</td>
                    <td style={td}>{row.reference || "-"}</td>
                    <td style={td}>{row.category || "office"}</td>
                    <td style={td}>
                      {formatDate(
                        row.transactionDate || row.createdAt || row.date,
                      )}
                    </td>
                    <td style={moneyCell}>
                      {formatMoney(row.amount || 0, {
                        currency: row.currency || "INR",
                      })}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={td} colSpan={5}>
                    <strong>Total</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(total)}</strong>
                  </td>
                </tr>
              </>
            ) : (
              <tr>
                <td style={td} colSpan={6}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    No common ledger entries found for these filters.
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
