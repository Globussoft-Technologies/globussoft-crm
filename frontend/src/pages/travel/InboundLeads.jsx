// Travel CRM — InboundLeads admin page (Arc 2 #904 slice — frontend STUB).
//
// Operator-facing list of inbound leads ingested via POST
// /api/travel/inbound/leads/:channel (slice 1 commit 8b562b0b — webhook
// scaffold; slice 4 commit 5bd46b2e — HMAC + spam + format verification).
// Inbound producers (Voyagr CMS, embedded webform, WhatsApp Cloud
// webhook, AdsGPT, metaads, manual) write rows to the Contact table with
// `source: 'inbound:<channel>'` so this page can surface them by
// substring-matching that prefix.
//
// STUB #904 slice (this commit): NO backend GET endpoint exists yet for
// listing inbound-only leads. The dedicated /api/travel/inbound/leads GET
// surface is deferred to a future slice (will likely consume the same
// auth/filter machinery as POST + add ?channel + ?from + ?to query
// params). For this slice we fetch /api/contacts?limit=100 (the existing
// generic contact list endpoint, capped at the route's hard 500 max per
// backend/routes/contacts.js:167) and filter client-side for
// `source.startsWith('inbound:')`.
//
// Performance note: the client-side filter is acceptable at the demo's
// current volume (10s of inbound contacts), but a tenant with thousands
// of inbound leads will need the dedicated GET endpoint — the limit=100
// window will silently truncate the visible list. Promote when a real
// tenant trips it.
//
// Convert-to-Lead navigation: clicking a row's "Convert to Lead" button
// routes to /leads/:id where the operator can promote a Contact to a
// Deal via the existing Leads page. The route target is the contact id
// (not a separate lead id) because Contact is the canonical row this
// page shows — Leads.jsx itself enriches contacts with deal data when
// the operator promotes.
//
// Filter surface:
//   - Channel chips (All / Voyagr / Web Form / WhatsApp / Ads / AdsGPT /
//     Manual) — narrow by `source === 'inbound:<channel>'` exactly.
//   - Date-range filter (from / to) on createdAt — both inclusive,
//     ISO date strings.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Inbox, Search } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

// Channels mirror VALID_CHANNELS in backend/routes/travel_inbound_leads.js:61
// (voyagr / webform / whatsapp / ads / adsgpt / metaads / manual). The
// "All" chip clears the filter.
const CHANNEL_CHIPS = [
  { value: "", label: "All" },
  { value: "voyagr", label: "Voyagr" },
  { value: "webform", label: "Web Form" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "ads", label: "Ads" },
  { value: "adsgpt", label: "AdsGPT" },
  { value: "metaads", label: "Meta Ads" },
  { value: "manual", label: "Manual" },
];

// Badge palette per channel — distinct hues so the operator can scan the
// channel column at a glance. Falls through to neutral grey on unknowns.
const CHANNEL_BG = {
  voyagr: "rgba(59, 130, 246, 0.18)",
  webform: "rgba(34, 197, 94, 0.18)",
  whatsapp: "rgba(16, 185, 129, 0.18)",
  ads: "rgba(245, 158, 11, 0.18)",
  adsgpt: "rgba(168, 85, 247, 0.18)",
  metaads: "rgba(59, 130, 246, 0.18)",
  manual: "rgba(148, 163, 184, 0.18)",
};
const CHANNEL_COLOR = {
  voyagr: "#3b82f6",
  webform: "var(--success-color, #22c55e)",
  whatsapp: "#10b981",
  ads: "var(--warning-color, #f59e0b)",
  adsgpt: "#a855f7",
  metaads: "#3b82f6",
  manual: "var(--text-secondary)",
};

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

// Inbound source matcher — backend writes `source: 'inbound:<channel>'`
// per routes/travel_inbound_leads.js:239. Anything that doesn't start
// with `inbound:` is excluded.
function isInboundSource(source) {
  return typeof source === "string" && source.startsWith("inbound:");
}

// Extract the channel suffix from an `inbound:<channel>` source string.
// Returns null if the source isn't an inbound row.
function channelFromSource(source) {
  if (!isInboundSource(source)) return null;
  return source.slice("inbound:".length);
}

