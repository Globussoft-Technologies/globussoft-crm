import { ArrowRight, Banknote, FolderTree, Landmark, ReceiptText, Tags, WalletCards } from "lucide-react";
import { Link } from "react-router-dom";
import TallySectionNav from "./TallySectionNav";

const cards = [
  ["Ledger Groups", "Maintain asset, liability, income, and expense groups.", "/travel/tally/masters/groups", FolderTree],
  ["Ledgers", "Create and maintain local Tally ledger masters.", "/travel/tally/ledger", Tags],
  ["Voucher Types", "Configure Sales, Purchase, Receipt, Payment, and notes.", "/travel/tally/masters/vouchers", ReceiptText],
  ["Payment Accounts", "Map Cash, Bank, UPI, NEFT, RTGS, and card modes.", "/travel/tally/masters/payment-accounts", Banknote],
  ["Tax Masters", "Maintain GST and TCS rules and ledger assignments.", "/travel/tally/masters/tax", Landmark],
  ["Cost Centres", "Review trip-level accounting cost centres.", "/travel/tally/masters/cost-centres", WalletCards],
];

export default function TallyMastersPage() {
  return <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}><TallySectionNav /><h1> Tally Masters</h1><p style={{ color: "var(--text-secondary)" }}>Configure the accounting masters used by the travel website. Live Tally synchronization is deferred.</p><section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 20 }}>{cards.map(([title, description, to, Icon]) => <Link key={to} to={to} style={cardStyle}><Icon size={22} color="#5b7cfa" /><strong>{title}</strong><span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{description}</span><span style={{ display: "inline-flex", gap: 5, alignItems: "center", fontWeight: 700, fontSize: 13 }}>Open <ArrowRight size={14} /></span></Link>)}</section></main>;
}

const cardStyle = { display: "grid", gap: 10, padding: 18, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 14, textDecoration: "none", color: "var(--text-primary)" };
