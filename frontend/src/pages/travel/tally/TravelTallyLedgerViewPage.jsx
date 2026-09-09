import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchApi } from "../../../utils/api";
import CommonLedgerView from "./CommonLedgerView";
import PurchaseLedgerView from "./PurchaseLedgerView";
import SalesLedgerView from "./SalesLedgerView";
import TripwiseLedgerView from "./TripwiseLedgerView";
import { useTravelTallyMaster } from "./useTravelTallyMaster";
import BankLedgerView from "./BankLedgerView";
import GstTcsLedgerView from "./GstTcsLedgerView";
import { loadTallyState, saveTallyState } from "./tallyStorage";
import TallySectionNav from "./TallySectionNav";

const tripTaxesStorageKey = "travel-tally-trip-taxes";

const viewConfig = {
  sales: {
    title: "Sales Ledger",
    description: "Customer invoices, payment received, tax, and trip details.",
  },
  purchase: {
    title: "Purchase Ledger",
    description: "Supplier payable details included in purchase accounting.",
  },
  common: {
    title: "Common Ledger",
    description: "Office expenses and non-supplier common accounting entries.",
  },
  taxes: {
    title: "TCS & GST Ledger",
    description: "Review and edit trip-level GST and TCS rates and amounts.",
  },
  gst: { title: "GST Ledger", description: "GST amounts by invoice, customer, trip, and date." },
  tcs: { title: "TCS Ledger", description: "TCS amounts by customer, invoice, trip, and date." },
  "trip-expenses": { title: "Trip Expense Ledger", description: "Trip-linked expenses grouped by trip and expense type." },
  "office-expenses": { title: "Office Expense Ledger", description: "Office expenses grouped by date and category." },
  customers: { title: "Customer Ledger", description: "Customer invoices, receipts, and outstanding amounts." },
  suppliers: { title: "Supplier Ledger", description: "Supplier bills, payments, and payable transactions." },
  salary: { title: "Salary Ledger", description: "Salary, commission, and incentive transactions." },
  bank: {
    title: "Bank Ledger",
    description: "Bank-based customer receipts and supplier purchases.",
  },
  cash: {
    title: "Cash Ledger",
    description: "Cash customer receipts and supplier purchases.",
  },
  tripwise: {
    title: "Tripwise Ledger",
    description: "Sales, purchase, common expenses, taxes, and profit/loss per trip.",
  },
};

const isBankStatementRow = (row) =>
  String(row?.reference || "").startsWith("STATEMENT-DEBIT-") ||
  /bank statement debit/i.test(String(row?.category || ""));

