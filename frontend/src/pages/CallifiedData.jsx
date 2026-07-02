import React, { useState, useEffect, useContext } from "react";
import { AuthContext } from "../App";
import { getAuthToken } from "../utils/api";
import { useNotify } from "../utils/notify";
import {
  Phone,
  MessageCircle,
  Clock,
  ThumbsUp,
  ThumbsDown,
  Calendar,
  Loader,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";

export default function CallifiedData() {
  const { user } = useContext(AuthContext);
  const notify = useNotify();
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expandedCampaign, setExpandedCampaign] = useState(null);
  const [expandedLead, setExpandedLead] = useState(null);
  const [lastSyncTime, setLastSyncTime] = useState(null);

  useEffect(() => {
    fetchCampaignData();
  }, []);

  const fetchCampaignData = async (isManualSync = false) => {
    try {
      if (isManualSync) {
        setSyncing(true);
      } else {
        setLoading(true);
      }

      const token = getAuthToken();
      if (!token) {
        notify.error("No authentication token found");
        return;
      }

      // Call the CRM backend endpoint which proxies to Callified
      const response = await fetch(
        "/api/integrations/callified/external-transcripts",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `API returned ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      setCampaigns(data || []);
      setLastSyncTime(new Date().toLocaleTimeString());

      if (isManualSync) {
        notify.success("Callified data synced successfully");
      }
    } catch (err) {
      console.error("Error fetching campaign data:", err);
      const errorMsg = err.message?.includes("401")
        ? "Authentication failed. Please log in again."
        : "Failed to load Callified data. Please check your Callified configuration.";
      notify.error(errorMsg);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loadingContainer}>
          <Loader size={32} style={{ animation: "spin 2s linear infinite" }} />
          <p>Loading Callified campaigns...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h1>Callified Campaigns & Transcripts</h1>
          <p style={styles.subtitle}>
            AI-powered call transcripts and analysis from your campaigns
          </p>
          {lastSyncTime && (
            <p style={styles.syncTime}>Last synced: {lastSyncTime}</p>
          )}
        </div>
        <button
          onClick={() => fetchCampaignData(true)}
          disabled={syncing}
          style={{
            ...styles.syncButton,
            opacity: syncing ? 0.6 : 1,
            cursor: syncing ? "not-allowed" : "pointer",
          }}
        >
          <RefreshCw
            size={18}
            style={{
              animation: syncing ? "spin 1s linear infinite" : "none",
            }}
          />
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>

      {!campaigns.length ? (
        <div style={styles.emptyState}>
          <Phone size={48} style={{ opacity: 0.3 }} />
          <p>No campaign data available</p>
        </div>
      ) : (
        <>
          {campaigns.map((campaign) => (
            <div key={campaign.campaign_id} style={styles.campaignCard}>
              {/* Campaign Header */}
              <button
                onClick={() =>
                  setExpandedCampaign(
                    expandedCampaign === campaign.campaign_id
                      ? null
                      : campaign.campaign_id,
                  )
                }
                style={{
                  ...styles.campaignHeader,
                  backgroundColor:
                    expandedCampaign === campaign.campaign_id
                      ? "var(--card-bg)"
                      : "transparent",
                }}
              >
                <div style={styles.campaignInfo}>
                  <h2 style={styles.campaignName}>{campaign.campaign_name}</h2>
                  <div style={styles.campaignMeta}>
                    <span style={styles.badge}>{campaign.channel}</span>
                    <span style={styles.status}>{campaign.status}</span>
                    <span style={styles.count}>
                      {campaign.totals.total} leads • {campaign.totals.called}{" "}
                      called
                    </span>
                  </div>
                </div>
                <div style={styles.campaignStats}>
                  <div style={styles.statBox}>
                    <span style={styles.statLabel}>Qualified</span>
                    <span style={styles.statValue}>
                      {campaign.totals.qualified}
                    </span>
                  </div>
                  <div style={styles.statBox}>
                    <span style={styles.statLabel}>Booked</span>
                    <span style={styles.statValue}>
                      {campaign.totals.booked}
                    </span>
                  </div>
                  {expandedCampaign === campaign.campaign_id ? (
                    <ChevronUp size={20} />
                  ) : (
                    <ChevronDown size={20} />
                  )}
                </div>
              </button>

              {/* Expanded Campaign Content */}
              {expandedCampaign === campaign.campaign_id && (
                <div style={styles.campaignContent}>
                  {campaign.leads.length === 0 ? (
                    <p style={styles.noData}>No leads in this campaign</p>
                  ) : (
                    campaign.leads.map((lead) => (
                      <div key={lead.lead_id} style={styles.leadCard}>
                        <button
                          onClick={() =>
                            setExpandedLead(
                              expandedLead === lead.lead_id
                                ? null
                                : lead.lead_id,
                            )
                          }
                          style={styles.leadHeader}
                        >
                          <div style={styles.leadInfo}>
                            <h3 style={styles.leadName}>{lead.lead_name}</h3>
                            <p style={styles.leadPhone}>{lead.phone}</p>
                            <span style={styles.leadStatus}>{lead.status}</span>
                          </div>
                          <div style={styles.leadMeta}>
                            <span style={styles.callCount}>
                              {lead.calls.length} calls
                            </span>
                            {expandedLead === lead.lead_id ? (
                              <ChevronUp size={16} />
                            ) : (
                              <ChevronDown size={16} />
                            )}
                          </div>
                        </button>

                        {/* Expanded Lead Content - Calls */}
                        {expandedLead === lead.lead_id && (
                          <div style={styles.callsList}>
                            {lead.calls.map((call) => (
                              <div key={call.id} style={styles.callItem}>
                                <div style={styles.callHeader}>
                                  <div style={styles.callMeta}>
                                    <Clock size={16} />
                                    <span>
                                      {new Date(
                                        call.created_at,
                                      ).toLocaleDateString()}
                                    </span>
                                    <span style={styles.duration}>
                                      {call.duration_s.toFixed(1)}s
                                    </span>
                                  </div>
                                  {call.conclusion && (
                                    <div style={styles.sentimentBadge}>
                                      {call.conclusion.sentiment ===
                                      "positive" ? (
                                        <ThumbsUp
                                          size={14}
                                          style={{ color: "#10b981" }}
                                        />
                                      ) : (
                                        <ThumbsDown
                                          size={14}
                                          style={{ color: "#ef4444" }}
                                        />
                                      )}
                                      <span style={styles.sentimentText}>
                                        {call.conclusion.sentiment}
                                      </span>
                                    </div>
                                  )}
                                </div>

                                {/* Transcript */}
                                {call.transcript &&
                                  call.transcript.length > 0 && (
                                    <div style={styles.transcript}>
                                      {call.transcript.map((msg, idx) => (
                                        <div
                                          key={idx}
                                          style={{
                                            ...styles.transcriptMessage,
                                            backgroundColor:
                                              msg.role === "AI"
                                                ? "var(--primary-color, #6366f1)"
                                                : "#e5e7eb",
                                            color:
                                              msg.role === "AI"
                                                ? "white"
                                                : "#1f2937",
                                            marginLeft:
                                              msg.role === "AI" ? "30%" : "0",
                                          }}
                                        >
                                          <strong>{msg.role}:</strong>{" "}
                                          {msg.text}
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                {/* Conclusion / Analysis */}
                                {call.conclusion && (
                                  <div style={styles.conclusion}>
                                    <div style={styles.conclusionGrid}>
                                      <div style={styles.conclusionField}>
                                        <span style={styles.fieldLabel}>
                                          Quality Score
                                        </span>
                                        <span style={styles.fieldValue}>
                                          {call.conclusion.quality_score}/5
                                        </span>
                                      </div>
                                      <div style={styles.conclusionField}>
                                        <span style={styles.fieldLabel}>
                                          Sentiment
                                        </span>
                                        <span style={styles.fieldValue}>
                                          {call.conclusion.customer_sentiment}
                                        </span>
                                      </div>
                                      <div style={styles.conclusionField}>
                                        <span style={styles.fieldLabel}>
                                          Appointment
                                        </span>
                                        <span style={styles.fieldValue}>
                                          {call.conclusion
                                            .appointment_booked ? (
                                            <Calendar
                                              size={16}
                                              style={{ color: "#10b981" }}
                                            />
                                          ) : (
                                            "—"
                                          )}
                                        </span>
                                      </div>
                                    </div>

                                    {call.conclusion.summary && (
                                      <div style={styles.summarySection}>
                                        <strong>Summary:</strong>
                                        <p>{call.conclusion.summary}</p>
                                      </div>
                                    )}

                                    {call.conclusion.insights && (
                                      <div style={styles.insightsSection}>
                                        <strong>Insights:</strong>
                                        <p>{call.conclusion.insights}</p>
                                      </div>
                                    )}
                                  </div>
                                )}

                                {call.recording_url && (
                                  <div style={styles.recordingSection}>
                                    <audio
                                      controls
                                      style={styles.audioPlayer}
                                      src={call.recording_url}
                                    />
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

const styles = {
  container: {
    padding: "2rem",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "2rem",
    marginBottom: "2rem",
  },
  subtitle: {
    color: "var(--text-secondary)",
    marginBottom: "0.5rem",
    fontSize: "0.95rem",
  },
  syncTime: {
    fontSize: "0.85rem",
    color: "var(--text-secondary)",
    margin: "0.5rem 0 0 0",
  },
  syncButton: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.75rem 1.5rem",
    backgroundColor: "var(--primary-color, #6366f1)",
    color: "white",
    border: "none",
    borderRadius: "6px",
    fontSize: "0.95rem",
    fontWeight: "600",
    cursor: "pointer",
    transition: "all 0.2s ease",
    whiteSpace: "nowrap",
  },
  loadingContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "3rem",
    gap: "1rem",
    color: "var(--text-secondary)",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "3rem",
    gap: "1rem",
    color: "var(--text-secondary)",
  },
  campaignCard: {
    border: "1px solid var(--border-color)",
    borderRadius: "8px",
    marginBottom: "1.5rem",
    overflow: "hidden",
    backgroundColor: "var(--card-bg)",
  },
  campaignHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "1rem",
    cursor: "pointer",
    border: "none",
    background: "transparent",
    width: "100%",
    textAlign: "left",
    gap: "1rem",
  },
  campaignInfo: {
    flex: 1,
  },
  campaignName: {
    margin: "0 0 0.5rem 0",
    fontSize: "1.1rem",
    fontWeight: "600",
  },
  campaignMeta: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
    flexWrap: "wrap",
    fontSize: "0.85rem",
    color: "var(--text-secondary)",
  },
  badge: {
    padding: "0.25rem 0.75rem",
    backgroundColor: "var(--primary-color, #6366f1)",
    color: "white",
    borderRadius: "4px",
    fontSize: "0.8rem",
    fontWeight: "500",
  },
  status: {
    padding: "0.25rem 0.75rem",
    backgroundColor: "#10b981",
    color: "white",
    borderRadius: "4px",
    fontSize: "0.8rem",
    fontWeight: "500",
    textTransform: "capitalize",
  },
  count: {
    color: "var(--text-secondary)",
  },
  campaignStats: {
    display: "flex",
    gap: "1rem",
    alignItems: "center",
  },
  statBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
  },
  statLabel: {
    fontSize: "0.75rem",
    color: "var(--text-secondary)",
    fontWeight: "500",
  },
  statValue: {
    fontSize: "1.1rem",
    fontWeight: "600",
  },
  campaignContent: {
    padding: "1rem",
    borderTop: "1px solid var(--border-color)",
    backgroundColor: "rgba(99, 102, 241, 0.02)",
  },
  leadCard: {
    border: "1px solid var(--border-color)",
    borderRadius: "6px",
    marginBottom: "1rem",
    backgroundColor: "var(--bg-primary)",
    overflow: "hidden",
  },
  leadHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.875rem",
    cursor: "pointer",
    border: "none",
    background: "transparent",
    width: "100%",
    textAlign: "left",
    gap: "0.75rem",
  },
  leadInfo: {
    flex: 1,
  },
  leadName: {
    margin: "0 0 0.25rem 0",
    fontSize: "1rem",
    fontWeight: "600",
  },
  leadPhone: {
    margin: "0.25rem 0",
    fontSize: "0.9rem",
    color: "var(--text-secondary)",
  },
  leadStatus: {
    display: "inline-block",
    marginTop: "0.25rem",
    padding: "0.2rem 0.5rem",
    backgroundColor: "rgba(99, 102, 241, 0.1)",
    color: "var(--primary-color, #6366f1)",
    borderRadius: "3px",
    fontSize: "0.8rem",
    fontWeight: "500",
  },
  leadMeta: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    color: "var(--text-secondary)",
    fontSize: "0.9rem",
  },
  callCount: {
    fontWeight: "500",
  },
  callsList: {
    padding: "1rem",
    borderTop: "1px solid var(--border-color)",
    backgroundColor: "rgba(99, 102, 241, 0.01)",
  },
  callItem: {
    marginBottom: "1rem",
    padding: "0.875rem",
    border: "1px solid var(--border-color)",
    borderRadius: "4px",
    backgroundColor: "var(--card-bg)",
  },
  callHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.75rem",
    paddingBottom: "0.75rem",
    borderBottom: "1px solid var(--border-color)",
  },
  callMeta: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
    fontSize: "0.9rem",
    color: "var(--text-secondary)",
  },
  duration: {
    fontWeight: "500",
    color: "var(--text-primary)",
  },
  sentimentBadge: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    padding: "0.25rem 0.5rem",
    backgroundColor: "var(--bg-secondary)",
    borderRadius: "4px",
    fontSize: "0.9rem",
    fontWeight: "500",
    textTransform: "capitalize",
  },
  sentimentText: {
    color: "var(--text-primary)",
  },
  transcript: {
    marginBottom: "1rem",
    backgroundColor: "var(--bg-primary)",
    borderRadius: "4px",
    overflow: "hidden",
  },
  transcriptMessage: {
    padding: "0.75rem",
    marginBottom: "0.25rem",
    borderRadius: "4px",
    lineHeight: "1.5",
    fontSize: "0.9rem",
  },
  conclusion: {
    marginTop: "0.75rem",
    padding: "0.75rem",
    backgroundColor: "rgba(99, 102, 241, 0.05)",
    borderRadius: "4px",
    borderLeft: "4px solid var(--primary-color, #6366f1)",
  },
  conclusionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: "1rem",
    marginBottom: "0.75rem",
  },
  conclusionField: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  fieldLabel: {
    fontSize: "0.8rem",
    color: "var(--text-secondary)",
    fontWeight: "500",
    textTransform: "uppercase",
  },
  fieldValue: {
    fontSize: "1rem",
    fontWeight: "600",
    color: "var(--text-primary)",
  },
  summarySection: {
    marginBottom: "0.75rem",
    fontSize: "0.9rem",
    lineHeight: "1.5",
  },
  insightsSection: {
    fontSize: "0.9rem",
    lineHeight: "1.5",
    color: "var(--text-primary)",
  },
  recordingSection: {
    marginTop: "0.75rem",
    paddingTop: "0.75rem",
    borderTop: "1px solid var(--border-color)",
  },
  audioPlayer: {
    width: "100%",
    height: "32px",
  },
  noData: {
    textAlign: "center",
    color: "var(--text-secondary)",
    padding: "1rem",
  },
};
