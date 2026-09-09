import { formatMoney } from "../../../utils/money";
import { Eye, Pencil } from "lucide-react";
import { TallyWriteGate } from "./TallySectionNav";
import {
  gstApplicabilityOptions,
  ledgerGroups,
  ledgerNatures,
  ledgerTypes,
} from "./ledgerConfig";

const card = {
  background: "var(--card-bg, rgba(255,255,255,.04))",
  border: "1px solid var(--border-color, rgba(148,163,184,.2))",
  borderRadius: 14,
};
const input = {
  padding: "10px 11px",
  borderRadius: 8,
  border: "1px solid var(--border-color, #334155)",
  background: "var(--input-bg, transparent)",
  color: "var(--text-primary)",
  width: "100%",
  boxSizing: "border-box",
};
const label = {
  display: "grid",
  gap: 6,
  fontSize: 13,
  color: "var(--text-secondary)",
};
const ledgerTh = {
  padding: "8px 9px",
  textAlign: "left",
  color: "var(--text-secondary)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".02em",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.16))",
};
const ledgerTd = {
  padding: "10px 9px",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.1))",
  fontSize: 13,
  verticalAlign: "top",
};
const miniButton = {
  border: "1px solid var(--border-color, rgba(148,163,184,.25))",
  borderRadius: 7,
  padding: "6px 9px",
  marginRight: 6,
  background: "transparent",
  color: "var(--text-primary)",
};
const badge = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid var(--border-color, rgba(148,163,184,.22))",
  borderRadius: 999,
  padding: "2px 8px",
  fontSize: 11,
  marginRight: 6,
  marginTop: 6,
};

function LedgerField({
  title,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  min,
}) {
  return (
    <label style={label}>
      {title}
      {required ? " *" : ""}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        min={min}
        style={input}
      />
    </label>
  );
}

