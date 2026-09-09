import { ArrowRight, BookOpen, Building2, Download, FileSpreadsheet, ListTree, Tags } from "lucide-react";
import { Link } from "react-router-dom";

const cards = [
  ["Company Setup", "Company, financial year, currency, and bank details.", "/travel/tally/company-setup", Building2],
  ["Ledgers & Mapping", "Ledger accounts and website-to-account mappings.", "/travel/tally/mappings", ListTree],
  ["Ledger Views", "Ledger accounts, balances, and mappings.", "/travel/tally/ledger", BookOpen],
  ["Masters", "Ledger groups, ledgers, voucher types, taxes, and payment accounts.", "/travel/tally/masters", Tags],
  ["Voucher Setup", "Voucher types, numbering, and export configuration.", "/travel/tally/settings", FileSpreadsheet],
  ["Tally Export", "Review all trips, preview accounting details, and download XML.", "/travel/tally/export", Download],
];

export default function TallyHomePage() {
  return <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
    <h1 style={{ marginBottom: 6 }}>Tally Accounting</h1>
    <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>Select a Tally work area. Live connection and dashboard features will be added later.</p>
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 14, marginTop: 20 }}>
      {cards.map(([title, description, to, Icon]) => <Link key={to} to={to} style={cardStyle}>
        <Icon size={22} color="#5b7cfa" />
        <strong>{title}</strong>
        <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{description}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text-primary)", fontWeight: 700, fontSize: 13 }}>Open <ArrowRight size={14} /></span>
      </Link>)}
    </section>
  </main>;
}

const cardStyle = { display: "grid", gap: 10, padding: 18, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 14, textDecoration: "none", color: "var(--text-primary)" };
