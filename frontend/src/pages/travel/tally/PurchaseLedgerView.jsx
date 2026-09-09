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

const statusColor = (status) => {
  if (status === "paid") return "#10b981";
  if (status === "scheduled") return "#3b82f6";
  if (status === "partial") return "#f59e0b";
  return "#f59e0b";
};

export default function PurchaseLedgerView({ rows }) {
  const categoryOptions = [...new Map(
    rows
      .filter((row) => row?.category)
      .map((row) => [row.category, row.category]),
  ).values()];
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return (
    <div style={{ ...card, padding: 14, gridColumn: "1 / -1" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: "0.98rem" }}>
        Purchase Ledger
      </h3>
      <p
        style={{
          margin: "0 0 10px",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        Supplier payable details included in purchase accounting.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Supplier</th>
              <th style={th}>Trip</th>
              <th style={th}>Payable / Ref</th>
              <th style={th}>Category</th>
              <th style={{ ...th, textAlign: "right" }}>Amount</th>
              <th style={th}>Status</th>
              <th style={th}>Due / Paid</th>
              <th style={th}>Payment Ref</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              <>
                {rows.map((row) => (
                  <tr key={row.id || row.reference}>
                    <td style={td}>
                      <strong>{row.name || "Supplier"}</strong>
                      {row.description && (
                        <small
                          style={{
                            display: "block",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {row.description}
                        </small>
                      )}
                    </td>
                    <td style={td}>{row.tripName || "Unassigned"}</td>
                    <td style={td}><details><summary style={{ cursor: "pointer", color: "var(--accent-color, #5b7cfa)" }}>{row.reference || `PAY-${row.id}`}</summary><small style={{ display: "grid", gap: 3, marginTop: 6, color: "var(--text-secondary)" }}><span>Created: {formatDate(row.transactionDate)}</span><span>Due: {formatDate(row.dueDate)}</span><span>Paid: {formatDate(row.paidAt)}</span><span>Payment reference: {row.paymentReference || "-"}</span></small></details></td>
                    <td style={td}>{row.category || "other"}</td>
                    <td style={moneyCell}>
                      {formatMoney(row.amount || 0, {
                        currency: row.currency || "INR",
                      })}
                    </td>
                    <td style={td}>
                      <strong
                        style={{
                          color: statusColor(row.status),
                          textTransform: "capitalize",
                        }}
                      >
                        {row.status || "pending"}
                      </strong>
                    </td>
                    <td style={td}>
                      <strong style={{ display: "block" }}>
                        {row.status === "paid"
                          ? formatDate(row.paidAt)
                          : row.status === "partial"
                            ? `${formatDate(row.paidAt)} - ${formatMoney(
                                row.paidAmount || 0,
                                { currency: row.currency || "INR" },
                              )} paid`
                            : formatDate(row.dueDate)}
                      </strong>
                      <small
                        style={{
                          color: "var(--text-secondary)",
                          textTransform: "capitalize",
                        }}
                      >
                        {row.paymentMode || "cash"}
                      </small>
                    </td>
                    <td style={td}>{row.paymentReference || "-"}</td>
                  </tr>
                ))}
                <tr>
                  <td style={td} colSpan={4}>
                    <strong>Total</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(total)}</strong>
                  </td>
                  <td style={td} colSpan={3} />
                </tr>
              </>
            ) : (
              <tr>
                <td style={td} colSpan={8}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    No paid supplier details found for these filters.
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
