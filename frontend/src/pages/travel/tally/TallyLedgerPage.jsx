import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { fetchApi } from "../../../utils/api";
import LedgerManager from "./LedgerManager";
import LedgerMapping from "./LedgerMapping";
import TallySectionNav, { TallyWriteGate } from "./TallySectionNav";
import TallySetupReset from "./TallySetupReset";
import { useTravelTallyLedgerMappings } from "./useTravelTallyLedgerMappings";
import { useTravelTallyLedgers } from "./useTravelTallyLedgers";
import { useTravelTallyMaster } from "./useTravelTallyMaster";

const brands = [
  ["all", "All sub-brands"],
  ["tmc", "TMC (schools)"],
  ["rfu", "RFU (Umrah)"],
  ["travelstall", "Travel Stall"],
  ["visasure", "Visa Sure"],
];

const mappingCards = [
  ["Expense Mapping", "Map office and trip expense categories.", "/travel/tally/mapping/expense"],
  ["Party Mapping", "Map customers and suppliers to ledgers.", "/travel/tally/mapping/party"],
  ["Service Mapping", "Map travel services to sales and purchase ledgers.", "/travel/tally/mapping/service"],
  ["Payment Mapping", "Map cash, bank, and online payment modes.", "/travel/tally/mapping/payment"],
  ["Tax Mapping", "Map GST and TCS tax ledgers.", "/travel/tally/mapping/tax"],
  ["Voucher Mapping", "Map transactions to voucher types.", "/travel/tally/mapping/voucher"],
];

export default function TallyLedgerPage({ showMappingsOnly = false }) {
  const navigate = useNavigate();
  const { master, updateMaster } = useTravelTallyMaster();
  const [accounts, setAccounts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [paymentDetails, setPaymentDetails] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [payables, setPayables] = useState([]);
  const [trips, setTrips] = useState([]);
  const [tripTaxes] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ subBrand: master.subBrand || "all" });
    if (master.from) params.set("from", master.from);
    if (master.to) params.set("to", master.to);
    setLoading(true);
    fetchApi(`/api/travel/tally/ledger?${params}`)
      .then((data) => {
        if (cancelled) return;
        setAccounts(data?.accounts || []);
        setCustomers(data?.customerDetails || []);
        setPaymentDetails(data?.paymentDetails || []);
        setSuppliers(data?.supplierDetails || []);
        setPayables(data?.payableDetails || []);
        setTrips(data?.trips || []);
        setError("");
      })
      .catch(() => {
        if (!cancelled) setError("Could not load ledger details.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [master.subBrand, master.from, master.to]);

  const ledgerState = useTravelTallyLedgers({
    accounts,
    masterSubBrand: master.subBrand,
    trips,
    customers,
    paymentDetails,
    suppliers,
    payables,
    tripTaxes,
    setError,
  });
  const mappingState = useTravelTallyLedgerMappings();
  const selectedSubBrandLabel =
    brands.find(([value]) => value === master.subBrand)?.[1] || "All sub-brands";

  const handleViewLedger = (ledger) => {
    const name = String(ledger?.type || ledger?.name || "").toLowerCase();
    const category = String(ledger?.type || "").toUpperCase();
    const view = category === "SALES" || name.includes("sale") ? "sales" : category === "PURCHASE" || name.includes("purchase") ? "purchase" : name.includes("gst") || name.includes("tcs") ? "taxes" : name.includes("bank") ? "bank" : name.includes("cash") ? "cash" : name.includes("expense") ? "common" : "tripwise";
    // A custom expense ledger represents one mapped expense category. Open
    // the category-specific view instead of the aggregate Common Ledger.
    if (view === "common" && ledger?.custom) {
      const databaseId = ledger.databaseId || String(ledger.id || "").replace(/^db-/, "");
      if (/^\d+$/.test(String(databaseId))) {
        navigate(`/travel/tally/view/custom/${databaseId}`);
        return;
      }
      const params = new URLSearchParams();
      if (ledger.name) params.set("ledgerName", ledger.name);
      navigate(`/travel/tally/view/common?${params}`);
      return;
    }
    navigate(`/travel/tally/view/${view}`);
  };

  return (
    <main style={{ padding: 24, maxWidth: 1280, margin: "0 auto", minHeight: "100vh", background: "var(--bg-color)" }}>
      <TallySectionNav showBack />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "end", flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h1 style={{ marginBottom: 6 }}>{showMappingsOnly ? "Ledgers & Mapping" : "Ledger View"}</h1>
          <p style={{ marginTop: 0, color: "var(--text-secondary)" }}>
            {showMappingsOnly ? "Choose an accounting mapping to maintain." : `Travel ledgers for ${selectedSubBrandLabel}.`}
          </p>
        </div>
        <label style={{ display: "grid", gap: 6, color: "var(--text-secondary)", fontSize: 13 }}>
          Sub-brand
          <select value={master.subBrand} onChange={(event) => updateMaster("subBrand")(event.target.value)} style={{ padding: "10px 12px", borderRadius: 8, minWidth: 190 }}>
            {brands.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {loading && <p style={{ color: "var(--text-secondary)" }}>Loading ledger details…</p>}
      {error && <p role="alert" style={{ color: "#f87171" }}>{error}</p>}
      {showMappingsOnly && <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 16 }} aria-label="Ledger mappings">
        {mappingCards.map(([title, description, to]) => <Link key={to} to={to} style={mappingCardStyle}><strong>{title}</strong><span>{description}</span><small>Open mapping →</small></Link>)}
      </section>}
      {!showMappingsOnly && <LedgerManager brands={brands} selectedSubBrandLabel={selectedSubBrandLabel} ledgerState={ledgerState} onViewLedger={handleViewLedger} />}
      {!showMappingsOnly && <LedgerMapping ledgerRows={ledgerState.ledgerRows} mappings={mappingState.mappings} onChange={mappingState.updateMapping} onReset={mappingState.resetMappings} />}
      {!showMappingsOnly && <TallyWriteGate><TallySetupReset hasSavedSetup={ledgerState.hasSavedLedgers || mappingState.hasSavedMappings} onReset={() => { ledgerState.resetSavedLedgers(); mappingState.resetSavedMappings(); }} /></TallyWriteGate>}
    </main>
  );
}

const mappingCardStyle = {
  display: "grid",
  gap: 6,
  padding: 14,
  border: "1px solid var(--border-color, rgba(148,163,184,.2))",
  borderRadius: 12,
  textDecoration: "none",
  color: "var(--text-primary)",
  background: "var(--card-bg, rgba(255,255,255,.03))",
};
