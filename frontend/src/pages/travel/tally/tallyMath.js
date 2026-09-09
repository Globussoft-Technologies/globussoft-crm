export const toTallyAmount = (value) => Number(value || 0);

export const getInvoiceAmount = (row) =>
  toTallyAmount(row.invoiceAmount ?? row.invoiceTotal ?? row.amount);

export const getReceivedAmount = (row) => toTallyAmount(row.amount);

export const tripDisplayName = (trip) =>
  trip.destination || trip.tripCode || trip.name || `Trip ${trip.id}`;

export const rowMatchesTrip = (row, tripId) => {
  const id = String(tripId);
  if (id.startsWith("quote-")) return String(row.quoteId || "") === id.slice(6);
  return String(row.itineraryId) === id || String(row.tripId) === id.replace(/^tmc-/, "");
};

export const getTripSales = (customers, tripId) =>
  customers
    .filter((row) => rowMatchesTrip(row, tripId))
    .reduce(
      // Trip-wise sales are the invoice/package total. Collected amounts are
      // intentionally reserved for the bank and cash ledgers.
      (sum, row) => sum + getInvoiceAmount(row),
      0,
    );

// Cash collected from customers. `amount` is the canonical received amount
// returned by /api/travel/tally/ledger; invoiceAmount is the accrual value and
// must not be used for a paid/cash summary.
export const getTripReceivedSales = (customers, tripId) =>
  customers
    .filter((row) => rowMatchesTrip(row, tripId))
    .reduce((sum, row) => sum + getReceivedAmount(row), 0);

export const getTripTaxAmounts = ({ sales, tripId, tripTaxes, customers = [] }) => {
  const backendRows = customers.filter(
    (row) => rowMatchesTrip(row, tripId),
  );

  const hasStoredTax = backendRows.some(
    (row) => row.gstRetrieved || row.gstTcsAmount != null,
  );
  if (hasStoredTax) {
    return backendRows.reduce(
      (sum, row) => ({
        gst:
          sum.gst +
          Number(
            row.gstAmount ||
              (row.gstAmount === 0 && Number(row.tcsAmount || 0) === 0
                ? row.gstTcsAmount || 0
                : 0),
          ),
        tcs: sum.tcs + Number(row.tcsAmount || 0),
      }),
      { gst: 0, tcs: 0 },
    );
  }
  const tax = tripTaxes[String(tripId)] || {};

  return {
    gst: (sales * toTallyAmount(tax.gstRate)) / 100,
    tcs: (sales * toTallyAmount(tax.tcsRate)) / 100,
  };
};

export const getTripLedgerRows = ({
  trips,
  customers,
  suppliers = [],
  payables = [],
  tripTaxes = {},
}) =>
  trips.map((trip) => {
    const tripId = String(trip.id);
    const invoiceSales = getTripSales(customers, tripId);
    const receivedSales = getTripReceivedSales(customers, tripId);
    const unpaidSales = Math.max(0, invoiceSales - receivedSales);
    const commonExpenses = suppliers
      .filter((row) => !row.isTripExpense && rowMatchesTrip(row, tripId))
      .reduce((sum, row) => sum + toTallyAmount(row.amount), 0);
    const purchase = payables
      .filter((row) => rowMatchesTrip(row, tripId))
      .reduce((sum, row) => sum + toTallyAmount(row.amount), 0);
    const { gst: invoicedGst, tcs: invoicedTcs } = getTripTaxAmounts({ sales: invoiceSales, tripId, tripTaxes, customers });
    const gst = invoicedGst;
    const tcs = invoicedTcs;
    const cashProfit = receivedSales - purchase - commonExpenses - gst - tcs;
    const totalSales = receivedSales + unpaidSales;
    const accrualProfit = totalSales - purchase - commonExpenses - invoicedGst - invoicedTcs;

    return {
      id: tripId,
      label: tripDisplayName(trip),
      status: trip.status || "Booking",
      sales: receivedSales,
      invoicedSales: invoiceSales,
      receivedSales,
      unpaidSales,
      purchase,
      commonExpenses,
      gst,
      tcs,
      profit: cashProfit,
      cashProfit,
      accrualProfit,
    };
  });

export const getTripTaxTotals = ({ trips, customers, tripTaxes }) =>
  trips.reduce(
    (sum, trip) => {
      const sales = getTripSales(customers, trip.id);
      const tax = getTripTaxAmounts({
        sales,
        tripId: trip.id,
        tripTaxes,
        customers,
      });

      return {
        gst: sum.gst + tax.gst,
        tcs: sum.tcs + tax.tcs,
      };
    },
    { gst: 0, tcs: 0 },
  );
