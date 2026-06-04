// Travel CRM — public trip microsite (parent / teacher facing, no login).
//
// Served at /p/tripmicrosite/:publicUuid (the URL TmcMicrositePreview links
// to). Shows the public trip info + the participant list, with DigiLocker
// Aadhaar verification per participant. All endpoints are public (server
// openPath allowlist on /travel/microsites/public).
//
// No app-side OTP: authenticity is established by DigiLocker itself — the
// parent signs in to THEIR OWN DigiLocker account (its own OTP / MPIN) and
// consents before any Aadhaar data is shared. Clicking "Verify Aadhaar"
// hands off to DigiLocker (real mode) or completes inline (stub mode, when
// no APISetu keys are configured — synthetic last-4 for dev/demo).
//
// The ONLY external dependency is the APISetu DigiLocker keys; until they
// land the flow runs in stub mode end-to-end.

import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { ShieldCheck, CheckCircle2, AlertCircle, Loader2, Plane } from "lucide-react";

const KYC_MICROSITE_UUID_KEY = "kycMicrositeUuid";

/** Lightweight client-side HTML sanitiser — strips scripts, event handlers,
 *  and javascript: URLs as defence-in-depth even though the server already
 *  runs sanitizeBody on storage. */
function sanitizeHtml(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw;
  // Remove <script> and <style> blocks entirely
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  // Remove on* event handlers from tags
  s = s.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
  // Neutralise javascript: / data: URLs
  s = s.replace(/(href|src|action)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]*)/gi, '$1="#"');
  s = s.replace(/(href|src|action)\s*=\s*("data:[^"]*"|'data:[^']*'|data:[^\s>]*)/gi, '$1="#"');
  return s;
}

async function publicFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/travel/microsites/public${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export default function PublicTripMicrosite() {
  const { publicUuid } = useParams();
  const justVerified = new URLSearchParams(window.location.search).get("verified") === "1";

  const [info, setInfo] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok: boolean, text: string }

  const refreshParticipants = useCallback(async () => {
    const r = await publicFetch(`/${publicUuid}/participants`);
    setParticipants(Array.isArray(r.participants) ? r.participants : []);
  }, [publicUuid]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await publicFetch(`/${publicUuid}`);
        if (!alive) return;
        setInfo(data);
        await refreshParticipants();
      } catch (e) {
        if (alive) setLoadErr(e.code === "GONE" ? "This trip page has expired." : "Trip page not found.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [publicUuid, refreshParticipants]);

  const verifyAadhaar = async (participantId) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await publicFetch(`/${publicUuid}/verify/aadhaar/start`, {
        method: "POST",
        body: { participantId },
      });
      if (r.mode === "stub") {
        // No real DigiLocker configured — complete inline so dev/demo works.
        await publicFetch(`/${publicUuid}/verify/aadhaar/callback`, {
          method: "POST",
          body: { state: r.state, code: "stub-code" },
        });
        await refreshParticipants();
        setMsg({ ok: true, text: "Verified ✓ (demo / stub mode)" });
      } else {
        // Real mode — stash the uuid so the callback page can complete the
        // return leg, then hand the browser off to DigiLocker for consent.
        sessionStorage.setItem(KYC_MICROSITE_UUID_KEY, publicUuid);
        window.location.href = r.oauthUrl;
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={S.wrap}>
        <Loader2 size={32} style={{ animation: "spin 1s linear infinite", color: "#122647" }} aria-hidden />
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>
    );
  }
  if (loadErr) {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <AlertCircle size={40} style={{ color: "#dc2626" }} aria-hidden />
          <h2 style={{ margin: "12px 0 4px" }}>{loadErr}</h2>
        </div>
      </div>
    );
  }

  const trip = info?.trip || {};

  return (
    <div style={S.page}>
      <div style={S.container}>
        <header style={S.header}>
          <Plane size={22} aria-hidden />
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>{trip.destination || "Trip"}</h1>
            <p style={{ margin: "2px 0 0", color: "#cbd5e1", fontSize: 13 }}>
              {fmtDate(trip.departDate)} – {fmtDate(trip.returnDate)}
            </p>
          </div>
        </header>

        {info?.itineraryHtml && (
          <section style={S.section}>
            {/* itineraryHtml is sanitised server-side (sanitizeBody strips
                dangerous tags) before it is ever stored. */}
            <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(info.itineraryHtml) }} />
          </section>
        )}

        <section style={S.section}>
          <h2 style={S.h2}><ShieldCheck size={18} aria-hidden /> Aadhaar verification</h2>

          {justVerified && (
            <div style={S.okBanner}>
              <CheckCircle2 size={16} aria-hidden /> Aadhaar verified successfully.
            </div>
          )}

          <p style={S.help}>
            Choose a traveller to verify their Aadhaar through DigiLocker. You will sign in to
            DigiLocker and approve sharing — we only ever store the last 4 digits, never the full
            number.
          </p>

          {participants.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: 14 }}>No travellers have been added to this trip yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {participants.map((p) => (
                <li key={p.id} style={S.participant}>
                  <span style={{ fontWeight: 600 }}>{p.fullName}</span>
                  {p.aadhaarLast4 ? (
                    <span style={S.verified}>
                      <CheckCircle2 size={14} aria-hidden /> Verified ••••{p.aadhaarLast4}
                    </span>
                  ) : (
                    <button onClick={() => verifyAadhaar(p.id)} disabled={busy} style={S.btn}>
                      {busy ? "Working…" : "Verify Aadhaar"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {msg && (
            <div style={{ ...S.msg, color: msg.ok ? "#16a34a" : "#dc2626" }}>
              {msg.ok ? <CheckCircle2 size={16} aria-hidden /> : <AlertCircle size={16} aria-hidden />}
              <span>{msg.text}</span>
            </div>
          )}
        </section>
      </div>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(); } catch { return "—"; }
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9" },
  card: { background: "#fff", borderRadius: 16, padding: "36px 32px", maxWidth: 420, textAlign: "center", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" },
  page: { minHeight: "100vh", background: "#f1f5f9", padding: "0 0 40px" },
  container: { maxWidth: 720, margin: "0 auto" },
  header: {
    display: "flex", gap: 12, alignItems: "center", color: "#fff",
    background: "#122647", padding: "24px 24px", borderRadius: "0 0 16px 16px",
  },
  section: { background: "#fff", borderRadius: 14, padding: 24, margin: "20px 16px", boxShadow: "0 4px 14px rgba(0,0,0,0.05)" },
  h2: { display: "flex", alignItems: "center", gap: 8, fontSize: 17, margin: "0 0 12px" },
  help: { color: "#475569", fontSize: 14, marginTop: 0 },
  participant: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 0", borderBottom: "1px solid #e2e8f0", gap: 12,
  },
  verified: { display: "inline-flex", alignItems: "center", gap: 6, color: "#16a34a", fontWeight: 600, fontSize: 14 },
  okBanner: {
    display: "flex", alignItems: "center", gap: 8, background: "#f0fdf4",
    color: "#16a34a", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 12,
  },
  btn: {
    padding: "10px 16px", border: "none", borderRadius: 8, background: "#C89A4E",
    color: "#122647", fontWeight: 600, cursor: "pointer", fontSize: 14,
  },
  msg: { display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 14 },
};
