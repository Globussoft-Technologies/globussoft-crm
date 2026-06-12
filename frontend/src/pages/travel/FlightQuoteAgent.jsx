// Travel CRM — Flight quick-quote (agent fallback for the Chrome flight plugin).
//
// Lands at /travel/flights/quote (PRD §7 page plan: FlightQuoteAgent.jsx).
// Until the (separate-repo) Chrome flight plugin ships, an advisor manually
// enters up to 4 flight options here — airline / route / times / fare /
// baggage — picks the contact, and submits. The backend applies the tenant's
// markup rules server-side (FR-6: pricing math has ONE source of truth) and
// persists the options as flight ItineraryItems on a draft Itinerary, which
// gives us the branded PDF + WhatsApp share for free.
//
// Backend:
//   POST /api/v1/flight-plugin/agent-quotes   (JWT; routes/travel_flight_quotes.js)
//     body { contactId, subBrand, currency?, markupRuleId?, options: [up to 4] }
//     201  { itineraryId, items: [{itineraryItemId,totalWithMarkup,currency}],
//            totalWithMarkup, currency, pdfUrl }
//   GET  /api/travel/markup-rules?subBrand&scope=flight&active=true
//     → markup preview (client-side mirror of lib/travelPricing.pickMarkup;
//       display-only — the server recomputes on submit)
//   GET  /api/contacts?limit=200               → contact picker feed (same
//       pattern as Itineraries.jsx / visa/Applications.jsx — no server-side
//       search param today; filter client-side by name/phone)
//   POST /api/travel/itineraries/:id/share     → WhatsApp share (watiClient
//       best-effort) + copyable share URL — same flow ItineraryDetail uses.
//
// NOTE: the contact must have a completed diagnostic for the chosen sub-brand
// (PRD §4.1 — same guard as Itinerary creation). The 403 DIAGNOSTIC_REQUIRED
// error surfaces via the standard notify.error path.

import { useContext, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeft, Copy, Download, MessageCircle, Percent, Plane, Plus,
  RotateCcw, Send, Trash2,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import { useActiveSubBrand } from "../../utils/subBrand";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";

// PRD §7 — "up to 4 flight options". Mirrors MAX_AGENT_OPTIONS server-side.
const MAX_OPTIONS = 4;

const FARE_CLASSES = ["Economy", "Premium Economy", "Business", "First"];

function blankOption() {
  return {
    airline: "", flightNumber: "", from: "", to: "",
    departAt: "", arriveAt: "", fare: "", fareClass: "Economy", baggage: "",
  };
}

// Client-side mirror of backend lib/travelPricing.pickMarkup — PREVIEW ONLY
// (the server recomputes on submit; this just shows the advisor what to
// expect). Same eligibility filters + priority sort + pct/flat math.
export function previewMarkup(rules, fare, { forcedRuleId = null, userId = null } = {}) {
  const eligible = (rules || [])
    .filter((r) => r.isActive !== false)
    .filter((r) =>
      forcedRuleId
        ? r.id === forcedRuleId
        : r.ownerUserId == null || r.ownerUserId === userId,
    );
  if (eligible.length === 0) return { rule: null, markupAmount: 0 };
  eligible.sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));
  const rule = eligible[0];
  let amount = 0;
  if (rule.markupPct != null) amount = fare * (Number(rule.markupPct) / 100);
  else if (rule.markupFlat != null) amount = Number(rule.markupFlat);
  return { rule, markupAmount: Math.round(amount * 100) / 100 };
}

