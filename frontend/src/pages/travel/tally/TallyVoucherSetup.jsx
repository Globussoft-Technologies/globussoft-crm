import {
  defaultVoucherTypes,
  voucherNumberingModes,
} from "./travelTallyVoucherConfig";
import { getVoucherNumberPreview } from "./tallyExportBuilder";

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
const th = {
  padding: "8px 9px",
  textAlign: "left",
  color: "var(--text-secondary)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".02em",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.16))",
};
const td = {
  padding: "10px 9px",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.1))",
  fontSize: 13,
  verticalAlign: "top",
};
const statusPill = (status) => ({
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 700,
  border:
    status === "Ready"
      ? "1px solid rgba(16, 185, 129, .35)"
      : status === "Partial"
        ? "1px solid rgba(245, 158, 11, .35)"
        : "1px solid rgba(239, 68, 68, .35)",
  color:
    status === "Ready"
      ? "#10b981"
      : status === "Partial"
        ? "#f59e0b"
        : "#ef4444",
  background:
    status === "Ready"
      ? "rgba(16, 185, 129, .08)"
      : status === "Partial"
        ? "rgba(245, 158, 11, .08)"
        : "rgba(239, 68, 68, .08)",
});
const voucherLedgerDependencies = {
  sales: ["travelInvoice"],
  purchase: ["supplierPayable"],
  receipt: ["customerPayment", "cashEntry"],
  payment: ["officeExpense", "cashEntry"],
  taxJournal: ["outputGst", "tcsCollected"],
  journal: ["roundOff"],
};
const voucherUsageHints = {
  sales: "Customer billing entry",
  purchase: "Supplier cost booking",
  receipt: "Customer money receipt",
  payment: "Cash or bank payment",
  taxJournal: "GST or TCS adjustment",
  journal: "Round off or manual adjustment",
};

