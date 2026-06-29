import { useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2 } from "lucide-react";

export default function InvoicePaymentSuccess() {
  const [confirming, setConfirming] = useState(true);
  const [plinkId, setPlinkId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const plink = params.get("razorpay_payment_link_id");
    const status = params.get("razorpay_payment_link_status");

    // Razorpay payment links with accept_partial=true can return either
    // "paid" (full amount) or "partially_paid" (advance / part payment).
    // Both are successful completions and must be reconciled.
    const isSuccess = status === "paid" || status === "partially_paid";
    if (!plink || !isSuccess) {
      setConfirming(false);
      return;
    }

    setPlinkId(plink);

    fetch("/api/billing/public/confirm-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_payment_link_id: plink,
        razorpay_payment_link_reference_id: params.get("razorpay_payment_link_reference_id"),
        razorpay_payment_link_status: status,
        razorpay_payment_id: params.get("razorpay_payment_id"),
        razorpay_signature: params.get("razorpay_signature"),
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setSummary(data);
      })
      .catch(() => {})
      .finally(() => setConfirming(false));
  }, []);

  const isPartial = summary && summary.balanceDue > 0;

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        {confirming ? (
          <>
            <Loader2 size={48} color="#10b981" style={{ marginBottom: 16, animation: "spin 1s linear infinite" }} />
            <p style={subStyle}>Confirming your payment…</p>
          </>
        ) : (
          <>
            <CheckCircle2 size={56} color="#10b981" style={{ marginBottom: 20 }} />
            <h1 style={headingStyle}>Payment Successful</h1>
            <p style={subStyle}>
              Thank you — your payment has been received and recorded.
              {!error && summary && (
                isPartial
                  ? " A balance remains on this booking; you can use the same link to pay the remainder."
                  : " Your booking is fully paid."
              )}
            </p>

            {summary && (
              <div style={summaryStyle}>
                <div style={summaryRowStyle}>
                  <span style={summaryLabelStyle}>Amount paid</span>
                  <span style={summaryValueStyle}>
                    {summary.currency || "INR"} {Number(summary.amountPaid || 0).toLocaleString("en-IN")}
                  </span>
                </div>
                {summary.invoiceNum && (
                  <div style={summaryRowStyle}>
                    <span style={summaryLabelStyle}>Invoice</span>
                    <span style={summaryValueStyle}>{summary.invoiceNum}</span>
                  </div>
                )}
                {isPartial && (
                  <div style={summaryRowStyle}>
                    <span style={summaryLabelStyle}>Balance due</span>
                    <span style={summaryValueStyle}>
                      {summary.currency || "INR"} {Number(summary.balanceDue || 0).toLocaleString("en-IN")}
                    </span>
                  </div>
                )}
              </div>
            )}

            {plinkId && (
              <a
                href={`/api/billing/public/receipt?plinkId=${encodeURIComponent(plinkId)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={downloadBtnStyle}
              >
                <Download size={16} style={{ marginRight: 8 }} />
                Download Receipt / Invoice PDF
              </a>
            )}

            {error && (
              <p style={{ marginTop: 16, fontSize: 13, color: "#ef4444" }}>{error}</p>
            )}
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

const downloadBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  marginTop: 28,
  padding: "12px 24px",
  background: "#10b981",
  color: "#fff",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 15,
  textDecoration: "none",
};
