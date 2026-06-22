/**
 * QuoteAcceptLanding.jsx — public customer-facing quote landing (C9).
 *
 * PRD_TRAVEL_QUOTE_BUILDER §3.7 — share-link landing.
 *
 * URL: /p/quote/:shareToken — no auth (backend openPaths regex covers).
 *
 * Wire:
 *   GET    /api/travel/quotes/public/quote/:shareToken          → load
 *   POST   /api/travel/quotes/public/quote/:shareToken/accept   → accept
 *   POST   /api/travel/quotes/public/quote/:shareToken/reject   → reject
 *   POST   /api/travel/quotes/public/quote/:shareToken/counter  → counter
 *
 * Error-state mapping (mirror to backend envelope):
 *   404 QUOTE_EXPIRED / QUOTE_NOT_AVAILABLE / QUOTE_NOT_FOUND
 *     → "This quote has expired or is no longer available"
 *   410 LINK_EXPIRED
 *     → "Share link expired"
 *   401 INVALID_TOKEN
 *     → "Invalid share link"
 *   409 ALREADY_ACTIONED
 *     → "This quote was already actioned" + the prior status
 *
 * Theme + voice per CLAUDE.md standing rules:
 *   - Primary CTA uses var(--primary-color, var(--accent-color)) — wellness
 *     embedders won't render salmon.
 *   - Calm-institutional voice on the action surfaces — no urgency.
 *   - Responsive grid via auto-fit minmax pattern; no media queries needed.
 *
 * NOT a render of the operator quote builder. This is a strict read-only
 * customer view: line items (description / quantity / per-line subtotal),
 * tax-inclusive total, validity. Operator-internal fields (supplier id,
 * margin %, internal notes) are stripped at the backend's projection layer
 * and never reach this component.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, AlertCircle, XCircle, MessageSquare, Plane, Hotel, Car, Calendar, Ticket } from "lucide-react";
import { DestinationHero, DestinationSideRails } from "../../components/DestinationVisuals";

// Per-line icon so the customer view reads like a trip, not a spreadsheet.
const LINE_ICON = { flight: Plane, hotel: Hotel, transport: Car, transfer: Car, visa: Ticket, service: Ticket };

// Derive a destination for the hero photo/title from the quote's lines:
// prefer hotel cities (from "Hotel, City — Room"), else a flight arrival city.
function deriveDestination(lines) {
  const cities = [];
  for (const l of lines || []) {
    if (l.lineType === "hotel" && l.description) {
      const m = /,\s*([^—-]+?)\s*(?:—|-|$)/.exec(l.description);
      const city = m && m[1] ? m[1].trim() : null;
      if (city && !cities.includes(city)) cities.push(city);
    }
  }
  if (cities.length) return { title: cities.join(" · "), photo: cities[0] };
  for (const l of lines || []) {
    if (l.lineType === "flight" && l.description) {
      const m = /(?:→|->)\s*([A-Za-z .]+?)\s*(?:\(|\[|$)/.exec(l.description);
      if (m && m[1]) return { title: m[1].trim(), photo: m[1].trim() };
    }
  }
  return { title: "Your trip", photo: null };
}

const ACTION = Object.freeze({
  NONE: null,
  ACCEPT: "accept",
  REJECT: "reject",
  COUNTER: "counter",
});

function formatMoney(amount, currency = "INR") {
  if (amount == null) return "—";
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(num)) return "—";
  try {
    return new Intl.NumberFormat(
      currency === "INR" ? "en-IN" : "en-US",
      { style: "currency", currency, maximumFractionDigits: 2 },
    ).format(num);
  } catch {
    return `${currency} ${num.toFixed(2)}`;
  }
}

// Customer-friendly qty label per line type (nights for hotels, travellers for
// flights) — bare "×2" was confusing.
function qtyLabel(l) {
  const q = Number(l.quantity) || 1;
  if (l.lineType === "hotel") return `Hotel · ${q} night${q === 1 ? "" : "s"}`;
  if (l.lineType === "flight") return `Flight · ${q} traveller${q === 1 ? "" : "s"}`;
  if (l.lineType === "transport") return "Transfer";
  return l.lineType;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric",
    });
  } catch { return String(iso); }
}

export default function QuoteAcceptLanding() {
  const { shareToken } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { message, code }

  const [action, setAction] = useState(ACTION.NONE);
  const [submitting, setSubmitting] = useState(false);

  // Form state per action
  const [customerName, setCustomerName] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [proposedTotal, setProposedTotal] = useState("");
  const [counterComments, setCounterComments] = useState("");

  const [done, setDone] = useState(null); // { kind: 'accepted'|'rejected'|'countered', ... }

  const linesTotal = useMemo(() => {
    if (!data?.lines) return 0;
    return data.lines.reduce(
      (a, l) => a + (Number(l.amount) || 0),
      0,
    );
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(
          `/api/travel/quotes/public/quote/${encodeURIComponent(shareToken)}`,
        );
        if (cancelled) return;
        if (!r.ok) {
          let body = {};
          try { body = await r.json(); } catch { /* tolerate */ }
          let message;
          if (r.status === 410) message = "Share link expired";
          else if (r.status === 401) message = "Invalid share link";
          else message = "This quote has expired or is no longer available";
          setError({ message, code: body.code || `HTTP_${r.status}`, status: r.status });
          setLoading(false);
          return;
        }
        const body = await r.json();
        if (cancelled) return;
        setData(body);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError({ message: "Could not load this quote. Please try again later.", code: "NETWORK_ERROR" });
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [shareToken]);

  async function submitAction() {
    setSubmitting(true);
    setError(null);
    try {
      let body = {};
      if (action === ACTION.ACCEPT) {
        body = { customerName: customerName || undefined, customerNote: customerNote || undefined };
      } else if (action === ACTION.REJECT) {
        if (!rejectionReason || !rejectionReason.trim()) {
          setError({ message: "Please share a brief reason so our team can follow up.", code: "MISSING_REASON" });
          setSubmitting(false);
          return;
        }
        body = { rejectionReason };
      } else if (action === ACTION.COUNTER) {
        const num = Number(proposedTotal);
        if (!Number.isFinite(num) || num <= 0) {
          setError({ message: "Please enter your counter-offer amount.", code: "MISSING_PROPOSED_TOTAL" });
          setSubmitting(false);
          return;
        }
        body = { proposedTotal: num, comments: counterComments || undefined };
      }
      const path = action === ACTION.COUNTER ? "counter" : action;
      const r = await fetch(
        `/api/travel/quotes/public/quote/${encodeURIComponent(shareToken)}/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) {
        let respBody = {};
        try { respBody = await r.json(); } catch { /* tolerate */ }
        let message;
        if (r.status === 409) message = "This quote was already actioned.";
        else if (r.status === 410) message = "Share link expired";
        else if (r.status === 404) message = "This quote is no longer available.";
        else message = respBody.error || "Could not complete this action.";
        setError({ message, code: respBody.code || `HTTP_${r.status}`, status: r.status });
        setSubmitting(false);
        return;
      }
      const respBody = await r.json();
      setDone({ kind: respBody.status, ...respBody });
      setSubmitting(false);
    } catch {
      setError({ message: "Network error — please try again.", code: "NETWORK_ERROR" });
      setSubmitting(false);
    }
  }

  // ----- Render -----
  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <p style={{ color: "var(--text-muted, #6b7280)" }}>Loading your quote…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <AlertCircle size={32} color="var(--text-muted, #6b7280)" />
          <h1 style={headingStyle}>{error.message}</h1>
          <p style={{ color: "var(--text-muted, #6b7280)" }}>
            If you believe this is in error, please contact our team for a fresh quote.
          </p>
        </div>
      </div>
    );
  }

  if (done) {
    const kindLabel = done.kind === "accepted" ? "Quote accepted"
      : done.kind === "rejected" ? "Quote declined"
      : "Counter-offer submitted";
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <CheckCircle2 size={40} color="var(--primary-color, var(--accent-color, #10b981))" />
          <h1 style={headingStyle}>Thank you</h1>
          <p style={{ fontSize: 18, marginTop: 8 }}>
            <strong>{kindLabel}.</strong>
          </p>
          <p style={{ color: "var(--text-muted, #6b7280)", marginTop: 12 }}>
            Our team will be in touch shortly to finalise the next steps.
          </p>
        </div>
      </div>
    );
  }

  const { quote, lines = [], customer } = data;
  const totalDisplay = quote?.totalAmount != null
    ? formatMoney(quote.totalAmount, quote.currency)
    : formatMoney(linesTotal, quote?.currency);
  const dest = deriveDestination(lines);

  return (
    <div style={pageStyle}>
      {/* Culture photos in the wide desktop gutters (keyless Wikipedia). */}
      <DestinationSideRails destination={dest.title} photoDestination={dest.photo} />
      <div style={{ ...cardStyle, textAlign: "left", padding: 0, overflow: "hidden" }}>
        {/* Destination hero — real photo + themed gradient, swaps with the trip. */}
        <DestinationHero destination={dest.title} photoDestination={dest.photo}>
          <Calendar size={14} aria-hidden style={{ verticalAlign: -2, marginRight: 4 }} />
          Quote #{quote.id} · Valid until {formatDate(quote.validUntil)}
          {customer?.name ? ` · For ${customer.name}` : ""}
        </DestinationHero>

        <div style={{ padding: "0 32px 32px" }}>
          <section aria-label="What's included" style={{ marginBottom: 24 }}>
            <h2 style={{ ...subHeadingStyle, marginTop: 8 }}>Your trip includes</h2>
            {lines.length === 0 ? (
              <p style={{ color: "var(--text-muted, #6b7280)" }}>No line items on this quote yet.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
                {lines.map((l) => {
                  const Icon = LINE_ICON[l.lineType] || Ticket;
                  return (
                    <li key={l.id} style={itemRowStyle}>
                      <Icon size={18} aria-hidden style={{ color: "var(--primary-color, #2563eb)", flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: "#111827" }}>{l.description}</div>
                        <div style={{ fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
                          {qtyLabel(l)}
                        </div>
                      </div>
                      <div style={{ fontWeight: 700, whiteSpace: "nowrap", color: "#111827" }}>{formatMoney(l.amount, l.currency || quote.currency)}</div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div style={costBoxStyle}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Total</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: "var(--primary-color, #2563eb)" }}>{totalDisplay}</span>
            </div>
          </section>

        {error && (
          <div role="alert" style={errorBoxStyle}>
            <AlertCircle size={16} /> {error.message}
          </div>
        )}

        {action === ACTION.NONE && (
          <div style={actionGridStyle}>
            <button
              type="button"
              style={primaryBtnStyle}
              onClick={() => setAction(ACTION.ACCEPT)}
              aria-label="Accept this quote"
            >
              <CheckCircle2 size={18} /> Accept
            </button>
            <button
              type="button"
              style={secondaryBtnStyle}
              onClick={() => setAction(ACTION.COUNTER)}
              aria-label="Submit a counter-offer"
            >
              <MessageSquare size={18} /> Counter-offer
            </button>
            <button
              type="button"
              style={ghostBtnStyle}
              onClick={() => setAction(ACTION.REJECT)}
              aria-label="Decline this quote"
            >
              <XCircle size={18} /> Decline
            </button>
          </div>
        )}

        {action === ACTION.ACCEPT && (
          <section aria-labelledby="confirm-accept" style={confirmBoxStyle}>
            <h2 id="confirm-accept" style={subHeadingStyle}>Confirm acceptance</h2>
            <label style={labelStyle}>
              Your name (optional)
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                style={inputStyle}
                maxLength={200}
              />
            </label>
            <label style={labelStyle}>
              Anything you&apos;d like to add? (optional)
              <textarea
                value={customerNote}
                onChange={(e) => setCustomerNote(e.target.value)}
                style={{ ...inputStyle, minHeight: 80 }}
                maxLength={2000}
              />
            </label>
            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <button type="button" style={primaryBtnStyle} disabled={submitting} onClick={submitAction}>
                {submitting ? "Submitting…" : "Confirm accept"}
              </button>
              <button type="button" style={ghostBtnStyle} onClick={() => setAction(ACTION.NONE)}>
                Cancel
              </button>
            </div>
          </section>
        )}

        {action === ACTION.REJECT && (
          <section aria-labelledby="confirm-reject" style={confirmBoxStyle}>
            <h2 id="confirm-reject" style={subHeadingStyle}>Decline this quote</h2>
            <label style={labelStyle}>
              Reason (required)
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                style={{ ...inputStyle, minHeight: 100 }}
                maxLength={2000}
                aria-required="true"
              />
            </label>
            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <button type="button" style={primaryBtnStyle} disabled={submitting} onClick={submitAction}>
                {submitting ? "Submitting…" : "Submit decline"}
              </button>
              <button type="button" style={ghostBtnStyle} onClick={() => setAction(ACTION.NONE)}>
                Cancel
              </button>
            </div>
          </section>
        )}

        {action === ACTION.COUNTER && (
          <section aria-labelledby="confirm-counter" style={confirmBoxStyle}>
            <h2 id="confirm-counter" style={subHeadingStyle}>Submit a counter-offer</h2>
            <label style={labelStyle}>
              Your proposed total ({quote.currency || "INR"})
              <input
                type="number"
                min="1"
                step="0.01"
                value={proposedTotal}
                onChange={(e) => setProposedTotal(e.target.value)}
                style={inputStyle}
                aria-required="true"
              />
            </label>
            <label style={labelStyle}>
              Comments (optional)
              <textarea
                value={counterComments}
                onChange={(e) => setCounterComments(e.target.value)}
                style={{ ...inputStyle, minHeight: 80 }}
                maxLength={2000}
              />
            </label>
            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <button type="button" style={primaryBtnStyle} disabled={submitting} onClick={submitAction}>
                {submitting ? "Submitting…" : "Submit counter-offer"}
              </button>
              <button type="button" style={ghostBtnStyle} onClick={() => setAction(ACTION.NONE)}>
                Cancel
              </button>
            </div>
          </section>
        )}
        </div>
      </div>
    </div>
  );
}

// ─── styles ───────────────────────────────────────────────
const pageStyle = {
  minHeight: "100vh",
  background: "var(--bg-color, #f9fafb)",
  padding: "32px 16px",
  display: "flex",
  justifyContent: "center",
};

const cardStyle = {
  maxWidth: 720,
  width: "100%",
  background: "var(--card-bg, #fff)",
  borderRadius: 16,
  padding: 32,
  boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
  textAlign: "center",
};

const headingStyle = {
  fontSize: 28,
  fontWeight: 700,
  margin: 0,
  color: "var(--text-color, #111827)",
};

const subHeadingStyle = {
  fontSize: 20,
  fontWeight: 600,
  margin: "0 0 16px 0",
  color: "#111827",
};

const itemRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 14px",
  border: "1px solid var(--border-color, #e5e7eb)",
  borderRadius: 10,
  background: "var(--card-bg, #fff)",
};

const costBoxStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginTop: 16,
  padding: "14px 16px",
  background: "var(--bg-color, #f7f3eb)",
  borderRadius: 12,
  border: "1px solid var(--border-color, #e5e7eb)",
};

const actionGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
  gap: 12,
  marginTop: 24,
};

const primaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "12px 20px",
  background: "var(--primary-color, var(--accent-color, #2563eb))",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtnStyle = {
  ...primaryBtnStyle,
  background: "var(--card-bg, #fff)",
  color: "var(--primary-color, var(--accent-color, #2563eb))",
  border: "1px solid var(--primary-color, var(--accent-color, #2563eb))",
};

const ghostBtnStyle = {
  ...primaryBtnStyle,
  background: "transparent",
  color: "var(--text-muted, #6b7280)",
  border: "1px solid var(--border-color, #e5e7eb)",
};

const confirmBoxStyle = {
  marginTop: 24,
  padding: 16,
  background: "var(--bg-color, #f9fafb)",
  borderRadius: 12,
  textAlign: "left",
};

const labelStyle = {
  display: "block",
  marginTop: 12,
  fontSize: 14,
  color: "var(--text-color, #111827)",
};

const inputStyle = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "10px 12px",
  border: "1px solid var(--border-color, #d1d5db)",
  borderRadius: 8,
  fontSize: 14,
  background: "var(--card-bg, #fff)",
  color: "var(--text-color, #111827)",
  boxSizing: "border-box",
};

const errorBoxStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  background: "rgba(220,38,38,0.08)",
  color: "#b91c1c",
  borderRadius: 8,
  marginTop: 16,
  fontSize: 14,
};
