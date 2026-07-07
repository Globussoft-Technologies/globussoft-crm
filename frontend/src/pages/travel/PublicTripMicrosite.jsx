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
//
// G095 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.i / AC-6.9) — the public
// GET response now carries a `brandKit` block (palette / logo / fonts /
// mission / support contacts) resolved from the microsite's sub-brand
// (TMC per Q21). When present, this page applies the palette as CSS vars
// at the root, renders the logo + tagline in the header band, and
// surfaces mission + supportEmail/Phone in the footer. Falls back to
// the navy/gold default chrome when brandKit is null (no active kit or
// fetch error).

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  CheckCircle2, AlertCircle, Loader2, Plane, Mail, Phone, UserCheck,
  CalendarDays, MapPin, IndianRupee, FileText, Users, Clock, Sparkles, ClipboardCheck,
  Upload, X,
} from "lucide-react";
import { DestinationHero, DestinationSideRails } from "../../components/DestinationVisuals";

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
  const queryParams = new URLSearchParams(window.location.search);
  // Phase 7 — hybrid registration confirmation. When the user is
  // redirected here from a landing-page registration submission, the
  // URL carries an opaque draftToken (no PII). We surface a
  // RegistrationConfirmPanel above the existing content that walks
  // the user through phone OTP verification and binds the verified
  // OTP to the draft. After verification, the draft sits in the CRM's
  // Participants queue waiting for operator approval.
  const draftToken = queryParams.get("draftToken");

  const [info, setInfo] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // Document-upload status for THIS registrant only, scoped by draftToken.
  // We deliberately do NOT fetch a participant list — this is a public page
  // and showing other families' names/verification would leak their data.
  // docStatus drives the "Upload documents" button + the modal's checkmarks.
  const [docStatus, setDocStatus] = useState(null);
  const [docModalOpen, setDocModalOpen] = useState(false);

  const refreshDocStatus = useCallback(async () => {
    if (!draftToken) return;
    try {
      const s = await publicFetch(`/${publicUuid}/draft-summary?token=${encodeURIComponent(draftToken)}`);
      setDocStatus(s);
    } catch {
      // A bad / expired token is surfaced by RegistrationConfirmPanel; the
      // upload button simply stays in its default (no-docs) state.
    }
  }, [publicUuid, draftToken]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await publicFetch(`/${publicUuid}`);
        if (!alive) return;
        setInfo(data);
      } catch (e) {
        if (alive) setLoadErr(e.code === "GONE" ? "This trip page has expired." : "Trip page not found.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [publicUuid]);

  useEffect(() => { refreshDocStatus(); }, [refreshDocStatus]);

  // G095 — palette + chrome derived from the brandKit when present.
  // Hooks must run on EVERY render in the same order (React rules), so
  // the memo lands BEFORE the conditional early-returns below.
  const brandKit = info?.brandKit || null;
  const palette = useMemo(() => buildPalette(brandKit), [brandKit]);

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
  const itineraryDays = parseItineraryDays(info?.itineraryHtml);
  const docs = Array.isArray(trip.documentRequirements) ? trip.documentRequirements : [];
  const instalments = parseInstalments(trip.paymentPlan?.instalmentsJson);
  const durationDays = tripDurationDays(trip);
  const studentCount = trip?._count?.participants || 0;
  const price = formatMoney(trip.pricePerStudent, "INR");

  return (
    <div style={{ ...S.page, background: palette.bg }}>
      <DestinationSideRails destination={trip.destination} />
      <div style={S.container}>
        <div style={S.brandStrip}>
          {brandKit?.logoUrl ? (
            <img
              src={brandKit.logoUrl}
              alt={brandKit.tagline ? `${brandKit.tagline} logo` : "Brand logo"}
              style={S.logo}
              data-testid="microsite-brand-logo"
            />
          ) : (
            <span style={{ ...S.logoFallback, background: palette.headerBg, color: palette.headerFg }}>
              <Plane size={18} aria-hidden />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 data-testid="microsite-destination-title" style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>{trip.destination || "Trip"}</h1>
            <p style={{ margin: "2px 0 0", color: "#64748b", fontSize: 13 }}>
              {fmtDate(trip.departDate)} – {fmtDate(trip.returnDate)}
            </p>
            {brandKit?.tagline && (
              <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 12, fontStyle: "italic" }}>
                {brandKit.tagline}
              </p>
            )}
          </div>
        </div>

        {/* Destination photo banner — a real destination photo (Wikipedia,
            keyless) under the brand header; falls back to a themed gradient. */}
        <DestinationHero destination={trip.destination || "Trip"}>
          <div style={S.heroMeta}>
            <span><CalendarDays size={15} aria-hidden /> {fmtDate(trip.departDate)} to {fmtDate(trip.returnDate)}</span>
            <span><Clock size={15} aria-hidden /> {durationDays} day{durationDays === 1 ? "" : "s"}</span>
            {trip.tripCode && <span><ClipboardCheck size={15} aria-hidden /> {trip.tripCode}</span>}
          </div>
        </DestinationHero>

        <section style={S.quickGrid} aria-label="Trip summary">
          <InfoTile icon={MapPin} label="Destination" value={trip.destination || "To be announced"} />
          <InfoTile icon={IndianRupee} label="Package price" value={price || "Shared by coordinator"} />
          <InfoTile icon={Users} label="Registered travellers" value={studentCount ? String(studentCount) : "Open"} />
          <InfoTile icon={FileText} label="Required documents" value={docs.length ? `${docs.length} item${docs.length === 1 ? "" : "s"}` : "Basic ID"} />
        </section>

        {/* Phase 7 — hybrid registration confirmation panel. Only
            rendered when the user landed here via the landing-page
            wizard (URL carries ?draftToken=...). The panel is
            self-contained — it manages its own OTP request/verify
            state and reports its terminal state via the headline. */}
        {draftToken && (
          <section style={S.section}>
            <RegistrationConfirmPanel
              publicUuid={publicUuid}
              draftToken={draftToken}
              accentBg={palette.headerBg}
            />
          </section>
        )}

        <section style={S.section}>
          <h2 style={S.h2}><Sparkles size={18} aria-hidden /> Package highlights</h2>
          <div style={S.packageGrid}>
            <PackageItem title="Included planning" text="Curated school-friendly schedule, destination coordination and pre-departure support." />
            <PackageItem title="Travel readiness" text="OTP confirmation, Aadhaar verification and document checks before admin approval." />
            <PackageItem title="Transparent package" text={price ? `${price} per student, with instalments shown below when configured.` : "Final package amount will be confirmed by the school coordinator."} />
          </div>
          {instalments.length > 0 && (
            <div style={S.instalmentBox}>
              <div style={S.miniTitle}>Payment schedule</div>
              <div style={S.instalmentGrid}>
                {instalments.map((it, idx) => (
                  <div key={`${it.dueDate || "due"}-${idx}`} style={S.instalment}>
                    <span>Instalment {idx + 1}</span>
                    <strong>{formatMoney(it.amount, "INR") || "Amount TBA"}</strong>
                    <small>{it.dueDate ? `Due ${fmtDate(it.dueDate)}` : "Due date TBA"}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section style={S.section} data-testid="microsite-itinerary">
          <h2 style={S.h2}><CalendarDays size={18} aria-hidden /> Itinerary</h2>
          {itineraryDays.length > 0 ? (
            <div style={S.timeline}>
              {itineraryDays.map((day, idx) => (
                <article key={`${day.title}-${idx}`} style={S.dayCard}>
                  <div style={S.dayBadge}>Day {day.dayNumber || idx + 1}</div>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={S.dayTitle}>{day.title || `Explore ${trip.destination || "the destination"}`}</h3>
                    {day.items.length > 0 ? (
                      <ul style={S.dayList}>
                        {day.items.map((item, itemIdx) => <li key={itemIdx}>{item}</li>)}
                      </ul>
                    ) : (
                      <p style={S.dayText}>Details will be shared shortly.</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : info?.itineraryHtml && info.itineraryHtml.trim() ? (
            <div style={S.htmlContent} dangerouslySetInnerHTML={{ __html: sanitizeHtml(info.itineraryHtml) }} />
          ) : (
            <p style={S.help}>The detailed day-by-day itinerary will appear here once the coordinator publishes it.</p>
          )}
        </section>

        <section style={S.section}>
          <div style={S.sectionHeadRow}>
            <h2 style={{ ...S.h2, margin: 0 }}><FileText size={18} aria-hidden /> Documents to keep ready</h2>
            {draftToken && (
              <button
                type="button"
                onClick={() => setDocModalOpen(true)}
                style={{ ...S.uploadBtn, background: palette.headerBg }}
                data-testid="microsite-upload-docs-btn"
              >
                <Upload size={15} aria-hidden />
                {docStatus?.hasPassportDoc && docStatus?.hasAadhaarDoc ? "Update documents" : "Upload documents"}
              </button>
            )}
          </div>
          <div style={S.docGrid}>
            {(docs.length ? docs : DEFAULT_DOCUMENTS).map((doc) => (
              <div key={doc.docType} style={S.docItem}>
                <CheckCircle2 size={15} aria-hidden />
                <span>{docLabel(doc.docType)}{doc.required === false ? " (optional)" : ""}</span>
              </div>
            ))}
          </div>
          {draftToken ? (
            <p style={{ ...S.help, marginTop: 12, marginBottom: 0 }}>
              {docStatus?.hasPassportDoc && docStatus?.hasAadhaarDoc
                ? "Your documents have been received. You can re-upload above if anything needs to change."
                : "Upload your Passport and Aadhaar and confirm parent consent using the button above."}
            </p>
          ) : (
            <p style={{ ...S.help, marginTop: 12, marginBottom: 0 }}>
              To upload your documents, please open this page from the registration link we sent you.
            </p>
          )}
        </section>

        {brandKit && (brandKit.missionStatement || brandKit.supportEmail || brandKit.supportPhone || brandKit.footerText) && (
          <footer style={S.brandFooter} data-testid="microsite-brand-footer">
            {brandKit.missionStatement && (
              <p style={{ margin: "0 0 12px", fontSize: 14, color: "#475569", lineHeight: 1.5 }}>
                {brandKit.missionStatement}
              </p>
            )}
            {(brandKit.supportEmail || brandKit.supportPhone) && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "#475569" }}>
                {brandKit.supportEmail && (
                  <a href={`mailto:${brandKit.supportEmail}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: palette.headerBg }}>
                    <Mail size={14} aria-hidden /> {brandKit.supportEmail}
                  </a>
                )}
                {brandKit.supportPhone && (
                  <a href={`tel:${brandKit.supportPhone}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: palette.headerBg }}>
                    <Phone size={14} aria-hidden /> {brandKit.supportPhone}
                  </a>
                )}
              </div>
            )}
            {brandKit.footerText && (
              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#94a3b8" }}>{brandKit.footerText}</p>
            )}
          </footer>
        )}
      </div>

      {docModalOpen && draftToken && (
        <DocumentUploadModal
          publicUuid={publicUuid}
          draftToken={draftToken}
          status={docStatus}
          accentBg={palette.headerBg}
          onClose={() => setDocModalOpen(false)}
          onUploaded={refreshDocStatus}
        />
      )}
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

// G095 — derive a palette from the public brandKit. Falls back to the
// pre-G095 navy/gold hard-coded chrome when brandKit is null or empty.
// Kept pure (no React) so it can be unit-tested independently.
function buildPalette(brandKit) {
  const DEFAULT_HEADER = "#122647"; // pre-G095 navy
  const DEFAULT_BG = "#f1f5f9";
  if (!brandKit) {
    return {
      headerBg: DEFAULT_HEADER,
      headerFg: "#ffffff",
      headerMutedFg: "#cbd5e1",
      bg: DEFAULT_BG,
    };
  }
  return {
    headerBg: brandKit.primaryColor || DEFAULT_HEADER,
    headerFg: brandKit.textColor || "#ffffff",
    headerMutedFg: "#cbd5e1",
    bg: brandKit.bgColor || DEFAULT_BG,
  };
}

function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(); } catch { return "—"; }
}

// ─── Phase 7 — RegistrationConfirmPanel ──────────────────────────────
//
// Lightweight 3-state OTP confirmation surfaced above the rest of the
// microsite when the URL carries ?draftToken=... The user (a parent
// who just submitted the multi-step wizard on the landing page)
// enters the phone number they used in the wizard, receives an OTP
// via the existing /request-otp endpoint, and the existing /verify-otp
// endpoint atomically marks the PendingTripRegistration as
// OTP_VERIFIED (Phase 4). After success, the panel shows a brief
// "awaiting review" message — operator decisioning happens in the
// CRM Participants tab (Phase 5).
//
// Errors map to the explicit codes returned by the backend per
// decision #9 — DRAFT_NOT_FOUND / DRAFT_WRONG_TRIP / DRAFT_EXPIRED /
// OTP_INVALID — so the visitor sees a deterministic next-action
// instead of a generic "something went wrong".
function tripDurationDays(trip) {
  if (!trip?.departDate || !trip?.returnDate) return 1;
  const start = new Date(trip.departDate);
  const end = new Date(trip.returnDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  return Math.max(1, Math.floor((end - start) / 86400000) + 1);
}

function formatMoney(value, currency = "INR") {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `₹${Math.round(n).toLocaleString("en-IN")}`;
  }
}

function parseInstalments(raw) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function parseItineraryDays(raw) {
  const clean = sanitizeHtml(raw);
  if (!clean || typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
  const root = doc.body;
  const headings = [...root.querySelectorAll("h1,h2,h3")];
  if (headings.length === 0) {
    const text = root.textContent?.trim();
    return text ? [{ dayNumber: 1, title: "Trip plan", items: [text] }] : [];
  }
  return headings.map((heading, idx) => {
    const rawTitle = heading.textContent?.trim() || `Day ${idx + 1}`;
    const dayMatch = rawTitle.match(/day\s*(\d+)/i);
    const title = rawTitle.replace(/^day\s*\d+\s*[-—:]\s*/i, "").trim() || rawTitle;
    const items = [];
    let node = heading.nextElementSibling;
    while (node && !/^H[1-3]$/i.test(node.tagName)) {
      if (node.matches("ul,ol")) {
        items.push(...[...node.querySelectorAll("li")].map((li) => li.textContent?.trim()).filter(Boolean));
      } else {
        const text = node.textContent?.trim();
        if (text) items.push(text);
      }
      node = node.nextElementSibling;
    }
    return { dayNumber: dayMatch ? Number(dayMatch[1]) : idx + 1, title, items: items.slice(0, 8) };
  }).filter((day) => day.title || day.items.length > 0);
}

const DEFAULT_DOCUMENTS = [
  { docType: "passport", required: true },
  { docType: "aadhaar", required: true },
  { docType: "consent-form", required: true },
];

function docLabel(docType) {
  const labels = {
    passport: "Passport",
    aadhaar: "Aadhaar",
    "medical-form": "Medical form",
    "consent-form": "Parent consent form",
    "school-id": "School ID",
  };
  return labels[docType] || String(docType || "Document").replace(/-/g, " ");
}

function InfoTile({ icon: Icon, label, value }) {
  return (
    <div style={S.infoTile}>
      <span style={S.infoIcon}><Icon size={18} aria-hidden /></span>
      <span style={S.infoLabel}>{label}</span>
      <strong style={S.infoValue}>{value}</strong>
    </div>
  );
}

function PackageItem({ title, text }) {
  return (
    <div style={S.packageItem}>
      <div style={S.packageDot} />
      <div>
        <div style={S.packageTitle}>{title}</div>
        <p style={S.packageText}>{text}</p>
      </div>
    </div>
  );
}

export function RegistrationConfirmPanel({ publicUuid, draftToken, accentBg }) {
  const [step, setStep] = useState("idle"); // idle | sending | otp_sent | verifying | verified | error
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  // Delivery channel — phone (WhatsApp/SMS) only.
  // Email OTP is disabled; channel is fixed to "phone".
  // const [channel, setChannel] = useState("phone"); // email OTP disabled
  const channel = "phone";
  // Code expiry — request-otp returns an ISO expiresAt (10-min TTL server
  // side). We surface a live countdown so the parent knows the window and
  // block verify once it lapses (a stale code always fails OTP_INVALID).
  const [expiresAt, setExpiresAt] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!expiresAt) return undefined;
    const tick = () => {
      const remaining = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = step === "otp_sent" && expiresAt != null && secondsLeft <= 0;
  const mmss = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;

  // Phase 7+ — on mount, fetch the non-PII draft summary so we can
  // greet the visitor by first name and show them the (masked)
  // contact details we'll OTP. If the token is bogus / expired / for
  // a different trip the panel surfaces a terminal error before any
  // OTP is requested.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await publicFetch(`/${publicUuid}/draft-summary?token=${encodeURIComponent(draftToken)}`);
        if (!alive) return;
        setSummary(data);
        // If the draft is already verified, jump straight to the
        // "submitted for review" terminal state on revisit.
        if (data.otpVerified) {
          setStep("verified");
        }
      } catch (err) {
        if (!alive) return;
        const copy = draftErrorCopy(err.code);
        const terminal = err.code === "DRAFT_NOT_FOUND"
          || err.code === "DRAFT_WRONG_TRIP"
          || err.code === "DRAFT_EXPIRED";
        setSummaryError({ code: err.code, text: copy || err.message, terminal });
        if (terminal) setStep("error");
      }
    })();
    return () => { alive = false; };
  }, [publicUuid, draftToken]);

  const draftErrorCopy = (codeStr) => {
    switch (codeStr) {
      case "DRAFT_NOT_FOUND":
        return "We could not find your registration. Please re-submit the form on the landing page.";
      case "DRAFT_WRONG_TRIP":
        return "This confirmation link is for a different trip. Please use the link from your registration email or the landing page.";
      case "DRAFT_EXPIRED":
        return "Your confirmation link has expired. Please re-submit the registration form on the landing page.";
      case "OTP_INVALID":
        return "That code doesn't match. Please request a fresh code and try again.";
      case "OTP_COOLDOWN":
        return "Please wait a minute before requesting another code.";
      default:
        return null;
    }
  };

  // Phase 7+ — request-otp now derives the phone from the draft when
  // a draftToken is supplied, so the visitor doesn't have to retype
  // what they already entered on the landing page.
  const requestOtp = async (e) => {
    e?.preventDefault?.();
    setError(null);
    setStep("sending");
    try {
      const resp = await publicFetch(`/${publicUuid}/request-otp`, {
        method: "POST",
        body: { purpose: "registration", draftToken, channel },
      });
      setExpiresAt(resp?.expiresAt || null);
      setCode("");
      setStep("otp_sent");
    } catch (err) {
      const copy = draftErrorCopy(err.code);
      const terminal = err.code === "DRAFT_NOT_FOUND"
        || err.code === "DRAFT_WRONG_TRIP"
        || err.code === "DRAFT_EXPIRED";
      setError({ code: err.code, text: copy || err.message, terminal });
      setStep(terminal ? "error" : "idle");
    }
  };

  const verifyOtp = async (e) => {
    e?.preventDefault?.();
    if (!code.trim()) {
      setError({ text: "Please enter the code we sent you." });
      return;
    }
    if (expired) {
      setError({ text: "This code has expired. Please request a fresh one." });
      return;
    }
    setError(null);
    setStep("verifying");
    try {
      const resp = await publicFetch(`/${publicUuid}/verify-otp`, {
        method: "POST",
        body: {
          purpose: "registration",
          code: code.trim(),
          draftToken,
          channel,
        },
      });
      if (resp.verified) {
        setStep("verified");
      } else {
        setError({ text: "Verification could not be completed. Please try again." });
        setStep("error");
      }
    } catch (err) {
      const copy = draftErrorCopy(err.code);
      const terminal = err.code === "DRAFT_NOT_FOUND"
        || err.code === "DRAFT_WRONG_TRIP"
        || err.code === "DRAFT_EXPIRED";
      setError({ code: err.code, text: copy || err.message, terminal });
      setStep(terminal ? "error" : "otp_sent");
    }
  };

  const buttonBg = accentBg || "#122647";
  const buttonStyle = {
    padding: "10px 16px", border: "none", borderRadius: 8,
    background: buttonBg, color: "#fff", fontWeight: 600,
    cursor: "pointer", fontSize: 14,
  };
  const inputStyle = {
    width: "100%", padding: "10px 12px", border: "1px solid #cbd5e1",
    borderRadius: 8, fontSize: 14, boxSizing: "border-box",
  };

  const greeting = summary?.parentFirstName ? `Hi ${summary.parentFirstName},` : "Hello,";
  const terminalErr = (step === "error" && error?.terminal) || summaryError?.terminal;
  const terminalCopy = error?.text || summaryError?.text;

  // Phone-only OTP — email channel disabled.
  // const hasEmail = !!summary?.parentEmailMasked; // email OTP disabled
  const destinationMasked = summary?.parentPhoneMasked;
  const channelNoun = "phone number";
  // const segBtn = ... // channel picker unused — email OTP disabled

  return (
    <div data-testid="registration-confirm-panel">
      <h2 style={S.h2}><UserCheck size={18} aria-hidden /> Confirm your registration</h2>

      {step === "verified" ? (
        <div data-testid="registration-confirmed">
          <div style={{ ...S.okBanner, padding: "14px 16px", fontSize: 14, marginBottom: 12 }}>
            <CheckCircle2 size={18} aria-hidden />
            <span>
              Contact verified — your registration is being reviewed. We&apos;ll be in touch shortly.
            </span>
          </div>
          {summary && (
            <div style={S.summaryCard}>
              <div style={S.summaryTitle}>What we received</div>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Student</span>
                <span>{summary.studentFirstName}</span>
              </div>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Parent</span>
                <span>{summary.parentFirstName}</span>
              </div>
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Phone</span>
                <span>{summary.parentPhoneMasked}</span>
              </div>
              {summary.parentEmailMasked && (
                <div style={S.summaryRow}>
                  <span style={S.summaryLabel}>Email</span>
                  <span>{summary.parentEmailMasked}</span>
                </div>
              )}
              <div style={S.summaryRow}>
                <span style={S.summaryLabel}>Passport</span>
                <span>{summary.hasPassport ? "Provided" : "Not provided"}</span>
              </div>
            </div>
          )}
        </div>
      ) : terminalErr ? (
        <div style={{ ...S.msg, color: "#dc2626", padding: "10px 0" }} data-testid="registration-error">
          <AlertCircle size={16} aria-hidden /> <span>{terminalCopy}</span>
        </div>
      ) : !summary ? (
        <div style={{ color: "#475569", fontSize: 14 }}>Loading your registration…</div>
      ) : (
        <>
          <p style={S.help}>
            {greeting} we&apos;ve received your registration for this trip. To finish, verify the
            {" "}{channelNoun} you provided — we&apos;ll send a one-time code.
          </p>

          {/* Channel picker disabled — email OTP hidden, phone only.
          {hasEmail && (step === "idle" || step === "sending" || (step === "error" && !error?.terminal)) && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "#475569", marginBottom: 6 }}>
                How would you like to receive your code?
              </div>
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden" }} role="group" aria-label="Verification channel">
                <button
                  type="button"
                  onClick={() => setChannel("phone")}
                  disabled={step === "sending"}
                  style={{ ...segBtn(channel === "phone"), borderRadius: "8px 0 0 8px" }}
                  aria-pressed={channel === "phone"}
                  data-testid="registration-channel-phone"
                >
                  <Phone size={14} aria-hidden /> Text / WhatsApp
                </button>
                <button
                  type="button"
                  onClick={() => setChannel("email")}
                  disabled={step === "sending"}
                  style={{ ...segBtn(channel === "email"), borderRadius: "0 8px 8px 0", borderLeft: "none" }}
                  aria-pressed={channel === "email"}
                  data-testid="registration-channel-email"
                >
                  <Mail size={14} aria-hidden /> Email
                </button>
              </div>
            </div>
          )} */}

          <div style={S.summaryCard}>
            <div style={S.summaryRow}>
              <span style={S.summaryLabel}>Student</span>
              <span>{summary.studentFirstName}</span>
            </div>
            <div style={S.summaryRow}>
              <span style={S.summaryLabel}>Parent</span>
              <span>{summary.parentFirstName}</span>
            </div>
            <div style={S.summaryRow}>
              <span style={S.summaryLabel}>We&apos;ll send a code to</span>
              <span style={{ fontWeight: 600 }} data-testid="registration-destination-masked">{destinationMasked}</span>
            </div>
          </div>

          {(step === "idle" || step === "sending" || (step === "error" && !error?.terminal)) && (
            <button
              type="button"
              onClick={requestOtp}
              disabled={step === "sending"}
              style={{ ...buttonStyle, marginTop: 14 }}
              data-testid="registration-request-otp-btn"
            >
              {step === "sending" ? "Sending code…" : "Send verification code"}
            </button>
          )}

          {(step === "otp_sent" || step === "verifying") && (
            <form onSubmit={verifyOtp} data-testid="registration-otp-verify-form" style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, color: "#475569", margin: "10px 0" }}>
                We sent a 4-digit code to <strong>{destinationMasked}</strong>. Enter it below.
              </p>
              {expiresAt && (
                <p
                  style={{ fontSize: 13, margin: "0 0 10px", color: expired ? "#dc2626" : "#475569", display: "flex", alignItems: "center", gap: 6 }}
                  data-testid="registration-otp-expiry"
                >
                  <Clock size={14} aria-hidden />
                  {expired
                    ? "Your code has expired — tap Resend code for a new one."
                    : <span>Code expires in <strong>{mmss}</strong></span>}
                </p>
              )}
              <label htmlFor="reg-code" style={{ display: "block", fontSize: 13, color: "#475569", marginBottom: 6 }}>
                Verification code
              </label>
              <input
                id="reg-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
                style={inputStyle}
                autoComplete="one-time-code"
                data-testid="registration-code-input"
                autoFocus
              />
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <button
                  type="submit"
                  disabled={step === "verifying" || expired}
                  style={{ ...buttonStyle, ...(expired ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}
                  data-testid="registration-verify-otp-btn"
                >
                  {step === "verifying" ? "Verifying…" : "Verify and confirm"}
                </button>
                <button
                  type="button"
                  onClick={requestOtp}
                  disabled={step === "verifying"}
                  style={{ ...buttonStyle, background: "transparent", color: buttonBg, border: `1px solid ${buttonBg}` }}
                  data-testid="registration-resend-otp-btn"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}

          {error && !error?.terminal && (
            <div style={{ ...S.msg, color: "#dc2626" }} data-testid="registration-otp-error">
              <AlertCircle size={16} aria-hidden /> <span>{error.text}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── DocumentUploadModal ─────────────────────────────────────────────
//
// Parent-facing document capture, opened from the "Documents to keep
// ready" section. Because this is a PUBLIC page, the modal is scoped
// entirely to THIS registrant via the draftToken — it never lists or
// touches other travellers. Requires Passport + Aadhaar (a doc already
// stored on the draft counts, so a re-upload of just one is allowed) and
// a mandatory parent-consent checkbox. Posts multipart/form-data to the
// public /documents endpoint.
function DocumentUploadModal({ publicUuid, draftToken, status, accentBg, onClose, onUploaded }) {
  const [passport, setPassport] = useState(null);
  const [aadhaar, setAadhaar] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const hasPassportDoc = !!status?.hasPassportDoc;
  const hasAadhaarDoc = !!status?.hasAadhaarDoc;

  const ACCEPT = "image/jpeg,image/png,application/pdf";
  const MAX_BYTES = 8 * 1024 * 1024;

  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickFile = (setter) => (e) => {
    setError(null);
    const f = e.target.files?.[0] || null;
    if (f && f.size > MAX_BYTES) {
      setError("File too large — the maximum size is 8MB.");
      e.target.value = "";
      setter(null);
      return;
    }
    setter(f);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!consent) {
      setError("Please confirm parent consent to continue.");
      return;
    }
    // Both docs must exist after this submit — a freshly-chosen file OR one
    // already stored on the draft satisfies each requirement.
    if ((!passport && !hasPassportDoc) || (!aadhaar && !hasAadhaarDoc)) {
      setError("Both Passport and Aadhaar documents are required.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("draftToken", draftToken);
      fd.append("consent", "true");
      if (passport) fd.append("passport", passport);
      if (aadhaar) fd.append("aadhaar", aadhaar);
      const res = await fetch(`/api/travel/microsites/public/${publicUuid}/documents`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
      setDone(true);
      onUploaded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const accent = accentBg || "#122647";

  return (
    <div
      style={S.overlay}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Upload your documents"
      data-testid="microsite-doc-modal"
    >
      <div style={S.modal}>
        <div style={S.modalHead}>
          <h2 style={{ ...S.h2, margin: 0 }}><Upload size={18} aria-hidden /> Upload your documents</h2>
          <button type="button" onClick={onClose} style={S.closeBtn} aria-label="Close" data-testid="microsite-doc-modal-close">
            <X size={18} aria-hidden />
          </button>
        </div>

        {done ? (
          <div data-testid="microsite-doc-modal-done">
            <div style={{ ...S.okBanner, padding: "14px 16px", fontSize: 14 }}>
              <CheckCircle2 size={18} aria-hidden />
              <span>Your documents were uploaded. Thank you — we&apos;ll review them shortly.</span>
            </div>
            <button type="button" onClick={onClose} style={{ ...S.primaryBtn, background: accent, marginTop: 16 }}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p style={{ ...S.help, marginTop: 0 }}>
              Please upload a clear scan or photo of each document (JPEG, PNG or PDF, up to 8MB).
              These are shared securely with the trip coordinator only.
            </p>

            <FileField
              label="Passport"
              testid="microsite-doc-passport"
              file={passport}
              alreadyUploaded={hasPassportDoc}
              accept={ACCEPT}
              onChange={pickFile(setPassport)}
            />
            <FileField
              label="Aadhaar"
              testid="microsite-doc-aadhaar"
              file={aadhaar}
              alreadyUploaded={hasAadhaarDoc}
              accept={ACCEPT}
              onChange={pickFile(setAadhaar)}
            />

            <label style={S.consentRow} data-testid="microsite-doc-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => { setConsent(e.target.checked); setError(null); }}
                style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0 }}
              />
              <span style={{ fontSize: 13, color: "#334155", lineHeight: 1.5 }}>
                I am the parent / legal guardian and I consent to sharing these documents
                with the school and trip coordinator for this trip.
              </span>
            </label>

            {error && (
              <div style={{ ...S.msg, color: "#dc2626" }} data-testid="microsite-doc-error">
                <AlertCircle size={16} aria-hidden /> <span>{error}</span>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
              <button type="submit" disabled={busy} style={{ ...S.primaryBtn, background: accent }} data-testid="microsite-doc-submit">
                {busy ? "Uploading…" : "Upload documents"}
              </button>
              <button type="button" onClick={onClose} disabled={busy} style={S.secondaryBtn}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function FileField({ label, testid, file, alreadyUploaded, accept, onChange }) {
  return (
    <div style={S.fileField}>
      <div style={S.fileFieldHead}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>{label}</span>
        {(file || alreadyUploaded) && (
          <span style={S.fileOk}>
            <CheckCircle2 size={14} aria-hidden /> {file ? "Selected" : "Already uploaded"}
          </span>
        )}
      </div>
      <input
        type="file"
        accept={accept}
        onChange={onChange}
        data-testid={testid}
        style={{ fontSize: 13, width: "100%" }}
      />
      {file && <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{file.name}</div>}
      {!file && alreadyUploaded && (
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>Choose a file to replace the one on record.</div>
      )}
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9" },
  card: { background: "#fff", borderRadius: 16, padding: "36px 32px", maxWidth: 420, textAlign: "center", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" },
  page: { minHeight: "100vh", background: "#f1f5f9", padding: "0 0 40px" },
  container: { maxWidth: 920, margin: "0 auto", position: "relative", zIndex: 1, padding: "0 16px 40px" },
  brandStrip: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "16px 0 14px",
    color: "#0f172a",
  },
  logo: { width: 42, height: 42, objectFit: "contain", background: "#fff", borderRadius: 8, padding: 4, boxShadow: "0 6px 18px rgba(15,23,42,0.08)" },
  logoFallback: { width: 42, height: 42, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 10 },
  brandName: { fontSize: 14, fontWeight: 800, color: "#0f172a" },
  brandMeta: { fontSize: 12, color: "#64748b", marginTop: 2 },
  heroMeta: { display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" },
  quickGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))",
    gap: 12,
    margin: "16px 0 20px",
  },
  infoTile: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: 14,
    boxShadow: "0 8px 24px rgba(15,23,42,0.05)",
    display: "grid",
    gap: 6,
  },
  infoIcon: { color: "#C89A4E", display: "inline-flex" },
  infoLabel: { fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 800 },
  infoValue: { fontSize: 17, color: "#0f172a", lineHeight: 1.2 },
  header: {
    display: "flex", gap: 12, alignItems: "center", color: "#fff",
    background: "#122647", padding: "24px 24px", borderRadius: "0 0 16px 16px",
  },
  section: { background: "#fff", borderRadius: 14, padding: 24, margin: "20px 16px", boxShadow: "0 4px 14px rgba(0,0,0,0.05)" },
  h2: { display: "flex", alignItems: "center", gap: 8, fontSize: 17, margin: "0 0 12px" },
  help: { color: "#475569", fontSize: 14, marginTop: 0 },
  registrationSection: { border: "1px solid rgba(200,154,78,0.4)", boxShadow: "0 12px 32px rgba(200,154,78,0.12)" },
  packageGrid: { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" },
  packageItem: { display: "flex", gap: 10, padding: 12, border: "1px solid #e2e8f0", borderRadius: 10, background: "#f8fafc" },
  packageDot: { width: 9, height: 9, borderRadius: 99, background: "#C89A4E", marginTop: 5, flexShrink: 0 },
  packageTitle: { fontSize: 13, fontWeight: 800, color: "#0f172a" },
  packageText: { margin: "4px 0 0", fontSize: 12, lineHeight: 1.5, color: "#475569" },
  miniTitle: { fontSize: 12, fontWeight: 800, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
  instalmentBox: { marginTop: 16, paddingTop: 16, borderTop: "1px solid #e2e8f0" },
  instalmentGrid: { display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" },
  instalment: { display: "grid", gap: 3, padding: 12, background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, color: "#7c2d12", fontSize: 12 },
  timeline: { display: "grid", gap: 12 },
  dayCard: { display: "grid", gridTemplateColumns: "86px 1fr", gap: 14, padding: 14, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12 },
  dayBadge: { alignSelf: "start", textAlign: "center", padding: "8px 10px", borderRadius: 9, background: "#122647", color: "#fff", fontSize: 12, fontWeight: 800 },
  dayTitle: { margin: "0 0 8px", color: "#0f172a", fontSize: 16, lineHeight: 1.3 },
  dayList: { margin: 0, paddingLeft: 18, color: "#334155", fontSize: 13, lineHeight: 1.6 },
  dayText: { margin: 0, color: "#475569", fontSize: 13 },
  htmlContent: { color: "#1e293b", lineHeight: 1.6, fontSize: 14 },
  docGrid: { display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))" },
  docItem: { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, background: "#f0fdf4", color: "#166534", fontSize: 13, fontWeight: 700 },
  sectionHeadRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 12, flexWrap: "wrap", marginBottom: 12,
  },
  uploadBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "9px 14px", border: "none", borderRadius: 8, background: "#122647",
    color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 13,
  },
  okBanner: {
    display: "flex", alignItems: "center", gap: 8, background: "#f0fdf4",
    color: "#16a34a", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 12,
  },
  msg: { display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 14 },
  // Document upload modal
  overlay: {
    position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 16, zIndex: 1000,
  },
  modal: {
    background: "#fff", borderRadius: 16, padding: "22px 24px 24px",
    width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
  },
  modalHead: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 12, marginBottom: 4,
  },
  closeBtn: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 32, height: 32, border: "none", borderRadius: 8, background: "#f1f5f9",
    color: "#475569", cursor: "pointer",
  },
  fileField: {
    border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, marginTop: 12,
    background: "#f8fafc",
  },
  fileFieldHead: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 8, marginBottom: 8,
  },
  fileOk: { display: "inline-flex", alignItems: "center", gap: 5, color: "#16a34a", fontWeight: 600, fontSize: 12 },
  consentRow: {
    display: "flex", alignItems: "flex-start", gap: 10, marginTop: 16,
    padding: 12, border: "1px solid #e2e8f0", borderRadius: 10, cursor: "pointer",
  },
  primaryBtn: {
    padding: "10px 18px", border: "none", borderRadius: 8, background: "#122647",
    color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 14,
  },
  secondaryBtn: {
    padding: "10px 18px", border: "1px solid #cbd5e1", borderRadius: 8,
    background: "#fff", color: "#475569", fontWeight: 600, cursor: "pointer", fontSize: 14,
  },
  brandFooter: {
    background: "#fff",
    borderRadius: 14,
    padding: 24,
    margin: "20px 16px",
    boxShadow: "0 4px 14px rgba(0,0,0,0.05)",
  },
  summaryCard: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: "14px 16px",
    marginTop: 12,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  summaryTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#475569",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 13,
    color: "#1e293b",
    gap: 12,
  },
  summaryLabel: {
    color: "#64748b",
  },
};
