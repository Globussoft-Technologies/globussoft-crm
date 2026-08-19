// Travel CRM — Tally accounting wizard and report preview.
//
// The page coordinates three stages:
//   1. Master filters and company details.
//   2. Backend-filtered ledger accounts, trip taxes, and reconciliation.
//   3. Report preview with bank transactions, trip profit/loss, and totals.
//
// Ledger values are fetched from existing Travel CRM records. User edits and
// statement confirmations are kept in the wizard state and passed to the
// report preview; this page does not create accounting records directly.

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Download,
  FileBarChart,
  IndianRupee,
  Landmark,
  Settings2,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { formatMoney } from "../../utils/money";
import ReconciliationQueue, { TripTaxTable } from "./ReconciliationQueue";
import CompactRangeCalendar from "./CompactRangeCalendar";

const brands = [
  ["", "Select sub-brand"],
  ["tmc", "TMC (schools)"],
  ["rfu", "RFU (Umrah)"],
  ["travelstall", "Travel Stall"],
  ["visasure", "Visa Sure"],
];
const steps = [
  { title: "Master", description: "Account setup", icon: Settings2 },
  { title: "Ledger", description: "Ledger details", icon: Landmark },
  { title: "Reports", description: "View reports", icon: FileBarChart },
];
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
const isBankStatementRow = (row) =>
  String(row?.reference || "").startsWith("STATEMENT-DEBIT-") ||
  /bank statement debit/i.test(String(row?.category || ""));
const getCustomerTripValue = (row) =>
  Number(row?.amount || 0);
let activeTcsUpdater = null;
let activeGstUpdater = null;
let activeSupplierGstUpdater = null;

function Field({
  title,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  min,
  max,
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
        max={max}
        style={input}
      />
    </label>
  );
}

