// PRD_TRAVEL_QUOTE_BUILDER G019 — operator-facing counter-offer review UI.
//
// Mounts at /travel/quotes/:id/counter-review. After the customer submits
// a counter-offer via the public landing page (POST
// /api/travel/quotes/public/quote/:shareToken/counter), the operator gets
// notified and lands here to compare:
//   - "Our quote"      — the current TravelQuote state (lines + total)
//   - "Customer counter" — the proposedTotal + comments from the customer
//
// Three actions at the bottom:
//   - Accept             → POST /quotes/:id/accept (existing endpoint)
//   - Reject             → POST /quotes/:id/decline (existing endpoint)
//   - Counter their counter → navigate back to QuoteBuilder pre-populated
//     with the customer's proposed values (a future "counter back" round
//     creates a new SENT version).
//
// The customer's counter payload lives in TravelQuoteSnapshot.changeReason
// (JSON string of { proposedTotal, comments }). We look up the most-recent
// snapshot with changedBy='customer' + statusAfter='Countered' for the
// quote.

import { useEffect, useState, useContext } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ThumbsUp, ThumbsDown, Copy, ArrowLeft } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QuoteCounterReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [loading, setLoading] = useState(true);
  const [quote, setQuote] = useState(null);
  const [lines, setLines] = useState([]);
  const [counter, setCounter] = useState(null); // { proposedTotal, comments, counteredAt }
  const [acting, setActing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [q, linesResp] = await Promise.all([
          fetchApi(`/api/travel/quotes/${id}`),
          fetchApi(`/api/travel/quotes/${id}/lines`).catch(() => ({ lines: [] })),
        ]);
        if (cancelled) return;
        setQuote(q);
        setLines(Array.isArray(linesResp?.lines) ? linesResp.lines : []);

        // Load the most-recent customer snapshot to extract proposedTotal.
        try {
          const audit = await fetchApi(`/api/travel/quotes/${id}/audit-trail`);
          const customerEntries = Array.isArray(audit?.entries)
            ? audit.entries.filter((e) => e.changedBy === "customer" || (e.action || "").toLowerCase().includes("counter"))
            : [];
          const latest = customerEntries[customerEntries.length - 1];
          if (latest && latest.changeReason) {
            try {
              const parsed = JSON.parse(latest.changeReason);
              setCounter({
                proposedTotal: Number(parsed.proposedTotal),
                comments: parsed.comments || "",
                counteredAt: latest.createdAt,
              });
            } catch {
              setCounter(null);
            }
          }
        } catch {
          // Audit endpoint optional — silently fall through.
        }
      } catch (err) {
        notify.error(err?.body?.error || err?.message || "Failed to load quote");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id, notify]);

  const accept = async () => {
    if (!canWrite) return;
    setActing(true);
    try {
      await fetchApi(`/api/travel/quotes/${id}/accept`, { method: "POST" });
      notify.success("Counter accepted — quote marked Accepted");
      navigate(`/travel/quotes/builder/${id}`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Accept failed");
    } finally {
      setActing(false);
    }
  };

  const reject = async () => {
    if (!canWrite) return;
    setActing(true);
    try {
      await fetchApi(`/api/travel/quotes/${id}/decline`, {
        method: "POST",
        body: JSON.stringify({ reason: "Customer counter rejected" }),
      });
      notify.success("Counter rejected — quote marked Rejected");
      navigate(`/travel/quotes/builder/${id}`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Reject failed");
    } finally {
      setActing(false);
    }
  };

  const counterBack = () => {
    // Navigate back to QuoteBuilder with the proposed total pre-populated
    // via query string. The builder reads ?counterTotal=<n> on mount and
    // pre-fills the override.
    if (!counter) {
      notify.error("No customer counter to respond to");
      return;
    }
    navigate(`/travel/quotes/builder/${id}?counterTotal=${counter.proposedTotal}`);
  };

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <p>Loading counter review…</p>
      </div>
    );
  }

  if (!quote) {
    return (
      <div style={{ padding: 24 }}>
        <p>Quote not found.</p>
        <button type="button" onClick={() => navigate("/travel/quotes-admin")}>
          <ArrowLeft size={14} /> Back to quotes
        </button>
      </div>
    );
  }

  const ourTotal = Number(quote.totalAmount) || 0;
  const customerTotal = counter ? Number(counter.proposedTotal) : null;
  const delta = customerTotal != null ? ourTotal - customerTotal : null;

  const colStyle = {
    flex: 1,
    minWidth: 0,
    padding: 16,
  };
  const heading = {
    margin: "0 0 12px",
    fontSize: "1rem",
    fontWeight: 600,
    color: "var(--text-primary)",
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => navigate(`/travel/quotes/builder/${id}`)}
          aria-label="Back to builder"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>
          Quote #{id} — Counter-offer review
        </h1>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <section className="glass" style={colStyle} aria-label="Our quote">
          <h2 style={heading}>Our quote</h2>
          <p style={{ margin: "4px 0", color: "var(--text-secondary)" }}>
            Status: <strong>{quote.status}</strong>
          </p>
          <p style={{ margin: "4px 0" }}>
            Total: <strong>{quote.currency} {fmt(ourTotal)}</strong>
          </p>
          <table style={{ width: "100%", marginTop: 12, fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Line</th>
                <th style={{ textAlign: "right" }}>Qty</th>
                <th style={{ textAlign: "right" }}>Unit</th>
                <th style={{ textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td style={{ textAlign: "right" }}>{l.quantity}</td>
                  <td style={{ textAlign: "right" }}>{fmt(l.unitPrice)}</td>
                  <td style={{ textAlign: "right" }}>{fmt(l.amount)}</td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={4} style={{ color: "var(--text-secondary)" }}>(No lines)</td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section
          className="glass"
          style={{
            ...colStyle,
            borderLeft: counter ? "3px solid var(--accent-color, #3b82f6)" : undefined,
          }}
          aria-label="Customer counter"
        >
          <h2 style={heading}>Customer counter</h2>
          {counter ? (
            <>
              <p style={{ margin: "4px 0" }}>
                Proposed total:{" "}
                <strong style={{ color: customerTotal < ourTotal ? "var(--danger-color, #f43f5e)" : "var(--success-color, #22c55e)" }}>
                  {quote.currency} {fmt(customerTotal)}
                </strong>
              </p>
              {delta != null && (
                <p style={{ margin: "4px 0", color: "var(--text-secondary)" }}>
                  Delta from our quote:{" "}
                  <strong>{delta >= 0 ? `-${quote.currency} ${fmt(delta)}` : `+${quote.currency} ${fmt(-delta)}`}</strong>
                </p>
              )}
              {counter.counteredAt && (
                <p style={{ margin: "4px 0", color: "var(--text-secondary)", fontSize: 12 }}>
                  Submitted: {new Date(counter.counteredAt).toLocaleString()}
                </p>
              )}
              {counter.comments && (
                <div
                  style={{
                    marginTop: 12,
                    padding: 12,
                    background: "var(--surface-color, rgba(148, 163, 184, 0.06))",
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  <em>Customer comments:</em>
                  <p style={{ margin: "6px 0 0" }}>{counter.comments}</p>
                </div>
              )}
            </>
          ) : (
            <p style={{ color: "var(--text-secondary)" }}>
              No customer counter on record. The customer has not yet submitted a counter-offer for this quote.
            </p>
          )}
        </section>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={reject}
          disabled={acting || !canWrite || !counter}
          aria-label="Reject counter"
          style={{ background: "var(--danger-color, #f43f5e)", color: "#fff", padding: "8px 16px", border: "none", borderRadius: 6 }}
        >
          <ThumbsDown size={14} /> Reject
        </button>
        <button
          type="button"
          onClick={counterBack}
          disabled={acting || !canWrite || !counter}
          aria-label="Counter their counter"
          style={{ padding: "8px 16px", border: "1px solid var(--border-color)", borderRadius: 6 }}
        >
          <Copy size={14} /> Counter their counter
        </button>
        <button
          type="button"
          onClick={accept}
          disabled={acting || !canWrite || !counter}
          aria-label="Accept counter"
          style={{ background: "var(--success-color, #22c55e)", color: "#fff", padding: "8px 16px", border: "none", borderRadius: 6 }}
        >
          <ThumbsUp size={14} /> Accept
        </button>
      </div>
    </div>
  );
}
