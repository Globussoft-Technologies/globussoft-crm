import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, Loader2, AlertTriangle } from "lucide-react";

/**
 * Razorpay callback landing page for itinerary advance/balance payments.
 *
 * Razorpay redirects here (with GET query params) after redirect-based
 * payment methods such as Netbanking, UPI intent, and some 3DS card flows.
 * The page forwards the signature to the existing verify-payment endpoint,
 * which reconciles the payment exactly like the modal handler path — so the
 * admin itinerary view, payment ledger, and status updates all happen through
 * the same backend code.
 */
export default function ItineraryPaymentSuccess() {
  const { shareToken } = useParams();
  const [confirming, setConfirming] = useState(true);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("razorpay_order_id");
    const paymentId = params.get("razorpay_payment_id");
    const signature = params.get("razorpay_signature");

    if (!shareToken) {
      setError("Payment details are missing. Please return to the itinerary and try again.");
      setConfirming(false);
      return;
    }

    const razorpayError = params.get("error");
    const razorpayErrorDesc = params.get("error_description");
    if (razorpayError || razorpayErrorDesc) {
      setError(razorpayErrorDesc || razorpayError || "Payment could not be completed. Please return to the itinerary and try again.");
      setConfirming(false);
      return;
    }

    if (!orderId || !paymentId || !signature) {
      setError("Payment details are missing. Please return to the itinerary and try again.");
      setConfirming(false);
      return;
    }

    fetch(`/api/travel/itineraries/public/${encodeURIComponent(shareToken)}/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      }),
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Payment verification failed.");
        return data;
      })
      .then((data) => setSummary(data))
      .catch((err) => setError(err.message || "Could not confirm payment. Please contact support."))
      .finally(() => setConfirming(false));
  }, [shareToken]);

  const hasBalance = summary && Number(summary.balanceDue || 0) > 0;
  const itineraryUrl = `/p/itinerary/${encodeURIComponent(shareToken || "")}`;

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        {confirming ? (
          <>
            <Loader2 size={48} color="#10b981" style={{ marginBottom: 16, animation: "spin 1s linear infinite" }} />
            <p style={subStyle}>Confirming your payment…</p>
          </>
        ) : error ? (
          <>
            <AlertTriangle size={56} color="#ef4444" style={{ marginBottom: 20 }} />
            <h1 style={headingStyle}>Payment Could Not Be Confirmed</h1>
            <p style={subStyle}>{error}</p>
            <a href={itineraryUrl} style={secondaryBtnStyle}>
              Return to itinerary
            </a>
          </>
        ) : (
          <>
            <CheckCircle2 size={56} color="#10b981" style={{ marginBottom: 20 }} />
            <h1 style={headingStyle}>Payment Successful</h1>
            <p style={subStyle}>
              Thank you — your payment has been received and recorded.
              {hasBalance
                ? " A balance remains on this booking; you can return to the itinerary to pay the remainder."
                : " Your booking is fully paid."}
            </p>

            {summary && (
              <div style={summaryStyle}>
                <div style={summaryRowStyle}>
                  <span style={summaryLabelStyle}>Amount paid</span>
                  <span style={summaryValueStyle}>
                    {summary.currency || "INR"} {Number(summary.advancePaidAmount || 0).toLocaleString("en-IN")}
                  </span>
                </div>
                {summary.status && (
                  <div style={summaryRowStyle}>
                    <span style={summaryLabelStyle}>Booking status</span>
                    <span style={summaryValueStyle}>{summary.status}</span>
                  </div>
                )}
                {hasBalance && (
                  <div style={summaryRowStyle}>
                    <span style={summaryLabelStyle}>Balance due</span>
                    <span style={summaryValueStyle}>
                      {summary.currency || "INR"} {Number(summary.balanceDue || 0).toLocaleString("en-IN")}
                    </span>
                  </div>
                )}
              </div>
            )}

            <a href={itineraryUrl} style={primaryBtnStyle}>
              Return to itinerary
            </a>
          </>
        )}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: "#f9fafb",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px 16px",
};

const cardStyle = {
  background: "#fff",
  borderRadius: 16,
  padding: "48px 40px",
  maxWidth: 480,
  width: "100%",
  textAlign: "center",
  boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
};

const headingStyle = {
  fontSize: 26,
  fontWeight: 700,
  color: "#111827",
  margin: "0 0 12px",
};

const subStyle = {
  fontSize: 15,
  color: "#6b7280",
  lineHeight: 1.6,
  margin: 0,
};

const summaryStyle = {
  marginTop: 24,
  padding: 16,
  background: "#f3f4f6",
  borderRadius: 8,
  textAlign: "left",
};

const summaryRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 8,
  fontSize: 14,
};

const summaryLabelStyle = {
  color: "#6b7280",
};

const summaryValueStyle = {
  fontWeight: 600,
  color: "#111827",
};

const primaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  marginTop: 28,
  padding: "12px 24px",
  background: "#10b981",
  color: "#fff",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 15,
  textDecoration: "none",
};

const secondaryBtnStyle = {
  ...primaryBtnStyle,
  background: "#fff",
  color: "#111827",
  border: "1px solid #d1d5db",
};
