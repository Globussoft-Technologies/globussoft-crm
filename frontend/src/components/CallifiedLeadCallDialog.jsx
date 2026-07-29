import { useEffect, useState } from "react";
import { Phone, X, Loader, AlertCircle } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

/**
 * Campaign picker + AI call trigger for a CRM lead.
 *
 * Flow:
 *   1. Load Callified campaigns for the tenant.
 *   2. User selects a campaign.
 *   3. Click Call → POST /api/callified/leads/:leadId/call
 *   4. Show success / error state.
 */
export default function CallifiedLeadCallDialog({ lead, onClose, onCalled }) {
  const notify = useNotify();
  const [campaigns, setCampaigns] = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [campaignError, setCampaignError] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingCampaigns(true);
    setCampaignError("");
    fetchApi("/api/callified/campaigns")
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.campaigns) ? res.campaigns : [];
        setCampaigns(list);
        if (list.length === 1) setSelectedCampaignId(String(list[0].id));
      })
      .catch((err) => {
        if (cancelled) return;
        setCampaignError(err?.message || "Failed to load campaigns");
      })
      .finally(() => {
        if (!cancelled) setLoadingCampaigns(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCall = async () => {
    if (!selectedCampaignId) {
      notify.error("Please select a campaign");
      return;
    }
    setCalling(true);
    setCallResult(null);
    try {
      const res = await fetchApi(`/api/callified/leads/${lead.id}/call`, {
        method: "POST",
        body: JSON.stringify({ campaignId: Number(selectedCampaignId) }),
      });
      setCallResult({ ok: true, ...res });
      notify.success(`AI call initiated for ${lead.name || "lead"}`);
      if (onCalled) onCalled(res);
    } catch (err) {
      const msg = err?.message || "Failed to initiate call";
      setCallResult({ ok: false, error: msg });
      notify.error(msg);
    } finally {
      setCalling(false);
    }
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Call lead with Callified AI"
    >
      <div
        className="card"
        style={{
          background: "var(--bg-color)",
          width: "100%",
          maxWidth: "480px",
          maxHeight: "90vh",
          overflow: "auto",
          borderRadius: "12px",
          border: "1px solid var(--border-color)",
          padding: "1.5rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Phone size={20} color="var(--accent-color)" /> Call {lead.name || "lead"}
          </h3>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}>
            <X size={20} />
          </button>
        </div>

        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1rem" }}>
          Choose a Callified campaign and trigger an AI outbound call to{" "}
          <strong>{lead.phone}</strong>.
        </p>

        {loadingCampaigns ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)", padding: "1rem 0" }}>
            <Loader size={18} style={{ animation: "spin 1s linear infinite" }} /> Loading campaigns…
          </div>
        ) : campaignError ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--danger-color)", padding: "1rem 0" }}>
            <AlertCircle size={18} /> {campaignError}
          </div>
        ) : campaigns.length === 0 ? (
          <div style={{ color: "var(--text-secondary)", padding: "1rem 0" }}>
            No active Callified campaigns found. Create a campaign in Callified first.
          </div>
        ) : (
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)", display: "block", marginBottom: "0.35rem" }}>
              Campaign
            </label>
            <select
              className="input-field"
              value={selectedCampaignId}
              onChange={(e) => setSelectedCampaignId(e.target.value)}
              disabled={calling}
              style={{ width: "100%" }}
            >
              <option value="">Select a campaign…</option>
              {campaigns.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name || `Campaign ${c.id}`}
                  {c.product_name ? ` — ${c.product_name}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {callResult && (
          <div
            style={{
              padding: "0.75rem 1rem",
              borderRadius: "8px",
              marginBottom: "1rem",
              background: callResult.ok ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
              border: `1px solid ${callResult.ok ? "#10b981" : "#ef4444"}`,
              color: callResult.ok ? "#10b981" : "#ef4444",
              fontSize: "0.875rem",
            }}
          >
            {callResult.ok
              ? `Call initiated. Callified lead id: ${callResult.callifiedLeadId}. Use the details icon to fetch the transcript after the call ends.`
              : callResult.error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
            disabled={calling}
            style={{ padding: "0.625rem 1rem" }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleCall}
            className="btn-primary"
            disabled={calling || !selectedCampaignId || campaigns.length === 0}
            style={{ padding: "0.625rem 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            {calling ? (
              <>
                <Loader size={16} style={{ animation: "spin 1s linear infinite" }} /> Calling…
              </>
            ) : (
              <>
                <Phone size={16} /> Call Now
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
