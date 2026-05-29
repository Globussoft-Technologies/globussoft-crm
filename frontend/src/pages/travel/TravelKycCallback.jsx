// Travel CRM — DigiLocker / Aadhaar OAuth callback handler.
//
// This is the page DigiLocker redirects the browser back to after the user
// consents (real mode). It reads ?code & ?state from the URL and replays
// them to the backend to complete verification, then bounces the user back
// to where they started.
//
// Two flows share this component via the `flow` prop:
//   - flow="portal"    → POST /api/portal/kyc/callback (Bearer portalToken),
//                        then back to /travel/portal
//   - flow="microsite" → POST /api/travel/microsites/public/:uuid/verify/
//                        aadhaar/callback, then back to the trip page
//
// The microsite flow needs the publicUuid, which the public microsite page
// stashes in sessionStorage before redirecting out to DigiLocker.

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

const PORTAL_TOKEN_KEY = "portalToken";
const KYC_MICROSITE_UUID_KEY = "kycMicrositeUuid";

export default function TravelKycCallback({ flow }) {
  const [status, setStatus] = useState("working"); // working | ok | error
  const [message, setMessage] = useState("Completing your Aadhaar verification…");
  const ran = useRef(false);

  useEffect(() => {
    // React 18 StrictMode double-invokes effects in dev; the auth code is
    // single-use, so guard against replaying it twice.
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const state = params.get("state");
    const code = params.get("code");
    const oauthError = params.get("error");

    async function complete() {
      if (oauthError) {
        setStatus("error");
        setMessage(
          oauthError === "access_denied"
            ? "You declined to share your Aadhaar with DigiLocker."
            : `DigiLocker reported an error: ${oauthError}`,
        );
        return;
      }
      if (!state || !code) {
        setStatus("error");
        setMessage("DigiLocker did not return the expected verification details.");
        return;
      }
      try {
        if (flow === "portal") {
          const token = localStorage.getItem(PORTAL_TOKEN_KEY);
          const data = await postJson("/api/portal/kyc/callback", { state, code }, token);
          setStatus("ok");
          setMessage(`Verified ✓ — Aadhaar ••••${data.aadhaarLast4 || "????"}`);
          redirectAfter("/travel/portal");
        } else {
          const uuid = sessionStorage.getItem(KYC_MICROSITE_UUID_KEY);
          if (!uuid) {
            throw new Error("Verification context was lost — please reopen the trip page and try again.");
          }
          const data = await postJson(
            `/api/travel/microsites/public/${uuid}/verify/aadhaar/callback`,
            { state, code },
          );
          sessionStorage.removeItem(KYC_MICROSITE_UUID_KEY);
          setStatus("ok");
          setMessage(`Verified ✓ — Aadhaar ••••${data.aadhaarLast4 || "????"}`);
          redirectAfter(`/p/tripmicrosite/${uuid}?verified=1`);
        }
      } catch (err) {
        setStatus("error");
        setMessage(err.message || "We couldn't complete the verification.");
      }
    }
    complete();
  }, [flow]);

  return (
    <div style={wrap}>
      <div style={card}>
        {status === "working" && <Loader2 size={40} style={{ ...icon, animation: "spin 1s linear infinite" }} aria-hidden />}
        {status === "ok" && <CheckCircle2 size={40} style={{ ...icon, color: "#16a34a" }} aria-hidden />}
        {status === "error" && <AlertCircle size={40} style={{ ...icon, color: "#dc2626" }} aria-hidden />}
        <h2 style={{ margin: "12px 0 6px", fontSize: 18 }}>
          {status === "ok" ? "Verification complete" : status === "error" ? "Verification problem" : "Please wait"}
        </h2>
        <p style={{ margin: 0, color: "#475569", fontSize: 14 }}>{message}</p>
        {status === "ok" && <p style={{ marginTop: 10, color: "#94a3b8", fontSize: 12 }}>Redirecting you back…</p>}
      </div>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

async function postJson(url, body, bearer) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Verification failed (HTTP ${res.status})`);
  return data;
}

function redirectAfter(path, delayMs = 1800) {
  setTimeout(() => { window.location.href = path; }, delayMs);
}

const wrap = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f1f5f9",
  padding: 20,
};
const card = {
  background: "#fff",
  borderRadius: 16,
  padding: "36px 32px",
  maxWidth: 420,
  textAlign: "center",
  boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
};
const icon = { color: "#122647" };
