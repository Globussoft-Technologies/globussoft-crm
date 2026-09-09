export const defaultTravelTallyMaster = {
  companyName: "",
  mailingName: "",
  gstin: "",
  pan: "",
  state: "",
  address: "",
  country: "India",
  pinCode: "",
  contactNumber: "",
  email: "",
  bankDetails: {
    bankName: "",
    accountName: "",
    accountNumber: "",
    ifscCode: "",
    branchName: "",
    upiId: "",
  },
  financialYear: "",
  financialYearTo: "",
  booksBeginningFrom: "",
  voucherNumbering: "auto",
  baseCurrency: "INR",
  openingBalanceMode: "adjusted",
  subBrand: "all",
  tripId: "",
  quoteId: "",
  from: "",
  to: "",
};

export const voucherNumberingOptions = [
  { value: "auto", label: "Automatic" },
  { value: "manual", label: "Manual" },
  { value: "auto-manual", label: "Automatic with manual override" },
];

export const baseCurrencyOptions = [
  { value: "INR", label: "INR" },
  { value: "USD", label: "USD" },
  { value: "AED", label: "AED" },
  { value: "SAR", label: "SAR" },
];

export const openingBalanceModeOptions = [
  { value: "adjusted", label: "Adjusted in current books" },
  { value: "separate", label: "Separate opening balance entry" },
  { value: "none", label: "No opening balance adjustment" },
];
