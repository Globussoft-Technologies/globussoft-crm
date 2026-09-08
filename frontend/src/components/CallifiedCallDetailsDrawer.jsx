import { useEffect, useState, useMemo } from "react";
import { FileText, X, Loader, Phone, Clock, Smile, Calendar, AlertCircle, RefreshCw, User, Play } from "lucide-react";
import { fetchApi, getAuthToken } from "../utils/api";
import { crmRecordingUrl } from "../utils/callified";

/**
 * Drawer showing every Callified AI call attempt for a CRM lead.
 *
 * Fetches all transcripts + reviews from Callified and all CRM-stored CallLog
 * attempts, then renders each call as a card (Call #1, Call #2, …) with:
 *   - timestamp and duration
 *   - recording player
 *   - transcript messages
 *   - AI review (score, sentiment, appointment, summary, insights)
 */
/**
 * Recording player — blob-fetch, loaded on demand.
 *
 * An `<audio src>` cannot send an Authorization header, and both hops need
 * one: Callified's `/api/recordings` is behind their Bearer JWT, and our proxy
 * is behind the CRM's. The app does set an HttpOnly `auth_token` cookie the
 * proxy would accept, but it expires after 15 minutes while the session JWT
 * lasts days — so a cookie-only player would work right after login and then
 * mysteriously stop. Fetching the bytes with the Bearer header and handing the
 * element an object URL is the pattern Callified's own frontend uses.
 *
 * Loaded on click rather than on render: these are WAV files at ~16 KB/s and
 * a long call runs to tens of megabytes, so opening the drawer must not pull
 * every recording down uninvited.
 */
function RecordingPlayer({ url, durationSeconds }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Revoke on unmount — an un-revoked object URL pins the whole blob in memory
  // for the life of the document.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const load = async () => {
    if (loading || objectUrl) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error ||
            (res.status === 404
              ? "Recording not available yet."
              : `Could not load the recording (${res.status}).`),
        );
      }
      setObjectUrl(URL.createObjectURL(await res.blob()));
    } catch (e) {
      setError(e?.message || "Could not load the recording.");
    } finally {
      setLoading(false);
    }
  };

  const shell = {
    padding: "0.75rem",
    borderRadius: "8px",
    background: "var(--bg-color)",
    border: "1px solid var(--border-color)",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  };

  if (error) {
    return (
      <div style={{ ...shell, color: "var(--danger-color, #ef4444)", fontSize: "0.82rem" }}>
        <AlertCircle size={16} /> {error}
      </div>
    );
  }

  if (objectUrl) {
    return (
      <div style={shell} data-testid="callified-recording-player">
        <Phone size={16} color="var(--accent-color)" />
        <audio controls autoPlay src={objectUrl} style={{ flex: 1, height: 32 }}>
          Your browser does not support the audio element.
        </audio>
      </div>
    );
  }

  return (
    <div style={shell}>
      <Phone size={16} color="var(--accent-color)" />
      <button
        type="button"
        onClick={load}
        disabled={loading}
        className="btn-secondary"
        data-testid="callified-recording-load"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.35rem 0.75rem",
          fontSize: "0.8rem",
        }}
      >
        {loading ? (
          <>
            <Loader size={14} style={{ animation: "spin 1s linear infinite" }} /> Loading…
          </>
        ) : (
          <>
            <Play size={14} /> Play recording
          </>
        )}
      </button>
      {durationSeconds != null && (
        <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
          {durationSeconds}s
        </span>
      )}
    </div>
  );
}

