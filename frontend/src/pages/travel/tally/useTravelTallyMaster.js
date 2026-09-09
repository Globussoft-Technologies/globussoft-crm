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
    if (!master.financialYear.trim())
      return "Enter the financial year to continue.";
    if (!master.financialYearTo.trim())
      return "Enter the financial year end date to continue.";
    if (!master.booksBeginningFrom)
      return "Select the books beginning date to continue.";
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
