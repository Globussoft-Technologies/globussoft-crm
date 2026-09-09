import { useState } from "react";

const card = {
  background: "var(--card-bg, rgba(255,255,255,.04))",
  border: "1px solid var(--border-color, rgba(148,163,184,.2))",
  borderRadius: 14,
};

export default function TallySetupReset({ hasSavedSetup, onReset }) {
  const [confirming, setConfirming] = useState(false);

  const handleReset = () => {
    if (!hasSavedSetup) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }

    onReset();
    setConfirming(false);
  };

  return (
    <div
      style={{
        ...card,
        padding: 14,
        marginBottom: 16,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 4,
          }}
        >
          <strong>Saved Tally setup</strong>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".03em",
              padding: "3px 8px",
              borderRadius: 999,
              background: hasSavedSetup
                ? "rgba(16,185,129,.15)"
                : "rgba(148,163,184,.15)",
              color: hasSavedSetup ? "#34d399" : "var(--text-secondary)",
            }}
          >
            {hasSavedSetup ? "Saved locally" : "Using defaults"}
          </span>
        </div>
        <small style={{ display: "block", color: "var(--text-secondary)" }}>
          Clear saved ledgers and mapping selections from this browser.
        </small>
      </div>
      <button
        type="button"
        disabled={!hasSavedSetup}
        onClick={handleReset}
        style={{
          border: confirming ? "1px solid #f59e0b" : "1px solid #ef4444",
          borderRadius: 8,
          padding: "8px 12px",
          background: "transparent",
          color: confirming ? "#f59e0b" : "#f87171",
          fontWeight: 700,
          opacity: hasSavedSetup ? 1 : 0.5,
          cursor: hasSavedSetup ? "pointer" : "not-allowed",
        }}
      >
        {confirming ? "Click Again To Confirm" : "Clear Saved Setup"}
      </button>
    </div>
  );
}
