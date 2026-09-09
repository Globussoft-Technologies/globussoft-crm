import { useEffect, useState } from "react";
import { fetchApi } from "../../../utils/api";
import { defaultLedgerMappings } from "./ledgerMappingConfig";
import { clearTallyState, loadTallyState, saveTallyState } from "./tallyStorage";

const mappingStorageKey = "travel-tally-ledger-mappings";

export function useTravelTallyLedgerMappings() {
  const [mappings, setMappings] = useState(() =>
    loadTallyState(mappingStorageKey, defaultLedgerMappings),
  );
  const [remoteMappings, setRemoteMappings] = useState([]);

  useEffect(() => {
    fetchApi("/api/travel/tally/mappings")
      .then((data) => {
        setRemoteMappings(
          (data?.mappings || []).map((mapping) => ({
            id: `db-${mapping.id}`,
            databaseId: mapping.id,
            label: mapping.sourceKey,
            description: `${mapping.sourceType} → ${mapping.transactionType}`,
            ledgerId: `db-${mapping.tallyLedgerId}`,
          })),
        );
      })
      .catch(() => setRemoteMappings([]));
  }, []);
  const visibleMappings = [
    ...mappings.filter(
      (mapping) =>
        !remoteMappings.some(
          (remote) => remote.label === mapping.label,
        ),
    ),
    ...remoteMappings,
  ];
  const hasSavedMappings =
    JSON.stringify(mappings) !== JSON.stringify(defaultLedgerMappings);

  useEffect(() => {
    saveTallyState(mappingStorageKey, mappings);
  }, [mappings]);

  const updateMapping = (mappingId, ledgerId) => {
    setMappings((current) =>
      current.map((mapping) =>
        mapping.id === mappingId ? { ...mapping, ledgerId } : mapping,
      ),
    );
    const remote = remoteMappings.find((mapping) => mapping.id === mappingId);
    if (remote?.databaseId) {
      const numericLedgerId = Number(String(ledgerId).replace(/^db-/, ""));
      if (Number.isInteger(numericLedgerId) && numericLedgerId > 0) {
        fetchApi(`/api/travel/tally/mappings/${remote.databaseId}`, {
          method: "PUT",
          body: JSON.stringify({ tallyLedgerId: numericLedgerId }),
        }).catch(() => undefined);
      }
    }
  };

  const resetMappings = () => setMappings(defaultLedgerMappings);

  const resetSavedMappings = () => {
    clearTallyState(mappingStorageKey);
    setMappings(defaultLedgerMappings);
  };

  return {
    mappings: visibleMappings,
    hasSavedMappings,
    updateMapping,
    resetMappings,
    resetSavedMappings,
  };
}
