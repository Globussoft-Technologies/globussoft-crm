import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Check, Loader2, Sparkles, ArrowLeft } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { tokensToCredits } from "../utils/aiCredits";

const CURRENCY_SYM = { INR: "₹", USD: "$" };

export default function AiSubscription() {
  const navigate = useNavigate();
  const notify = useNotify();
  const [plans, setPlans] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [purchasingPlanId, setPurchasingPlanId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [plansRes, statusRes] = await Promise.all([
        fetchApi("/api/ai-subscriptions/plans"),
        fetchApi("/api/ai-provider-management/status"),
      ]);
      setPlans(Array.isArray(plansRes) ? plansRes : []);
      setStatus(statusRes);
    } catch (err) {
      notify.error(err.message || "Failed to load AI subscription plans.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    document.body.appendChild(script);
    return () => document.body.removeChild(script);
  }, []);

  const handlePurchase = async (plan) => {
    if (!window.Razorpay) {
      notify.error("Payment system is still loading. Please try again in a moment.");
      return;
    }
    setPurchasingPlanId(plan.id);
    try {
      const orderData = await fetchApi("/api/ai-subscriptions/create-order", {
        method: "POST",
        body: JSON.stringify({ planId: plan.id }),
      });

      const razorpayKeyId = import.meta.env.VITE_RAZORPAY_KEY_ID;
      if (!razorpayKeyId) {
        throw new Error("Razorpay Key ID not configured (VITE_RAZORPAY_KEY_ID)");
      }
      if (!orderData.orderId || !orderData.amount || !orderData.currency) {
        throw new Error("Invalid order data from server");
      }

      const options = {
        key: razorpayKeyId,
        amount: orderData.amount,
        currency: orderData.currency,
        order_id: orderData.orderId,
        name: "Globussoft CRM",
        description: `${plan.name} — CRM-managed AI subscription`,
        handler: async (response) => {
          try {
            await fetchApi("/api/ai-subscriptions/verify-payment", {
              method: "POST",
              body: JSON.stringify({
                razorpayOrderId: orderData.orderId,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            notify.success(`${plan.name} activated — ${tokensToCredits(plan.creditTokens).toLocaleString()} AI credits added.`);
            navigate("/settings/ai-usage");
          } catch (err) {
            notify.error(err.message || "Payment verification failed. Contact support if you were charged.");
          } finally {
            setPurchasingPlanId(null);
          }
        },
        modal: {
          ondismiss: () => setPurchasingPlanId(null),
        },
        theme: { color: "#3b82f6" },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      notify.error(err.message || "Failed to start checkout.");
      setPurchasingPlanId(null);
    }
  };

  const hasByok = Boolean(status?.byokConfigured);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(1rem, 3vw, 2rem)" }}>
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="btn-secondary"
        style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", marginBottom: "1.5rem" }}
      >
        <ArrowLeft size={16} /> Back
      </button>

      <div style={{ textAlign: "center", marginBottom: "2rem" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <Bot size={28} color="var(--accent-color)" />
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>AI Subscription</h1>
        </div>
        <p style={{ color: "var(--text-secondary)", maxWidth: 560, margin: "0 auto" }}>
          Purchase CRM-managed AI credits to use AI-powered features without configuring your own provider API key.
        </p>
      </div>

      {hasByok && (
        <div
          style={{
            padding: "1rem",
            marginBottom: "1.5rem",
            borderRadius: 8,
            background: "rgba(16, 185, 129, 0.1)",
            border: "1px solid #10b981",
            display: "flex",
            gap: "0.75rem",
            alignItems: "flex-start",
          }}
        >
          <Check size={18} color="#10b981" style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            Your organization already has its own AI provider configured — that always takes priority. You can still
            purchase a CRM-managed plan as a fallback for when your own key is removed.
          </div>
        </div>
      )}

      {status?.activeSubscription && (
        <div
          style={{
            padding: "1rem",
            marginBottom: "1.5rem",
            borderRadius: 8,
            background: "rgba(59,130,246,0.08)",
            border: "1px solid rgba(59,130,246,0.35)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.75rem",
          }}
        >
          <div>
            <strong>Current plan: {status.activeSubscription.planName}</strong>
            <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
              {tokensToCredits(status.creditWallet.balanceTokens).toLocaleString()} / {tokensToCredits(status.creditWallet.totalPurchasedTokens).toLocaleString()} credits
              remaining ({status.creditWallet.percentRemaining}%)
            </div>
          </div>
          <button type="button" className="btn-secondary" onClick={() => navigate("/settings/ai-usage")}>
            View usage dashboard
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <Loader2 size={28} className="spin" />
        </div>
      ) : plans.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "var(--text-secondary)" }}>
          No AI subscription plans are available yet. Please check back later or contact support.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
            gap: "1.25rem",
          }}
        >
          {plans.map((plan) => {
            const sym = CURRENCY_SYM[plan.currency] || plan.currency + " ";
            return (
              <div
                key={plan.id}
                className="card"
                style={{
                  padding: "1.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                  border:
                    status?.activeSubscription?.planId === plan.id
                      ? "2px solid var(--accent-color)"
                      : "1px solid var(--border-color)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <Sparkles size={18} color="var(--accent-color)" />
                  <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>{plan.name}</h3>
                </div>
                {plan.description && (
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-secondary)" }}>{plan.description}</p>
                )}
                <div style={{ fontSize: "1.75rem", fontWeight: 700 }}>
                  {sym}
                  {plan.price.toLocaleString()}
                  <span style={{ fontSize: "0.85rem", fontWeight: 400, color: "var(--text-secondary)" }}>
                    {" "}
                    / {plan.billingCycle === "one_time" ? "one-time" : "month"}
                  </span>
                </div>
                <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                  {tokensToCredits(plan.creditTokens).toLocaleString()} AI Credits
                </div>
                {plan.validityDays && (
                  <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    Valid for {plan.validityDays} days
                  </div>
                )}
                {plan.featureRestrictions?.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                    {plan.featureRestrictions.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
                {plan.fairUsagePolicy && (
                  <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-secondary)", fontStyle: "italic" }}>
                    {plan.fairUsagePolicy}
                  </p>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handlePurchase(plan)}
                  disabled={purchasingPlanId === plan.id}
                  style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}
                >
                  {purchasingPlanId === plan.id ? (
                    <>
                      <Loader2 size={16} className="spin" /> Processing...
                    </>
                  ) : (
                    "Purchase Plan"
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