export default function TallyVoucherSetup({
  voucherTypes,
  updateVoucherType,
  ledgerMappings = [],
  ledgerRows = [],
  master = {},
  selectedSubBrandLabel = "All sub-brands",
}) {
  const mappingById = Object.fromEntries(
    ledgerMappings.map((mapping) => [mapping.id, mapping]),
  );
  const ledgerNameById = Object.fromEntries(
    ledgerRows.map((ledger) => [ledger.id, ledger.name]),
  );
  const voucherStatuses = voucherTypes.map((voucher) => {
    const dependentMappings =
      voucherLedgerDependencies[voucher.id]?.map((mappingId) => {
        const mapping = mappingById[mappingId];
        const ledgerName = ledgerNameById[mapping?.ledgerId];
        return {
          id: mappingId,
          label: mapping?.label || mappingId,
          ledgerName: ledgerName || "Not mapped",
          ready: Boolean(mapping?.ledgerId && ledgerName),
        };
      }) || [];
    const readyCount = dependentMappings.filter((item) => item.ready).length;
    const status =
      dependentMappings.length === 0 || readyCount === dependentMappings.length
        ? "Ready"
        : readyCount > 0
          ? "Partial"
          : "Missing";

    return {
      voucherId: voucher.id,
      dependentMappings,
      status,
    };
  });
  const statusSummary = voucherStatuses.reduce(
    (summary, item) => ({
      ...summary,
      [item.status]: (summary[item.status] || 0) + 1,
    }),
    { Ready: 0, Partial: 0, Missing: 0 },
  );
  const voucherContext = [
    {
      id: "company",
      title: "Company",
      value: master.companyName || "Not selected",
    },
    {
      id: "scope",
      title: "Scope",
      value: selectedSubBrandLabel || "All sub-brands",
    },
    {
      id: "dates",
      title: "Voucher period",
      value:
        master.from && master.to
          ? `${master.from} to ${master.to}`
          : "Date range not set",
    },
    {
      id: "year",
      title: "Financial year",
      value: master.financialYear || "Not set",
    },
  ];

  return (
    <div style={{ ...card, padding: 14, marginBottom: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <strong>Voucher master setup</strong>
        <small style={{ display: "block", color: "var(--text-secondary)" }}>
          Set the base voucher types that later accounting entries will follow.
        </small>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
          marginBottom: 12,
        }}
      >
        {voucherContext.map((item) => (
          <div
            key={item.id}
            style={{
              ...card,
              padding: 10,
              borderRadius: 10,
            }}
          >
            <small
              style={{
                display: "block",
                color: "var(--text-secondary)",
                marginBottom: 4,
              }}
            >
              {item.title}
            </small>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        {Object.entries(statusSummary).map(([status, count]) => (
          <span key={status} style={statusPill(status)}>
            {status}: {count}
          </span>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Voucher</th>
              <th style={th}>Status</th>
              <th style={th}>Prefix</th>
              <th style={th}>Numbering</th>
              <th style={th}>Preview</th>
              <th style={th}>Ledger hint</th>
              <th style={th}>Counterparty</th>
              <th style={th}>Narration</th>
              <th style={th}>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {voucherTypes.map((voucher) => {
              const voucherStatus = voucherStatuses.find(
                (item) => item.voucherId === voucher.id,
              );
              const dependentMappings = voucherStatus?.dependentMappings || [];

              return (
                <tr key={voucher.id}>
                  <td style={td}>
                    <strong>{voucher.label}</strong>
                    <small
                      style={{ display: "block", color: "var(--text-secondary)" }}
                    >
                      {voucherUsageHints[voucher.id] || "General voucher flow"}
                    </small>
                    <small
                      style={{
                        display: "block",
                        color: "var(--text-secondary)",
                        marginTop: 4,
                      }}
                    >
                      {defaultVoucherTypes.find((row) => row.id === voucher.id)
                        ?.narrationTemplate || ""}
                    </small>
                  </td>
                  <td style={td}>
                    <span style={statusPill(voucherStatus?.status || "Missing")}>
                      {voucherStatus?.status || "Missing"}
                    </span>
                  </td>
                  <td style={td}>
                    <label style={label}>
                      <input
                        type="text"
                        value={voucher.prefix}
                        onChange={(event) =>
                          updateVoucherType(
                            voucher.id,
                            "prefix",
                            event.target.value.toUpperCase(),
                          )
                        }
                        maxLength={8}
                        style={input}
                      />
                    </label>
                  </td>
                  <td style={td}>
                    <label style={label}>
                      <select
                        value={voucher.numberingMode}
                        onChange={(event) =>
                          updateVoucherType(
                            voucher.id,
                            "numberingMode",
                            event.target.value,
                          )
                        }
                        style={input}
                      >
                        {voucherNumberingModes.map((mode) => (
                          <option key={mode.value} value={mode.value}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </td>
                  <td style={td}>
                    <strong>{getVoucherNumberPreview(voucher)}</strong>
                    <small
                      style={{ display: "block", color: "var(--text-secondary)" }}
                    >
                      Pattern used during export
                    </small>
                  </td>
                  <td style={td}>
                    {dependentMappings.length ? (
                      dependentMappings.map((item) => (
                        <div key={item.id} style={{ marginBottom: 6 }}>
                          <strong style={{ display: "block" }}>{item.label}</strong>
                          <small
                            style={{
                              color: item.ready
                                ? "var(--text-secondary)"
                                : "#f59e0b",
                            }}
                          >
                            {item.ledgerName}
                          </small>
                        </div>
                      ))
                    ) : (
                      <small style={{ color: "var(--text-secondary)" }}>
                        No mapping needed
                      </small>
                    )}
                  </td>
                  <td style={td}>
                    <label style={label}>
                      <input
                        type="text"
                        value={voucher.counterpartyLabel}
                        onChange={(event) =>
                          updateVoucherType(
                            voucher.id,
                            "counterpartyLabel",
                            event.target.value,
                          )
                        }
                        style={input}
                      />
                    </label>
                  </td>
                  <td style={td}>
                    <label style={label}>
                      <input
                        type="text"
                        value={voucher.narrationTemplate}
                        onChange={(event) =>
                          updateVoucherType(
                            voucher.id,
                            "narrationTemplate",
                            event.target.value,
                          )
                        }
                        style={input}
                      />
                    </label>
                  </td>
                  <td style={td}>
                    <label
                      style={{
                        ...label,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={voucher.enabled}
                        onChange={(event) =>
                          updateVoucherType(
                            voucher.id,
                            "enabled",
                            event.target.checked,
                          )
                        }
                      />
                      Active
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