function DetailCard({
  title,
  description,
  rows,
  empty,
  customer,
  onTcsChange,
  onGstChange,
}) {
  const showGst = false;
  const showTcs = false;
  const columns =
    customer
      ? "minmax(0, 1fr) 96px 96px"
      : showGst && showTcs
        ? "minmax(0, 1fr) 96px 86px 86px"
        : showGst
          ? "minmax(0, 1fr) 96px 86px"
          : "minmax(0, 1fr) 96px";
  return (
    <div style={{ ...card, padding: 14 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: "0.98rem" }}>{title}</h3>
      <p
        style={{
          margin: "0 0 10px",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        {description}
      </p>
      <div
        style={{
          overflowX: "hidden",
          overflowY: "auto",
          maxHeight: 320,
          paddingRight: 2,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {rows.length ? (
            <>
              {
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    gap: 6,
                    padding: "0 0 6px",
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: ".02em",
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    background: "var(--modal-bg, #ffffff)",
                  }}
                >
                  <span>Contact</span>
                  <span>{customer ? "Received" : "Amount"}</span>
                  {customer && <span>Remaining</span>}
                  {showGst && <span>GST</span>}
                  {showTcs && <span>TCS</span>}
                </div>
              }
              {rows.map((row) => (
                <div
                  key={row.reference}
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    alignItems: "center",
                    gap: 6,
                    padding: "9px 0",
                    borderBottom:
                      "1px solid var(--border-color, rgba(148,163,184,.1))",
                    fontSize: 13,
                  }}
                >
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    <strong style={{ display: "block" }}>{row.name}</strong>
                    <small
                      style={{
                        color: "var(--text-secondary)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {row.reference}
                      {row.email ? ` - ${row.email}` : ""}
                      {row.category ? ` - ${row.category}` : ""}
                    </small>
                  </span>
                  <strong style={{ whiteSpace: "nowrap" }}>
                    {Number(row.amount || 0) !== 0
                      ? formatMoney(row.amount, {
                          currency: customer ? row.currency || "INR" : "INR",
                        })
                      : "-"}
                  </strong>
                  {customer && (
                    <strong style={{ whiteSpace: "nowrap", color: row.outstandingAmount > 0 ? "#f59e0b" : "#34d399" }}>
                      {Number(row.outstandingAmount || 0) !== 0
                        ? formatMoney(row.outstandingAmount, {
                            currency: row.currency || "INR",
                          })
                        : "-"}
                    </strong>
                  )}
                  {showGst && (
                    <input
                      aria-label={`GST for ${row.name}`}
                      type="text"
                      inputMode="decimal"
                      value={row.gstAmount ?? ""}
                      onChange={(event) =>
                        (
                          onGstChange ||
                          (customer
                            ? activeGstUpdater
                            : activeSupplierGstUpdater)
                        )?.(row.reference, event.target.value)
                      }
                      style={{
                        ...input,
                        width: "100%",
                        padding: "7px 6px",
                        textAlign: "right",
                      }}
                    />
                  )}
                  {showTcs &&
                    (row.international ? (
                      <input
                        aria-label={`TCS for ${row.name}`}
                        type="text"
                        inputMode="decimal"
                        value={row.tcsAmount ?? ""}
                        onChange={(event) =>
                          (onTcsChange || activeTcsUpdater)?.(
                            row.reference,
                            event.target.value,
                          )
                        }
                        style={{
                          ...input,
                          width: "100%",
                          padding: "7px 6px",
                          textAlign: "right",
                          color:
                            row.tcsAmount > 0
                              ? "#fbbf24"
                              : "var(--text-primary)",
                        }}
                      />
                    ) : (
                      <span />
                    ))}
                </div>
              ))}
            </>
          ) : (
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              {empty}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Tally() {
  // Wizard state is intentionally local so users can review and edit the
  // ledger before moving to the final report step.
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [master, setMaster] = useState({
    companyName: "",
    mailingName: "",
    gstin: "",
    pan: "",
    state: "",
    address: "",
    subBrand: "",
    tripId: "",
    from: "",
    to: "",
  });
  const [gst, setGst] = useState("");
  const [customFields, setCustomFields] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [trips, setTrips] = useState([]);
  const [tripTaxes, setTripTaxes] = useState({});
  const [statementItems, setStatementItems] = useState([]);
  const [tripSummary, setTripSummary] = useState(null);
  const requiresTcs = false;
  const [loading, setLoading] = useState(false);
  const loadedLedgerFilters = useRef("");

  // Update one Master field while preserving the rest of the filter state.
  const updateMaster = (key) => (value) =>
    setMaster((current) => ({
      ...current,
      [key]: value,
      ...(key === "from" ? { to: "" } : {}),
      ...(key === "subBrand" ? { tripId: "" } : {}),
    }));

  // Load available trips whenever the selected sub-brand changes.
  useEffect(() => {
    if (!master.subBrand) {
      setTrips([]);
      return undefined;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      fields: "summary",
      limit: "200",
      subBrand: master.subBrand,
    });
    if (master.from) params.set("from", master.from);
    if (master.to) params.set("to", master.to);
    fetchApi(`/api/travel/itineraries?${params}`)
      .then((data) => {
        if (!cancelled) setTrips(data?.itineraries || []);
      })
      .catch(() => {
        if (!cancelled) setTrips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [master.subBrand, master.from, master.to]);

  // Load backend ledger accounts and customer/supplier details for the
  // selected sub-brand, date range, and optional trip.
  useEffect(() => {
    setTripTaxes((current) => {
      const next = {};
      trips.forEach((trip) => {
        const id = String(trip.id);
        const existing = current[id] || {};
        const backendRows = customers.filter(
          (row) => String(row.itineraryId) === id,
        );
        const backendGstRate = backendRows.find(
          (row) => row.gstRate != null,
        )?.gstRate;
        const backendTcsRate = backendRows.find(
          (row) => row.tcsRate != null,
        )?.tcsRate;
        next[id] = {
          gstRate:
            existing.gstRate !== "" && existing.gstRate != null
              ? existing.gstRate
              : (backendGstRate ?? ""),
          tcsRate:
            existing.tcsRate !== "" && existing.tcsRate != null
              ? existing.tcsRate
              : (backendTcsRate ?? ""),
        };
      });
      return next;
    });
  }, [trips, customers]);

  // Seed editable trip-tax inputs from backend GST/TCS values without
  // overwriting values the user has already edited in this wizard.
  useEffect(() => {
    if (!master.subBrand) return;
    const filterKey = JSON.stringify({
      subBrand: master.subBrand,
      tripId: master.tripId,
      from: master.from,
      to: master.to,
    });
    if (loadedLedgerFilters.current === filterKey) return;
    loadedLedgerFilters.current = filterKey;
    let cancelled = false;
    const params = new URLSearchParams({ subBrand: master.subBrand });
    if (master.from) params.set("from", master.from);
    if (master.to) params.set("to", master.to);
    if (master.tripId) params.set("itineraryId", master.tripId);
    setLoading(true);
    fetchApi(`/api/travel/tally/ledger?${params}`)
      .then((data) => {
        if (!cancelled) {
          setAccounts(data?.accounts || []);
          setCustomers(data?.customerDetails || []);
          setSuppliers(data?.supplierDetails || []);
          setTripSummary(data?.trip || null);
          setGst("");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTripSummary(null);
          setError("Could not load filtered ledger details.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [master.subBrand, master.tripId, master.from, master.to]);

  // Save an edited ledger amount in local wizard state.
  const saveAmount = (id, value) => {
    if (id === "inputGst" && value === "") {
      if (id === "inputGst") setGst("");
      return;
    }
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return;
    if (id === "inputGst") setGst(amount);
    setAccounts((current) =>
      current.map((account) =>
        account.id === id ? { ...account, amount, edited: true } : account,
      ),
    );
  };

  // Allow report users to override backend customer-level TCS values.
  const updateCustomerTcs = (reference, value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return;
    setCustomers((current) =>
      current.map((customer) =>
        customer.reference === reference
          ? { ...customer, tcsAmount: amount, tcsEdited: true }
          : customer,
      ),
    );
  };
  // Allow report users to override backend customer-level GST values.
  const updateCustomerGst = (reference, value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return;
    setCustomers((current) =>
      current.map((customer) =>
        customer.reference === reference
          ? { ...customer, gstAmount: amount, gstEdited: true }
          : customer,
      ),
    );
  };
  // Allow report users to override supplier GST values used in reports.
  const updateSupplierGst = (reference, value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return;
    setSuppliers((current) =>
      current.map((supplier) =>
        supplier.reference === reference
          ? { ...supplier, gstAmount: amount, gstEdited: true }
          : supplier,
      ),
    );
  };
  // Update GST/TCS percentages for one selected trip.
  const updateTripTax = (tripId, key, value) =>
    setTripTaxes((current) => ({
      ...current,
      [String(tripId)]: {
        ...(current[String(tripId)] || {}),
        [key]:
          value === "" ? "" : Math.min(100, Math.max(0, Number(value) || 0)),
      },
    }));
  activeTcsUpdater = step === 1 ? updateCustomerTcs : null;
  activeGstUpdater = step === 1 ? updateCustomerGst : null;
  activeSupplierGstUpdater = step === 1 ? updateSupplierGst : null;

  const activeTripOptions = trips.filter((trip) => {
        const id = String(trip.id);
        const earnings = customers
          .filter((row) => String(row.itineraryId) === id)
          .reduce((sum, row) => sum + getCustomerTripValue(row), 0);
        const spent = suppliers
          .filter((row) => !isBankStatementRow(row))
          .filter((row) => String(row.itineraryId) === id)
          .reduce((sum, row) => sum + Number(row.amount || 0), 0);
        return earnings > 0 || spent > 0;
      });
  const visibleTrips = master.tripId
    ? trips.filter((trip) => String(trip.id) === String(master.tripId))
    : activeTripOptions;
  const visibleTripIds = new Set(visibleTrips.map((trip) => String(trip.id)));
  const visibleCustomers = customers.filter((row) =>
    !row.itineraryId || visibleTripIds.has(String(row.itineraryId)),
  );
  const visibleSuppliers = suppliers.filter(
    (row) => !row.itineraryId || visibleTripIds.has(String(row.itineraryId)),
  );
  const tripSuppliers = visibleSuppliers.filter((row) => !isBankStatementRow(row));

  // Manage optional report fields added by the user.
  const addCustomField = () =>
    setCustomFields((current) => [
      ...current,
      { id: `${Date.now()}-${current.length}`, name: "", value: "" },
    ]);
  const updateCustomField = (id, key, value) =>
    setCustomFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, [key]: value } : field,
      ),
    );
  const removeCustomField = (id) =>
    setCustomFields((current) => current.filter((field) => field.id !== id));

  const validateMasterStep = () => {
    if (!master.companyName.trim()) return "Enter the company name to continue.";
    if (!master.subBrand) return "Select a sub-brand to continue.";
    if (master.from && master.to && master.to <= master.from)
      return "To date must be after the From date.";
    return "";
  };

  const validateLedgerStep = () => {
    if (!trips.length)
      return "No trips found for the selected sub-brand and dates.";
    if (!activeTripOptions.length)
      return "No trips with earnings or spending for the selected filters.";
    const applicableTrips = master.tripId
      ? trips.filter((trip) => String(trip.id) === String(master.tripId))
      : trips;
    const activeTrips = applicableTrips.filter((trip) => {
      const id = String(trip.id);
      const earnings = customers
        .filter((row) => String(row.itineraryId) === id)
        .reduce((sum, row) => sum + getCustomerTripValue(row), 0);
      const spent = suppliers
        .filter((row) => !isBankStatementRow(row))
        .filter((row) => String(row.itineraryId) === id)
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);
      return earnings > 0 || spent > 0;
    });
    const missingTax = activeTrips.some((trip) => {
      const id = String(trip.id);
      const tax = tripTaxes[id] || {};
      const international = Boolean(
        trip.international ||
          trip.isInternational ||
          customers.some((row) => String(row.itineraryId) === id && row.international),
      );
      return (
        tax.gstRate === "" ||
        tax.gstRate == null ||
        (international && (tax.tcsRate === "" || tax.tcsRate == null))
      );
    });
    if (missingTax)
      return "Enter GST % for every trip and TCS % for every international trip. Enter 0 when no tax applies.";
    return "";
  };

  const canOpenStep = (targetStep) => {
    if (targetStep <= step) return true;
    if (targetStep === 1) return !validateMasterStep();
    if (targetStep === 2) return !validateMasterStep() && !validateLedgerStep();
    return false;
  };

  // Validate the current stage before advancing the wizard.
  const continueWizard = () => {
    const masterError = validateMasterStep();
    if (step === 0 && masterError) return setError(masterError);
    const ledgerError = validateLedgerStep();
    if (step === 1 && ledgerError) return setError(ledgerError);
    setError("");
    setStep((current) => Math.min(current + 1, 2));
  };

  // Merge confirmed statement rows and totals from ReconciliationQueue into
  // the local ledger/report state.
  const applyReconciliation = (applied) => {
    if (applied.sales !== undefined || applied.purchase !== undefined)
      setAccounts((current) =>
        current.map((account) =>
          account.id === "sales" && applied.sales !== undefined
            ? {
                ...account,
                amount: applied.sales,
                calculatedAmount: applied.sales,
                edited: true,
              }
            : account.id === "purchase" && applied.purchase !== undefined
              ? {
                  ...account,
                  amount: applied.purchase,
                  calculatedAmount: applied.purchase,
                  edited: true,
                }
              : account,
        ),
      );
    if (applied.customerDetails) setCustomers(applied.customerDetails);
    if (applied.supplierDetails) setSuppliers(applied.supplierDetails);
    if (applied.statementItems) setStatementItems(applied.statementItems);
  };

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 1440,
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 22,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <IndianRupee size={25} color="#10b981" />
            <h1 style={{ margin: 0, fontSize: "1.75rem" }}>Tally accounting</h1>
          </div>
          <p style={{ color: "var(--text-secondary)", margin: "7px 0 0" }}>
            Complete each step to configure your accounting workspace.
          </p>
        </div>
        <span
          style={{
            border: "1px solid var(--border-color, rgba(148,163,184,.25))",
            borderRadius: 999,
            padding: "8px 12px",
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
        >
          Step {step + 1} of 3
        </span>
      </header>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
          marginBottom: 18,
        }}
      >
        {steps.map((item, index) => {
          const Icon = item.icon;
          const active = index === step;
          const done = index < step;
          return (
            <button
              key={item.title}
              type="button"
              disabled={!canOpenStep(index)}
              onClick={() => {
                const masterError = validateMasterStep();
                const ledgerError = validateLedgerStep();
                if (index === 1 && masterError) return setError(masterError);
                if (index === 2 && (masterError || ledgerError))
                  return setError(masterError || ledgerError);
                setError("");
                setStep(index);
              }}
              style={{
                ...card,
                padding: "16px 18px",
                textAlign: "left",
                borderColor: active
                  ? "#5b7cfa"
                  : done
                    ? "#10b98155"
                    : undefined,
                background: active ? "rgba(91,124,250,.14)" : undefined,
                color: "var(--text-primary)",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: active
                    ? "#5b7cfa"
                    : done
                      ? "#10b981"
                      : "rgba(148,163,184,.18)",
                  color: "white",
                }}
              >
                {done ? <Check size={16} /> : <Icon size={16} />}
              </span>
              <span>
                <strong style={{ display: "block" }}>{item.title}</strong>
                <small style={{ color: "var(--text-secondary)" }}>
                  {item.description}
                </small>
              </span>
            </button>
          );
        })}
      </section>
      <section style={{ ...card, padding: 20 }}>
        {step === 1 && (
          <label
            style={{
              ...label,
              display: "block",
              maxWidth: 360,
              marginBottom: 14,
            }}
          >
            Trip / Booking
            <select
              value={master.tripId}
              onChange={(event) => updateMaster("tripId")(event.target.value)}
              style={input}
            >
              {activeTripOptions.length ? (
                <>
                  <option value="">All trips</option>
                  {activeTripOptions.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {trip.destination || `Trip ${trip.id}`} -{" "}
                      {trip.status || "Booking"}
                    </option>
                  ))}
                </>
              ) : (
                <option value="" disabled>
                  {trips.length
                    ? "No trips with earnings or spending"
                    : "No trips found for the selected filters"}
                </option>
              )}
            </select>
            <small
              style={{
                display: "block",
                marginTop: 5,
                color: "var(--text-secondary)",
              }}
            >
              Trips are filtered by Sub-brand and transaction dates.
            </small>
          </label>
        )}
        {step === 0 && (
          <>
            <h2 style={{ margin: 0, fontSize: "1.15rem" }}>Master details</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              Set up the company and reporting filters first.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                gap: 14,
              }}
            >
              <label style={label}>
                Sub-brand *
                <select
                  required
                  value={master.subBrand}
                  onChange={(event) =>
                    updateMaster("subBrand")(event.target.value)
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
              <Field
                title="Company name"
                value={master.companyName}
                onChange={updateMaster("companyName")}
                placeholder="Legal company name"
                required
              />
              <Field
                title="Mailing name"
                value={master.mailingName}
                onChange={updateMaster("mailingName")}
                placeholder="Name shown on invoices"
              />
              <Field
                title="GSTIN"
                value={master.gstin}
                onChange={updateMaster("gstin")}
                placeholder="22AAAAA0000A1Z5"
              />
              <Field
                title="PAN"
                value={master.pan}
                onChange={updateMaster("pan")}
                placeholder="AAAAA0000A"
              />
              <Field
                title="State"
                value={master.state}
                onChange={updateMaster("state")}
                placeholder="State / province"
              />
              <label style={{ ...label, gridColumn: "span 2" }}>
                Registered address
                <textarea
                  value={master.address}
                  onChange={(event) =>
                    updateMaster("address")(event.target.value)
                  }
                  rows={2}
                  placeholder="Business address"
                  style={{ ...input, resize: "vertical" }}
                />
              </label>
              <div style={{ gridColumn: "span 2" }}>
                <label style={{ ...label, marginBottom: 8 }}>
                  Transaction dates
                </label>
                <CompactRangeCalendar
                  from={master.from}
                  to={master.to}
                  popover
                  onChange={({ from, to }) => {
                    updateMaster("from")(from);
                    updateMaster("to")(to);
                  }}
                />
              </div>
            </div>
          </>
        )}
        {step === 1 && (
          <div style={{ ...card, padding: 16 }}>
            <h2 style={{ margin: 0, fontSize: "1.15rem" }}>Ledger accounts</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              Sales and purchase accounts are calculated for the selected
              period.
            </p>
            {loading && (
              <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Loading filtered records…
              </p>
            )}
            {accounts
              .filter((account) => ["sales", "purchase"].includes(account.id))
              .map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  onSave={saveAmount}
                />
              ))}
            <AccountRow
              account={{
                id: "inputGst",
                name: "GST %",
                amount: gst,
                manual: true,
                required: true,
              }}
              onSave={saveAmount}
              showTcs={requiresTcs}
            />
            {requiresTcs && (
              <small
                style={{
                  display: "block",
                  color: "var(--text-secondary)",
                  marginTop: 4,
                }}
              >
                TCS % is required because the selected trips include
                international travel.
              </small>
            )}
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop:
                  "1px solid var(--border-color, rgba(148,163,184,.16))",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 10,
                }}
              >
                <div>
                  <strong>Add fields to report</strong>
                  <small
                    style={{ display: "block", color: "var(--text-secondary)" }}
                  >
                    Add any extra label and value required in the report.
                  </small>
                </div>
                <button
                  type="button"
                  onClick={addCustomField}
                  style={{
                    border: "1px solid #5b7cfa",
                    borderRadius: 8,
                    padding: "8px 12px",
                    background: "transparent",
                    color: "var(--text-primary)",
                    fontWeight: 700,
                  }}
                >
                  + Add field
                </button>
              </div>
              {customFields.map((field) => (
                <div
                  key={field.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr auto",
                    gap: 10,
                    marginBottom: 10,
                  }}
                >
                  <input
                    aria-label="Field name"
                    value={field.name}
                    onChange={(event) =>
                      updateCustomField(field.id, "name", event.target.value)
                    }
                    placeholder="Field name"
                    style={input}
                  />
                  <input
                    aria-label="Field value"
                    value={field.value}
                    onChange={(event) =>
                      updateCustomField(field.id, "value", event.target.value)
                    }
                    placeholder="Value"
                    style={input}
                  />
                  <button
                    type="button"
                    onClick={() => removeCustomField(field.id)}
                    style={{
                      border: 0,
                      background: "transparent",
                      color: "#f87171",
                      padding: "0 8px",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 14,
                marginTop: 16,
              }}
            >
              <DetailCard
                title="Customer A/c"
                description="Sales and invoice details."
                rows={visibleCustomers}
                empty="No customer sales found for these filters."
                customer
              />
              <DetailCard
                title="Supplier A/c"
                description="Purchase and expense details."
                rows={visibleSuppliers}
                empty="No supplier purchases found for these filters."
              />
            </div>
          </div>
        )}
        {step === 1 && (
          <TripTaxTable
            trips={visibleTrips}
            customers={visibleCustomers}
            suppliers={tripSuppliers}
            tripTaxes={tripTaxes}
            selectedTripId={master.tripId}
            onChange={updateTripTax}
          />
        )}
        <div style={{ display: step === 1 ? "block" : "none" }}>
          <ReconciliationQueue
            accounts={accounts}
            customers={visibleCustomers}
            suppliers={visibleSuppliers}
            trips={visibleTrips}
            tripTaxes={tripTaxes}
            onTripTaxChange={updateTripTax}
            onLedgerApplied={applyReconciliation}
          />
        </div>
        {step === 2 && (
          <LedgerPreview
            master={master}
            accounts={accounts}
            gst={gst}
            customFields={customFields}
            customers={visibleCustomers}
            suppliers={tripSuppliers}
            trips={visibleTrips}
            tripTaxes={tripTaxes}
            statementItems={statementItems}
            tripSummary={tripSummary}
          />
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
            marginTop: 22,
            paddingTop: 16,
            borderTop: "1px solid var(--border-color, rgba(148,163,184,.16))",
          }}
        >
          {error ? (
            <span
              style={{ color: "#f87171", fontSize: 13, marginRight: "auto" }}
            >
              {error}
            </span>
          ) : (
            <span style={{ marginRight: "auto" }} />
          )}
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((current) => current - 1)}
              style={{
                border: "1px solid var(--border-color, rgba(148,163,184,.25))",
                borderRadius: 9,
                padding: "10px 14px",
                background: "transparent",
                color: "var(--text-primary)",
              }}
            >
              <ChevronLeft size={16} /> Back
            </button>
          )}
          {step < 2 && (
            <button
              type="button"
              onClick={continueWizard}
              disabled={step === 1 && !activeTripOptions.length}
              style={{
                border: 0,
                borderRadius: 9,
                padding: "10px 16px",
                background: "#5b7cfa",
                color: "white",
                display: "inline-flex",
                gap: 8,
                alignItems: "center",
                fontWeight: 700,
                opacity: step === 1 && !activeTripOptions.length ? 0.55 : 1,
                cursor:
                  step === 1 && !activeTripOptions.length
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              Continue <ArrowRight size={16} />
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

// Render one editable or calculated ledger account row.
function AccountRow({ account, onSave }) {
  if (account.id === "inputGst") return null;
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          padding: "12px 0",
          borderBottom: "1px solid var(--border-color, rgba(148,163,184,.12))",
        }}
      >
        <span>
          <strong>
            {account.name}
            {account.required ? " *" : ""}
          </strong>
          <small style={{ display: "block", color: "var(--text-secondary)" }}>
            {account.manual
              ? "Manual amount"
              : account.edited
                ? `Edited · calculated ${formatMoney(account.calculatedAmount)}`
                : "Calculated from backend filters"}
          </small>
        </span>
        <input
          key={`${account.id}-${account.amount}`}
          aria-label={`${account.name} amount`}
          required={account.required}
          type="text"
          inputMode="decimal"
          defaultValue={account.amount ?? 0}
          onBlur={(event) => onSave(account.id, event.target.value)}
          style={{ ...input, width: 160, textAlign: "right" }}
        />
      </div>
    </div>
  );
}

// Shared label/value row used by report summaries.
function ReportRow({ label, value }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid var(--border-color, rgba(148,163,184,.12))",
      }}
    >
      <strong>{label}</strong>
      <span style={{ color: "var(--text-secondary)" }}>{value}</span>
    </div>
  );
}

function TripProfitLossWithTrips({
  customers,
  suppliers,
  trips,
  selectedTripId = "",
  tripTaxes = {},
  statementItems = [],
  salesOverride = null,
  purchaseOverride = null,
}) {
  const grouped = new Map(
    trips.map((trip) => [
      String(trip.id),
      {
        key: String(trip.id),
        tripName: trip.destination || `Trip ${trip.id}`,
        sales: 0,
        expenses: 0,
        gst: 0,
        tcs: 0,
        dates: new Set(),
      },
    ]),
  );
  customers.forEach((row) => {
    const current = row.itineraryId
      ? grouped.get(String(row.itineraryId))
      : null;
    if (current) {
      current.sales += Number(row.amount || 0);
      if (row.transactionDate) {
        current.dates.add(String(row.transactionDate).slice(0, 10));
      }
    }
  });
  suppliers.filter((row) => !isBankStatementRow(row)).forEach((row) => {
    const current = row.itineraryId
      ? grouped.get(String(row.itineraryId))
      : null;
    if (current) {
      current.expenses += Number(row.amount || 0);
      if (row.transactionDate) {
        current.dates.add(String(row.transactionDate).slice(0, 10));
      }
    }
  });
  const tripRows = [...grouped.values()].map((row) => {
    const gstRate = Number(tripTaxes[row.key]?.gstRate || 0);
    const tcsRate = Number(tripTaxes[row.key]?.tcsRate || 0);
    const gst = (row.sales * gstRate) / 100;
    const tcs = (row.sales * tcsRate) / 100;
    const dates = [...row.dates].sort();
    return {
      ...row,
      dates,
      dateLabel: dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0] || "-",
      gst,
      tcs,
      profit: row.sales - row.expenses - gst - tcs,
    };
  });
  const displayedTripRows = selectedTripId
    ? tripRows
    : tripRows.filter((row) => row.sales > 0 || row.expenses > 0);
  const selectedTrip = selectedTripId
    ? tripRows.find((row) => row.key === String(selectedTripId))
    : null;
  const totals = tripRows.reduce(
    (sum, row) => ({
      sales: sum.sales + row.sales,
      expenses: sum.expenses + row.expenses,
      gst: sum.gst + row.gst,
      tcs: sum.tcs + row.tcs,
      profit: sum.profit + row.profit,
    }),
    { sales: 0, expenses: 0, gst: 0, tcs: 0, profit: 0 },
  );
  const totalSales = salesOverride != null ? Number(salesOverride) : totals.sales;
  const totalExpenses =
    purchaseOverride != null ? Number(purchaseOverride) : totals.expenses;
  const totalProfit = totalSales - totalExpenses - totals.gst - totals.tcs;
  const cell = {
    padding: "10px 8px",
    borderBottom: "1px solid var(--border-color, rgba(148,163,184,.1))",
  };
  const right = { ...cell, textAlign: "right" };
  return (
    <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
      {statementItems.length > 0 && (
        <div style={{ ...card, padding: 16 }}>
          <h3>Bank Statement Transactions</h3>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                minWidth: 700,
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr>
                  {[
                    "Date",
                    "Description",
                    "Reference",
                    "Credit",
                    "Debit / Withdrawal",
                  ].map((label) => (
                    <th
                      key={label}
                      style={{
                        padding: 8,
                        textAlign: [
                          "Date",
                          "Description",
                          "Reference",
                        ].includes(label)
                          ? "left"
                          : "right",
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statementItems.map((item, index) => (
                  <tr key={item.id || index}>
                    <td style={cell}>
                      {item.transactionDate
                        ? String(item.transactionDate).slice(0, 10)
                        : "—"}
                    </td>
                    <td style={cell}>{item.description || "—"}</td>
                    <td style={cell}>{item.sourceRef || "—"}</td>
                    <td style={{ ...right, color: "#34d399" }}>
                      {item.direction !== "DEBIT"
                        ? Number(item.amount || 0) !== 0
                          ? formatMoney(item.amount)
                          : "-"
                        : "—"}
                    </td>
                    <td style={{ ...right, color: "#fbbf24" }}>
                      {item.direction === "DEBIT"
                        ? Number(item.amount || 0) !== 0
                          ? formatMoney(item.amount)
                          : "-"
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div style={{ ...card, padding: 16 }}>
        <h3>Trip Details / Profit & Loss</h3>
        {selectedTrip && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              margin: "12px 0 14px",
              padding: "14px 16px",
              borderRadius: 10,
              background: "rgba(91, 124, 250, 0.12)",
              border: "1px solid rgba(91, 124, 250, 0.35)",
            }}
          >
            <div>
              <strong style={{ display: "block" }}>
                Total spent for {selectedTrip.tripName}
              </strong>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Supplier expenses linked to this trip
              </span>
            </div>
            <strong style={{ fontSize: 18, whiteSpace: "nowrap" }}>
              {formatMoney(selectedTrip.expenses)}
            </strong>
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", minWidth: 760, borderCollapse: "collapse" }}
          >
            <thead>
              <tr>
                {[
                  "Trip / Place",
                  "Ledger dates",
                  "Earnings",
                  "Spent",
                  "GST",
                  "TCS",
                  "Profit / Loss",
                ].map((label) => (
                  <th
                    key={label}
                    style={{
                      padding: 8,
                      textAlign: ["Trip / Place", "Ledger dates"].includes(label)
                        ? "left"
                        : "right",
                    }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayedTripRows.map((row) => (
                <tr key={row.key}>
                  <td style={{ ...cell, fontWeight: 700 }}>{row.tripName}</td>
                  <td style={cell}>{row.dateLabel}</td>
                  <td style={right}>{formatMoney(row.sales)}</td>
                  <td style={right}>{formatMoney(row.expenses)}</td>
                  <td style={right}>{formatMoney(row.gst)}</td>
                  <td style={right}>{formatMoney(row.tcs)}</td>
                  <td
                    style={{
                      ...right,
                      color: row.profit >= 0 ? "#34d399" : "#f87171",
                      fontWeight: 800,
                    }}
                  >
                    {row.profit >= 0 ? "Profit " : "Loss "}
                    {formatMoney(Math.abs(row.profit))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan="2" style={{ padding: 10, fontWeight: 800 }}>
                  Cumulative total Profit / Loss
                </td>
                <td style={{ ...right, fontWeight: 800 }}>
                  {formatMoney(totalSales)}
                </td>
                <td style={{ ...right, fontWeight: 800 }}>
                  {formatMoney(totalExpenses)}
                </td>
                <td style={{ ...right, fontWeight: 800 }}>
                  {formatMoney(totals.gst)}
                </td>
                <td style={{ ...right, fontWeight: 800 }}>
                  {formatMoney(totals.tcs)}
                </td>
                <td
                  style={{
                    ...right,
                    color: totalProfit >= 0 ? "#34d399" : "#f87171",
                    fontWeight: 800,
                  }}
                >
                  {totalProfit >= 0 ? "Profit " : "Loss "}
                  {formatMoney(Math.abs(totalProfit))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// Show the cumulative totals card from the filtered ledger and trip taxes.
function CumulativeReportCard({
  trips,
  tripTaxes,
  customers,
  suppliers = [],
  statementItems = [],
  selectedTripId = "",
  salesOverride = null,
  purchaseOverride = null,
}) {
  const activeTrips = trips.filter((trip) => {
    const id = String(trip.id);
    const earnings = customers
      .filter((row) => String(row.itineraryId) === id)
      .reduce((sum, row) => sum + getCustomerTripValue(row), 0);
    const spent = suppliers
      .filter(
        (row) =>
          !isBankStatementRow(row) && String(row.itineraryId) === id,
      )
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);
    return selectedTripId || earnings > 0 || spent > 0;
  });
  const allTripsReport = !selectedTripId;
  const activeTripIds = new Set(activeTrips.map((trip) => String(trip.id)));
  const reportCustomers = allTripsReport
    ? customers
    : customers.filter((row) => activeTripIds.has(String(row.itineraryId)));
  const reportSuppliers = allTripsReport
    ? suppliers.filter((row) => !isBankStatementRow(row))
    : suppliers.filter(
        (row) =>
          !isBankStatementRow(row) &&
          activeTripIds.has(String(row.itineraryId)),
      );
  const sales = salesOverride != null
    ? Number(salesOverride)
    : reportCustomers.reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0,
      );
  const supplierExpenses = purchaseOverride != null
    ? Number(purchaseOverride)
    : reportSuppliers.reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0,
      );
  const expenses = supplierExpenses;
  const expenseBreakdown = reportSuppliers
    .filter(
      (row) =>
        String(row.category || "").toLowerCase() !== "travel" &&
        !row.itineraryId,
    )
    .reduce((categories, row) => {
      const category = row.category || "Uncategorized";
      categories[category] = (categories[category] || 0) + Number(row.amount || 0);
      return categories;
    }, {});
  const expenseRows = Object.entries(expenseBreakdown).sort(
    ([, amountA], [, amountB]) => amountB - amountA,
  );
  const reportTableCell = {
    padding: "10px 8px",
    borderBottom: "1px solid var(--border-color, rgba(148,163,184,.1))",
  };
  const reportTrips = allTripsReport ? trips : activeTrips;
  const gst = reportTrips.reduce((sum, trip) => {
    const amount = customers
      .filter((row) => String(row.itineraryId) === String(trip.id))
      .reduce((total, row) => total + Number(row.amount || 0), 0);
    return (
      sum + (amount * Number(tripTaxes[String(trip.id)]?.gstRate || 0)) / 100
    );
  }, 0);
  const tcs = reportTrips.reduce((sum, trip) => {
    const amount = customers
      .filter((row) => String(row.itineraryId) === String(trip.id))
      .reduce((total, row) => total + Number(row.amount || 0), 0);
    return (
      sum + (amount * Number(tripTaxes[String(trip.id)]?.tcsRate || 0)) / 100
    );
  }, 0);
  const profit = sales - expenses - gst - tcs;
  return (
      <div style={{ ...card, padding: 16, marginTop: 14 }}>
        <h3 style={{ margin: 0 }}>Cumulative Profit / Loss</h3>
      <div style={{ ...card, padding: 16, marginTop: 14 }}>
        <h3 style={{ margin: 0 }}>Expense Breakdown</h3>
        <p style={{ color: "var(--text-secondary)", margin: "6px 0 12px" }}>
          {selectedTripId
            ? "Additional expenses not already included in trip spending."
            : "Additional non-Travel expenses not already included in the trip details."}
        </p>
        {expenseRows.length ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...reportTableCell, textAlign: "left" }}>
                    Category
                  </th>
                  <th style={{ ...reportTableCell, textAlign: "right" }}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {expenseRows.map(([category, amount]) => (
                  <tr key={category}>
                    <td style={reportTableCell}>{category}</td>
                    <td style={{ ...reportTableCell, textAlign: "right" }}>
                      {formatMoney(amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ color: "var(--text-secondary)", margin: 0 }}>
            No expenses found for these filters.
          </p>
        )}
      </div>
      <div style={{ display: "grid", gap: 0, marginTop: 10 }}>
        <ReportRow label="Total earnings" value={formatMoney(sales)} />
        <ReportRow label="Total spent" value={formatMoney(expenses)} />
        <ReportRow label="Total GST" value={formatMoney(gst)} />
        <ReportRow label="Total TCS" value={formatMoney(tcs)} />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "16px 0 4px",
          color: profit >= 0 ? "#34d399" : "#f87171",
          fontWeight: 800,
        }}
      >
        <strong>
          {profit >= 0 ? "Cumulative Profit" : "Cumulative Loss"}
        </strong>
        <span>{formatMoney(Math.abs(profit))}</span>
      </div>
    </div>
  );
}

// Final Reports step. It combines the report sections and exposes CSV/PDF
// downloads without adding any data outside the current wizard state.
function LedgerPreview({
  master,
  accounts,
  gst,
  customFields,
  customers,
  suppliers,
  trips = [],
  tripTaxes = {},
  statementItems = [],
  tripSummary,
}) {
  const totals = accounts.filter((account) =>
    ["sales", "purchase"].includes(account.id),
  );
  const sales = Number(
    totals.find((account) => account.id === "sales")?.amount || 0,
  );
  const expenses = Number(
    totals.find((account) => account.id === "purchase")?.amount || 0,
  );
  // Open the print-ready A4 report containing only the visible report sections.
  const downloadPdf = () => {
    const escapeHtml = (value) =>
      String(value ?? "").replace(
        /[&<>"]/g,
        (character) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[
            character
          ],
      );
    const tripRows = trips.map((trip) => {
      const key = String(trip.id);
      const customerRows = customers.filter((row) => String(row.itineraryId) === key);
      const supplierRows = suppliers
        .filter((row) => !isBankStatementRow(row))
        .filter((row) => String(row.itineraryId) === key);
      const earnings = customerRows.reduce(
        (sum, row) => sum + getCustomerTripValue(row),
        0,
      );
      const spent = supplierRows.reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0,
      );
      const dates = [...new Set(
        [...customerRows, ...supplierRows]
          .map((row) => row.transactionDate && String(row.transactionDate).slice(0, 10))
          .filter(Boolean),
      )].sort();
      const tax = tripTaxes[key] || {};
      const gstAmount = (earnings * Number(tax.gstRate || 0)) / 100;
      const tcsAmount = (earnings * Number(tax.tcsRate || 0)) / 100;
      return {
        name: trip.destination || `Trip ${key}`,
        dateLabel: dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0] || "-",
        earnings,
        spent,
        gstAmount,
        tcsAmount,
        profit: earnings - spent - gstAmount - tcsAmount,
      };
    }).filter((row) => row.earnings > 0 || row.spent > 0);
    const totalGst = tripRows.reduce((sum, row) => sum + row.gstAmount, 0);
    const totalTcs = tripRows.reduce((sum, row) => sum + row.tcsAmount, 0);
    const cumulativeProfit = sales - expenses - totalGst - totalTcs;
    const statementRows = statementItems
      .map(
        (item) =>
          `<tr><td>${escapeHtml(item.transactionDate ? String(item.transactionDate).slice(0, 10) : "—")}</td><td>${escapeHtml(item.description || "—")}</td><td>${escapeHtml(item.sourceRef || "—")}</td><td class="num positive">${item.direction !== "DEBIT" ? escapeHtml(formatMoney(item.amount)) : "—"}</td><td class="num negative">${item.direction === "DEBIT" ? escapeHtml(formatMoney(item.amount)) : "—"}</td></tr>`,
      )
      .join("");
    const tripRowsHtml = tripRows
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.dateLabel)}</td><td class="num">${escapeHtml(formatMoney(row.earnings))}</td><td class="num">${escapeHtml(formatMoney(row.spent))}</td><td class="num">${escapeHtml(formatMoney(row.gstAmount))}</td><td class="num">${escapeHtml(formatMoney(row.tcsAmount))}</td><td class="num ${row.profit >= 0 ? "positive" : "negative"}">${row.profit >= 0 ? "Profit " : "Loss "}${escapeHtml(formatMoney(Math.abs(row.profit)))}</td></tr>`,
      )
      .join("");
    // Open from the current application URL so Chrome does not print `about:blank`
    // in the generated document footer.
    const popup = window.open(
      window.location.href,
      "_blank",
      "width=900,height=700",
    );
    if (!popup) return;
    popup.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Travel Tally Report</title><style>@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;background:#fff;margin:0;font-size:10px;line-height:1.35}header{border-bottom:3px solid #2563eb;padding-bottom:12px;margin-bottom:18px}h1{font-size:22px;margin:0 0 5px;color:#0f172a}h2{font-size:14px;margin:0 0 9px;color:#0f172a}p{margin:0;color:#64748b}.section{margin:0 0 20px;break-inside:avoid}table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#eaf1ff;color:#1e3a8a;font-size:9px;text-transform:uppercase;letter-spacing:.03em;text-align:left}th,td{border:1px solid #d7deea;padding:7px 8px;vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#f8fafc}.num{text-align:right;white-space:nowrap}.positive{color:#047857;font-weight:700}.negative{color:#b91c1c;font-weight:700}.summary{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px}.metric{border:1px solid #d7deea;border-radius:7px;padding:9px 10px;background:#f8fafc}.metric label{display:block;color:#64748b;font-size:9px;margin-bottom:3px}.metric strong{font-size:13px}.total-row td{background:#eefcf7;font-weight:700}.muted{color:#64748b;font-size:9px}thead{display:table-header-group}tr{break-inside:avoid}</style></head><body><header><h1>Travel Tally Report</h1><p>${escapeHtml(master.companyName || "Travel accounting")} · ${escapeHtml(master.subBrand || "All sub-brands")} · ${escapeHtml(master.from || "Any date")} to ${escapeHtml(master.to || "Any date")}</p></header><section class="section"><h2>Bank Statement Transactions</h2>${statementItems.length ? `<table><thead><tr><th style="width:13%">Date</th><th style="width:34%">Description</th><th style="width:25%">Reference</th><th style="width:14%" class="num">Credit</th><th style="width:14%" class="num">Debit / Withdrawal</th></tr></thead><tbody>${statementRows}</tbody></table>` : `<p class="muted">No bank statement transactions were added.</p>`}</section><section class="section"><h2>Trip Details / Profit &amp; Loss</h2>${tripRows.length ? `<table><thead><tr><th style="width:22%">Trip / Place</th><th style="width:16%">Ledger dates</th><th class="num">Earnings</th><th class="num">Spent</th><th class="num">GST</th><th class="num">TCS</th><th class="num">Profit / Loss</th></tr></thead><tbody>${tripRowsHtml}</tbody></table>` : `<p class="muted">No trip details were found for the selected filters.</p>`}</section><section class="section"><h2>Cumulative Profit / Loss</h2><div class="summary"><div class="metric"><label>Total earnings</label><strong>${escapeHtml(formatMoney(sales))}</strong></div><div class="metric"><label>Total spent</label><strong>${escapeHtml(formatMoney(expenses))}</strong></div><div class="metric"><label>Total GST</label><strong>${escapeHtml(formatMoney(totalGst))}</strong></div><div class="metric"><label>Total TCS</label><strong>${escapeHtml(formatMoney(totalTcs))}</strong></div></div><table><tbody><tr class="total-row"><td>Cumulative ${cumulativeProfit >= 0 ? "Profit" : "Loss"}</td><td class="num ${cumulativeProfit >= 0 ? "positive" : "negative"}">${escapeHtml(formatMoney(Math.abs(cumulativeProfit)))}</td></tr></tbody></table></section></body></html>`,
    );
    popup.document.close();
    popup.focus();
    setTimeout(() => popup.print(), 250);
  };

  return (
    <div className="tally-report-preview" style={{ padding: "24px 12px" }}>
      <style>{`.tally-report-preview > div:nth-of-type(3) { display: none; } .tally-report-preview > div:nth-of-type(4) > div:nth-of-type(2) tfoot { display: none; } .tally-report-preview > div:nth-of-type(4) table { font-size: 12px; }`}</style>
      <div style={{ textAlign: "center", position: "relative" }}>
        <FileBarChart size={38} color="#10b981" />
        <h2 style={{ margin: "10px 0 0", fontSize: "1.2rem" }}>
          Ledger preview
        </h2>
        <p style={{ color: "var(--text-secondary)" }}>
          Trip-wise revenue, costs, GST, TCS, and profit/loss.
        </p>
      </div>
      <div style={{ ...card, padding: 16, marginTop: 20 }}>
        <h3 style={{ margin: "0 0 12px" }}>Master filters</h3>
        <ReportRow label="Company name" value={master.companyName || "—"} />
        <ReportRow label="Mailing name" value={master.mailingName || "—"} />
        <ReportRow label="GSTIN" value={master.gstin || "—"} />
        <ReportRow label="PAN" value={master.pan || "—"} />
        <ReportRow label="State" value={master.state || "—"} />
        <ReportRow label="Registered address" value={master.address || "—"} />
        <ReportRow label="Sub-brand" value={master.subBrand || "—"} />
        <ReportRow
          label="Trip / Booking"
          value={
            tripSummary?.destination ||
            (master.tripId ? `Trip ${master.tripId}` : "All trips")
          }
        />
        <ReportRow
          label="Transaction period"
          value={`${master.from || "Any date"} to ${master.to || "Any date"}`}
        />
      </div>
      <div style={{ ...card, padding: 16, marginTop: 14 }}>
        <h3 style={{ margin: "0 0 12px" }}>
          Ledger accounts and custom fields
        </h3>
        {totals.map((account) => (
          <ReportRow
            key={account.id}
            label={account.name}
            value={formatMoney(account.amount)}
          />
        ))}
        <ReportRow label="GST %" value={gst === "" ? "—" : `${gst}%`} />
        {customFields
          .filter((field) => field.name.trim())
          .map((field) => (
            <ReportRow
              key={field.id}
              label={field.name}
              value={field.value || "—"}
            />
          ))}
      </div>
      <TripProfitLossWithTrips
        customers={customers}
        suppliers={suppliers}
        trips={trips}
        selectedTripId={master.tripId}
        tripTaxes={tripTaxes}
        statementItems={statementItems}
        salesOverride={Number(
          accounts.find((account) => account.id === "sales")?.amount || 0,
        )}
        purchaseOverride={Number(
          accounts.find((account) => account.id === "purchase")?.amount || 0,
        )}
      />
      <CumulativeReportCard
        trips={trips}
        tripTaxes={tripTaxes}
        customers={customers}
        suppliers={suppliers}
        statementItems={statementItems}
        selectedTripId={master.tripId}
        salesOverride={Number(
          accounts.find((account) => account.id === "sales")?.amount || 0,
        )}
        purchaseOverride={Number(
          accounts.find((account) => account.id === "purchase")?.amount || 0,
        )}
      />
      <div
        style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}
      >
        <button
          type="button"
          onClick={downloadPdf}
          style={{
            border: 0,
            borderRadius: 9,
            padding: "10px 16px",
            background: "#5b7cfa",
            color: "white",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 700,
          }}
        >
          <Download size={15} /> Download PDF
        </button>
      </div>
    </div>
  );
}



