import { useState } from "react";
import { formatMoney } from "../../../utils/money";
import { getTripLedgerRows, rowMatchesTrip } from "./tallyMath";

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

export default function TripwiseLedgerView({
  trips,
  customers,
  suppliers,
  payables,
  tripTaxes,
}) {
  const [expandedTrip, setExpandedTrip] = useState(null);
  const rows = getTripLedgerRows({
    trips,
    customers,
    suppliers,
    payables,
    tripTaxes,
  });

  const totals = rows.reduce(
    (sum, row) => ({
      sales: sum.sales + row.sales,
      purchase: sum.purchase + row.purchase,
      commonExpenses: sum.commonExpenses + row.commonExpenses,
      gstTcs: sum.gstTcs + row.gst + row.tcs,
      profit: sum.profit + row.profit,
    }),
    { sales: 0, purchase: 0, commonExpenses: 0, gstTcs: 0, profit: 0 },
  );

  return (
    <div style={{ ...card, padding: 14, gridColumn: "1 / -1" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: "0.98rem" }}>
        Tripwise Ledger
      </h3>
      <p
        style={{
          margin: "0 0 10px",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        Sales, purchase, common expenses, taxes, and profit/loss per trip.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Trip</th>
              <th style={th}>Status</th>
              <th style={{ ...th, textAlign: "right" }}>Sales</th>
              <th style={{ ...th, textAlign: "right" }}>Purchase</th>
              <th style={{ ...th, textAlign: "right" }}>Common</th>
              <th style={{ ...th, textAlign: "right" }}>GST/TCS</th>
              <th style={{ ...th, textAlign: "right" }}>Profit/Loss</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              <>
                {rows.map((row) => {
                  const participantRows = customers.filter((customer) =>
                    rowMatchesTrip(customer, row.id),
                  );
                  return [
                  <tr key={row.id}>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => setExpandedTrip((current) => current === row.id ? null : row.id)}
                        style={{ border: 0, background: "transparent", padding: 0, color: "inherit", cursor: "pointer", fontWeight: 700 }}
                      >
                        {expandedTrip === row.id ? "▼" : "▶"} {row.label}
                      </button>
                    </td>
                    <td style={td}>{row.status}</td>
                    <td style={moneyCell}>{formatMoney(row.sales)}</td>
                    <td style={moneyCell}>{formatMoney(row.purchase)}</td>
                    <td style={moneyCell}>
                      {formatMoney(row.commonExpenses)}
                    </td>
                    <td style={moneyCell}>{formatMoney(row.gst + row.tcs)}</td>
                    <td
                      style={{
                        ...moneyCell,
                        color: row.profit >= 0 ? "#10b981" : "#f87171",
                        fontWeight: 700,
                      }}
                    >
                      {formatMoney(row.profit)}
                    </td>
                  </tr>,
                  expandedTrip === row.id ? (
                    <tr key={`${row.id}-participants`}>
                      <td style={{ ...td, padding: "8px 12px 12px 30px" }} colSpan={7}>
                        <strong style={{ display: "block", marginBottom: 8 }}>Participants and payments</strong>
                        {participantRows.length ? participantRows.map((participant) => (
                          <div key={participant.reference} style={{ display: "grid", gridTemplateColumns: "1.5fr .8fr .8fr .8fr .7fr", gap: 8, padding: "7px 9px", marginBottom: 6, borderRadius: 8, background: "rgba(148,163,184,.08)" }}>
                            <span><strong>{participant.participantName || participant.name || "Customer"}</strong><small style={{ display: "block", color: "var(--text-secondary)" }}>{participant.name || "Customer"}{participant.email ? ` · ${participant.email}` : ""} · {participant.reference}</small></span>
                            <span>Total<br /><strong>{formatMoney(participant.invoiceTotal || participant.amount)}</strong></span>
                            <span>Paid<br /><strong>{formatMoney(participant.amount)}</strong></span>
                            <span>Balance<br /><strong>{formatMoney(participant.outstandingAmount)}</strong></span>
                            <span>Status<br /><strong>{participant.status || "—"}</strong></span>
                          </div>
                        )) : <span style={{ color: "var(--text-secondary)" }}>No participant invoices found.</span>}
                      </td>
                    </tr>
                  ) : null,
                ];
                })}
                <tr>
                  <td style={td} colSpan={2}>
                    <strong>Total</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.sales)}</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.purchase)}</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.commonExpenses)}</strong>
                  </td>
                  <td style={moneyCell}>
                    <strong>{formatMoney(totals.gstTcs)}</strong>
                  </td>
                  <td
                    style={{
                      ...moneyCell,
                      color: totals.profit >= 0 ? "#10b981" : "#f87171",
                    }}
                  >
                    <strong>{formatMoney(totals.profit)}</strong>
                  </td>
                </tr>
              </>
            ) : (
              <tr>
                <td style={td} colSpan={7}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    No tripwise ledger data found for these filters.
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
