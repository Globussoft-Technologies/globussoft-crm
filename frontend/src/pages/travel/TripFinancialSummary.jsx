import { useEffect, useState } from "react";
import { IndianRupee, TrendingUp } from "lucide-react";
import { fetchApi } from "../../utils/api";

const fields = [["sales", "Sales"], ["gst", "GST"], ["tcs", "TCS"], ["purchases", "Purchases"], ["tripExpenses", "Trip expenses"], ["received", "Received"], ["customerOutstanding", "Customer outstanding"], ["supplierOutstanding", "Supplier outstanding"]];

export default function TripFinancialSummary({ trip }) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    const params = new URLSearchParams({ itineraryId: String(trip.id), subBrand: trip.subBrand || "tmc" });
    fetchApi(`/api/travel/tally/ledger?${params}`).then((data) => setSummary(data?.tripFinancialSummary || null)).catch(() => setSummary(null));
  }, [trip.id, trip.subBrand]);
  const displaySummary = summary || {};
  const margin = Number(displaySummary.sales || 0) - Number(displaySummary.purchases || 0) - Number(displaySummary.tripExpenses || 0);
  return <section style={panelStyle} aria-label="Trip financial summary"><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}><TrendingUp size={18} /><strong>Trip financial summary</strong>{!summary && <small style={{ color: "var(--text-secondary)" }}>Loading…</small>}</div><div style={gridStyle}>{fields.map(([key, label]) => <div key={key}><small style={{ color: "var(--text-secondary)" }}>{label}</small><strong style={{ display: "block", marginTop: 3 }}><IndianRupee size={12} style={{ verticalAlign: "-1px" }} />{Number(displaySummary[key] || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong></div>)}<div><small style={{ color: "var(--text-secondary)" }}>Gross margin</small><strong style={{ display: "block", marginTop: 3, color: margin >= 0 ? "#2f855a" : "#c53030" }}><IndianRupee size={12} style={{ verticalAlign: "-1px" }} />{Math.abs(margin).toLocaleString("en-IN", { maximumFractionDigits: 2 })}{margin < 0 ? " loss" : ""}</strong></div></div></section>;
}

const panelStyle = { padding: 16, border: "1px solid var(--border-color)", borderRadius: 12, background: "var(--bg-color, #111318)" };
const gridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 14 };
