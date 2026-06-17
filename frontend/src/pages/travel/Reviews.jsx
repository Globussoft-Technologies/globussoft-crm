// Travel CRM — admin "Customer Reviews" page (2026-06-16).
//
// Lands at /travel/reviews. Lists submitted post-trip reviews for the tenant
// (sub-brand scoped server-side) from GET /api/travel/reviews. Shows the
// headline star rating + the full per-question breakdown (the fixed set from
// backend/lib/travelReviewQuestions.js).

import { useEffect, useState } from "react";
import { Star, RefreshCw, MessageSquareText } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const PRIMARY = "var(--primary-color, var(--accent-color, #122647))";

// Mirrors the fixed question set in backend/lib/travelReviewQuestions.js so the
// stored answer keys render with human labels.
const Q_LABELS = {
  rate_accommodation: "Accommodation & hotels",
  rate_transport: "Transportation & transfers",
  rate_activities: "Activities & sightseeing",
  rate_support: "Tour coordination & support",
  rate_value: "Value for money",
  recommend: "Would recommend?",
  rebook: "Book again?",
  loved_most: "Loved most",
  improve: "Could do better",
  highlight: "Memorable moment",
};
const RATING_IDS = ["rate_accommodation", "rate_transport", "rate_activities", "rate_support", "rate_value"];
const CHOICE_IDS = ["recommend", "rebook"];
const TEXT_IDS = ["loved_most", "improve", "highlight"];

function Stars({ value, size = 16 }) {
  const v = Number(value) || 0;
  return (
    <span style={{ display: "inline-flex", gap: 1, verticalAlign: "middle" }} aria-label={`${v} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={size} aria-hidden fill={n <= v ? "#F5B301" : "none"} color={n <= v ? "#F5B301" : "var(--text-secondary,#94a3b8)"} />
      ))}
    </span>
  );
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "—");
// Theme-safe surface — uses the travel theme's --surface-color / --text-* so it
// reads correctly in BOTH light and dark mode (the earlier --card-bg/#fff
// fallback rendered light-on-white in dark mode).
const card = {
  background: "var(--surface-color, #fff)",
  border: "1px solid var(--border-color, var(--border-light, #e2e8f0))",
  borderRadius: 12, padding: 18, marginBottom: 14,
  color: "var(--text-primary)", boxShadow: "var(--shadow-sm)",
};

export default function Reviews() {
  const notify = useNotify();
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetchApi("/api/travel/reviews")
      .then((res) => setReviews(Array.isArray(res?.reviews) ? res.reviews : []))
      .catch((e) => { notify.error(e?.body?.error || "Failed to load reviews"); setReviews([]); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rated = reviews.filter((r) => typeof r.overallRating === "number");
  const avg = rated.length ? (rated.reduce((s, r) => s + r.overallRating, 0) / rated.length) : 0;

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
          <MessageSquareText size={26} aria-hidden /> Customer Reviews
        </h1>
        <button type="button" onClick={load} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border-light,#d1d5db)", background: "transparent", cursor: "pointer", fontWeight: 600 }}>
          <RefreshCw size={15} aria-hidden /> Refresh
        </button>
      </div>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Post-trip feedback from your customers.{" "}
        {rated.length > 0 && (
          <strong>{reviews.length} review{reviews.length !== 1 ? "s" : ""} · average <Stars value={Math.round(avg)} /> {avg.toFixed(1)}/5</strong>
        )}
      </p>

      {loading && <p style={{ color: "var(--text-secondary)" }}>Loading…</p>}
      {!loading && reviews.length === 0 && (
        <div style={{ ...card, textAlign: "center", color: "var(--text-secondary)" }}>
          No reviews yet. Customers are asked for a review after their trip ends.
        </div>
      )}

      {!loading && reviews.map((r) => {
        const a = r.answers || {};
        return (
          <div key={r.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>{r.destination || "Trip"}</div>
                {/* WHO left the review — name + contact, so the advisor can follow up. */}
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginTop: 3 }}>
                  {r.contactName || `Contact #${r.contactId}`}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                  {r.subBrand && <span style={{ textTransform: "uppercase", letterSpacing: 0.5, marginRight: 8 }}>{r.subBrand}</span>}
                  {r.contactEmail && <span style={{ marginRight: 8 }}>{r.contactEmail}</span>}
                  {r.contactPhone && <span style={{ marginRight: 8 }}>{r.contactPhone}</span>}
                  · {fmtDate(r.submittedAt)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <Stars value={r.overallRating} size={20} />
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r.overallRating}/5 overall</div>
              </div>
            </div>

            {/* Ratings */}
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: "6px 18px" }}>
              {RATING_IDS.filter((id) => a[id] != null).map((id) => (
                <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{Q_LABELS[id]}</span>
                  <Stars value={a[id]} size={14} />
                </div>
              ))}
            </div>

            {/* Loyalty choices */}
            {CHOICE_IDS.some((id) => a[id]) && (
              <div style={{ marginTop: 10, display: "flex", gap: 18, flexWrap: "wrap" }}>
                {CHOICE_IDS.filter((id) => a[id]).map((id) => (
                  <span key={id} style={{ fontSize: 13 }}>
                    <span style={{ color: "var(--text-secondary)" }}>{Q_LABELS[id]} </span>
                    <strong style={{ color: PRIMARY }}>{a[id]}</strong>
                  </span>
                ))}
              </div>
            )}

            {/* Free text */}
            {TEXT_IDS.filter((id) => a[id]).map((id) => (
              <div key={id} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{Q_LABELS[id]}</div>
                <div style={{ fontSize: 14, fontStyle: "italic", color: "var(--text-primary)", borderLeft: `3px solid ${PRIMARY}`, paddingLeft: 10, marginTop: 2 }}>“{a[id]}”</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
