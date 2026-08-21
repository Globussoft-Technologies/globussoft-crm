// Travel CRM — frontend payment reconciliation queue.
//
// This component uploads bank statements to the reconciliation API, displays
// editable credited/debited rows per file, and asks the user for confirmation
// before adding amounts to the in-memory Tally report. It supports multiple
// statements and keeps pending files separate from already-applied files.

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { formatMoney } from "../../utils/money";
import { useNotify } from "../../utils/notify";

const box = {
  border: "1px solid var(--border-color, rgba(148,163,184,.18))",
  borderRadius: 12,
  background: "rgba(255,255,255,.025)",
};

const button = {
  border: "1px solid #5b7cfa",
  borderRadius: 8,
  padding: "8px 11px",
  background: "transparent",
  color: "var(--text-primary)",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  fontWeight: 700,
};

const taxInput = {
  padding: "10px 11px",
  borderRadius: 8,
  border: "1px solid var(--border-color, #334155)",
  background: "var(--input-bg, transparent)",
  color: "var(--text-primary)",
  width: 86,
  marginLeft: "auto",
  display: "block",
  boxSizing: "border-box",
};
const getCustomerTripValue = (row) =>
  Number(row?.amount || 0);

// The parent owns ledger totals and report data; this component only manages
// the statement-review UI and sends confirmed changes through callbacks.
export default function ReconciliationQueue({
  accounts = [],
  customers = [],
  suppliers = [],
  onLedgerApplied,
}) {
  const notify = useNotify();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [statement, setStatement] = useState(null);
  const [statementError, setStatementError] = useState("");
  const [previousTotals, setPreviousTotals] = useState(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = ".travel-reconciliation table { table-layout: fixed; }";
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // Calculate aggregate credit and debit totals for the statement summary.
  const totalsFromItems = (items = []) => ({
    creditedTotal: items
      .filter((item) => item.direction !== "DEBIT")
      .reduce((sum, item) => sum + Number(item.amount || 0), 0),
    withdrawnTotal: items
      .filter((item) => item.direction === "DEBIT")
      .reduce((sum, item) => sum + Number(item.amount || 0), 0),
  });

  // Keep both the aggregate list and its source file in sync when a reviewer
  // edits a description, reference, date, or amount.
  const updateStatementItem = (id, key, value) => {
    setStatement((current) => {
      if (!current) return current;
      const items = (current.items || []).map((item) =>
        item.id === id
          ? {
              ...item,
              [key]: key === "amount" ? value.replace(/[^\d.]/g, "") : value,
            }
          : item,
      );
      const files = (current.files || []).map((file) => ({
        ...file,
        items: (file.items || []).map((item) =>
          item.id === id
            ? {
                ...item,
                [key]: key === "amount" ? value.replace(/[^\d.]/g, "") : value,
              }
            : item,
        ),
      }));
      return { ...current, files, items, ...totalsFromItems(items) };
    });
  };

  // Remove one reviewed row without affecting the backend or parent report
  // until the file is confirmed.
  const removeStatementItem = (id) => {
    setStatement((current) => {
      if (!current) return current;
      const items = (current.items || []).filter((item) => item.id !== id);
      const files = (current.files || []).map((file) => ({
        ...file,
        items: (file.items || []).filter((item) => item.id !== id),
        transactionCount: (file.items || []).filter((item) => item.id !== id)
          .length,
      }));
      return {
        ...current,
        files,
        items,
        transactionCount: items.length,
        ...totalsFromItems(items),
      };
    });
  };

  // Confirm one uploaded statement and hand its rows to the parent ledger.
  // Existing backend totals are displayed in the confirmation message; no
  // reconciliation record is persisted here.
  const askToAddTotals = async (result, existingStatement = null) => {
    const currentSales = Number(
      accounts.find((account) => account.id === "sales")?.amount || 0,
    );
    const currentPurchase = Number(
      accounts.find((account) => account.id === "purchase")?.amount || 0,
    );
    const items = result.items || [];
    const { creditedTotal, withdrawnTotal } = totalsFromItems(items);
    const nextSales = currentSales + creditedTotal;
    const nextPurchase = currentPurchase + withdrawnTotal;

    const approved = await notify.confirm({
      title: "Add statement amounts to the calculation?",
      message: `Credited ${formatMoney(creditedTotal)} will be added to Customer A/c and Sales A/c (${formatMoney(currentSales)} + ${formatMoney(creditedTotal)} = ${formatMoney(nextSales)}). Debited/withdrawn ${formatMoney(withdrawnTotal)} will be added to Supplier A/c and Purchase A/c (${formatMoney(currentPurchase)} + ${formatMoney(withdrawnTotal)} = ${formatMoney(nextPurchase)}).`,
      confirmText: "Yes, add amounts",
      cancelText: "No, keep current totals",
    });

    if (!approved) {
      if (!existingStatement) {
        onLedgerApplied?.({ statementItems: [] });
        setStatement(null);
        setPreviousTotals(null);
      }
      return false;
    }
    if (!previousTotals) {
      setPreviousTotals({ sales: currentSales, purchase: currentPurchase });
    }
    const customerDetails = items
      .filter((item) => item.direction !== "DEBIT")
      .map((item, index) => ({
        statementItemId: item.id,
        reference: item.sourceRef || `STATEMENT-CREDIT-${index + 1}`,
        name: item.description || "Statement credit",
        email: `${result.fileName || result.extraction || "Statement"} - ${item.transactionDate ? new Date(item.transactionDate).toLocaleDateString() : "Date unavailable"}`,
        amount: Number(item.amount || 0),
        currency: item.currency || "INR",
      }));
    const supplierDetails = items
      .filter((item) => item.direction === "DEBIT")
      .map((item, index) => ({
        statementItemId: item.id,
        reference: item.sourceRef || `STATEMENT-DEBIT-${index + 1}`,
        name: item.description || "Statement debit",
        category: `${result.fileName || "Statement"} - Bank statement debit`,
        amount: Number(item.amount || 0),
        currency: item.currency || "INR",
      }));
    const reportItems = [...(existingStatement?.items || []), ...items];
    onLedgerApplied?.({
      creditedTotal,
      withdrawnTotal,
      sales: nextSales,
      purchase: nextPurchase,
      customerDetails: [...customers, ...customerDetails],
      supplierDetails: [...suppliers, ...supplierDetails],
      statementItems: reportItems,
    });
    notify.success("Statement amounts added to the current report calculation");
    return true;
  };

  // Apply a single pending file. This is intentionally per-file so every
  // uploaded statement receives its own confirmation step.
  const addUploadedStatement = async (fileId) => {
    if (!statement) return;
    const targetFile = (statement.files || []).find(
      (file) => file.id === fileId,
    );
    if (!targetFile || targetFile.applied) return;
    const appliedItems = (statement.files || [])
      .filter((file) => file.applied)
      .flatMap((file) => file.items || []);
    const result = {
      ...statement,
      fileName: targetFile.fileName,
      extraction: targetFile.extraction,
      items: targetFile.items || [],
    };
    const existingStatement = { ...statement, items: appliedItems };
    const approved = await askToAddTotals(
      result,
      appliedItems.length ? existingStatement : null,
    );
    if (approved) {
      setStatement((current) =>
        current
          ? {
              ...current,
              files: (current.files || []).map((file) =>
                file.id === fileId ? { ...file, applied: true } : file,
              ),
            }
          : current,
      );
    }
  };

  // Remove one statement and, only when it was applied, subtract its rows
  // from the parent ledger and report transaction list.
  const removeUploadedStatement = (fileId) => {
    if (!statement) return;
    const removedFile = (statement.files || []).find(
      (file) => file.id === fileId,
    );
    if (!removedFile) return;
    const removedItems = removedFile.items || [];
    const remainingFiles = (statement.files || []).filter(
      (file) => file.id !== fileId,
    );
    const remainingItems = (statement.items || []).filter(
      (item) => item.statementFileId !== fileId,
    );
    const removedTotals = totalsFromItems(removedItems);

    if (previousTotals && removedFile.applied) {
      const currentSales = Number(
        accounts.find((account) => account.id === "sales")?.amount || 0,
      );
      const currentPurchase = Number(
        accounts.find((account) => account.id === "purchase")?.amount || 0,
      );
      const removedIds = new Set(removedItems.map((item) => item.id));
      const remainingAppliedItems = remainingFiles
        .filter((file) => file.applied)
        .flatMap((file) => file.items || []);
      onLedgerApplied?.({
        creditedTotal: remainingAppliedItems
          .filter((item) => item.direction !== "DEBIT")
          .reduce((sum, item) => sum + Number(item.amount || 0), 0),
        withdrawnTotal: remainingAppliedItems
          .filter((item) => item.direction === "DEBIT")
          .reduce((sum, item) => sum + Number(item.amount || 0), 0),
        sales: currentSales - removedTotals.creditedTotal,
        purchase: currentPurchase - removedTotals.withdrawnTotal,
        customerDetails: customers.filter(
          (row) => !removedIds.has(row.statementItemId),
        ),
        supplierDetails: suppliers.filter(
          (row) => !removedIds.has(row.statementItemId),
        ),
        statementItems: remainingAppliedItems,
      });
    }

    if (!remainingFiles.length) {
      setStatement(null);
      setPreviousTotals(null);
    } else {
      const totals = totalsFromItems(remainingItems);
      setStatement({
        files: remainingFiles,
        fileName: remainingFiles.map((file) => file.fileName).join(", "),
        extraction: remainingFiles
          .map((file) => file.extraction)
          .filter(Boolean)
          .join(", "),
        transactionCount: remainingItems.length,
        ...totals,
        items: remainingItems,
      });
      if (!remainingFiles.some((file) => file.applied)) {
        setPreviousTotals(null);
      }
    }
    notify.success("The statement was removed from the report");
  };

  // Upload one supported statement file and append it as a pending file.
  // Parsing and OCR are performed by the backend reconciliation endpoint.
  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const body = new FormData();
    body.append("statement", file);
    setStatementError("");
    setBusy(true);
    try {
      const result = await fetchApi(
        "/api/travel/tally/reconciliation/statements",
        {
          method: "POST",
          body,
        },
      );
      const uploadId = Date.now();
      const parsedItems = (result.items || []).map((item, index) => ({
        ...item,
        id: `statement-${uploadId}-${index}`,
        statementFileId: uploadId,
      }));
      const existingStatement = statement;
      const files = [
        ...(existingStatement?.files || []),
        {
          id: uploadId,
          fileName: file.name,
          extraction: result.extraction,
          transactionCount: parsedItems.length || Number(result.imported || 0),
          items: parsedItems,
          applied: false,
        },
      ];
      const items = [...(existingStatement?.items || []), ...parsedItems];
      const totals = totalsFromItems(items);
      const combinedStatement = {
        files,
        fileName: files.map((entry) => entry.fileName).join(", "),
        extraction: files
          .map((entry) => entry.extraction)
          .filter(Boolean)
          .join(", "),
        transactionCount: items.length,
        creditedTotal: totals.creditedTotal,
        withdrawnTotal: totals.withdrawnTotal,
        items,
      };
      setStatement(combinedStatement);
    } catch (error) {
      setStatementError(
        error?.data?.error ||
          "Statement processing failed. Please check the document and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="travel-reconciliation"
      style={{ ...box, marginTop: 16, padding: 14 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <strong>Bank statement</strong>
          <small
            style={{
              display: "block",
              color: "var(--text-secondary)",
              marginTop: 3,
            }}
          >
            Upload a statement to separate credited and debited/withdrawal
            amounts.
          </small>
        </div>
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            style={button}
          >
            <Upload size={15} />{" "}
            {busy ? "Reading statement…" : "Upload statement"}
          </button>
          <input
            ref={fileRef}
            hidden
            type="file"
            accept=".pdf,.csv,.xlsx,.xls,image/*"
            onChange={upload}
          />
        </div>
      </div>

      <small
        role={statementError ? "alert" : undefined}
        style={{
          display: "block",
          marginTop: 10,
          color: statementError ? "#f87171" : "var(--text-secondary)",
          fontWeight: statementError ? 700 : 400,
        }}
      >
        <strong>Note:</strong> Password-protected documents cannot be read or
        processed. Please remove the password protection before uploading the
        document.
      </small>

      {statement && (
        <div style={{ marginTop: 14 }}>
          <div style={{ marginBottom: 9 }}>
            <small
              style={{
                display: "block",
                color: "var(--text-secondary)",
                marginBottom: 7,
              }}
            >
              {statement.files?.length > 1
                ? `${statement.files.length} statements uploaded`
                : statement.fileName}{" "}
              · {statement.transactionCount} transactions read
            </small>
            <div style={{ display: "grid", gap: 6 }}>
              {(statement.files || []).map((file) => (
                <div
                  key={file.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 8px",
                    border:
                      "1px solid var(--border-color, rgba(148,163,184,.18))",
                    borderRadius: 7,
                  }}
                >
                  <small style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    {file.fileName} · {file.transactionCount} transactions
                  </small>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeUploadedStatement(file.id)}
                    style={{
                      border: 0,
                      background: "transparent",
                      color: "#f87171",
                      padding: "3px 4px",
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Remove statement
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 10,
            }}
          >
            <div style={{ ...box, padding: 12 }}>
              <small style={{ color: "var(--text-secondary)" }}>
                Credited → Sales A/c
              </small>
              <strong
                style={{ display: "block", color: "#34d399", marginTop: 4 }}
              >
                {formatMoney(statement.creditedTotal)}
              </strong>
            </div>
            <div style={{ ...box, padding: 12 }}>
              <small style={{ color: "var(--text-secondary)" }}>
                Debited / withdrawal → Purchase A/c
              </small>
              <strong
                style={{ display: "block", color: "#fbbf24", marginTop: 4 }}
              >
                {formatMoney(statement.withdrawnTotal)}
              </strong>
            </div>
          </div>
          {(statement.files || []).map((file) => {
            const creditItems = (file.items || []).filter(
              (item) => item.direction !== "DEBIT",
            );
            const debitItems = (file.items || []).filter(
              (item) => item.direction === "DEBIT",
            );
            return (
              <div
                key={`review-${file.id}`}
                style={{ ...box, padding: 12, marginTop: 12 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    {file.fileName}
                  </strong>
                  <small
                    style={{
                      color: file.applied ? "#34d399" : "var(--text-secondary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {file.applied ? "Added to report" : "Awaiting confirmation"}
                  </small>
                </div>
                {!file.applied && (
                  <>
                    <StatementReview
                      title="Customer A/c"
                      description="Credited rows read from this statement."
                      rows={creditItems}
                      onChange={updateStatementItem}
                      onRemove={removeStatementItem}
                    />
                    <StatementReview
                      title="Supplier A/c"
                      description="Debited/withdrawal rows read from this statement."
                      rows={debitItems}
                      onChange={updateStatementItem}
                      onRemove={removeStatementItem}
                    />
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        marginTop: 12,
                      }}
                    >
                      <button
                        type="button"
                        disabled={busy || !(file.items || []).length}
                        onClick={() => addUploadedStatement(file.id)}
                        style={{
                          ...button,
                          background: "#5b7cfa",
                          color: "white",
                        }}
                      >
                        Add statement amounts
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Editable per-trip GST/TCS inputs used before statement reconciliation.
export function TripTaxTable({
  trips,
  customers,
  suppliers,
  tripTaxes,
  selectedTripId = "",
  onChange,
}) {
  if (!trips.length) return null;
  const displayedTrips = selectedTripId
    ? trips
    : trips.filter((trip) => {
        const id = String(trip.id);
        const earnings = customers
          .filter((row) => String(row.itineraryId) === id)
          .reduce((sum, row) => sum + getCustomerTripValue(row), 0);
        const spent = suppliers
          .filter((row) => String(row.itineraryId) === id)
          .reduce((sum, row) => sum + Number(row.amount || 0), 0);
        return earnings > 0 || spent > 0;
      });
  if (!displayedTrips.length) return null;
  return (
    <div style={{ ...box, padding: 12, marginTop: 14 }}>
      <strong>Trip totals and taxes</strong>
      <small
        style={{
          display: "block",
          color: "var(--text-secondary)",
          marginTop: 3,
        }}
      >
        Enter GST and TCS percentages. Tax amounts are calculated from trip
        earnings.
      </small>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table
          style={{
            width: "100%",
            minWidth: 900,
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead>
            <tr>
              {[
                "Trip / Place",
                "Earnings",
                "Spent",
                "GST %",
                "GST Amount",
                "TCS %",
                "TCS Amount",
              ].map((label) => (
                <th
                  key={label}
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    background: "var(--modal-bg, #ffffff)",
                    textAlign: label === "Trip / Place" ? "left" : "right",
                    padding: "8px",
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    borderBottom:
                      "1px solid var(--border-color, rgba(148,163,184,.2))",
                  }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedTrips.map((trip) => {
              const id = String(trip.id);
              const earnings = customers
                .filter((row) => String(row.itineraryId) === id)
                .reduce((sum, row) => sum + getCustomerTripValue(row), 0);
              const spent = suppliers
                .filter((row) => String(row.itineraryId) === id)
                .reduce((sum, row) => sum + Number(row.amount || 0), 0);
              const international = Boolean(
                trip.international ||
                  trip.isInternational ||
                  customers.some(
                    (row) => String(row.itineraryId) === id && row.international,
                  ),
              );
              const tax = tripTaxes[id] || {};
              const gstRate = Number(tax.gstRate || 0);
              const tcsRate = Number(tax.tcsRate || 0);
              return (
                <tr key={id}>
                  <td style={{ padding: "9px 8px", fontWeight: 700 }}>
                    {trip.destination || `Trip ${id}`}
                  </td>
                  <td style={{ padding: "9px 8px", textAlign: "right" }}>
                    {formatMoney(earnings)}
                  </td>
                  <td style={{ padding: "9px 8px", textAlign: "right" }}>
                    {formatMoney(spent)}
                  </td>
                  <td style={{ padding: "9px 8px" }}>
                    <input
                      aria-label={`GST percentage for ${trip.destination || id}`}
                      value={tax.gstRate ?? ""}
                      onChange={(event) =>
                        onChange?.(id, "gstRate", event.target.value)
                      }
                      inputMode="decimal"
                      placeholder="%"
                      style={{
                        ...taxInput,
                        width: 64,
                        padding: "7px 6px",
                        textAlign: "right",
                      }}
                    />
                  </td>
                  <td style={{ padding: "9px 8px", textAlign: "right" }}>
                    {formatMoney((earnings * gstRate) / 100)}
                  </td>
                  <td style={{ padding: "9px 8px" }}>
                    {international ? (
                      <input
                        aria-label={`TCS percentage for ${trip.destination || id}`}
                        value={tax.tcsRate ?? ""}
                        onChange={(event) =>
                          onChange?.(id, "tcsRate", event.target.value)
                        }
                        inputMode="decimal"
                        placeholder="%"
                        style={{
                          ...taxInput,
                          width: 64,
                          padding: "7px 6px",
                          textAlign: "right",
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          display: "block",
                          textAlign: "right",
                          color: "var(--text-secondary)",
                        }}
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "9px 8px", textAlign: "right" }}>
                    {international
                      ? formatMoney((earnings * tcsRate) / 100)
                      : "—"}
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

// Reusable review table for one statement's credited or debited rows.
function StatementReview({ title, description, rows, onChange, onRemove }) {
  return (
    <div style={{ ...box, padding: 12, marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div>
          <strong>{title}</strong>
          <small
            style={{
              display: "block",
              color: "var(--text-secondary)",
              marginTop: 3,
            }}
          >
            {description}
          </small>
        </div>
        <small style={{ color: "var(--text-secondary)" }}>
          {rows.length} rows
        </small>
      </div>
      {rows.length ? (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((row) => (
            <div
              key={row.id}
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(190px, 1.4fr) minmax(140px, 1fr) minmax(120px, .7fr) minmax(120px, .7fr) auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <input
                aria-label={`${title} name`}
                value={row.description || ""}
                onChange={(event) =>
                  onChange(row.id, "description", event.target.value)
                }
                placeholder="Account / narration"
                style={reviewInput}
              />
              <input
                aria-label={`${title} reference`}
                value={row.sourceRef || ""}
                onChange={(event) =>
                  onChange(row.id, "sourceRef", event.target.value)
                }
                placeholder="Reference"
                style={reviewInput}
              />
              <input
                aria-label={`${title} date`}
                type="date"
                value={
                  row.transactionDate
                    ? String(row.transactionDate).slice(0, 10)
                    : ""
                }
                onChange={(event) =>
                  onChange(row.id, "transactionDate", event.target.value)
                }
                style={reviewInput}
              />
              <input
                aria-label={`${title} amount`}
                value={row.amount ?? ""}
                inputMode="decimal"
                onChange={(event) =>
                  onChange(row.id, "amount", event.target.value)
                }
                placeholder="Amount"
                style={{ ...reviewInput, textAlign: "right" }}
              />
              <button
                type="button"
                onClick={() => onRemove(row.id)}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "#f87171",
                  padding: "8px 4px",
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <small style={{ color: "var(--text-secondary)" }}>No rows found.</small>
      )}
    </div>
  );
}

const reviewInput = {
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid var(--border-color, #334155)",
  background: "var(--input-bg, rgba(15,23,42,.42))",
  color: "var(--text-primary)",
  width: "100%",
  boxSizing: "border-box",
};

