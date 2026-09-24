import { useEffect, useState } from "react";
import { fetchApi } from "../../../utils/api";
import { defaultTravelTallyMaster } from "./travelTallyMasterConfig";
import { clearTallyState } from "./tallyStorage";

const masterDetailsApiPath = "/api/travel/tally/master-details";
const legacyMasterStorageKey = "travel-tally-master";
const masterFieldNames = [
  "companyName",
  "mailingName",
  "gstin",
  "pan",
  "state",
  "address",
  "country",
  "pinCode",
  "contactNumber",
  "email",
  "bankDetails",
  "financialYear",
  "financialYearTo",
  "booksBeginningFrom",
  "voucherNumbering",
  "baseCurrency",
  "openingBalanceMode",
];

const mergeMasterDetails = (current, next) =>
  masterFieldNames.reduce(
    (merged, field) => ({ ...merged, [field]: next?.[field] ?? current[field] }),
    current,
  );

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isValidFinancialYear = (value) => {
  const match = /^(\d{4})-(\d{4})$/.exec(value);
  return Boolean(match && Number(match[2]) === Number(match[1]) + 1);
};
const parseDayFirstDate = (value) => {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return date.getFullYear() === Number(match[3])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[1])
    ? date
    : null;
};

export function useTravelTallyMaster() {
  const [master, setMaster] = useState(defaultTravelTallyMaster);
  const [savedMaster, setSavedMaster] = useState(defaultTravelTallyMaster);
  const [masterHydrated, setMasterHydrated] = useState(false);

  useEffect(() => {
    clearTallyState(legacyMasterStorageKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchApi(masterDetailsApiPath)
      .then((data) => {
        if (cancelled) return;
        if (data?.masterDetails) {
          setMaster((current) => {
            const merged = mergeMasterDetails(current, data.masterDetails);
            setSavedMaster(merged);
            return merged;
          });
        }
      })
      .catch(() => {
        // Keep the default form available if the database read fails.
      })
      .finally(() => {
        if (!cancelled) setMasterHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateMaster = (key) => (value) =>
    setMaster((current) => {
      if (key.startsWith("bankDetails.")) {
        const bankField = key.slice("bankDetails.".length);
        return {
          ...current,
          bankDetails: {
            ...(current.bankDetails || {}),
            [bankField]: value,
          },
        };
      }
      return {
        ...current,
        [key]: value,
        ...(key === "from" ? { to: "" } : {}),
        ...(key === "subBrand" ? { tripId: "", quoteId: "" } : {}),
      };
    });

  const validateMasterStep = () => {
    if (!master.companyName.trim()) return "Enter the company name to continue.";
    if (!master.subBrand) return "Select a sub-brand to continue.";
    if (!master.state.trim()) return "Enter the registered state to continue.";
    if (!master.country.trim()) return "Enter the country to continue.";
    if (!master.financialYear.trim())
      return "Enter the financial year to continue.";
    if (!isValidFinancialYear(master.financialYear.trim()))
      return "Enter the financial year in YYYY-YYYY format, for example 2026-2027.";
    if (!master.financialYearTo.trim())
      return "Enter the financial year end date to continue.";
    const financialYearEnd = parseDayFirstDate(master.financialYearTo.trim());
    if (!financialYearEnd)
      return "Enter the financial year end date in DD-MM-YYYY format.";
    const yearMatch = /^(\d{4})-(\d{4})$/.exec(master.financialYear.trim());
    if (financialYearEnd.getFullYear() !== Number(yearMatch[2]) || financialYearEnd.getMonth() !== 2 || financialYearEnd.getDate() !== 31)
      return "The financial year end date must be 31 March of the ending year.";
    if (!master.booksBeginningFrom)
      return "Select the books beginning date to continue.";
    const booksBeginning = master.booksBeginningFrom.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(booksBeginning))
      return "Enter the books beginning date in YYYY-MM-DD format.";
    if (booksBeginning < `${yearMatch[1]}-04-01` || booksBeginning > `${yearMatch[2]}-03-31`)
      return `Books beginning date must be between 01-04-${yearMatch[1]} and 31-03-${yearMatch[2]}.`;
    if (master.email.trim() && !isValidEmail(master.email.trim()))
      return "Enter a valid email address.";
    if (master.gstin.trim() && !/^[0-9A-Z]{15}$/.test(master.gstin.trim().toUpperCase()))
      return "Enter a valid 15-character GSTIN.";
    if (master.pan.trim() && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(master.pan.trim().toUpperCase()))
      return "Enter a valid PAN.";
    if (master.pinCode.trim() && !/^\d{6}$/.test(master.pinCode.trim()))
      return "Enter a valid 6-digit PIN code.";
    if (master.contactNumber.trim() && !/^\+?[0-9 ()-]{7,20}$/.test(master.contactNumber.trim()))
      return "Enter a valid contact number.";
    if (master.bankDetails?.accountNumber?.trim() && !/^\d{9,18}$/.test(master.bankDetails.accountNumber.trim()))
      return "Enter a valid 9–18 digit bank account number.";
    if (master.bankDetails?.ifscCode?.trim() && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(master.bankDetails.ifscCode.trim().toUpperCase()))
      return "Enter a valid IFSC code.";
    if (master.bankDetails?.upiId?.trim() && !/^[\w.-]+@[\w.-]+$/.test(master.bankDetails.upiId.trim()))
      return "Enter a valid UPI ID.";
    if (master.from && master.to && master.to <= master.from)
      return "To date must be after the From date.";
    return "";
  };

  const saveMaster = async () => {
    if (!masterHydrated) return;
    await fetchApi(masterDetailsApiPath, {
      method: "PUT",
      body: JSON.stringify({
        masterDetails: master,
      }),
    });
    setSavedMaster(master);
  };

  const cancelEdit = () => setMaster(savedMaster);

  return {
    master,
    masterHydrated,
    isConfigured: Boolean(master.companyName && master.state && master.financialYear && master.financialYearTo && master.booksBeginningFrom),
    updateMaster,
    validateMasterStep,
    saveMaster,
    cancelEdit,
  };
}
