import { formatMoney } from "../../../utils/money";
import { getInvoiceAmount } from "./tallyMath";

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
const input = {
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid var(--border-color, #334155)",
  background: "var(--input-bg, transparent)",
  color: "var(--text-primary)",
  width: "100%",
  boxSizing: "border-box",
};

// Legacy quote-level tax is stored as one GST/TCS total. Use it when the
// invoice has not yet been split into GST and TCS fields.
const getGstAmount = (row) => {
  const gst = Number(row.gstAmount || 0);
  const tcs = Number(row.tcsAmount || 0);
  if (gst === 0 && tcs === 0 && row.gstTcsAmount != null) {
    return Number(row.gstTcsAmount || 0);
  }
  return gst;
};

export default function SalesLedgerView({
  rows,
}) {
  const totals = rows.reduce(
    (sum, row) => ({
      invoice: sum.invoice + getInvoiceAmount(row),
      received: sum.received + Number(row.amount || 0),
      remaining: sum.remaining + Number(row.outstandingAmount || 0),
      gstTcs: sum.gstTcs + getGstAmount(row) + Number(row.tcsAmount || 0),
    }),
    { invoice: 0, received: 0, remaining: 0, gstTcs: 0 },
  );

  return (
    <div style={{ ...card, padding: 14, gridColumn: "1 / -1" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: "0.98rem" }}>
        Sales Ledger
      </h3>
      <p
        style={{
          margin: "0 0 10px",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        Customer invoices, payment received, tax, and trip details.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Customer</th>
              <th style={th}>Trip</th>
              <th style={th}>Invoice / Ref</th>
              <th style={{ ...th, textAlign: "right" }}>Invoice</th>
              <th style={{ ...th, textAlign: "right" }}>Received</th>
              <th style={{ ...th, textAlign: "right" }}>Remaining</th>
              <th style={{ ...th, textAlign: "right" }}>GST/TCS</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              <>
                {rows.map((row) => (
                  <tr key={row.id || row.reference}>
                    <td style={td}>
                      <strong>{row.name || "Customer"}</strong>
                      {row.email && (
                        <small
                          style={{
                            display: "block",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {row.email}
                        </small>
                      )}
                    </td>
                    <td style={td}>{row.tripName || "Unassigned"}</td>
                    <td style={td}><details><summary style={{ cursor: "pointer", color: "var(--accent-color, #5b7cfa)" }}>{row.reference || "-"}</summary><small style={{ display: "grid", gap: 3, marginTop: 6, color: "var(--text-secondary)" }}><span>Status: {row.status || "-"}</span><span>Invoice date: {row.transactionDate ? new Date(row.transactionDate).toLocaleDateString("en-IN") : "-"}</span><span>GST: {formatMoney(getGstAmount(row), { currency: row.currency || "INR" })}</span><span>TCS: {formatMoney(row.tcsAmount || 0, { currency: row.currency || "INR" })}</span></small></details></td>
                    <td style={moneyCell}>
                      {formatMoney(getInvoiceAmount(row), {
                        currency: row.currency || "INR",
                      })}
                    </td>
                    <td style={moneyCell}>
                      {formatMoney(row.amount || 0, {
                        currency: row.currency || "INR",
                      })}
                      {row.paymentRecordMissing && (
                        <small
                          title="This invoice is marked Paid, but has no payment record."
                          style={{
                            display: "block",
                            color: "#f59e0b",
                            fontSize: 10,
                            marginTop: 3,
                          }}
                        >
                          Legacy paid
                        </small>
                      )}
                    </td>
                    <td
                      style={{
                        ...moneyCell,
                        color:
                          Number(row.outstandingAmount || 0) > 0
                            ? "#f59e0b"
                            : "var(--text-primary)",
                      }}
                    >
                      {formatMoney(row.outstandingAmount || 0, {
                        currency: row.currency || "INR",
                      })}
                    </td>
                    <td style={moneyCell}>
                      {formatMoney(
                        getGstAmount(row) + Number(row.tcsAmount || 0),
                        {
                          currency: row.currency || "INR",
                        },
                      )}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={td} colSpan={3}>
                    <strong>Total</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.invoice)}</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.received)}</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.remaining)}</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.gstTcs)}</strong>
                  </td>
                </tr>
              </>
            ) : (
              <tr>
                <td style={td} colSpan={7}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    No customer sales found for these filters.
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
