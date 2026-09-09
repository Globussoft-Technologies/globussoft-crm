import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { useNavigate } from "react-router-dom";
import TallyMasterSection from "./TallyMasterSection";
import TallySectionNav, { TallyWriteGate } from "./TallySectionNav";
import { useTravelTallyMaster } from "./useTravelTallyMaster";

export default function TallyCompanySetupPage() {
  const navigate = useNavigate();
  const { master, updateMaster, validateMasterStep, saveMaster, cancelEdit, isConfigured, masterHydrated } =
    useTravelTallyMaster();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // Start locked while the saved database record is being hydrated. This
  // prevents a saved setup from briefly rendering as editable on reload.
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (masterHydrated) setEditing(!isConfigured);
  }, [masterHydrated, isConfigured]);

  const save = async () => {
    const validationError = validateMasterStep();
    if (validationError) {
      setMessage("");
      setError(validationError);
      return;
    }
    try {
      await saveMaster();
      setError("");
      setMessage("Company setup saved.");
      setEditing(false);
    } catch {
      setMessage("");
      setError("Company setup could not be saved. Please try again.");
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <TallySectionNav showBack />
      <section
        style={{
          padding: 20,
          border: "1px solid var(--border-color, rgba(148,163,184,.2))",
          borderRadius: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: "0 0 6px" }}>Company Setup</h1>
          {!editing && <TallyWriteGate><button type="button" onClick={() => { setEditing(true); setMessage(""); }} aria-label="Edit Company Setup" title="Edit Company Setup" style={iconButtonStyle}><Pencil size={18} /></button></TallyWriteGate>}
        </div>
        <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
          Maintain the accounting company information used by the Tally module.
        </p>
        <fieldset disabled={!editing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <TallyMasterSection master={master} updateMaster={updateMaster} />
        </fieldset>
        {error && <p style={{ color: "#ef4444", fontWeight: 700 }}>{error}</p>}
        {message && <p style={{ color: "#10b981", fontWeight: 700 }}>{message}</p>}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          {editing && <><TallyWriteGate><button type="button" onClick={save} style={buttonStyle}>Save Company Setup</button></TallyWriteGate>{isConfigured && <button type="button" onClick={() => { cancelEdit(); setEditing(false); setError(""); setMessage(""); }} style={secondaryButtonStyle}>Cancel Edit</button>}</>}
          <button
            type="button"
            onClick={() => navigate("/travel/tally/ledger")}
            style={secondaryButtonStyle}
          >
            Continue to Ledgers
          </button>
        </div>
      </section>
    </main>
  );
}

const buttonStyle = {
  border: "0",
  borderRadius: 8,
  padding: "10px 14px",
  background: "var(--primary-color, var(--accent-color))",
  color: "white",
  fontWeight: 700,
  cursor: "pointer",
};

const iconButtonStyle = {
  border: "1px solid var(--border-color, rgba(148,163,184,.3))",
  borderRadius: 8,
  padding: 9,
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const secondaryButtonStyle = {
  border: "1px solid var(--border-color, rgba(148,163,184,.3))",
  borderRadius: 8,
  padding: "10px 14px",
  background: "transparent",
  color: "var(--text-primary)",
  fontWeight: 700,
  cursor: "pointer",
};
