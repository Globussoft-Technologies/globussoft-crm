import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchApi } from "../../../utils/api";
import TallyVoucherSetup from "./TallyVoucherSetup";
import { loadTallyState } from "./tallyStorage";
import { useTravelTallyLedgerMappings } from "./useTravelTallyLedgerMappings";
import { useTravelTallyLedgers } from "./useTravelTallyLedgers";
import { useTravelTallyMaster } from "./useTravelTallyMaster";
import { useTravelTallyVoucherSetup } from "./useTravelTallyVoucherSetup";

const statementItemsStorageKey = "travel-tally-statement-items";

export default function VoucherMasterSetupPage() {
  const navigate = useNavigate();
  const { master } = useTravelTallyMaster();
  const [accounts, setAccounts] = useState([]);
  const [statementItems] = useState(() =>
    loadTallyState(statementItemsStorageKey, []),
  );
  const [error, setError] = useState("");
  const ledgerState = useTravelTallyLedgers({
    accounts,
    masterSubBrand: master.subBrand,
    statementItems,
    setError,
  });
  const ledgerMappingState = useTravelTallyLedgerMappings();
  const voucherSetupState = useTravelTallyVoucherSetup();
  const selectedSubBrand = master.subBrand === "all" ? "" : master.subBrand;

  useEffect(() => {
    if (master.subBrand !== "all" && !master.subBrand) return undefined;
    let cancelled = false;
    const params = new URLSearchParams({ subBrand: master.subBrand });
    if (master.from) params.set("from", master.from);
    if (master.to) params.set("to", master.to);
    if (master.tripId) params.set("itineraryId", master.tripId);
    fetchApi(`/api/travel/tally/ledger?${params}`)
      .then((data) => {
        if (!cancelled) setAccounts(data?.accounts || []);
      })
      .catch(() => {
        if (!cancelled) {
          setAccounts([]);
          setError("Could not load ledger settings.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [master.subBrand, master.tripId, master.from, master.to]);

  return (
    <main style={{ padding: 20 }}>
      <button
        type="button"
        onClick={() => navigate(-1)}
        style={{
          border: "1px solid var(--border-color, rgba(148,163,184,.25))",
          borderRadius: 8,
          padding: "8px 12px",
          background: "transparent",
          color: "var(--text-primary)",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <ArrowLeft size={16} />
        Back
      </button>
      <h1 style={{ margin: 0, fontSize: "1.6rem" }}>Voucher master setup</h1>
      <p style={{ color: "var(--text-secondary)", margin: "6px 0 16px" }}>
        Configure voucher types, numbering, ledger mappings, and export status.
      </p>
      {error && (
        <p style={{ color: "#ef4444", fontWeight: 700 }}>{error}</p>
      )}
      <TallyVoucherSetup
        voucherTypes={voucherSetupState.voucherTypes}
        updateVoucherType={voucherSetupState.updateVoucherType}
        ledgerMappings={ledgerMappingState.mappings}
        ledgerRows={ledgerState.ledgerRows}
        master={master}
        selectedSubBrandLabel={selectedSubBrand || "All sub-brands"}
      />
    </main>
  );
}
