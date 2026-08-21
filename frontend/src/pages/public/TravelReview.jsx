import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import TravelReviewForm from "../../components/TravelReviewForm";

const wrap = { minHeight: "100vh", background: "var(--cream-bg, #f7f3ec)", padding: "32px 16px", color: "var(--text-primary, #1e293b)" };
const card = { maxWidth: 640, margin: "0 auto", background: "#fff", borderRadius: 16, padding: "28px 28px 32px", boxShadow: "0 6px 30px rgba(18,38,71,0.10)" };
const reviewBox = { marginTop: 18, padding: 16, borderRadius: 12, background: "#f8fafc", border: "1px solid #dbe4f0", textAlign: "left" };
const ctaBtn = { display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 14, padding: "11px 18px", borderRadius: 10, background: "#1d4ed8", color: "#fff", textDecoration: "none", fontWeight: 700 };

export default function TravelReview() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, data: null, done: false, externalReview: null });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/travel/reviews/public/${encodeURIComponent(token || "")}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "This review link is not valid.");
        return body;
      })
      .then((data) => { if (alive) setState({ loading: false, error: null, data, done: data.alreadySubmitted, externalReview: null }); })
      .catch((e) => { if (alive) setState({ loading: false, error: e.message, data: null, done: false, externalReview: null }); });
    return () => { alive = false; };
  }, [token]);

  const submit = async (answers) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(`/api/travel/reviews/public/${encodeURIComponent(token || "")}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not submit your review. Please try again.");
      setState((s) => ({ ...s, done: true, externalReview: body.externalReview || null }));
    } catch (e) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (state.loading) {
    return <div style={wrap}><div style={card}>Loading…</div></div>;
  }
  if (state.error) {
    return <div style={wrap}><div style={card}><h2 style={{ marginTop: 0 }}>Review unavailable</h2><p style={{ color: "var(--text-secondary,#64748b)" }}>{state.error}</p></div></div>;
  }
  if (state.done) {
    const followUp = state.externalReview;
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: "center" }}>
          <div style={{ fontSize: 34, lineHeight: 1, fontWeight: 700, color: "#1d4ed8" }}>5/5</div>
          <h2 style={{ margin: "12px 0 6px" }}>Thank you for your review!</h2>
          <p style={{ color: "var(--text-secondary,#64748b)" }}>
            Your feedback on {state.data?.destination || "your trip"} helps us make every journey better.
          </p>
          {followUp?.enabled && (
            <div style={reviewBox}>
              <p style={{ margin: 0, fontWeight: 600, color: "#0f172a" }}>{followUp.message}</p>
              {followUp.suggestedReview && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Suggested review
                  </div>
                  <div style={{ marginTop: 6, color: "#0f172a", lineHeight: 1.55 }}>{followUp.suggestedReview}</div>
                </div>
              )}
              <a href={followUp.url} target="_blank" rel="noreferrer" style={ctaBtn}>
                {followUp.label || "Post to Google"}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <p style={{ fontSize: 13, color: "var(--text-secondary,#64748b)", margin: 0, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Travel Stall · Trip review
        </p>
        <h1 style={{ fontSize: 24, margin: "6px 0 18px" }}>{state.data?.form?.formTitle || "How was your trip?"}</h1>
        <TravelReviewForm form={state.data?.form} onSubmit={submit} submitting={submitting} submitError={submitError} />
      </div>
    </div>
  );
}


