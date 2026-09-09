import { useEffect, useState } from "react";
import { defaultVoucherTypes } from "./travelTallyVoucherConfig";
import { loadTallyState, saveTallyState } from "./tallyStorage";

const voucherStorageKey = "travel-tally-voucher-setup";

const mergeVoucherTypes = (saved = []) =>
  defaultVoucherTypes.map((voucher) => {
    const existing = saved.find((row) => row.id === voucher.id);
    return existing ? { ...voucher, ...existing } : voucher;
  });

export function useTravelTallyVoucherSetup() {
  const [voucherTypes, setVoucherTypes] = useState(() =>
    mergeVoucherTypes(loadTallyState(voucherStorageKey, defaultVoucherTypes)),
  );

  useEffect(() => {
    saveTallyState(voucherStorageKey, voucherTypes);
  }, [voucherTypes]);

  const updateVoucherType = (id, key, value) =>
    setVoucherTypes((current) =>
      current.map((voucher) =>
        voucher.id === id ? { ...voucher, [key]: value } : voucher,
      ),
    );

  const getVoucherType = (id) =>
    voucherTypes.find((voucher) => voucher.id === id) ||
    defaultVoucherTypes.find((voucher) => voucher.id === id);

  return {
    voucherTypes,
    updateVoucherType,
    getVoucherType,
  };
}
