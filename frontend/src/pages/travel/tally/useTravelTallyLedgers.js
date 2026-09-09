import { useEffect, useMemo, useState } from "react";
import { fetchApi } from "../../../utils/api";
import { emptyLedgerForm, systemLedgers } from "./ledgerConfig";
import { clearTallyState, loadTallyState, saveTallyState } from "./tallyStorage";
import { getTripLedgerRows } from "./tallyMath";

const ledgerStorageKey = "travel-tally-ledgers";
const ledgerDefaultsByType = {
  Sales: {
    group: "Sales Accounts",
    nature: "Sales",
    gstApplicability: "applicable",
    billWise: false,
  },
  Purchase: {
    group: "Purchase Accounts",
    nature: "Purchase",
    gstApplicability: "applicable",
    billWise: true,
  },
  GST: {
    group: "Duties & Taxes",
    nature: "Duties & Taxes",
    gstApplicability: "applicable",
    billWise: false,
  },
  TCS: {
    group: "Duties & Taxes",
    nature: "Duties & Taxes",
    gstApplicability: "not-applicable",
    billWise: false,
  },
  "GST/TCS": {
    group: "Duties & Taxes",
    nature: "Duties & Taxes",
    gstApplicability: "applicable",
    billWise: false,
  },
  Bank: {
    group: "Bank Accounts",
    nature: "Bank",
    gstApplicability: "not-applicable",
    billWise: false,
  },
  Cash: {
    group: "Cash-in-hand",
    nature: "Cash",
    gstApplicability: "not-applicable",
    billWise: false,
  },
  Expense: {
    group: "Indirect Expenses",
    nature: "Indirect Expense",
    gstApplicability: "applicable",
    billWise: false,
  },
  "Trip-wise": {
    group: "Current Assets",
    nature: "Indirect Income",
    gstApplicability: "not-applicable",
    billWise: false,
  },
  Custom: {
    group: "",
    nature: "Indirect Income",
    gstApplicability: "not-applicable",
    billWise: false,
  },
};

const toRemoteLedger = (ledger) => ({
  id: `db-${ledger.id}`,
  databaseId: ledger.id,
  name: ledger.ledgerName,
  type: ledger.ledgerCategory,
  group: ledger.ledgerGroup,
  nature: ledger.ledgerCategory,
  gstApplicability: ledger.gstApplicable ? "applicable" : "not-applicable",
  billWise: false,
  openingBalance: Number(ledger.openingBalance || 0),
  openingBalanceType: ledger.openingBalanceType || "DEBIT",
  tdsApplicable: Boolean(ledger.tdsApplicable),
  effectiveFrom: ledger.effectiveFrom ? String(ledger.effectiveFrom).slice(0, 10) : "",
  amount: 0,
  source: "Database",
  custom: true,
  status: ledger.status,
  syncStatus: ledger.syncStatus,
  sourceType: ledger.sourceType,
  sourceKey: ledger.sourceKey,
  subBrand: ledger.subBrand || "all",
});