export default function LedgerManager({
  brands,
  selectedSubBrandLabel,
  ledgerState,
  onViewLedger,
}) {
  const {
    ledgerRows,
    ledgerForm,
    showLedgerForm,
    updateLedgerForm,
    startNewLedger,
    editLedger,
    cancelLedger,
    saveLedger,
    deleteCustomLedger,
  } = ledgerState;

  return (
    <div style={{ ...card, padding: 14, marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <strong>Create and manage ledgers</strong>
          <small style={{ display: "block", color: "var(--text-secondary)" }}>
            Common ledgers are auto-created. Custom ledgers can be added and
            removed here.
          </small>
        </div>
        <TallyWriteGate><button
          type="button"
          onClick={startNewLedger}
          style={{
            border: "1px solid #5b7cfa",
            borderRadius: 8,
            padding: "8px 12px",
            background: "transparent",
            color: "var(--text-primary)",
            fontWeight: 700,
          }}
        >Create Ledger</button></TallyWriteGate>
      </div>
      {showLedgerForm && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
            marginBottom: 14,
            padding: 12,
            border: "1px solid var(--border-color, rgba(148,163,184,.18))",
            borderRadius: 10,
          }}
        >
          <LedgerField
            title="Ledger name"
            value={ledgerForm.name}
            onChange={(value) => updateLedgerForm("name", value)}
            placeholder="Sales Ledger"
            required
          />
          <label style={label}>
            Ledger type
            <select
              value={ledgerForm.type}
              onChange={(event) => updateLedgerForm("type", event.target.value)}
              style={input}
            >
              {ledgerTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Ledger group
            <select
              value={ledgerForm.group}
              onChange={(event) => updateLedgerForm("group", event.target.value)}
              style={input}
            >
              <option value="">Select group</option>
              {ledgerGroups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Ledger nature
            <select
              value={ledgerForm.nature}
              onChange={(event) =>
                updateLedgerForm("nature", event.target.value)
              }
              style={input}
            >
              {ledgerNatures.map((nature) => (
                <option key={nature} value={nature}>
                  {nature}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            GST applicability
            <select
              value={ledgerForm.gstApplicability}
              onChange={(event) =>
                updateLedgerForm("gstApplicability", event.target.value)
              }
              style={input}
            >
              {gstApplicabilityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <LedgerField
            title="Opening balance"
            type="number"
            min="0"
            value={ledgerForm.openingBalance}
            onChange={(value) => updateLedgerForm("openingBalance", value)}
            placeholder="0"
          />
          <label style={label}>
            Balance type
            <select value={ledgerForm.openingBalanceType} onChange={(event) => updateLedgerForm("openingBalanceType", event.target.value)} style={input}>
              <option value="DEBIT">Debit</option>
              <option value="CREDIT">Credit</option>
            </select>
          </label>
          <label style={label}>
            TDS applicability
            <select value={ledgerForm.tdsApplicable ? "yes" : "no"} onChange={(event) => updateLedgerForm("tdsApplicable", event.target.value === "yes")} style={input}>
              <option value="no">Not applicable</option>
              <option value="yes">Applicable</option>
            </select>
          </label>
          <LedgerField title="Effective from" type="date" value={ledgerForm.effectiveFrom} onChange={(value) => updateLedgerForm("effectiveFrom", value)} />
          <label style={label}>
            Bill-wise tracking
            <select
              value={ledgerForm.billWise ? "yes" : "no"}
              onChange={(event) =>
                updateLedgerForm("billWise", event.target.value === "yes")
              }
              style={input}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </label>
          <label style={label}>
            Sub-brand
            <select
              value={ledgerForm.subBrand}
              onChange={(event) =>
                updateLedgerForm("subBrand", event.target.value)
              }
              style={input}
            >
              {brands.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
            <TallyWriteGate><button
              type="button"
              onClick={saveLedger}
              style={{
                border: 0,
                borderRadius: 8,
                padding: "10px 13px",
                background: "#5b7cfa",
                color: "white",
                fontWeight: 700,
              }}
            >Save Ledger</button></TallyWriteGate>
            <button
              type="button"
              onClick={cancelLedger}
              style={{
                border: "1px solid var(--border-color, rgba(148,163,184,.25))",
                borderRadius: 8,
                padding: "9px 12px",
                background: "transparent",
                color: "var(--text-primary)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={ledgerTh}>Ledger</th>
              <th style={ledgerTh}>Type</th>
              <th style={ledgerTh}>Group</th>
              <th style={ledgerTh}>Nature</th>
              <th style={ledgerTh}>GST</th>
              <th style={ledgerTh}>Bill-wise</th>
              <th style={ledgerTh}>Sub-brand</th>
              <th style={ledgerTh}>Balance</th>
              <th style={ledgerTh}>Action</th>
            </tr>
          </thead>
          <tbody>
            {ledgerRows.map((ledger) => (
              <tr key={ledger.id}>
                <td style={ledgerTd}>
                  <strong>{ledger.name}</strong>
                  <small
                    style={{
                      display: "block",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {ledger.source}
                  </small>
                  <div>
                    <span style={badge}>
                      {ledger.custom ? "Custom ledger" : "System ledger"}
                    </span>
                    <span style={badge}>
                      {ledger.billWise ? "Bill-wise" : "Non bill-wise"}
                    </span>
                  </div>
                </td>
                <td style={ledgerTd}>{ledger.type}</td>
                <td style={ledgerTd}>{ledger.group || "-"}</td>
                <td style={ledgerTd}>{ledger.nature || "-"}</td>
                <td style={ledgerTd}>
                  {gstApplicabilityOptions.find(
                    (option) => option.value === ledger.gstApplicability,
                  )?.label || "-"}
                </td>
                <td style={ledgerTd}>{ledger.billWise ? "Yes" : "No"}</td>
                <td style={ledgerTd}>
                  {brands.find(([value]) => value === ledger.subBrand)?.[1] ||
                    selectedSubBrandLabel}
                </td>
                <td style={ledgerTd}>{formatMoney(ledger.amount || 0)}</td>
                <td style={ledgerTd}>
                  <TallyWriteGate><button
                    type="button"
                    aria-label={`Edit ${ledger.name || "ledger"}`}
                    title="Edit"
                    onClick={() => editLedger(ledger)}
                    style={{ ...miniButton, padding: 7 }}
                  >
                    <Pencil size={15} />
                  </button></TallyWriteGate>
                  <button
                    type="button"
                    aria-label={`View ${ledger.name || "ledger"}`}
                    title="View"
                    onClick={() => onViewLedger?.(ledger)}
                    style={{ ...miniButton, padding: 7 }}
                  >
                    <Eye size={15} />
                  </button>
                  {ledger.custom && (
                    <TallyWriteGate><button
                      type="button"
                      onClick={() => deleteCustomLedger(ledger.id)}
                      style={{ ...miniButton, color: "#f87171" }}
                    >
                      Delete
                    </button></TallyWriteGate>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