export default function TravelTallyLedgerViewPage() {
  const { ledgerView: routeLedgerView, customLedgerId } = useParams();
  // The custom-ledger route has no :ledgerView segment. Resolve it to the
  // view key expected by the rest of this component.
  const ledgerView = routeLedgerView || (customLedgerId ? "custom" : undefined);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const masterState = useTravelTallyMaster();
  const { master } = masterState;
  const { updateMaster } = masterState;
  const [trips, setTrips] = useState([]);
  const [quoteTrips, setQuoteTrips] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [payables, setPayables] = useState([]);
  const [supplierLedgerDetails, setSupplierLedgerDetails] = useState([]);
  const [salaryDetails, setSalaryDetails] = useState([]);
  const [tripTaxes, setTripTaxes] = useState(() =>
    loadTallyState(tripTaxesStorageKey, {}),
  );
  const [loading, setLoading] = useState(false);
  const [paymentDetails, setPaymentDetails] = useState([]);
  const [search, setSearch] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [paymentMode, setPaymentMode] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState("");
  const [voucherTypeFilter, setVoucherTypeFilter] = useState("");
  const [mappedExpenseCategory, setMappedExpenseCategory] = useState("");
  const [customLedgerType, setCustomLedgerType] = useState("");
  const selectedLedgerId = customLedgerId || searchParams.get("ledgerId");
  const selectedLedgerName = searchParams.get("ledgerName");

  const selectedSubBrand = master.subBrand === "all" ? "" : master.subBrand;
  const selectedTripView = viewConfig[ledgerView === "custom" ? "common" : ledgerView] || null;

  useEffect(() => {
    if ((!selectedLedgerId && !selectedLedgerName) || (ledgerView !== "office-expenses" && ledgerView !== "common" && ledgerView !== "custom")) {
      setMappedExpenseCategory("");
      return undefined;
    }
    let cancelled = false;
    fetchApi("/api/travel/tally/mappings")
      .then((data) => {
        if (cancelled) return;
        const mapping = (data?.mappings || []).find((row) =>
          (selectedLedgerId && String(row.tallyLedgerId) === String(selectedLedgerId)
            || selectedLedgerName && String(row.tallyLedger?.ledgerName || "").trim().toLowerCase() === selectedLedgerName.trim().toLowerCase())
          && row.sourceType === "EXPENSE"
          && row.transactionType === "PAYMENT",
        );
        setMappedExpenseCategory(mapping?.sourceKey?.replace(/^EXPENSE:/, "") || "");
      })
      .catch(() => { if (!cancelled) setMappedExpenseCategory(""); });
    return () => { cancelled = true; };
  }, [selectedLedgerId, selectedLedgerName, ledgerView]);

  useEffect(() => {
    if (ledgerView !== "custom" || !selectedLedgerId) {
      setCustomLedgerType("");
      return undefined;
    }
    let cancelled = false;
    fetchApi("/api/travel/tally/masters")
      .then((data) => {
        if (cancelled) return;
        const ledger = (data?.ledgers || []).find((row) => String(row.id) === String(selectedLedgerId));
        setCustomLedgerType(String(ledger?.ledgerCategory || "").toUpperCase());
      })
      .catch(() => { if (!cancelled) setCustomLedgerType(""); });
    return () => { cancelled = true; };
  }, [selectedLedgerId, ledgerView]);

  useEffect(() => {
    saveTallyState(tripTaxesStorageKey, tripTaxes);
  }, [tripTaxes]);

  useEffect(() => {
    if (master.subBrand !== "all" && !master.subBrand) {
      setTrips([]);
      return undefined;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      fields: "summary",
      limit: "200",
    });
    if (selectedSubBrand) params.set("subBrand", selectedSubBrand);
    if (master.from) params.set("from", master.from);
    if (master.to) params.set("to", master.to);
    const itineraryPromise = fetchApi(`/api/travel/itineraries?${params}`);
    const tmcPromise = !selectedSubBrand || selectedSubBrand === "tmc"
      ? fetchApi(`/api/travel/trips?fields=summary&limit=200`).catch(() => ({ trips: [] }))
      : Promise.resolve({ trips: [] });
    Promise.all([itineraryPromise, tmcPromise])
      .then(([itineraryData, tmcData]) => {
        if (cancelled) return;
        const itineraryRows = (itineraryData?.itineraries || []).map((row) => ({
          ...row,
          ledgerType: "itinerary",
        }));
        const tmcRows = (tmcData?.trips || []).map((row) => ({
          ...row,
          id: `tmc-${row.id}`,
          tmcTripId: row.id,
          ledgerType: "tmc",
          destination: row.tripCode
            ? `${row.tripCode} — ${row.destination || ""}`.trim()
            : row.destination,
        }));
        setTrips([...itineraryRows, ...tmcRows]);
      })
      .catch(() => {
        if (!cancelled) setTrips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [master.subBrand, selectedSubBrand, master.from, master.to]);

  useEffect(() => {
    setTripTaxes((current) => {
      const next = {};
      trips.forEach((trip) => {
        const id = String(trip.id);
        const existing = current[id] || {};
        const backendRows = customers.filter(
          (row) => String(row.itineraryId) === id,
        );
        const backendGstRate = backendRows.find((row) => row.gstRate != null)?.gstRate;
        const backendTcsRate = backendRows.find((row) => row.tcsRate != null)?.tcsRate;
        next[id] = {
          gstRate:
            existing.gstRate !== "" && existing.gstRate != null
              ? existing.gstRate
              : (backendGstRate ?? 0),
          tcsRate:
            existing.tcsRate !== "" && existing.tcsRate != null
              ? existing.tcsRate
              : (backendTcsRate ?? 0),
        };
      });
      return next;
    });
  }, [trips, customers]);

  useEffect(() => {
    if (master.subBrand !== "all" && !master.subBrand) return;
    let cancelled = false;
    const params = new URLSearchParams({ subBrand: master.subBrand });
    if (master.from) params.set("from", master.from);
    if (master.to) params.set("to", master.to);
    if (master.tripId) {
      const selectedTripId = String(master.tripId);
      if (selectedTripId.startsWith("quote-")) {
        params.set("quoteId", selectedTripId.replace(/^quote-/, ""));
      } else {
        params.set("itineraryId", selectedTripId);
      }
    }
    if (paymentMode) params.set("paymentMode", paymentMode);
    setLoading(true);
    fetchApi(`/api/travel/tally/ledger?${params}`)
      .then((data) => {
        if (!cancelled) {
          setCustomers(data?.customerDetails || []);
          setPaymentDetails(data?.paymentDetails || []);
          setSuppliers(data?.supplierDetails || []);
          setPayables(data?.payableDetails || []);
          setSupplierLedgerDetails(data?.supplierLedgerDetails || []);
          setSalaryDetails(data?.salaryDetails || []);
          const quoteRows = [
            ...(data?.customerDetails || []),
            ...(data?.payableDetails || []),
            ...(data?.supplierDetails || []),
          ];
          const quoteRowsById = new Map();
          quoteRows.forEach((row) => {
            if (row.quoteId != null && !row.itineraryId && !row.tripId && !quoteRowsById.has(String(row.quoteId))) {
              quoteRowsById.set(String(row.quoteId), row);
            }
          });
          setQuoteTrips([...quoteRowsById.entries()].map(([quoteId, row]) => ({
            id: `quote-${quoteId}`,
            quoteId: Number(quoteId),
            destination: row.tripName || `Quote #${quoteId}`,
            status: "Quoted",
            ledgerType: "quote",
          })));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCustomers([]);
          setPaymentDetails([]);
          setSuppliers([]);
          setPayables([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [master.subBrand, master.tripId, master.from, master.to, paymentMode]);

  const visibleTrips = master.tripId
    ? [...trips, ...quoteTrips].filter((trip) => String(trip.id) === String(master.tripId))
    : [...trips, ...quoteTrips];
  const allLedgerTrips = [...trips, ...quoteTrips];
  const visibleTripIds = new Set(visibleTrips.map((trip) => String(trip.id)));
  const rowTripKey = (row) => row.itineraryId != null
    ? String(row.itineraryId)
    : row.tripId != null
      ? `tmc-${row.tripId}`
      : row.quoteId != null
        ? `quote-${row.quoteId}`
      : null;
  const visibleCustomers = customers.filter(
    (row) => !master.tripId || !rowTripKey(row) || visibleTripIds.has(rowTripKey(row)),
  );
  const visiblePayables = payables.filter(
    (row) => !master.tripId || !rowTripKey(row) || visibleTripIds.has(rowTripKey(row)),
  );
  const visibleSuppliers = suppliers.filter(
    (row) => !master.tripId || !rowTripKey(row) || visibleTripIds.has(rowTripKey(row)),
  );
  const tripSuppliers = visibleSuppliers.filter((row) => !isBankStatementRow(row));
  const filterRows = (rows) => rows.filter((row) => {
    const haystack = [row.name, row.reference, row.tripName, row.description, row.category, row.paymentReference]
      .filter(Boolean).join(" ").toLowerCase();
    const amount = Number(row.amount || row.totalAmount || 0);
    const rowLedger = String(row.ledger || row.category || "").toLowerCase();
    const rowVoucher = String(row.voucherType || (ledgerView === "sales" || ledgerView === "customers" ? "SALES" : ledgerView === "purchase" || ledgerView === "suppliers" ? "PURCHASE" : ledgerView === "salary" || ledgerView === "office-expenses" || ledgerView === "trip-expenses" ? "PAYMENT" : "")).toLowerCase();
    const rowDate = row.transactionDate || row.createdAt || row.date || row.paidAt;
    const dateValue = rowDate ? new Date(rowDate).getTime() : null;
    const fromValue = master.from ? new Date(`${master.from}T00:00:00`).getTime() : null;
    const toValue = master.to ? new Date(`${master.to}T23:59:59.999`).getTime() : null;
    return (!search || haystack.includes(search.toLowerCase()))
      && (fromValue == null || (dateValue != null && dateValue >= fromValue))
      && (toValue == null || (dateValue != null && dateValue <= toValue))
      && (!master.tripId || !rowTripKey(row) || rowTripKey(row) === String(master.tripId))
      && (!ledgerFilter || rowLedger.includes(ledgerFilter.toLowerCase()))
      && (!voucherTypeFilter || rowVoucher === voucherTypeFilter.toLowerCase())
      && (amountMin === "" || amount >= Number(amountMin))
      && (amountMax === "" || amount <= Number(amountMax))
      && (!paymentMode || normalizePaymentMode(row.paymentMode) === paymentMode);
  });
  const filteredCustomers = filterRows(visibleCustomers);
  const filteredPayables = filterRows(visiblePayables);
  const filteredSuppliers = filterRows(visibleSuppliers);
  const filteredPayments = filterRows(paymentDetails);
  const filteredSalary = filterRows(salaryDetails);
  const filteredSupplierLedger = filterRows(supplierLedgerDetails);
  // Supplier payments belong to the Purchase/Supplier ledgers. The Common
  // Ledger is intentionally limited to office and other non-supplier entries.
  const commonLedgerRows = filteredSuppliers.filter((row) => !row.isTripExpense && !row.itineraryId && !row.tripId);
  const selectedView = useMemo(() => {
    if (!selectedTripView) return null;
    if (ledgerView === "sales") return <SalesLedgerView rows={filteredCustomers} />;
    if (ledgerView === "purchase") return <PurchaseLedgerView rows={filteredPayables} />;
    if (ledgerView === "common") return <CommonLedgerView title="Common Ledger" description="Office expenses and non-supplier common accounting entries." rows={commonLedgerRows} />;
    if (ledgerView === "custom" && customLedgerType === "PURCHASE") {
      const category = String(selectedLedgerName || "").trim().toLowerCase();
      return <PurchaseLedgerView title={selectedLedgerName ? `${selectedLedgerName} Ledger` : undefined} rows={filteredPayables.filter((row) => !category || String(row.category || "").trim().toLowerCase() === category)} />;
    }
    if (ledgerView === "custom") return <CommonLedgerView title={mappedExpenseCategory ? `${mappedExpenseCategory} Ledger` : "Common Ledger"} description={mappedExpenseCategory ? `Expenses mapped to ${mappedExpenseCategory}.` : undefined} rows={filteredSuppliers.filter((row) => !mappedExpenseCategory || String(row.category || "").trim() === mappedExpenseCategory)} />;
    if (ledgerView === "bank") {
      return <BankLedgerView rows={filteredPayments.filter((row) => row.ledger === "bank")} />;
    }
    if (ledgerView === "cash") {
      return <BankLedgerView ledger="cash" rows={filteredPayments.filter((row) => row.ledger === "cash")} />;
    }
    if (ledgerView === "tripwise") {
      return (
        <TripwiseLedgerView
          trips={visibleTrips}
          customers={visibleCustomers}
          suppliers={visibleSuppliers}
          payables={visiblePayables}
          tripTaxes={tripTaxes}
        />
      );
    }
    if (ledgerView === "taxes") {
      return <GstTcsLedgerView rows={filteredCustomers} />;
    }
    if (ledgerView === "gst") return <GstTcsLedgerView taxType="GST" rows={filteredCustomers.filter((row) => Number(row.gstAmount || 0) > 0)} />;
    if (ledgerView === "tcs") return <GstTcsLedgerView taxType="TCS" rows={filteredCustomers.filter((row) => Number(row.tcsAmount || 0) > 0)} />;
    if (ledgerView === "trip-expenses") return <CommonLedgerView title="Trip Expense Ledger" description="Trip-linked expense entries." rows={filteredPayables.filter((row) => row.isTripExpense || row.itineraryId || row.tripId)} />;
    if (ledgerView === "office-expenses") return <CommonLedgerView title={mappedExpenseCategory ? `${mappedExpenseCategory} Ledger` : "Office Expense Ledger"} description={mappedExpenseCategory ? `Expenses mapped to ${mappedExpenseCategory}.` : "Office expense entries not linked to a trip."} rows={filteredSuppliers.filter((row) => !row.isTripExpense && !row.itineraryId && !row.tripId && (!mappedExpenseCategory || String(row.category || "").trim() === mappedExpenseCategory))} />;
    if (ledgerView === "customers") return <CommonLedgerView title="Customer Ledger" description="Customer invoices, receipts, and outstanding amounts." rows={filteredCustomers} showCustomerTotals />;
    if (ledgerView === "suppliers") return <CommonLedgerView title="Supplier Ledger" description="Supplier bills, payments, and outstanding transactions." rows={filteredSupplierLedger} showOutstanding />;
    if (ledgerView === "salary") return <CommonLedgerView title="Salary Ledger" description="Salary, commission, and incentive transactions." rows={filteredSalary} />;
    return null;
  }, [
    ledgerView,
    selectedTripView,
    visibleCustomers,
    visiblePayables,
    visibleSuppliers,
    visibleTrips,
    tripSuppliers,
    tripTaxes,
    paymentDetails,
    search,
    amountMin,
    amountMax,
    paymentMode,
    ledgerFilter,
    voucherTypeFilter,
    filteredCustomers,
    filteredPayables,
    filteredSuppliers,
    filteredPayments,
    filteredSalary,
    filteredSupplierLedger,
    commonLedgerRows,
    mappedExpenseCategory,
  ]);

  if (!selectedTripView) {
    return <Navigate to="/travel/tally" replace />;
  }

  return (
    <main style={{ padding: 20, minHeight: "100vh", background: "var(--bg-color)" }}>
      <section style={{ marginBottom: 16 }}>
        <TallySectionNav showBack />
        <h1 style={{ margin: 0, fontSize: "1.6rem" }}>{selectedTripView.title}</h1>
        <p style={{ color: "var(--text-secondary)", margin: "6px 0 0" }}>
          {selectedTripView.description}
        </p>
        {loading && (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            Loading filtered records...
          </p>
        )}
        <div style={filterGrid}>
          <input style={{ ...filterControl, ...searchControl }} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search party, trip, reference" aria-label="Search ledger" />
          <label style={filterLabel}>From<input style={filterControl} type="date" value={master.from || ""} onChange={(event) => updateMaster("from")(event.target.value)} aria-label="Ledger date from" /></label>
          <label style={filterLabel}>To<input style={filterControl} type="date" value={master.to || ""} onChange={(event) => updateMaster("to")(event.target.value)} aria-label="Ledger date to" /></label>
          <label style={filterLabel}>Trip<select style={filterControl} value={master.tripId || ""} onChange={(event) => updateMaster("tripId")(event.target.value)} aria-label="Ledger trip"><option value="">All trips</option>{allLedgerTrips.map((trip) => <option key={trip.id} value={trip.id}>{trip.tripCode || `TRIP-${trip.id}`} - {trip.destination || "Trip"}</option>)}</select></label>
          <input style={filterControl} value={ledgerFilter} onChange={(event) => setLedgerFilter(event.target.value)} placeholder="Ledger" aria-label="Filter ledger" />
          <select style={filterControl} value={voucherTypeFilter} onChange={(event) => setVoucherTypeFilter(event.target.value)} aria-label="Filter voucher type"><option value="">All voucher types</option><option value="SALES">Sales</option><option value="PURCHASE">Purchase</option><option value="RECEIPT">Receipt</option><option value="PAYMENT">Payment</option><option value="JOURNAL">Journal</option></select>
          <input style={filterControl} type="number" min="0" value={amountMin} onChange={(event) => setAmountMin(event.target.value)} placeholder="Minimum amount" aria-label="Minimum amount" />
          <input style={filterControl} type="number" min="0" value={amountMax} onChange={(event) => setAmountMax(event.target.value)} placeholder="Maximum amount" aria-label="Maximum amount" />
          <select style={filterControl} value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)} aria-label="Payment mode"><option value="">All payment methods</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="neft">NEFT / bank transfer</option><option value="manual">Other manual</option></select>
        </div>
      </section>
      {selectedView}
    </main>
  );
}

const normalizePaymentMode = (value) => {
  const mode = String(value || "cash").toLowerCase().replace(/\s+/g, "_");
  if (mode === "bank_transfer") return "neft";
  if (["cheque", "rtgs", "wire"].includes(mode)) return "manual";
  return mode;
};

const filterGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", alignItems: "end", gap: 10, marginTop: 14, marginBottom: 20, padding: 12, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 12, background: "rgba(255,255,255,.035)" };
const filterControl = { width: "100%", height: 40, minHeight: 40, boxSizing: "border-box", padding: "9px 11px", border: "1px solid var(--border-color, rgba(148,163,184,.3))", borderRadius: 9, background: "var(--input-bg, rgba(255,255,255,.7))", color: "var(--text-primary)", fontSize: 13, outline: "none" };
const searchControl = { gridColumn: "span 2", minWidth: 220, alignSelf: "end", boxShadow: "0 0 0 3px rgba(91,124,250,.08)" };
const filterLabel = { display: "grid", gap: 5, color: "var(--text-secondary)", fontSize: 11, fontWeight: 600 };