export default function CallifiedCallDetailsDrawer({ lead, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError("");

      const latest = await fetchApi(`/api/callified/calls/lead/${lead.id}/latest`);
      const callifiedLeadId = latest?.callifiedLeadId;

      if (!callifiedLeadId) {
        setDetails({ noCall: true });
        setAttempts([]);
        return;
      }

      const [detailRes, attemptsRes] = await Promise.all([
        fetchApi(`/api/callified/calls/${callifiedLeadId}/details`),
        fetchApi(`/api/callified/calls/lead/${lead.id}/attempts`),
      ]);

      setDetails(detailRes || { transcripts: [], reviews: [] });
      setAttempts(Array.isArray(attemptsRes?.attempts) ? attemptsRes.attempts : []);
    } catch (err) {
      setError(err?.message || "Failed to fetch call details");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    load().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  const calls = useMemo(() => {
    if (!details || details.noCall) return [];
    const transcripts = Array.isArray(details.transcripts) ? details.transcripts : [];
    const reviews = Array.isArray(details.reviews) ? details.reviews : [];

    // Sort newest first so Call #1 is the most recent attempt.
    return transcripts
      .map((t) => {
        // ONLY the review belonging to this transcript. There used to be a
        // `|| reviews.find(r => !r.error)` fallback here, which handed a call
        // with no review of its own the FIRST review in the list — another
        // call's score, sentiment and summary, rendered as if it were this
        // one's. A missing review must read as missing, not as someone
        // else's.
        const review =
          reviews.find((r) => r && !r.error && r.transcript_id === t.id) || null;
        return { transcript: t, review };
      })
      .sort((a, b) => new Date(b.transcript.created_at || 0).getTime() - new Date(a.transcript.created_at || 0).getTime());
  }, [details]);

  const formatDuration = (s) => {
    const seconds = Math.round(Number(s) || 0);
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `${m}m ${rem}s`;
  };

  const formatCallTime = (iso) => {
    if (!iso) return "Unknown time";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const renderReview = (review) => {
    if (!review) return null;
    const score = Number(review.quality_score) || 0;
    const outOf = score > 5 ? 10 : 5;
    const sentiment = review.sentiment || "neutral";
    const appointment = Boolean(review.appointment_booked);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <span
            style={{
              padding: "0.25rem 0.6rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontWeight: 600,
              background: "rgba(245, 158, 11, 0.1)",
              color: "var(--warning-color)",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            {Array.from({ length: outOf }).map((_, i) => (
              <span key={i} style={{ opacity: i < score ? 1 : 0.3 }}>★</span>
            ))}
            <span style={{ marginLeft: 4 }}>{score}/{outOf}</span>
          </span>
          <span
            style={{
              padding: "0.25rem 0.6rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontWeight: 600,
              textTransform: "capitalize",
              background: sentiment === "positive" ? "rgba(16, 185, 129, 0.1)" : sentiment === "negative" ? "rgba(239, 68, 68, 0.1)" : "rgba(139, 92, 246, 0.1)",
              color: sentiment === "positive" ? "var(--success-color)" : sentiment === "negative" ? "#ef4444" : "var(--accent-color)",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <Smile size={12} /> {sentiment}
          </span>
          <span
            style={{
              padding: "0.25rem 0.6rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontWeight: 600,
              background: appointment ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
              color: appointment ? "var(--success-color)" : "#ef4444",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <Calendar size={12} /> {appointment ? "Appointment booked" : "No appointment"}
          </span>
        </div>

        {review.summary && (
          <div style={{ padding: "0.75rem", borderRadius: "8px", background: "var(--subtle-bg)", border: "1px solid var(--border-color)" }}>
            <h5 style={{ margin: "0 0 0.35rem 0", fontSize: "0.75rem", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "0.25rem" }}>
              <FileText size={12} /> Summary
            </h5>
            <p style={{ margin: 0, fontSize: "0.875rem", lineHeight: 1.5 }}>{review.summary}</p>
          </div>
        )}

        <div style={{ display: "grid", gap: "0.5rem" }}>
          {review.what_went_well && (
            <p style={{ margin: 0, fontSize: "0.8125rem", lineHeight: 1.5, color: "var(--success-color)" }}>
              <strong>What went well:</strong> {review.what_went_well}
            </p>
          )}
          {review.what_went_wrong && (
            <p style={{ margin: 0, fontSize: "0.8125rem", lineHeight: 1.5, color: "#ef4444" }}>
              <strong>What went wrong:</strong> {review.what_went_wrong}
            </p>
          )}
          {review.coaching_insight && (
            <p style={{ margin: 0, fontSize: "0.8125rem", lineHeight: 1.5, color: "var(--accent-color)" }}>
              <strong>Coaching insight:</strong> {review.coaching_insight}
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
        }}
      />
      <div
        className="card"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "560px",
          height: "100vh",
          background: "var(--bg-color)",
          borderLeft: "1px solid var(--border-color)",
          overflowY: "auto",
          padding: "1.5rem",
          zIndex: 1,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <FileText size={20} color="var(--accent-color)" /> Call Transcripts
          </h3>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              onClick={() => {
                setRefreshing(true);
                load();
              }}
              disabled={refreshing || loading}
              title="Refresh call details"
              style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
            >
              <RefreshCw size={18} style={refreshing ? { animation: "spin 1s linear infinite" } : {}} />
            </button>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}>
              <X size={20} />
            </button>
          </div>
        </div>

        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
          Lead: <strong>{lead.name || lead.email || `ID ${lead.id}`}</strong>
          {lead.phone ? <span> — {lead.phone}</span> : null}
        </p>

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)", padding: "2rem 0" }}>
            <Loader size={18} style={{ animation: "spin 1s linear infinite" }} /> Loading call details…
          </div>
        )}

        {!loading && error && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--danger-color)", padding: "1rem 0" }}>
            <AlertCircle size={18} /> {error}
          </div>
        )}

        {!loading && details?.noCall && (
          <div style={{ color: "var(--text-secondary)", padding: "1rem 0" }}>
            No Callified call has been made for this lead yet. Click the phone icon in the leads list to start one.
          </div>
        )}

        {!loading && !error && !details?.noCall && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
            {calls.length === 0 && (
              <div style={{ color: "var(--text-secondary)", padding: "1rem 0" }}>
                Call initiated — transcripts will appear here once the call completes and Callified processes the recording.
              </div>
            )}

            {calls.map(({ transcript, review }, idx) => {
              const messages = Array.isArray(transcript.transcript) ? transcript.transcript : [];
              const duration = transcript.call_duration_s != null ? Math.round(Number(transcript.call_duration_s)) : null;
              const recordingUrl = crmRecordingUrl(transcript.recording_url);
              const language = transcript.language || "English";

              return (
                <div
                  key={transcript.id || idx}
                  style={{
                    padding: "1rem",
                    borderRadius: "12px",
                    background: "var(--subtle-bg)",
                    border: "1px solid var(--border-color)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "1rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
                    <div>
                      <h4 style={{ margin: "0 0 0.25rem 0", fontSize: "1rem", fontWeight: 600 }}>
                        Call #{calls.length - idx}
                      </h4>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", color: "var(--text-secondary)", fontSize: "0.75rem" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                          <Clock size={12} /> {formatCallTime(transcript.created_at)}
                        </span>
                        {duration != null && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                            <Phone size={12} /> {formatDuration(duration)}
                          </span>
                        )}
                        <span
                          style={{
                            padding: "0.1rem 0.4rem",
                            borderRadius: "4px",
                            background: "rgba(16, 185, 129, 0.1)",
                            color: "var(--success-color)",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.25rem",
                          }}
                        >
                          <span style={{ fontSize: 10 }}>🌐</span> {language}
                        </span>
                      </div>
                    </div>
                    {review && renderReview(review)}
                  </div>

                  {recordingUrl && (
                    <RecordingPlayer url={recordingUrl} durationSeconds={duration} />
                  )}

                  {messages.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                      {messages.map((msg, mIdx) => {
                        const isAgent =
                          String(msg.role || "").toLowerCase().includes("agent") ||
                          String(msg.role || "").toLowerCase() === "ai" ||
                          String(msg.role || "").toLowerCase() === "caller";
                        return (
                          <div
                            key={mIdx}
                            style={{
                              display: "flex",
                              justifyContent: isAgent ? "flex-start" : "flex-end",
                            }}
                          >
                            <div
                              style={{
                                maxWidth: "80%",
                                padding: "0.6rem 0.85rem",
                                borderRadius: "12px",
                                borderBottomLeftRadius: isAgent ? 4 : 12,
                                borderBottomRightRadius: isAgent ? 12 : 4,
                                background: isAgent ? "rgba(139, 92, 246, 0.1)" : "var(--bg-color)",
                                border: "1px solid var(--border-color)",
                                color: "var(--text-primary)",
                                fontSize: "0.875rem",
                                lineHeight: 1.5,
                              }}
                            >
                              <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.15rem", display: "flex", alignItems: "center", gap: "0.25rem" }}>
                                {isAgent ? <User size={10} /> : <User size={10} />}
                                {msg.role || "Speaker"}
                              </div>
                              {msg.text || ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {/* CRM-stored call attempts timeline */}
            {attempts.length > 0 && (
              <div style={{ padding: "1rem", borderRadius: "12px", background: "var(--subtle-bg)", border: "1px solid var(--border-color)" }}>
                <h4 style={{ margin: "0 0 0.75rem 0", fontSize: "0.875rem", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "0.35rem" }}>
                  <Clock size={14} /> CRM call attempts
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {attempts.map((a, i) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8125rem", padding: "0.4rem 0", borderBottom: i < attempts.length - 1 ? "1px solid var(--border-color)" : "none" }}>
                      <span style={{ color: "var(--text-primary)" }}>
                        Attempt #{attempts.length - i} — {formatCallTime(a.createdAt)}
                      </span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {a.status}
                        {a.duration > 0 ? ` • ${formatDuration(a.duration)}` : ""}
                        {a.user?.name ? ` • ${a.user.name}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
