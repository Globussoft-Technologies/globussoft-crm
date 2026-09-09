import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import TallySectionNav, { TallyWriteGate } from "./TallySectionNav";
import { fetchApi } from "../../../utils/api";
import { defaultVoucherTypes } from "./travelTallyVoucherConfig";

const configs = {
  vouchers: { title: "Voucher Types", endpoint: "voucher-types", fields: [["name", "Name"], ["numberingMode", "Numbering mode"], ["prefix", "Prefix"]] },
  payments: { title: "Payment Accounts", endpoint: "payment-accounts", fields: [["mode", "Payment mode"], ["accountName", "Account name"], ["ledgerId", "Ledger ID"]] },
  taxes: { title: "Tax Masters", endpoint: "tax-masters", fields: [["taxName", "Tax name"], ["taxType", "Tax type (CGST/SGST/IGST/TCS)"], ["rate", "Rate %"], ["calculationBasis", "Calculation basis"], ["applicability", "Applicability"], ["ledgerId", "Ledger ID"]] },
};
const emptyForm = { numberingMode: "AUTO", status: "ACTIVE" };

export default function TallyAccountingMasterPage({ kind }) {
  const config = configs[kind];
  const navigate = useNavigate();
  const [data, setData] = useState({ voucherTypes: [], paymentAccounts: [], taxMasters: [], ledgers: [] });
  const [form, setForm] = useState(emptyForm); const [editingId, setEditingId] = useState(null); const [error, setError] = useState("");
  const load = () => fetchApi("/api/travel/tally/accounting-masters").then((value) => setData(value || data)).catch(() => setError("Could not load accounting masters."));
  useEffect(() => { load(); }, []);
  const defaultVoucherRows = defaultVoucherTypes.map((voucher) => ({ id: `system-${voucher.id}`, name: voucher.label, numberingMode: voucher.numberingMode.toUpperCase(), prefix: voucher.prefix, status: "ACTIVE", source: "SYSTEM" }));
  const rows = kind === "vouchers" ? [...defaultVoucherRows.filter((defaultRow) => !data.voucherTypes.some((row) => row.name === defaultRow.name)), ...data.voucherTypes] : kind === "payments" ? data.paymentAccounts : data.taxMasters;
  const save = async (event) => { event.preventDefault(); setError(""); try { await fetchApi(`/api/travel/tally/${config.endpoint}`, { method: "POST", body: JSON.stringify(form), headers: { "Content-Type": "application/json" } }); setForm(emptyForm); setEditingId(null); await load(); } catch (e) { setError(e.message || "Could not save."); } };
  const edit = (row) => { if (row.source === "SYSTEM") return; setEditingId(row.id); setForm(kind === "vouchers" ? { id: row.id, name: row.name, numberingMode: row.numberingMode, prefix: row.prefix || "" } : kind === "payments" ? { id: row.id, mode: row.mode, accountName: row.accountName, ledgerId: row.ledgerId || "" } : { id: row.id, taxName: row.taxName, taxType: row.taxType, rate: row.rate, calculationBasis: row.calculationBasis || "TAXABLE_VALUE", applicability: row.applicability || "", ledgerId: row.ledgerId || "" }); };
  const cancelEdit = () => { setEditingId(null); setForm(emptyForm); };
  return <main className="tally-master-page" style={{ padding: 24, maxWidth: 1180, margin: "0 auto" }}><TallySectionNav /><div className="tally-master-header"><div><span className="tally-mapping-eyebrow">Finance / Tally</span><h1>{config.title}</h1><p>Persistent, tenant-scoped accounting configuration. Live Tally sync remains deferred.</p></div><button className="tally-mapping-queue-button" type="button" onClick={() => navigate("/travel/tally/sync-queue")}>Sync Queue <span aria-hidden="true">→</span></button></div>
    <TallyWriteGate><form className="tally-master-form" onSubmit={save} style={formStyle}>{config.fields.map(([key, label]) => <label key={key} style={fieldStyle}>{label}{key === "ledgerId" ? <select style={controlStyle} value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })}><option value="">Select ledger</option>{data.ledgers.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.ledgerName}</option>)}</select> : <input style={controlStyle} value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required={key !== "prefix" && key !== "ledgerId"} />}</label>)}<button className="tally-master-submit" type="submit" style={buttonStyle}>{editingId ? "Update" : "Save"} {config.title.slice(0, -1)}</button>{editingId && <button className="tally-master-cancel" type="button" style={buttonStyle} onClick={cancelEdit}>Cancel</button>}</form></TallyWriteGate>
    {error && <p style={{ color: "#c53030" }}>{error}</p>}<div style={tableWrapStyle}><table style={tableStyle}><thead><tr><th style={headerCellStyle}>Name / Mode</th><th style={headerCellStyle}>Details</th><th style={headerCellStyle}>Status</th><th style={headerCellStyle}>Action</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id}><td style={cellStyle}><strong>{row.name || row.accountName || row.taxName}</strong></td><td style={cellStyle}>{row.mode || row.taxType || row.numberingMode}{row.rate != null ? ` · ${row.rate}%` : ""}{row.ledger?.ledgerName ? ` · ${row.ledger.ledgerName}` : ""}</td><td style={cellStyle}>{row.status}</td><td style={cellStyle}><TallyWriteGate><button type="button" onClick={() => edit(row)}>Edit</button></TallyWriteGate></td></tr>) : <tr><td style={cellStyle} colSpan="4">No records configured yet.</td></tr>}</tbody></table></div></main>;
}

const formStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14, alignItems: "end", margin: "18px 0 24px", padding: 16, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 12, background: "var(--surface-color)" };
const fieldStyle = { display: "grid", gap: 6, color: "var(--text-secondary)", fontSize: 13, fontWeight: 600 };
const controlStyle = { width: "100%", height: 40, boxSizing: "border-box", padding: "9px 11px", border: "1px solid var(--border-color, rgba(148,163,184,.3))", borderRadius: 9, background: "var(--input-bg)", color: "var(--text-primary)", fontSize: 13 };
const buttonStyle = { minHeight: 40, padding: "9px 14px", borderRadius: 9, fontWeight: 700, cursor: "pointer" };
const tableWrapStyle = { overflowX: "auto", marginTop: 22, padding: 12, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 12, background: "var(--surface-color)" };
const tableStyle = { width: "100%", minWidth: 700, borderCollapse: "collapse", tableLayout: "fixed", fontSize: 13 };
const headerCellStyle = { padding: "13px 12px", textAlign: "left", color: "var(--text-secondary)", fontSize: 12, fontWeight: 700, borderBottom: "1px solid var(--border-color, rgba(148,163,184,.3))" };
const cellStyle = { padding: "15px 12px", textAlign: "left", verticalAlign: "top", lineHeight: 1.45, borderBottom: "1px solid var(--border-color, rgba(148,163,184,.18))", overflowWrap: "anywhere" };
