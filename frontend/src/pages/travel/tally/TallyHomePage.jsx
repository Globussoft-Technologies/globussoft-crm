import { ArrowRight, BookOpen, Building2, Calculator, Download, FileSpreadsheet, ListTree, Tags } from "lucide-react";
import { Link } from "react-router-dom";

const cards = [
  ["Company Setup", "Company, financial year, currency, and bank details.", "/travel/tally/company-setup", Building2],
  ["Ledger Views", "Ledger accounts, balances, and mappings.", "/travel/tally/ledger", BookOpen],
  ["Ledgers & Mapping", "Ledger accounts and website-to-account mappings.", "/travel/tally/mappings", ListTree],
  ["Masters", "Ledger groups, ledgers, voucher types, taxes, and payment accounts.", "/travel/tally/masters", Tags],
  ["Voucher Setup", "Voucher types, numbering, and export configuration.", "/travel/tally/settings", FileSpreadsheet],
  ["Tally Export", "Review trips, preview vouchers, and push or download Tally XML.", "/travel/tally/export", Download],
];

export default function TallyHomePage() {
  return <main className="finance-page" style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
    <header className="finance-page__header">
      <div>
        <h1 className="finance-page__title"><Calculator size={26} aria-hidden /> Tally</h1>
        <p className="finance-page__subtitle" style={{ color: "var(--text-secondary)", marginTop: 0 }}>Configure Tally, review accounting records, export trips, and monitor direct sync activity.</p>
      </div>
    </header>
    <section className="finance-page__nav-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 14, marginTop: 20 }}>
      {cards.map(([title, description, to, Icon]) => <Link className="finance-page__nav-card" key={to} to={to} style={cardStyle}>
        <Icon size={22} />
        <strong>{title}</strong>
        <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{description}</span>
        <span className="finance-page__nav-card-action" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text-primary)", fontWeight: 700, fontSize: 13 }}>Open <ArrowRight size={14} /></span>
      </Link>)}
    </section>
  </main>;
}

const cardStyle = { display: "grid", gap: 10, padding: 18, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 14, textDecoration: "none", color: "var(--text-primary)" };
