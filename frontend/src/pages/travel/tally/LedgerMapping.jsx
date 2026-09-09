import { TallyWriteGate } from "./TallySectionNav";

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

const th = {
  padding: "8px 9px",
  textAlign: "left",
  color: "var(--text-secondary)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".02em",
  borderBottom:
    "1px solid var(--border-color, rgba(148,163,184,.16))",
};

const td = {
  padding: "10px 9px",
  borderBottom:
    "1px solid var(--border-color, rgba(148,163,184,.1))",
  fontSize: 13,
  verticalAlign: "top",
};

/**
 * Find the ledger that a transaction belongs to.
 *
 * Priority:
 * 1. Transaction Type + Category
 * 2. Transaction Type default
 * 3. No ledger
 */
export function findLedgerForTransaction(
  transaction,
  mappings = []
) {
  if (!transaction) {
    return null;
  }

  const transactionType =
    transaction.transactionType ||
    transaction.type ||
    "";

  const category =
    transaction.category ||
    transaction.categoryName ||
    transaction.subType ||
    transaction.subTypeName ||
    "";

  /*
   * First look for an exact mapping.
   *
   * Example:
   * Office Expense
   * Software/Tech Expenses
   *        ↓
   * Subscription Ledger
   */
  const exactMatch = mappings.find((mapping) => {
    const mappingType =
      mapping.transactionType ||
      mapping.type ||
      mapping.label ||
      "";

    const mappingCategory =
      mapping.category ||
      mapping.categoryName ||
      mapping.subType ||
      mapping.subTypeName ||
      "";

    return (
      mappingType === transactionType &&
      mappingCategory === category &&
      mapping.ledgerId
    );
  });

  if (exactMatch) {
    return exactMatch.ledgerId;
  }

  /*
   * If there is no category-specific mapping,
   * use the default mapping for that transaction type.
   *
   * Example:
   * Travel Invoice
   *        ↓
   * Sales Ledger
   */
  const defaultMatch = mappings.find((mapping) => {
    const mappingType =
      mapping.transactionType ||
      mapping.type ||
      mapping.label ||
      "";

    const mappingCategory =
      mapping.category ||
      mapping.categoryName ||
      mapping.subType ||
      mapping.subTypeName ||
      "";

    return (
      mappingType === transactionType &&
      !mappingCategory &&
      mapping.ledgerId
    );
  });

  return defaultMatch?.ledgerId || null;
}

/**
 * Assign the correct ledger to a transaction.
 *
 * Call this before saving a new transaction.
 */
export function assignLedgerToTransaction(
  transaction,
  mappings
) {
  const ledgerId = findLedgerForTransaction(
    transaction,
    mappings
  );

  return {
    ...transaction,
    ledgerId,
  };
}

/**
 * Get only transactions belonging to a ledger.
 */
export function getTransactionsForLedger(
  transactions = [],
  selectedLedgerId
) {
  if (!selectedLedgerId) {
    return [];
  }

  return transactions.filter(
    (transaction) =>
      transaction.ledgerId === selectedLedgerId
  );
}

export default function LedgerMapping({
  ledgerRows = [],
  mappings = [],
  onChange,
  onReset,
}) {
  return (
    <div
      style={{
        ...card,
        padding: 14,
        marginBottom: 16,
      }}
    >
      {/* HEADER */}
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
          <strong>Ledger mapping</strong>

          <small
            style={{
              display: "block",
              color: "var(--text-secondary)",
              marginTop: 3,
            }}
          >
            Decide which ledger each transaction type
            and category should use.
          </small>
        </div>

        <TallyWriteGate><button
          type="button"
          onClick={onReset}
          style={{
            border:
              "1px solid var(--border-color, rgba(148,163,184,.25))",
            borderRadius: 8,
            padding: "8px 12px",
            background: "transparent",
            color: "var(--text-primary)",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >Reset Mapping</button></TallyWriteGate>
      </div>

      {/* TABLE */}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
          }}
        >
          <thead>
            <tr>
              <th style={th}>
                Transaction Type
              </th>

              <th style={th}>
                Category / Sub-type
              </th>

              <th style={th}>
                Use Ledger
              </th>
            </tr>
          </thead>

          <tbody>
            {mappings.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  style={{
                    ...td,
                    textAlign: "center",
                    color: "var(--text-secondary)",
                    padding: 20,
                  }}
                >
                  No ledger mappings available.
                </td>
              </tr>
            ) : (
              mappings.map((mapping) => {
                const transactionType =
                  mapping.transactionType ||
                  mapping.type ||
                  mapping.label ||
                  "";

                const category =
                  mapping.category ||
                  mapping.categoryName ||
                  mapping.subType ||
                  mapping.subTypeName ||
                  "";

                return (
                  <tr key={mapping.id}>
                    {/* TRANSACTION TYPE */}
                    <td style={td}>
                      <strong>
                        {transactionType}
                      </strong>

                      {mapping.description && (
                        <small
                          style={{
                            display: "block",
                            color:
                              "var(--text-secondary)",
                            marginTop: 3,
                          }}
                        >
                          {mapping.description}
                        </small>
                      )}
                    </td>

                    {/* CATEGORY */}
                    <td style={td}>
                      {category ? (
                        <span>{category}</span>
                      ) : (
                        <span
                          style={{
                            color:
                              "var(--text-secondary)",
                          }}
                        >
                          All / Default
                        </span>
                      )}
                    </td>

                    {/* LEDGER */}
                    <td style={td}>
                      <select
                        value={
                          mapping.ledgerId || ""
                        }
                        onChange={(event) =>
                          onChange(
                            mapping.id,
                            event.target.value
                          )
                        }
                        style={input}
                      >
                        <option value="">
                          Select ledger
                        </option>

                        {ledgerRows.map(
                          (ledger) => (
                            <option
                              key={ledger.id}
                              value={ledger.id}
                            >
                              {ledger.name}
                            </option>
                          )
                        )}
                      </select>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
