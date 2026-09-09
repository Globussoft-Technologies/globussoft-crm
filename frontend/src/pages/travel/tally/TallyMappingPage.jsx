import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import TallySectionNav, { TallyWriteGate } from "./TallySectionNav";
import { fetchApi } from "../../../utils/api";

const presets = {
  expense: { title: "Expense Mapping", type: "EXPENSE", rows: ["Office Rent", "Salary", "Incentive", "Electricity", "Internet", "Marketing", "Software", "Office Supplies"] },
  payment: { title: "Payment Mapping", type: "PAYMENT", rows: ["CASH", "BANK", "UPI", "NEFT", "RTGS", "IMPS", "CARD", "PAYMENT GATEWAY"] },
  tax: { title: "Tax Mapping", type: "TAX", rows: ["CGST", "SGST", "IGST", "TCS"] },
  voucher: { title: "Voucher Mapping", type: "VOUCHER", rows: ["SALES", "PURCHASE", "RECEIPT", "PAYMENT", "JOURNAL", "CREDIT NOTE", "DEBIT NOTE"] },
};

// Expense rows become PAYMENT transactions in the sync queue. Keeping this
// translation in one place prevents the mapping screen from saving EXPENSE
// rows that the queue validator can never resolve.
const mappingTransactionType = (kind, key) => {
  if (kind === "voucher") return key;
  if (kind === "payment") return "PAYMENT";
  if (kind === "tax") return "TAX";
  if (kind === "expense") return "PAYMENT";
  return key;
};

export default function TallyMappingPage({ kind }) {
  const config = presets[kind];
  const navigate = useNavigate();
  const [ledgers, setLedgers] = useState([]); const [mappings, setMappings] = useState([]); const [selected, setSelected] = useState({}); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [voucherTypes, setVoucherTypes] = useState([]);
  const [expenseCategories, setExpenseCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setError("");
    setLoading(true);
    try {
      const requests = [
        fetchApi("/api/travel/tally/accounting-masters"),
        fetchApi("/api/travel/tally/mappings"),
      ];
      if (kind === "expense") requests.push(fetchApi("/api/expenses?fields=summary&limit=500"));
      const [data, mapData, expenseData] = await Promise.all(requests);
      setLedgers(data?.ledgers || []);
      setVoucherTypes(data?.voucherTypes || []);
      setMappings(mapData?.mappings || []);
      if (kind === "expense") {
        const categories = [...new Set((Array.isArray(expenseData) ? expenseData : [])
          .map((expense) => String(expense.category || "").trim())
          .filter(Boolean))].sort((a, b) => a.localeCompare(b));
        setExpenseCategories(categories);
      }
    } catch (loadError) {
      setError(loadError.message || "Could not load mapping data.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load().catch((loadError) => setError(loadError.message || "Could not load mapping data.")); }, []);
  const existing = (key) => mappings.find((row) => row.sourceType === config.type && row.sourceKey === `${config.type}:${key}` && row.transactionType === mappingTransactionType(kind, key));
  const suggestion = (key) => {
    const normalized = String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const exact = ledgers.filter((ledger) => String(ledger.ledgerName || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalized);
    if (exact.length === 1) return exact[0];
    const partial = ledgers.filter((ledger) => {
      const name = String(ledger.ledgerName || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return name.includes(normalized) || normalized.includes(name);
    });
    return partial.length === 1 ? partial[0] : null;
  };
  const mappingRows = kind === "expense"
    ? expenseCategories
    : kind === "voucher"
      ? [...new Set([...config.rows, ...voucherTypes.map((voucher) => String(voucher.name || voucher.label || "").trim().toUpperCase()).filter(Boolean)])]
      : config.rows;
  const save = async (key) => { const ledgerId = Number(selected[key] || existing(key)?.tallyLedgerId); if (!ledgerId) return; setError(""); setMessage(""); try { await fetchApi("/api/travel/tally/mappings", { method: "POST", body: JSON.stringify({ sourceType: config.type, sourceKey: `${config.type}:${key}`, transactionType: mappingTransactionType(kind, key), tallyLedgerId: ledgerId }) }); setMessage(`${key} mapping saved.`); await load(); } catch (saveError) { setError(saveError.message || `Could not save ${key} mapping.`); } };
  return <main className="tally-mapping-page"><TallySectionNav /><div className="tally-mapping-header"><div><span className="tally-mapping-eyebrow">Finance / Tally</span><h1>{config.title}</h1><p>{kind === "expense" ? "Only categories found in your recorded expenses are shown." : "Choose a ledger for each website accounting category."} Uncertain mappings are never created silently.</p></div><button className="tally-mapping-queue-button" type="button" onClick={() => navigate("/travel/tally/sync-queue")}>Sync Queue <span aria-hidden="true">→</span></button></div>{message && <p className="tally-mapping-message">{message}</p>}{error && <p className="tally-mapping-error" role="alert">{error}</p>}{loading ? <p className="tally-mapping-empty">Loading mapping data…</p> : mappingRows.length === 0 && kind === "expense" ? <p className="tally-mapping-empty">No expense categories found. Create an expense first, then refresh this page.</p> : <div className="tally-mapping-card"><div className="tally-mapping-card-heading"><div><h2>Ledger assignments</h2><p>Connect each website item to its Tally ledger.</p></div><span>{mappingRows.length} {mappingRows.length === 1 ? "item" : "items"}</span></div><div className="tally-mapping-table-wrap"><table><thead><tr><th>Website item</th><th>Transaction type</th><th>Tally ledger</th><th>Action</th></tr></thead><tbody>{mappingRows.map((key) => { const row = existing(key); const suggested = suggestion(key); return <tr key={key}><td><strong>{key}</strong>{suggested && !row && <small className="tally-mapping-suggestion">Suggested match: {suggested.ledgerName} <button type="button" onClick={() => setSelected({ ...selected, [key]: suggested.id })}>Use suggestion</button></small>}</td><td><span className="tally-mapping-type">{row?.transactionType || mappingTransactionType(kind, key)}</span></td><td><select value={selected[key] ?? row?.tallyLedgerId ?? ""} onChange={(e) => setSelected({ ...selected, [key]: e.target.value })}><option value="">Select ledger</option>{ledgers.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.ledgerName}</option>)}</select></td><td><TallyWriteGate><button className="tally-mapping-save" type="button" onClick={() => save(key)} disabled={!selected[key] && !row}>Save</button></TallyWriteGate></td></tr>; })}</tbody></table></div></div>}</main>;
}
