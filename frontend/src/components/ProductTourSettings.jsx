import { useState } from "react";
import { Compass, RotateCcw } from "lucide-react";
import { useProductTour } from "../tours/useProductTour";
import TourCatalogue from "./TourCatalogue";

export default function ProductTourSettings() {
  const [showCatalogue, setShowCatalogue] = useState(false);
  const {
    isAvailable,
    effectiveEnabled,
    organizationEnabled,
    canManageOrganization,
    preferences,
    currentFeature,
    setPreferences,
    setOrganizationEnabled,
    restartAllTours,
    startCurrentTour,
  } = useProductTour();

  if (!isAvailable) return null;

  const toggleRow = (key, label, description) => (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: 14 }}>
      <input
        type="checkbox"
        checked={preferences[key] !== false}
        onChange={(event) => setPreferences({ [key]: event.target.checked })}
        style={{ marginTop: 3 }}
      />
      <span>
        <strong style={{ display: "block", fontSize: 14 }}>{label}</strong>
        <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{description}</span>
      </span>
    </label>
  );

  return (
    <div className="card" data-testid="product-tour-settings" data-tour="personal-tour-settings" style={{ padding: "clamp(1.25rem, 3vw, 2rem)", marginBottom: "1rem" }}>
      <h3 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 1rem", display: "flex", alignItems: "center", gap: 8 }}>
        <Compass size={20} color="var(--accent-color)" /> Product Tours
      </h3>
      {canManageOrganization && (
        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--border-color)" }}>
          <input type="checkbox" checked={organizationEnabled} onChange={(event) => setOrganizationEnabled(event.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <strong style={{ display: "block", fontSize: 14 }}>Enable product tours for this organization</strong>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>Organization-wide control. When disabled, tours are unavailable to every user.</span>
          </span>
        </label>
      )}
      {!organizationEnabled && (
        <p role="status" style={{ color: "var(--text-secondary)", background: "var(--subtle-bg)", padding: 10, borderRadius: 8 }}>
          Product tours are currently disabled for this organization{canManageOrganization ? "." : " by an administrator."}
        </p>
      )}
      {toggleRow("enabled", "Enable guided tours", "Allow product tours and the Tour this page action.")}
      {toggleRow("autoStart", "Automatically start new tours", "Show a tour the first time you visit a feature.")}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
        <button type="button" className="btn-primary" onClick={() => setShowCatalogue(true)}>
          Browse all tours
        </button>
        <button type="button" className="btn-secondary" onClick={restartAllTours} disabled={!effectiveEnabled}>
          <RotateCcw size={14} style={{ marginRight: 6 }} /> Restart all tours
        </button>
        {currentFeature && effectiveEnabled && (
          <button type="button" className="btn-primary" onClick={startCurrentTour}>
            Tour this page
          </button>
        )}
      </div>
      {showCatalogue && <TourCatalogue onClose={() => setShowCatalogue(false)} />}
    </div>
  );
}