export default function InboundLeads() {
  const notify = useNotify();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [convertingId, setConvertingId] = useState(null);

  // PRD_TRAVEL_MULTICHANNEL_LEADS / TRAVEL_CRM_PRD §4.1 — "Convert to Lead"
  // opens the pipeline lead for this inbound contact: it creates a Deal (the
  // canonical pipeline "Lead") linked to the de-duped Contact, so the lead
  // actually lands in the pipeline instead of staying a bare contact. Stage is
  // left to the server default ("lead") so it's valid on every tenant's
  // pipeline config. Travel page only — generic/wellness never reach here.
  const convertToLead = async (c) => {
    setConvertingId(c.id);
    try {
      const channelLabel = String(c.source || "").replace(/^inbound:/, "") || "inbound";
      await fetchApi("/api/deals", {
        method: "POST",
        body: JSON.stringify({
          title: `${c.name || "Inbound lead"} — ${channelLabel}`,
          contactId: c.id,
          subBrand: c.subBrand || undefined,
        }),
      });
      notify.success(`${c.name || "Lead"} added to the pipeline`);
      navigate("/travel/leads");
    } catch (e) {
      notify.error(e?.data?.error || e?.body?.error || e?.message || "Failed to convert to lead");
    } finally {
      setConvertingId(null);
    }
  };

  // Client-side filter state.
  const [channel, setChannel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  // STUB #904 slice: client-side filter on /api/contacts source field
  // until a dedicated /api/travel/inbound/leads GET endpoint lands. The
  // generic contact list endpoint caps at limit=500 (see
  // backend/routes/contacts.js:167); we ask for 100 here to balance
  // payload size vs visibility on a demo with mixed-source contacts.
  const load = () => {
    setLoading(true);
    fetchApi("/api/contacts?limit=100")
      .then((d) => {
        const rows = Array.isArray(d) ? d : Array.isArray(d?.contacts) ? d.contacts : [];
        setContacts(rows);
      })
      .catch((err) => {
        setContacts([]);
        if (err?.status >= 500) {
          notify.error("Failed to load inbound leads — please try again.");
        } else if (err?.status === 404) {
          notify.error("Contacts endpoint not available on this server.");
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply all four client-side filters in one memoized pass:
  //   1. only inbound-source rows survive,
  //   2. channel chip narrows by exact suffix,
  //   3. from/to narrows by createdAt window (inclusive, ISO date),
  //   4. search narrows by case-insensitive substring on name OR email.
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const fromIso = from ? new Date(`${from}T00:00:00.000Z`).getTime() : null;
    const toIso = to ? new Date(`${to}T23:59:59.999Z`).getTime() : null;
    return contacts.filter((c) => {
      if (!isInboundSource(c.source)) return false;
      if (channel) {
        if (c.source !== `inbound:${channel}`) return false;
      }
      if (fromIso || toIso) {
        const ts = c.createdAt ? new Date(c.createdAt).getTime() : null;
        if (ts == null || Number.isNaN(ts)) return false;
        if (fromIso && ts < fromIso) return false;
        if (toIso && ts > toIso) return false;
      }
      if (term) {
        const name = (c.name || "").toLowerCase();
        const email = (c.email || "").toLowerCase();
        if (!name.includes(term) && !email.includes(term)) return false;
      }
      return true;
    });
  }, [contacts, channel, from, to, search]);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", animation: "fadeIn 0.4s ease-out" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
          <Inbox size={26} aria-hidden /> Inbound Leads
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
          Real-time lead ingestion from external channels — {filtered.length.toLocaleString()} lead{filtered.length === 1 ? "" : "s"} match.
        </p>
      </header>

      {/* Filter chrome — channel chips + search + date range. */}
      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div role="group" aria-label="Channel filter chips" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CHANNEL_CHIPS.map((c) => {
            const active = channel === c.value;
            return (
              <button
                key={c.value || "all"}
                type="button"
                onClick={() => setChannel(c.value)}
                aria-pressed={active}
                aria-label={`Filter by channel: ${c.label}`}
                style={{
                  ...chipStyle,
                  background: active ? "var(--primary-color, var(--accent-color))" : "var(--surface-color)",
                  color: active ? "#fff" : "var(--text-primary)",
                  borderColor: active ? "var(--primary-color, var(--accent-color))" : "var(--border-color)",
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Search size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
          <input
            type="text"
            placeholder="Search name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={inputStyle}
            aria-label="Search inbound leads"
          />
        </div>

        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          style={inputStyle}
          aria-label="Created from"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          style={inputStyle}
          aria-label="Created to"
        />
      </div>

      {/* Table */}
      <div className="glass" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : filtered.length === 0 ? (
          <div style={empty}>
            No inbound leads yet — external producers haven&apos;t started sending.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Email</th>
                <th style={th}>Phone</th>
                <th style={th}>Channel</th>
                <th style={th}>Quality</th>
                <th style={th}>Created</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const ch = channelFromSource(c.source) || "unknown";
                return (
                  <tr
                    key={c.id}
                    data-testid={`inbound-lead-row-${c.id}`}
                    style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <td style={td}>
                      <strong>{c.name || "—"}</strong>
                    </td>
                    <td style={td}>{c.email || "—"}</td>
                    <td style={td}>{c.phone || "—"}</td>
                    <td style={td}>
                      <span
                        data-testid={`inbound-lead-channel-${c.id}`}
                        style={{
                          ...channelBadge,
                          background: CHANNEL_BG[ch] || "rgba(255,255,255,0.08)",
                          color: CHANNEL_COLOR[ch] || "var(--text-primary)",
                        }}
                      >
                        {ch}
                      </span>
                    </td>
                    <td style={td}>
                      {(() => {
                        // Mirrors the generic Leads/Contacts pattern: aiScore
                        // badge (green >75 / amber >40 / red below) + a red
                        // "Suspect" pill when the junk filter tagged it
                        // (status='Junk') or the score is low. Show-all-badge —
                        // nothing is hidden.
                        const score = typeof c.aiScore === "number" ? c.aiScore : null;
                        const isSuspect = c.status === "Junk" || (score != null && score < 40);
                        if (score == null && !isSuspect) {
                          return <span style={{ color: "var(--text-secondary)" }}>—</span>;
                        }
                        return (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {score != null && (
                              <span
                                data-testid={`inbound-lead-score-${c.id}`}
                                style={{
                                  padding: "2px 8px",
                                  borderRadius: 10,
                                  fontSize: 11,
                                  fontWeight: 700,
                                  backgroundColor:
                                    score > 75
                                      ? "rgba(16, 185, 129, 0.1)"
                                      : score > 40
                                        ? "rgba(245, 158, 11, 0.1)"
                                        : "rgba(239, 68, 68, 0.1)",
                                  color:
                                    score > 75
                                      ? "var(--success-color)"
                                      : score > 40
                                        ? "var(--warning-color)"
                                        : "#ef4444",
                                }}
                              >
                                {score}/100
                              </span>
                            )}
                            {isSuspect && (
                              <span
                                data-testid={`inbound-lead-suspect-${c.id}`}
                                title="Flagged by the junk-lead filter"
                                style={{
                                  padding: "2px 8px",
                                  borderRadius: 10,
                                  fontSize: 11,
                                  fontWeight: 700,
                                  background: "rgba(239, 68, 68, 0.12)",
                                  color: "#ef4444",
                                  border: "1px solid rgba(239,68,68,0.25)",
                                }}
                              >
                                Suspect
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                    <td style={td}>{formatDate(c.createdAt)}</td>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => convertToLead(c)}
                        disabled={convertingId === c.id}
                        style={primaryBtn}
                        aria-label={`Convert ${c.name || "contact"} to Lead`}
                      >
                        {convertingId === c.id ? "Converting…" : "Convert to Lead"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
  fontWeight: 600,
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const inputStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13,
  minWidth: 140,
};
const chipStyle = {
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid var(--border-color)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
const channelBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "capitalize",
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