export default function FlightQuoteAgent() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  // ── form state ──────────────────────────────────────────────────
  const [contacts, setContacts] = useState([]);
  const [contactQuery, setContactQuery] = useState("");
  const [contactId, setContactId] = useState("");
  const [subBrand, setSubBrand] = useState(defaultSubBrandFor(user, activeSubBrand, "tmc"));
  const [currency, setCurrency] = useState("INR");
  const [rules, setRules] = useState([]);
  const [markupRuleId, setMarkupRuleId] = useState(""); // "" = auto priority pick
  const [options, setOptions] = useState([blankOption()]);
  const [submitting, setSubmitting] = useState(false);

  // ── result state ────────────────────────────────────────────────
  const [result, setResult] = useState(null); // { itineraryId, items, totalWithMarkup, currency, pdfUrl }
  const [share, setShare] = useState(null); // { shareUrl, whatsapp }
  const [sharing, setSharing] = useState(false);

  // Contact feed — same /api/contacts?limit=200 fetch the other travel
  // pickers use (no server-side ?search today; filtered client-side below).
  useEffect(() => {
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : res?.contacts || []))
      .catch(() => setContacts([]));
  }, []);

  // Applicable markup rules for the markup preview — re-fetched per sub-brand.
  useEffect(() => {
    if (!subBrand) return;
    const qs = new URLSearchParams({ subBrand, scope: "flight", active: "true" });
    fetchApi(`/api/travel/markup-rules?${qs.toString()}`)
      .then((res) => setRules(Array.isArray(res?.rules) ? res.rules : []))
      .catch(() => setRules([]));
    setMarkupRuleId("");
  }, [subBrand]);

  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.phone || "").toLowerCase().includes(q),
    );
  }, [contacts, contactQuery]);

  const setOpt = (i, patch) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const addOption = () =>
    setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, blankOption()]));
  const removeOption = (i) =>
    setOptions((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const forcedRuleId = markupRuleId ? parseInt(markupRuleId, 10) : null;
  const preview = options.map((o) => {
    const fare = Number(o.fare);
    if (!Number.isFinite(fare) || fare < 0 || o.fare === "") return null;
    const { rule, markupAmount } = previewMarkup(rules, fare, {
      forcedRuleId,
      userId: user?.userId ?? null,
    });
    return { fare, rule, markupAmount, total: Math.round((fare + markupAmount) * 100) / 100 };
  });

  const submit = async () => {
    const cid = parseInt(contactId, 10);
    if (!Number.isFinite(cid)) {
      notify.error("Contact is required");
      return;
    }
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      if (!o.airline.trim()) { notify.error(`Option ${i + 1}: airline is required`); return; }
      if (!o.from.trim() || !o.to.trim()) { notify.error(`Option ${i + 1}: origin and destination are required`); return; }
      const fare = Number(o.fare);
      if (o.fare === "" || !Number.isFinite(fare) || fare < 0) {
        notify.error(`Option ${i + 1}: fare must be a non-negative number`);
        return;
      }
    }
    const body = {
      contactId: cid,
      subBrand,
      currency: currency.trim().toUpperCase() || "INR",
      options: options.map((o) => ({
        airline: o.airline.trim().toUpperCase(),
        flightNumber: o.flightNumber.trim() || undefined,
        fareClass: o.fareClass || undefined,
        pricePerPax: Number(o.fare),
        route: { from: o.from.trim().toUpperCase(), to: o.to.trim().toUpperCase() },
        departAt: o.departAt || undefined,
        arriveAt: o.arriveAt || undefined,
        baggage: o.baggage.trim() || undefined,
      })),
    };
    if (forcedRuleId) body.markupRuleId = forcedRuleId;
    setSubmitting(true);
    try {
      const res = await fetchApi("/api/v1/flight-plugin/agent-quotes", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setResult(res);
      setShare(null);
      notify.success("Flight quote created");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to create flight quote");
    } finally {
      setSubmitting(false);
    }
  };

  // WhatsApp share — same /itineraries/:id/share flow ItineraryDetail's
  // action cluster drives (watiClient best-effort; falls back to the
  // advisor pasting the link manually, hence the copy button).
  const shareWhatsApp = async () => {
    if (!result?.itineraryId) return;
    setSharing(true);
    try {
      const res = await fetchApi(`/api/travel/itineraries/${result.itineraryId}/share`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setShare(res);
      notify.success(
        res?.whatsapp === "SKIPPED"
          ? "Share link minted — send it manually (contact has no phone or WhatsApp is not configured)"
          : "Share link sent to the customer on WhatsApp",
      );
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to mint share link");
    } finally {
      setSharing(false);
    }
  };

  const copyShareLink = async () => {
    if (!share?.shareUrl) return;
    try {
      await navigator.clipboard.writeText(share.shareUrl);
      notify.success("Share link copied");
    } catch {
      notify.error("Could not copy — select the link text manually");
    }
  };

  const reset = () => {
    setResult(null);
    setShare(null);
    setOptions([blankOption()]);
    setContactId("");
    setContactQuery("");
    setMarkupRuleId("");
  };

  const token = getAuthToken();
  const pdfHref = result?.pdfUrl
    ? `${result.pdfUrl}${token ? `?_t=${encodeURIComponent(token)}` : ""}`
    : null;

  const selectedContact = contacts.find((c) => String(c.id) === String(contactId));
  const fmtAmount = (n) => `${Number(n).toLocaleString()}`;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <Plane size={28} aria-hidden /> Flight quick-quote
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0 }}>
            Manual fallback for the Chrome flight plugin — enter up to {MAX_OPTIONS} options,
            markup rules apply server-side, then share the branded quote (PDF / WhatsApp).
          </p>
        </div>
        <Link to="/travel/pricing-rules" style={backLink}>
          <ChevronLeft size={16} aria-hidden /> Pricing rules
        </Link>
      </header>

      {result ? (
        // ── Result panel ────────────────────────────────────────────
        <section style={card}>
          <h2 style={sectionTitle}>Quote created</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 4 }}>
            Saved as draft itinerary #{result.itineraryId}
            {selectedContact ? ` for ${selectedContact.name}` : ""}.
          </p>
          <ul style={{ paddingLeft: 18, fontSize: 14 }}>
            {(result.items || []).map((it, i) => (
              <li key={it.itineraryItemId}>
                Option {i + 1}: {result.currency} {fmtAmount(it.totalWithMarkup)} (with markup)
              </li>
            ))}
          </ul>
          <p style={{ fontWeight: 600, fontSize: 15 }}>
            Total with markup: {result.currency} {fmtAmount(result.totalWithMarkup)}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {pdfHref && (
              <a href={pdfHref} target="_blank" rel="noreferrer" style={{ ...primaryBtn, textDecoration: "none" }}>
                <Download size={14} /> Download PDF
              </a>
            )}
            <button type="button" onClick={shareWhatsApp} disabled={sharing} style={secondaryBtn}>
              <MessageCircle size={14} /> {sharing ? "Sharing…" : "Share on WhatsApp"}
            </button>
            <button type="button" onClick={reset} style={secondaryBtn}>
              <RotateCcw size={14} /> New quote
            </button>
          </div>
          {share?.shareUrl && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ fontSize: 12, wordBreak: "break-all" }}>{share.shareUrl}</code>
              <button type="button" onClick={copyShareLink} style={secondaryBtn} aria-label="Copy share link">
                <Copy size={14} /> Copy link
              </button>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                WhatsApp: {share.whatsapp || "—"}
              </span>
            </div>
          )}
        </section>
      ) : (
        <>
          {/* ── Quote header: contact + brand + currency ───────────── */}
          <section style={card}>
            <h2 style={sectionTitle}>Customer</h2>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", marginTop: 8 }}>
              <input
                placeholder="Search contacts by name or phone"
                value={contactQuery}
                onChange={(e) => setContactQuery(e.target.value)}
                style={input}
                aria-label="Search contacts by name or phone"
              />
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                style={input}
                aria-label="Contact"
              >
                <option value="">Select contact…</option>
                {filteredContacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || `Contact #${c.id}`}{c.phone ? ` — ${c.phone}` : ""}
                  </option>
                ))}
              </select>
              {lockedBrand ? (
                <input
                  type="text"
                  value={subBrandShortLabel(subBrand)}
                  readOnly
                  disabled
                  aria-label="Sub-brand (locked to your assigned brand)"
                  style={{ ...input, opacity: 0.7, cursor: "not-allowed" }}
                />
              ) : (
                <select
                  value={subBrand}
                  onChange={(e) => setSubBrand(e.target.value)}
                  style={input}
                  aria-label="Sub-brand"
                >
                  {myBrands.map((b) => (
                    <option key={b} value={b}>{subBrandShortLabel(b)}</option>
                  ))}
                </select>
              )}
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                placeholder="Currency (e.g. INR)"
                style={input}
                aria-label="Currency"
              />
            </div>
          </section>

          <div style={{ height: 16 }} />

          {/* ── Flight options (max 4) ─────────────────────────────── */}
          <section style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <h2 style={sectionTitle}>
                Flight options
                <span style={countBadge}>{options.length}/{MAX_OPTIONS}</span>
              </h2>
              <button
                type="button"
                onClick={addOption}
                disabled={options.length >= MAX_OPTIONS}
                style={{ ...secondaryBtn, opacity: options.length >= MAX_OPTIONS ? 0.5 : 1 }}
              >
                <Plus size={14} /> Add option
              </button>
            </div>
            {options.map((o, i) => (
              <div key={i} style={optionBox}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>Option {i + 1}</strong>
                  <button
                    type="button"
                    onClick={() => removeOption(i)}
                    disabled={options.length <= 1}
                    style={{ ...iconBtn, opacity: options.length <= 1 ? 0.4 : 1 }}
                    aria-label={`Remove option ${i + 1}`}
                  >
                    <Trash2 size={16} style={{ color: "var(--danger-color)" }} />
                  </button>
                </div>
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 140px), 1fr))" }}>
                  <input
                    placeholder="Airline (e.g. AI)"
                    value={o.airline}
                    onChange={(e) => setOpt(i, { airline: e.target.value })}
                    style={input}
                    aria-label={`Airline code (option ${i + 1})`}
                  />
                  <input
                    placeholder="Flight no. (e.g. AI-302)"
                    value={o.flightNumber}
                    onChange={(e) => setOpt(i, { flightNumber: e.target.value })}
                    style={input}
                    aria-label={`Flight number (option ${i + 1})`}
                  />
                  <input
                    placeholder="From (IATA, e.g. DEL)"
                    value={o.from}
                    maxLength={4}
                    onChange={(e) => setOpt(i, { from: e.target.value })}
                    style={input}
                    aria-label={`Origin IATA (option ${i + 1})`}
                  />
                  <input
                    placeholder="To (IATA, e.g. JED)"
                    value={o.to}
                    maxLength={4}
                    onChange={(e) => setOpt(i, { to: e.target.value })}
                    style={input}
                    aria-label={`Destination IATA (option ${i + 1})`}
                  />
                  <input
                    type="datetime-local"
                    value={o.departAt}
                    onChange={(e) => setOpt(i, { departAt: e.target.value })}
                    style={input}
                    aria-label={`Departure time (option ${i + 1})`}
                  />
                  <input
                    type="datetime-local"
                    value={o.arriveAt}
                    onChange={(e) => setOpt(i, { arriveAt: e.target.value })}
                    style={input}
                    aria-label={`Arrival time (option ${i + 1})`}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Fare per pax"
                    value={o.fare}
                    onChange={(e) => setOpt(i, { fare: e.target.value })}
                    style={input}
                    aria-label={`Fare per pax (option ${i + 1})`}
                  />
                  <select
                    value={o.fareClass}
                    onChange={(e) => setOpt(i, { fareClass: e.target.value })}
                    style={input}
                    aria-label={`Fare class (option ${i + 1})`}
                  >
                    {FARE_CLASSES.map((fc) => <option key={fc} value={fc}>{fc}</option>)}
                  </select>
                  <input
                    placeholder="Baggage (e.g. 15kg + 7kg cabin)"
                    value={o.baggage}
                    onChange={(e) => setOpt(i, { baggage: e.target.value })}
                    style={input}
                    aria-label={`Baggage (option ${i + 1})`}
                  />
                </div>
              </div>
            ))}
          </section>

          <div style={{ height: 16 }} />

          {/* ── Markup preview ─────────────────────────────────────── */}
          <section style={card}>
            <h2 style={sectionTitle}>
              <Percent size={18} aria-hidden style={{ marginRight: 6, verticalAlign: -3 }} />
              Markup preview
            </h2>
            <div style={{ marginTop: 8, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
              <select
                value={markupRuleId}
                onChange={(e) => setMarkupRuleId(e.target.value)}
                style={input}
                aria-label="Markup rule"
              >
                <option value="">Auto (priority pick)</option>
                {rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.markupPct != null ? `${Number(r.markupPct)}%` : `+${Number(r.markupFlat).toLocaleString()} flat`} — priority {r.priority}
                  </option>
                ))}
              </select>
            </div>
            {rules.length === 0 ? (
              <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 0 }}>
                No active flight markup rules for {subBrandShortLabel(subBrand)} — fares go out as entered.
                Manage rules at <Link to="/travel/pricing-rules">Pricing Rules</Link>.
              </p>
            ) : (
              <ul style={{ paddingLeft: 18, fontSize: 13, marginBottom: 0 }}>
                {preview.map((p, i) =>
                  p ? (
                    <li key={i}>
                      Option {i + 1}: {fmtAmount(p.fare)} + {fmtAmount(p.markupAmount)} markup
                      = <strong>{fmtAmount(p.total)}</strong>
                      {p.rule == null && " (no rule matched)"}
                    </li>
                  ) : (
                    <li key={i} style={{ color: "var(--text-secondary)" }}>
                      Option {i + 1}: enter a fare to preview
                    </li>
                  ),
                )}
              </ul>
            )}
            <p style={{ color: "var(--text-secondary)", fontSize: 11, marginBottom: 0 }}>
              Preview only — the server recomputes markup on submit.
            </p>
          </section>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button type="button" onClick={submit} disabled={submitting} style={primaryBtn}>
              <Send size={14} /> {submitting ? "Creating…" : "Create quote"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Shared styles (parallel to PricingRules.jsx) ─────────────────────

const card = {
  background: "var(--surface-color)",
  borderRadius: 12,
  border: "1px solid var(--border-color)",
  padding: 16,
};
const sectionTitle = { margin: 0, fontSize: 17, display: "flex", alignItems: "center" };
const countBadge = {
  marginLeft: 8, padding: "2px 8px", borderRadius: 10,
  fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg)", color: "var(--text-secondary)",
};
const optionBox = {
  background: "var(--bg-color)", padding: 12, borderRadius: 8,
  border: "1px solid var(--border-color)", marginTop: 12,
};
const input = {
  padding: "8px 10px", borderRadius: 6, width: "100%", boxSizing: "border-box",
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13,
};
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color)", color: "#fff",
  border: "none", cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const iconBtn = {
  padding: 4, borderRadius: 4,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
const backLink = {
  display: "inline-flex", alignItems: "center", gap: 4,
  fontSize: 13, color: "var(--text-secondary)",
  textDecoration: "none", padding: "6px 12px", borderRadius: 6,
  border: "1px solid var(--border-color)",
};
