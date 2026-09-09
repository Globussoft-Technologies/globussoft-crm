import { formatMoney } from "../../../utils/money";
import { getTripTaxTotals } from "./tallyMath";

const card = {
  background: "var(--card-bg, rgba(255,255,255,.04))",
  border: "1px solid var(--border-color, rgba(148,163,184,.2))",
  borderRadius: 14,
};
const metric = {
  ...card,
  padding: 14,
  minHeight: 86,
  display: "grid",
  alignContent: "space-between",
};
const label = {
  color: "var(--text-secondary)",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: ".02em",
};
const value = {
  margin: "8px 0 0",
  fontSize: "1.1rem",
};

const getAccountAmount = (accounts, id) =>
  Number(accounts.find((account) => account.id === id)?.amount || 0);

export default function TallyPreviewSummary({
  accounts,
  customers,
  trips,
  tripTaxes,
}) {
  const sales = getAccountAmount(accounts, "sales");
  const purchase = getAccountAmount(accounts, "purchase");
  const commonExpenses = getAccountAmount(accounts, "officeExpenses");

  const tripTaxTotals = getTripTaxTotals({ trips, customers, tripTaxes });
  const totalExpense =
    purchase + commonExpenses + tripTaxTotals.gst + tripTaxTotals.tcs;
  const profit = sales - totalExpense;

  const rows = [
    ["Sales ledger", sales],
    ["Purchase ledger", purchase],
    ["Common ledger", commonExpenses],
    ["GST/TCS", tripTaxTotals.gst + tripTaxTotals.tcs],
    [profit >= 0 ? "Net profit" : "Net loss", Math.abs(profit)],
  ];

  return (
    <div style={{ ...card, padding: 16, marginTop: 20 }}>
      <h3 style={{ margin: "0 0 12px" }}>Tally final preview</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        {rows.map(([name, amount]) => (
          <div key={name} style={metric}>
            <span style={label}>{name}</span>
            <strong
              style={{
                ...value,
                color:
                  name.includes("profit")
                    ? "#10b981"
                    : name.includes("loss")
                      ? "#ef4444"
                      : "var(--text-primary)",
              }}
            >
              {formatMoney(amount)}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}