export function useTravelTallyLedgers({
  accounts,
  masterSubBrand,
  statementItems = [],
  trips = [],
  customers = [],
  paymentDetails = [],
  suppliers = [],
  payables = [],
  tripTaxes = {},
  setError,
}) {
  const [remoteLedgers, setRemoteLedgers] = useState([]);
  const [ledgerDrafts, setLedgerDrafts] = useState(
    () => loadTallyState(ledgerStorageKey, {}).ledgerDrafts || {},
  );
  const [customLedgers, setCustomLedgers] = useState(
    () => loadTallyState(ledgerStorageKey, {}).customLedgers || [],
  );
  const [showLedgerForm, setShowLedgerForm] = useState(false);
  const [ledgerForm, setLedgerForm] = useState(emptyLedgerForm);

  const effectiveTrips = useMemo(() => {
    const existingIds = new Set(trips.map((trip) => String(trip.id)));
    const quoteTrips = [];
    const quoteIds = new Set();
    customers.forEach((row) => {
      if (row.quoteId == null || row.itineraryId != null || row.tripId != null) return;
      const quoteId = String(row.quoteId);
      const syntheticId = `quote-${quoteId}`;
      if (existingIds.has(syntheticId) || quoteIds.has(quoteId)) return;
      quoteIds.add(quoteId);
      quoteTrips.push({
        id: syntheticId,
        quoteId: Number(quoteId),
        destination: row.tripName || `Quote #${quoteId}`,
        status: "Quoted",
      });
    });
    return [...trips, ...quoteTrips];
  }, [trips, customers]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (masterSubBrand) params.set("subBrand", masterSubBrand);
    fetchApi(`/api/travel/tally/masters?${params}`)
      .then((data) => {
        setRemoteLedgers(
          // Built-in ledgers are already rendered from ledgerConfig.js. The
          // database copies exist to support mappings, but must not appear as
          // duplicate rows in the Ledger Accounts screen.
          (data?.ledgers || [])
            .filter((ledger) => ledger.sourceType !== "SYSTEM")
            .map(toRemoteLedger),
        );
        // Remove optimistic local copies left by older versions of this flow.
        const remoteSourceKeys = new Set((data?.ledgers || []).map((ledger) => ledger.sourceKey));
        if (remoteSourceKeys.size) {
          setCustomLedgers((current) => current.filter((ledger) => !remoteSourceKeys.has(ledger.id)));
        }
      })
      .catch(() => setRemoteLedgers([]));
  }, [masterSubBrand]);

  useEffect(() => {
    saveTallyState(ledgerStorageKey, { ledgerDrafts, customLedgers });
  }, [customLedgers, ledgerDrafts]);

  const ledgerRows = useMemo(() => {
    const calculatedById = new Map(
      accounts.map((account) => [account.id, account]),
    );
    const paymentBalances = paymentDetails.reduce(
      (balances, payment) => {
        const amount = Number(payment.amount || 0);
        const signedAmount = payment.direction === "DEBIT" ? -amount : amount;
        if (payment.ledger === "cash") balances.cash += signedAmount;
        else balances.bank += signedAmount;
        return balances;
      },
      { bank: 0, cash: 0 },
    );
    const tripwiseBalance = getTripLedgerRows({
      trips: effectiveTrips,
      customers,
      suppliers,
      payables,
      tripTaxes,
    }).reduce((sum, row) => sum + row.profit, 0);
    const gstTcsBalance = customers.reduce(
      (sum, row) =>
        sum +
        Number(
          row.gstTcsAmount ??
            Number(row.gstAmount || 0) + Number(row.tcsAmount || 0),
        ),
      0,
    );
    const expenseTotalsByCategory = suppliers.reduce((totals, row) => {
      const category = String(row.category || "").trim().toLowerCase();
      if (category) totals.set(category, (totals.get(category) || 0) + Number(row.amount || 0));
      return totals;
    }, new Map());
    const totalCustomers = customers.reduce((sum, row) => sum + Number(row.amount || row.invoiceTotal || 0), 0);
    const totalPurchases = payables.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const totalGstTcs = customers.reduce(
      (sum, row) => sum + Number(row.gstTcsAmount ?? Number(row.gstAmount || 0) + Number(row.tcsAmount || 0)),
      0,
    );
    const calculateCustomLedgerAmount = (ledger) => {
      const sourceType = String(ledger.sourceType || "CUSTOM").toUpperCase();
      const type = String(ledger.type || "").toUpperCase();
      const ledgerName = String(ledger.name || "").trim().toLowerCase();
      const category = sourceType === "EXPENSE"
        ? String(ledger.sourceKey || "").replace(/^EXPENSE:/i, "").trim().toLowerCase()
        : ledgerName;

      // Expense ledgers remain category-specific. Other custom ledger types
      // represent the corresponding overall account on the ledger page.
      let calculatedAmount = 0;
      if (sourceType === "EXPENSE" || type === "EXPENSE" || type === "CUSTOM") {
        calculatedAmount = expenseTotalsByCategory.get(category) || 0;
      } else if (type === "PURCHASE") {
        calculatedAmount = totalPurchases;
      } else if (type === "SALES") {
        calculatedAmount = totalCustomers;
      } else if (type === "GST" || type === "TCS" || type === "GST/TCS") {
        calculatedAmount = totalGstTcs;
      } else if (type === "BANK" || type === "CASH") {
        calculatedAmount = type === "CASH" ? paymentBalances.cash : paymentBalances.bank;
      } else if (type === "TRIP-WISE") {
        calculatedAmount = tripwiseBalance;
      }
      return {
        ...ledger,
        amount: Number(ledger.openingBalance || 0) + calculatedAmount,
        calculatedAmount,
      };
    };
    const calculatedRemoteLedgers = remoteLedgers.map(calculateCustomLedgerAmount);
    const calculatedCustomLedgers = customLedgers.map(calculateCustomLedgerAmount);
    return [
      ...systemLedgers.map((ledger) => {
        const account = calculatedById.get(ledger.id);
        const openingBalance = Number(
          ledgerDrafts[ledger.id]?.openingBalance || 0,
        );
        const paymentBalance =
          ledger.id === "cash" ? paymentBalances.cash : paymentBalances.bank;
        return {
          ...ledger,
          ...ledgerDrafts[ledger.id],
          amount:
            ledger.id === "bank" || ledger.id === "cash"
              ? openingBalance + paymentBalance
              : ledger.id === "tripwise"
                ? openingBalance + tripwiseBalance
                : ledger.id === "outputGst"
                  ? openingBalance +
                    gstTcsBalance
                : account?.amount ?? ledgerDrafts[ledger.id]?.openingBalance ?? 0,
          calculatedAmount:
            ledger.id === "bank" || ledger.id === "cash"
              ? paymentBalance
                : ledger.id === "tripwise"
                  ? tripwiseBalance
                  : ledger.id === "outputGst"
                    ? gstTcsBalance
                  : account?.calculatedAmount,
          source: "System",
          custom: false,
        };
      }),
      ...calculatedRemoteLedgers,
      ...calculatedCustomLedgers,
    ];
  }, [accounts, customLedgers, ledgerDrafts, remoteLedgers, statementItems, paymentDetails, effectiveTrips, customers, suppliers, payables, tripTaxes]);
  const hasSavedLedgers =
    Object.keys(ledgerDrafts).length > 0 || customLedgers.length > 0;

  const updateLedgerForm = (key, value) =>
    setLedgerForm((current) => {
      if (key !== "type") return { ...current, [key]: value };
      return {
        ...current,
        type: value,
        ...ledgerDefaultsByType[value],
      };
    });

  const startNewLedger = () => {
    setLedgerForm({
      ...emptyLedgerForm,
      subBrand: masterSubBrand || "all",
    });
    setShowLedgerForm(true);
    setError("");
  };

  const editLedger = (ledger) => {
    setLedgerForm({
      id: ledger.id,
      databaseId: ledger.databaseId,
      name: ledger.name || "",
      type: ledger.type || "Custom",
      group: ledger.group || "",
      nature: ledger.nature || "Indirect Income",
      gstApplicability: ledger.gstApplicability || "not-applicable",
      billWise: Boolean(ledger.billWise),
      openingBalance: String(ledger.openingBalance ?? ledger.amount ?? ""),
      openingBalanceType: ledger.openingBalanceType || "DEBIT",
      tdsApplicable: Boolean(ledger.tdsApplicable),
      effectiveFrom: ledger.effectiveFrom ? String(ledger.effectiveFrom).slice(0, 10) : "",
      subBrand: ledger.subBrand || "all",
      custom: Boolean(ledger.custom),
    });
    setShowLedgerForm(true);
    setError("");
  };

  const cancelLedger = () => {
    setShowLedgerForm(false);
    setLedgerForm(emptyLedgerForm);
  };

  const saveLedger = async () => {
    const name = ledgerForm.name.trim();
    if (!name) {
      setError("Enter ledger name.");
      return;
    }
    const amount =
      ledgerForm.openingBalance === "" ? 0 : Number(ledgerForm.openingBalance);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Enter a valid opening balance.");
      return;
    }
    const nextLedger = {
      ...ledgerForm,
      id: ledgerForm.id || `custom-${Date.now()}`,
      name,
      group: ledgerForm.group.trim(),
      nature: ledgerForm.nature,
      gstApplicability: ledgerForm.gstApplicability,
      billWise: Boolean(ledgerForm.billWise),
      openingBalance: amount,
      amount,
      source: ledgerForm.custom ? "Custom" : "System",
    };
    if (nextLedger.custom) {
      if (nextLedger.databaseId) {
        try { await fetchApi(`/api/travel/tally/ledgers/${nextLedger.databaseId}`, {
          method: "PUT",
          body: JSON.stringify({
            ledgerName: nextLedger.name,
            ledgerGroup: nextLedger.group,
            ledgerCategory: nextLedger.type,
            gstApplicable: nextLedger.gstApplicability === "applicable",
            tdsApplicable: nextLedger.tdsApplicable,
            openingBalance: nextLedger.openingBalance,
            openingBalanceType: nextLedger.openingBalanceType,
            effectiveFrom: nextLedger.effectiveFrom || null,
          }),
        }); } catch (_) { setError("Ledger saved locally but could not be updated in the database."); return; }
      } else {
        try {
          const data = await fetchApi("/api/travel/tally/ledgers", {
          method: "POST",
          body: JSON.stringify({
            subBrand: nextLedger.subBrand === "all" ? null : nextLedger.subBrand,
            sourceType: "CUSTOM",
            sourceKey: nextLedger.id,
            ledgerName: nextLedger.name,
            ledgerCategory: nextLedger.type,
            ledgerGroup: nextLedger.group,
            gstApplicable: nextLedger.gstApplicability === "applicable",
            tdsApplicable: nextLedger.tdsApplicable,
            openingBalance: nextLedger.openingBalance,
            openingBalanceType: nextLedger.openingBalanceType,
            effectiveFrom: nextLedger.effectiveFrom || null,
          }),
          });
          // The server is the source of truth for database-backed ledgers.
          // Do not keep the optimistic local copy, otherwise it renders twice.
          if (data?.ledger?.id != null) {
            setRemoteLedgers((current) => [
              ...current.filter((ledger) => ledger.sourceKey !== nextLedger.id),
              toRemoteLedger(data.ledger),
            ]);
            setCustomLedgers((current) => current.filter((ledger) => ledger.id !== nextLedger.id));
          }
        } catch (_) { setError("Ledger saved locally but could not be saved in the database."); return; }
      }
      if (nextLedger.databaseId) {
        setRemoteLedgers((current) => current.map((ledger) =>
          ledger.databaseId === nextLedger.databaseId
            ? { ...ledger, ...nextLedger, id: `db-${nextLedger.databaseId}`, source: "Database" }
            : ledger,
        ));
      }
    } else {
      setCustomLedgers((current) => {
        const exists = current.some((ledger) => ledger.id === nextLedger.id);
        return exists
          ? current.map((ledger) =>
              ledger.id === nextLedger.id ? nextLedger : ledger,
            )
          : [...current, nextLedger];
      });
      setLedgerDrafts((current) => ({
        ...current,
        [nextLedger.id]: {
          name: nextLedger.name,
          type: nextLedger.type,
          group: nextLedger.group,
          nature: nextLedger.nature,
          gstApplicability: nextLedger.gstApplicability,
          billWise: nextLedger.billWise,
          openingBalance: nextLedger.openingBalance,
          openingBalanceType: nextLedger.openingBalanceType,
          tdsApplicable: nextLedger.tdsApplicable,
          effectiveFrom: nextLedger.effectiveFrom,
          subBrand: nextLedger.subBrand,
        },
      }));
    }
    setShowLedgerForm(false);
    setLedgerForm(emptyLedgerForm);
    setError("");
  };

  const deleteCustomLedger = async (id) => {
    const ledger = ledgerRows.find((row) => row.id === id);
    if (ledger?.databaseId) {
      try {
        await fetchApi(`/api/travel/tally/ledgers/${ledger.databaseId}`, { method: "DELETE" });
        setRemoteLedgers((current) => current.filter((row) => row.id !== id));
        setError("");
      } catch (_) {
        setError("Could not delete the ledger from the database.");
      }
      return;
    }
    setCustomLedgers((current) => current.filter((row) => row.id !== id));
  };

  const resetSavedLedgers = () => {
    clearTallyState(ledgerStorageKey);
    setLedgerDrafts({});
    setCustomLedgers([]);
    setLedgerForm(emptyLedgerForm);
    setShowLedgerForm(false);
    setError("");
  };

  return {
    ledgerRows,
    hasSavedLedgers,
    ledgerForm,
    showLedgerForm,
    updateLedgerForm,
    startNewLedger,
    editLedger,
    cancelLedger,
    saveLedger,
    deleteCustomLedger,
    resetSavedLedgers,
  };
}
