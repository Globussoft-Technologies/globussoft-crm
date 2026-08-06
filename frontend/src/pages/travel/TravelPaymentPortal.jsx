import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, Mail, KeyRound, ReceiptText, RefreshCw } from "lucide-react";

const RAZORPAY_SDK_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    if (window.Razorpay) return resolve(true);
    const existing = document.querySelector(`script[src="${RAZORPAY_SDK_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src = RAZORPAY_SDK_SRC;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

async function portalFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/travel${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

export default function TravelPaymentPortal() {
  const params = useParams();
  const tokenParam = params.token || null;
  const tripId = Number(params.tripId);
  const installmentId = Number(params.installmentId);

  const [loading, setLoading] = useState(!!tokenParam);
  const [session, setSession] = useState(null);
  const [sessionToken, setSessionToken] = useState(tokenParam || "");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [payingId, setPayingId] = useState(null);
  const [proofRefs, setProofRefs] = useState({});
  const [proofFiles, setProofFiles] = useState({});
  const [bankSubmittingId, setBankSubmittingId] = useState(null);
  const [error, setError] = useState("");

  const loadSession = useCallback(async (resolvedToken) => {
    setLoading(true);
    setError("");
    try {
      const data = await portalFetch(`/payment-portal/session/${encodeURIComponent(resolvedToken)}`);
      setSession(data);
      setSessionToken(data.token || resolvedToken);
      if (data.participant?.parentEmail) setEmail(data.participant.parentEmail);
    } catch (e) {
      setError(e.message || "Failed to load payment portal");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tokenParam) loadSession(tokenParam);
    else setLoading(false);
  }, [tokenParam, loadSession]);

  const requestOtp = async () => {
    if (!Number.isFinite(tripId)) {
      setError("Trip link is invalid.");
      return;
    }
    if (!email.trim()) {
      setError("Please enter the email address used for the booking.");
      return;
    }
    setAuthLoading(true);
    setError("");
    try {
      await portalFetch("/payment-portal/request-otp", {
        method: "POST",
        body: { tripId, email },
      });
      setOtpSent(true);
    } catch (e) {
      setError(e.message || "Failed to send code");
    } finally {
      setAuthLoading(false);
    }
  };

  const verifyOtp = async () => {
    if (!Number.isFinite(tripId)) {
      setError("Trip link is invalid.");
      return;
    }
    if (!code.trim()) {
      setError("Enter the verification code sent to your email.");
      return;
    }
    setAuthLoading(true);
    setError("");
    try {
      const data = await portalFetch("/payment-portal/verify-otp", {
        method: "POST",
        body: { tripId, email, code, installmentId: Number.isFinite(installmentId) ? installmentId : undefined },
      });
      setSession(data);
      setSessionToken(data.token);
      setCode("");
    } catch (e) {
      setError(e.message || "Failed to verify code");
    } finally {
      setAuthLoading(false);
    }
  };

  const confirmPayment = async (payload) => {
    const response = await portalFetch("/payment-portal/confirm-razorpay", {
      method: "POST",
      body: { token: sessionToken, ...payload },
    });
    return response;
  };

  const startPayment = async (instalment) => {
    if (!sessionToken) return;
    setPayingId(instalment.id);
    setError("");
    try {
      const sdkReady = await loadRazorpayScript();
      if (!sdkReady) throw new Error("Could not load Razorpay Checkout. Please try again.");
      const order = await portalFetch("/payment-portal/create-order", {
        method: "POST",
        body: { token: sessionToken, installmentId: instalment.id },
      });
      await new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: session.trip?.tripCode || session.trip?.destination || "Travel payment",
          description: `${session.trip?.tripCode || session.trip?.destination || "Trip"} - instalment ${instalment.instalmentIndex + 1}`,
          theme: { color: "#122647" },
          handler: async (resp) => {
            try {
              await confirmPayment(resp);
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: {
            ondismiss: () => reject(new Error("__cancelled__")),
          },
        });
        rzp.on("payment.failed", (resp) => {
          reject(new Error(resp?.error?.description || "Payment failed. Please try again."));
        });
        rzp.open();
      });
      await loadSession(sessionToken);
    } catch (e) {
      if (e.message !== "__cancelled__") setError(e.message || "Payment could not be completed");
    } finally {
      setPayingId(null);
    }
  };


  const submitBankTransfer = async (instalment) => {
    const proofReference = String(proofRefs[instalment.id] || "").trim();
    const proofFileName = proofFiles[instalment.id] || "";
    if (!proofReference && !proofFileName) {
      setError("Enter a UTR/reference number or choose a proof file name before submitting.");
      return;
    }
    setBankSubmittingId(instalment.id);
    setError("");
    try {
      await portalFetch("/payment-portal/submit-bank-transfer", {
        method: "POST",
        body: { token: sessionToken, installmentId: instalment.id, proofReference, proofFileName },
      });
      setProofRefs((prev) => ({ ...prev, [instalment.id]: "" }));
      setProofFiles((prev) => ({ ...prev, [instalment.id]: "" }));
      await loadSession(sessionToken);
    } catch (e) {
      setError(e.message || "Failed to submit bank transfer proof");
    } finally {
      setBankSubmittingId(null);
    }
  };
  if (loading) {
    return (
      <PageShell>
        <Loader2 size={28} aria-hidden style={{ animation: "spin 1s linear infinite", color: "#122647" }} />
      </PageShell>
    );
  }

  if (error && !session && !tokenParam) {
    return (
      <PageShell>
        <AlertBox message={error} />
        <button type="button" onClick={() => window.location.reload()} style={btnSecondary}>
          <RefreshCw size={14} aria-hidden /> Retry
        </button>
      </PageShell>
    );
  }

  const instalments = Array.isArray(session?.instalments) ? session.instalments : [];

  return (
    <PageShell>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <ReceiptText size={18} aria-hidden style={{ color: "#122647" }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>Payment Portal</h1>
            <div style={{ color: "#64748b", fontSize: 13 }}>
              {session?.trip?.tripCode || session?.trip?.destination || "Trip payment"}
            </div>
          </div>
        </div>

        {!session && !tokenParam ? (
          <div style={{ display: "grid", gap: 14 }}>
            <p style={{ margin: 0, color: "#334155",
              lineHeight: 1.45,
              fontSize: 14 }}>
              Enter the email used for the booking. We will send a verification code before showing the instalments.
            </p>
            <label style={fieldLabel}>
              <span style={fieldText}><Mail size={14} aria-hidden /> Email</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} placeholder="parent@example.com" />
            </label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={requestOtp} disabled={authLoading} style={btnPrimary}>
                <KeyRound size={14} aria-hidden /> {authLoading ? "Sending..." : "Send code"}
              </button>
            </div>
            {otpSent && (
              <>
                <label style={fieldLabel}>
                  <span style={fieldText}><CheckCircle2 size={14} aria-hidden /> Verification code</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} inputMode="numeric" placeholder="123456" />
                </label>
                <button type="button" onClick={verifyOtp} disabled={authLoading} style={btnPrimary}>
                  <CreditCard size={14} aria-hidden /> {authLoading ? "Verifying..." : "Verify and continue"}
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, color: "#334155", lineHeight: 1.45, fontSize: 14 }}>
              <span><strong>Participant:</strong> {session?.participant?.fullName || "Approved participant"}</span>
              <span><strong>Email:</strong> {session?.participant?.parentEmail || email}</span>
            </div>

            {error && <AlertBox message={error} />}

            <div style={{ display: "grid", gap: 10 }}>
              {instalments.map((inst) => {
                const paid = Number(inst.paidAmount || 0);
                const amount = Number(inst.amount || 0);
                const due = inst.status === "paid" ? "Paid" : inst.status === "pending_verification" ? "Pending verification" : inst.status === "partial" ? `Partial - ₹${paid.toLocaleString()} / ₹${amount.toLocaleString()}` : `Due ₹${amount.toLocaleString()}`;
                const disabled = inst.status === "paid" || inst.status === "pending_verification";
                const bank = session?.bankTransfer || {};
                return (
                  <div key={inst.id} style={instRow}>
                    <div style={instHeaderRow}>
                      <div style={instSummary}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: "#122647", lineHeight: 1.2 }}>Installment {inst.instalmentIndex + 1}</div>
                        <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.35 }}>Due {inst.dueDate ? new Date(inst.dueDate).toLocaleDateString() : "TBA"}</div>
                        <div style={{ fontSize: 13, marginTop: 4, fontWeight: 600, lineHeight: 1.35, color: inst.status === "paid" ? "#166534" : inst.status === "pending_verification" ? "#9a3412" : inst.status === "partial" ? "#9a6f2e" : "#334155" }}>{due}</div>
                      </div>
                      <button
                        type="button"
                        disabled={disabled || payingId === inst.id}
                        onClick={() => startPayment(inst)}
                        style={{ ...btnPrimary, opacity: disabled || payingId === inst.id ? 0.6 : 1, alignSelf: "flex-start", flexShrink: 0, minWidth: 112 }}
                      >
                        <CreditCard size={14} aria-hidden /> {inst.status === "paid" ? "Paid" : inst.status === "pending_verification" ? "Pending verification" : payingId === inst.id ? "Opening..." : "Pay now"}
                      </button>
                    </div>
                    {!disabled && (
                      <div style={bankBox}>
                        <div style={{ fontWeight: 700, color: "#122647" }}>Bank transfer</div>
                        <div style={bankGrid}>
                          <span><strong>Account:</strong> {bank.accountName || "Travel account"}</span>
                          <span><strong>Bank:</strong> {bank.bankName || "Contact advisor"}</span>
                          <span><strong>A/C:</strong> {bank.accountNumber || "Contact advisor"}</span>
                          <span><strong>IFSC:</strong> {bank.ifsc || "Contact advisor"}</span>
                          {bank.upiId && <span><strong>UPI:</strong> {bank.upiId}</span>}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8 }}>
                          <input
                            value={proofRefs[inst.id] || ""}
                            onChange={(e) => setProofRefs((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                            style={inputStyle}
                            placeholder="UTR/reference number or proof link"
                            aria-label={`Bank transfer proof for installment ${inst.instalmentIndex + 1}`}
                          />
                          <button type="button" onClick={() => submitBankTransfer(inst)} disabled={bankSubmittingId === inst.id} style={{ ...btnSecondary, opacity: bankSubmittingId === inst.id ? 0.6 : 1 }}>
                            {bankSubmittingId === inst.id ? "Submitting..." : "Submit proof"}
                          </button>
                        </div>
                        <input
                          type="file"
                          onChange={(e) => setProofFiles((prev) => ({ ...prev, [inst.id]: e.target.files?.[0]?.name || "" }))}
                          style={{ fontSize: 12, color: "#64748b" }}
                          aria-label={`Choose bank transfer proof file for installment ${inst.instalmentIndex + 1}`}
                        />
                        <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.45 }}>Proof is recorded for admin verification. The installment is marked paid only after approval.</div>
                      </div>
                    )}
                  </div>
                );
              })}
              {instalments.length === 0 && <p style={{ margin: 0, color: "#64748b" }}>No instalments found for this participant.</p>}
            </div>
          </div>
        )}
      </div>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </PageShell>
  );
}

function PageShell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "min(760px, 100%)" }}>{children}</div>
    </div>
  );
}

function AlertBox({ message }) {
  return (
    <div style={alertBox} role="alert">
      <AlertTriangle size={16} aria-hidden />
      <span>{message}</span>
    </div>
  );
}

const card = {
  background: "#fff",
  border: "1px solid rgba(18,38,71,0.12)",
  borderRadius: 18,
  boxShadow: "0 16px 40px rgba(18,38,71,0.10)",
  padding: 24,
};
const alertBox = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "#fff7ed",
  border: "1px solid #fed7aa",
  color: "#9a3412",
  borderRadius: 12,
  padding: "10px 12px",
};
const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid rgba(18,38,71,0.14)",
  borderRadius: 10,
  fontSize: 15,
  background: "#fff",
  color: "#111827",
};
const fieldLabel = { display: "grid", gap: 6 };
const fieldText = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "#334155" };
const btnPrimary = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  border: "none",
  borderRadius: 10,
  padding: "10px 14px",
  background: "#122647",
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
};
const btnSecondary = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  border: "1px solid rgba(18,38,71,0.14)",
  borderRadius: 10,
  padding: "10px 14px",
  background: "#fff",
  color: "#122647",
  fontWeight: 700,
  cursor: "pointer",
};
const bankBox = {
  width: "100%",
  display: "grid",
  gap: 8,
  marginTop: 8,
  padding: 12,
  border: "1px dashed rgba(18,38,71,0.18)",
  borderRadius: 12,
  background: "#fff",
};
const bankGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
  gap: 6,
  color: "#334155",
  lineHeight: 1.45,
  fontSize: 12,
};
const instRow = {
  display: "grid",
  gap: 12,
  padding: 14,
  border: "1px solid rgba(18,38,71,0.10)",
  borderRadius: 14,
  background: "#f8fafc",
};
const instHeaderRow = {
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
  justifyContent: "space-between",
  flexWrap: "wrap",
  minWidth: 0,
};
const instSummary = {
  minWidth: 0,
  flex: 1,
  color: "#122647",
};
