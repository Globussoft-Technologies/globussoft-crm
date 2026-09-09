export const defaultLedgerMappings = [
  {
    id: "travelInvoice",
    label: "Travel invoice",
    description: "Customer invoice and package billing",
    ledgerId: "sales",
  },
  {
    id: "customerPayment",
    label: "Customer payment",
    description: "Payment received from customer",
    ledgerId: "bank",
  },
  {
    id: "supplierPayable",
    label: "Supplier payable",
    description: "Hotel, flight, visa, and ground supplier cost",
    ledgerId: "purchase",
  },
  {
    id: "officeExpense",
    label: "Office expense",
    description: "Non-trip office or admin expense",
    ledgerId: "officeExpenses",
  },
  {
    id: "outputGst",
    label: "GST/TCS collected",
    description: "GST and TCS collected on customer sales",
    ledgerId: "outputGst",
  },
  {
    id: "tcsCollected",
    label: "TCS collected",
    description: "TCS collected for applicable travel",
    ledgerId: "outputGst",
  },
  {
    id: "cashEntry",
    label: "Cash entry",
    description: "Cash receipt or payment",
    ledgerId: "cash",
  },
  {
    id: "roundOff",
    label: "Round off",
    description: "Small invoice rounding adjustments",
    ledgerId: "officeExpenses",
  },
];
