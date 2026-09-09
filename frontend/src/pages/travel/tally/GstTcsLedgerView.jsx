import React from "react";

const formatMoney = (value, currency = "INR") =>
  `${currency} ${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatRate = (value) =>
  value == null || value === "" ? "-" : `${Number(value).toFixed(2)}%`;

export default function GstTcsLedgerView({ rows = [], taxType = "ALL" }) {
  const amountFor = (row) => taxType === "GST" ? Number(row.gstAmount || 0) : taxType === "TCS" ? Number(row.tcsAmount || 0) : Number(row.gstTcsAmount || 0);
  const rateFor = (row) => taxType === "GST" ? row.gstRate : taxType === "TCS" ? row.tcsRate : row.gstTcsRate;
  const totalTax = rows.reduce(
    (sum, row) => sum + amountFor(row),
    0,
  );

  return (
    <section
      style={{
        background: "var(--surface-color, #15171c)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-color, rgba(148,163,184,.25))",
        borderRadius: 12,
        overflow: "hidden",
      }}
      aria-label="GST and TCS transactions"
    >
      <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border-color, rgba(148,163,184,.25))" }}>
          <strong>{taxType === "GST" ? "GST Transactions" : taxType === "TCS" ? "TCS Transactions" : "GST/TCS Transactions"}</strong>
        <div style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 4 }}>
          Tax values retrieved from saved travel invoices and their source quotes.
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
          <thead>
            <tr>
              {[
                "Invoice",
                "Customer",
                "Trip",
                "Taxable Amount",
                taxType === "GST" ? "GST %" : taxType === "TCS" ? "TCS %" : "GST/TCS %",
                taxType === "GST" ? "GST Amount" : taxType === "TCS" ? "TCS Amount" : "GST/TCS Amount",
                "Invoice Total",
                "Status",
              ].map((heading) => (
                <th key={heading} style={thStyle}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} style={emptyStyle}>No GST/TCS records found.</td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.reference}>
                <td style={tdStyle}>{row.reference || "-"}</td>
                <td style={tdStyle}>{row.name || "Customer"}</td>
                <td style={tdStyle}>{row.tripName || "Unassigned"}</td>
                <td style={tdStyle}>{formatMoney(row.taxableAmount, row.currency)}</td>
                <td style={tdStyle}>{formatRate(rateFor(row))}</td>
                <td style={tdStyle}>{formatMoney(amountFor(row), row.currency)}</td>
                <td style={tdStyle}>{formatMoney(row.invoiceTotal, row.currency)}</td>
                <td style={tdStyle}>{row.status || "-"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
                <td colSpan={5} style={{ ...tdStyle, fontWeight: 700, textAlign: "right" }}>Total GST/TCS</td>
              <td style={{ ...tdStyle, fontWeight: 700 }}>{formatMoney(totalTax)}</td>
              <td colSpan={2} style={tdStyle} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

const thStyle = {
  padding: "12px 14px",
  textAlign: "left",
  fontSize: 12,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.25))",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "13px 14px",
  fontSize: 13,
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.18))",
  whiteSpace: "nowrap",
};

const emptyStyle = {
  padding: 28,
  textAlign: "center",
  color: "var(--text-secondary)",
};
