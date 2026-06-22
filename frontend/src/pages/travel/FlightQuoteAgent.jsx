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
//   POST /api/travel/itineraries/:id/share { channel:"auto" } → send to
//       customer EMAIL-FIRST (SendGrid), WhatsApp fallback (watiClient
//       best-effort) + copyable share URL — same endpoint ItineraryDetail
//       uses (which omits channel and stays WhatsApp-only).
//
// NOTE: this manual fallback does NOT require a completed diagnostic — the
// lead has typically reached out directly (WhatsApp / email) and the advisor
// quotes on the spot. (Itinerary creation still enforces the §4.1 guard.)

import { useContext, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeft, Clock, Copy, Download, Mail, MessageCircle, Percent, Plane, Plus,
  RotateCcw, Search, Send, Trash2,
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

// Search data-source badge: tells the advisor whether results are live TBO
// inventory, an AI web estimate, or offline sample data (so they verify before
// quoting). Mirrors tboClient's `provider` field.
const PROVIDER_LABEL = {
  tbo: "TBO live",
  "llm-web": "AI web estimate",
  stub: "Sample data",
};
const PROVIDER_COLORS = {
  tbo: { bg: "#e8f6ee", fg: "#1e8449" },
  "llm-web": { bg: "#eaf2fb", fg: "#1e4d8c" },
  stub: { bg: "#f3f0e8", fg: "#8a6d2f" },
};
function providerBadge(provider) {
  const c = PROVIDER_COLORS[provider] || PROVIDER_COLORS.stub;
  return {
    display: "inline-block", padding: "1px 7px", borderRadius: 10,
    fontSize: 11, fontWeight: 700, marginRight: 6,
    background: c.bg, color: c.fg,
  };
}
// Compact "2 Aug, 6:10 PM" for search rows; null when unparseable/absent.
function fmtSearchTime(s) {
  if (!s) return null;
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

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

  // ── live flight search (TBO → AI web → sample) ──────────────────
  // Searches real-ish flights via /api/travel/search/flights and lets the
  // advisor drop a result straight into an option row. Data source + freshness
  // are surfaced via the provider badge (TBO / AI estimate / sample).
  const [searchForm, setSearchForm] = useState({ from: "", to: "", departDate: "", cabinClass: "Economy" });
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchMeta, setSearchMeta] = useState(null); // { provider, note }

  // ── result state ────────────────────────────────────────────────
  const [result, setResult] = useState(null); // { itineraryId, items, totalWithMarkup, currency, pdfUrl }
  const [share, setShare] = useState(null); // { shareUrl, whatsapp }
  const [sharing, setSharing] = useState(false);

  // ── recent flight quotes (history) ──────────────────────────────
  // Flight quick-quotes are persisted as draft Itineraries named
  // "<FROM>→<TO> flights" (routes/travel_flight_quotes.js). There was no way
  // to see them again from this page — they only showed under /travel/
  // itineraries (status=draft), which operators didn't expect. This panel
  // surfaces them right here. Tenant + sub-brand-access scoped by the backend.
  const [recentQuotes, setRecentQuotes] = useState([]);
  const [resendingId, setResendingId] = useState(null); // itinerary id being re-sent

  // Contact feed — same /api/contacts?limit=200 fetch the other travel
  // pickers use (no server-side ?search today; filtered client-side below).
  useEffect(() => {
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : res?.contacts || []))
      .catch(() => setContacts([]));
  }, []);

  // Load recent flight quotes. The itineraries list returns full item rows
  // (include: items), so we filter to the flight quick-quote shape — a
  // destination ending in "flights" (how this page names them) — and keep
  // the latest 10. Refreshed after each successful create.
  const loadRecentQuotes = () => {
    fetchApi("/api/travel/itineraries?limit=50")
      .then((res) => {
        const list = Array.isArray(res?.itineraries) ? res.itineraries : [];
        const flights = list
          .filter((it) => /flights\s*$/i.test(String(it.destination || "")))
          .slice(0, 10);
        setRecentQuotes(flights);
      })
      .catch(() => setRecentQuotes([]));
  };
  useEffect(() => { loadRecentQuotes(); }, []);

  // Re-send a recent quote straight from the history row. Same email-first +
  // WhatsApp share the result panel uses (channel:"auto") — for a lead with
  // only a phone (e.g. WhatsApp-only), this delivers via the connected
  // WhatsApp Web number. Honest toast: only claims a channel that actually
  // delivered (the backend returns channel:"none" when nothing went out).
  const resendQuote = async (q) => {
    setResendingId(q.id);
    try {
      const res = await fetchApi(`/api/travel/itineraries/${q.id}/share`, {
        method: "POST",
        body: JSON.stringify({ channel: "auto" }),
      });
      const ch = res?.channel || "none";
      if (ch === "none") {
        notify.error("Couldn't send — the contact has no email/phone, or WhatsApp isn't connected");
      } else if (ch === "in-app") {
        notify.success("No email/phone — added an in-app reminder to send the link manually");
      } else {
        const parts = [];
        if (ch.includes("email")) parts.push("email");
        if (ch.includes("whatsapp")) parts.push("WhatsApp");
        notify.success(`Sent to the customer via ${parts.join(" + ")}`);
      }
      loadRecentQuotes(); // status may flip draft → sent
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to send");
    } finally {
      setResendingId(null);
    }
  };

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

  // Live flight search → fills option rows. Best-effort: the backend always
  // returns SOMETHING (TBO / AI estimate / sample), so this only errors on a
  // network/validation failure.
  const runFlightSearch = async () => {
    // Send the raw text (city name OR IATA code) — the backend resolves it to an
    // IATA code (static map, LLM fallback). Don't force-uppercase: a city name
    // stays readable and the resolver is case-insensitive either way.
    const from = searchForm.from.trim();
    const to = searchForm.to.trim();
    if (!from || !to) { notify.error("Enter where you're flying from and to"); return; }
    if (!searchForm.departDate) { notify.error("Pick a departure date"); return; }
    setSearching(true);
    setSearchResults([]);
    setSearchMeta(null);
    try {
      const res = await fetchApi("/api/travel/search/flights", {
        method: "POST",
        body: JSON.stringify({
          from, to, departDate: searchForm.departDate,
          cabinClass: searchForm.cabinClass,
          currency: currency.trim().toUpperCase() || "INR",
        }),
      });
      setSearchResults(Array.isArray(res?.options) ? res.options : []);
      setSearchMeta({ provider: res?.provider || "stub", note: res?.note || null, resolved: res?.resolved || null });
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Flight search failed");
    } finally {
      setSearching(false);
    }
  };

  // Drop a search result into an option row — reuse the first fully-empty row,
  // else append (respecting MAX_OPTIONS). datetime-local wants "YYYY-MM-DDTHH:mm".
  const applySearchResult = (o) => {
    const dtLocal = (s) => (s ? String(s).slice(0, 16) : "");
    const opt = {
      airline: o.airline || "",
      flightNumber: o.flightNumber || "",
      from: o.from || "",
      to: o.to || "",
      departAt: dtLocal(o.departAt),
      arriveAt: dtLocal(o.arriveAt),
      fare: o.fare != null ? String(o.fare) : "",
      fareClass: o.fareClass || "Economy",
      baggage: o.baggage || "",
    };
    setOptions((prev) => {
      const emptyIdx = prev.findIndex((p) => !p.airline && !p.from && !p.to && p.fare === "");
      if (emptyIdx >= 0) return prev.map((p, i) => (i === emptyIdx ? opt : p));
      if (prev.length >= MAX_OPTIONS) { notify.info?.(`Max ${MAX_OPTIONS} options`); return prev; }
      return [...prev, opt];
    });
    notify.success?.(`Added ${o.airline || "flight"} ${o.from}→${o.to}`);
  };

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
      loadRecentQuotes(); // surface the just-created quote in the history panel
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to create flight quote");
    } finally {
      setSubmitting(false);
    }
  };

  // Send to customer — same /itineraries/:id/share flow, but with
  // channel:"auto" so the backend delivers EMAIL-FIRST (the contact's email
  // if they have one) and falls back to WhatsApp otherwise. Either way the
  // share URL comes back so the advisor can also paste it manually (copy
  // button). Email works today; WhatsApp is stubbed until the Wati creds land.
  const sendToCustomer = async () => {
    if (!result?.itineraryId) return;
    setSharing(true);
    try {
      const res = await fetchApi(`/api/travel/itineraries/${result.itineraryId}/share`, {
        method: "POST",
        body: JSON.stringify({ channel: "auto" }),
      });
      setShare(res);
      const ch = res?.channel || "none";
      if (ch === "none") {
        notify.success(
          "Share link minted — send it manually (the contact has no email or phone, or delivery isn't configured)",
        );
      } else if (ch === "in-app") {
        notify.success(
          "Customer has no email or phone — added an in-app reminder to send the link manually",
        );
      } else {
        const parts = [];
        if (ch.includes("email")) parts.push("email");
        if (ch.includes("whatsapp")) parts.push("WhatsApp");
        notify.success(`Quote sent to the customer via ${parts.join(" + ")}`);
      }
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to send quote");
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

  // History helpers. The flight-quote create doesn't set Itinerary.totalAmount
  // (it lives on the per-flight items), so fall back to summing item totalPrice.
  const quoteTotal = (q) => {
    if (q.totalAmount != null) return Number(q.totalAmount);
    return (Array.isArray(q.items) ? q.items : []).reduce(
      (s, it) => s + (Number(it.totalPrice) || 0), 0,
    );
  };
  const contactNameFor = (id) => {
    if (!id) return "—";
    const c = contacts.find((x) => String(x.id) === String(id));
    return c?.name || `Contact #${id}`;
  };

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
            <button type="button" onClick={sendToCustomer} disabled={sharing} style={secondaryBtn}>
              <Send size={14} /> {sharing ? "Sending…" : "Send to customer"}
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
              <span style={{ fontSize: 12, color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {(share.channel || "none") === "none" ? (
                  "Not delivered — send the link manually"
                ) : (share.channel || "").includes("in-app") ? (
                  "No email/phone — in-app reminder added"
                ) : (
                  <>
                    {(share.channel || "").includes("email") && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <Mail size={12} aria-hidden /> Emailed
                      </span>
                    )}
                    {(share.channel || "").includes("whatsapp") && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <MessageCircle size={12} aria-hidden /> WhatsApp: {share.whatsapp}
                      </span>
                    )}
                  </>
                )}
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

          {/* ── Live flight search (TBO → AI web → sample) ─────────── */}
          <section style={card}>
            <h2 style={sectionTitle}>
              <Search size={18} aria-hidden style={{ marginRight: 6, verticalAlign: -3 }} />
              Search flights
            </h2>
            <p style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 4, marginBottom: 0 }}>
              Pull live options and drop one into a row below. Uses TBO when configured, else an AI web
              estimate, else sample data.
            </p>
            <div style={{ marginTop: 10, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))" }}>
              <input
                placeholder="From — city or code (e.g. Delhi or DEL)" value={searchForm.from} maxLength={60}
                onChange={(e) => setSearchForm({ ...searchForm, from: e.target.value })}
                style={input} aria-label="Search origin — city, airport, or IATA code"
              />
              <input
                placeholder="To — city or code (e.g. Jeddah or JED)" value={searchForm.to} maxLength={60}
                onChange={(e) => setSearchForm({ ...searchForm, to: e.target.value })}
                style={input} aria-label="Search destination — city, airport, or IATA code"
              />
              <input
                type="date" value={searchForm.departDate}
                onChange={(e) => setSearchForm({ ...searchForm, departDate: e.target.value })}
                style={input} aria-label="Search departure date"
              />
              <select
                value={searchForm.cabinClass}
                onChange={(e) => setSearchForm({ ...searchForm, cabinClass: e.target.value })}
                style={input} aria-label="Search cabin class"
              >
                {FARE_CLASSES.map((fc) => <option key={fc} value={fc}>{fc}</option>)}
              </select>
              <button type="button" onClick={runFlightSearch} disabled={searching} style={primaryBtn}>
                <Search size={14} /> {searching ? "Searching…" : "Search"}
              </button>
            </div>

            {searchMeta && (
              <p style={{ fontSize: 12, marginTop: 10, marginBottom: 0, color: "var(--text-secondary)" }}>
                <span style={providerBadge(searchMeta.provider)}>
                  {PROVIDER_LABEL[searchMeta.provider] || searchMeta.provider}
                </span>
                {/* Reassure the advisor which airports the names resolved to. */}
                {searchMeta.resolved && searchMeta.resolved.from && searchMeta.resolved.to
                  ? ` ${searchMeta.resolved.from.iata} → ${searchMeta.resolved.to.iata}`
                  : ""}
                {searchMeta.note ? ` · ${searchMeta.note}` : ""}
              </p>
            )}

            {searchResults.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                {searchResults.map((o, i) => (
                  <div key={i} style={searchRow}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ fontSize: 13 }}>
                        {o.airlineName || o.airline}{o.flightNumber ? ` · ${o.flightNumber}` : ""} {o.from}→{o.to}
                      </strong>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                        {[
                          fmtSearchTime(o.departAt) && `Dep ${fmtSearchTime(o.departAt)}`,
                          fmtSearchTime(o.arriveAt) && `Arr ${fmtSearchTime(o.arriveAt)}`,
                          o.stops != null && (o.stops === 0 ? "Non-stop" : `${o.stops} stop`),
                          o.fareClass,
                          o.baggage && `Bag ${o.baggage}`,
                        ].filter(Boolean).join("  ·  ")}
                      </div>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" }}>
                      {currency || "INR"} {o.fare != null ? Number(o.fare).toLocaleString() : "—"}
                    </div>
                    <button type="button" onClick={() => applySearchResult(o)} style={{ ...secondaryBtn, padding: "5px 10px" }}>
                      <Plus size={12} /> Use
                    </button>
                  </div>
                ))}
              </div>
            )}
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

      {/* ── Recent flight quotes (history) ─────────────────────────── */}
      {recentQuotes.length > 0 && (
        <section style={{ ...card, marginTop: 16 }}>
          <h2 style={sectionTitle}>
            <Clock size={18} aria-hidden style={{ marginRight: 6, verticalAlign: -3 }} />
            Recent flight quotes
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 4, marginBottom: 8 }}>
            Saved as draft itineraries. Click one to open it, download the PDF, or re-send.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recentQuotes.map((q) => (
              <div key={q.id} style={recentRow}>
                <Link
                  to={`/travel/itineraries/${q.id}`}
                  style={{ fontWeight: 600, color: "var(--text-primary)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {q.destination}
                </Link>
                <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {contactNameFor(q.contactId)}
                </span>
                <span>{q.currency || "INR"} {fmtAmount(quoteTotal(q))}</span>
                <span style={{ textTransform: "capitalize", color: "var(--text-secondary)" }}>{q.status}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                  {q.updatedAt ? new Date(q.updatedAt).toLocaleDateString() : ""}
                </span>
                <button
                  type="button"
                  onClick={() => resendQuote(q)}
                  disabled={resendingId === q.id}
                  style={{ ...secondaryBtn, padding: "5px 10px", opacity: resendingId === q.id ? 0.6 : 1 }}
                  aria-label={`Send quote ${q.destination} to the customer`}
                >
                  <Send size={12} /> {resendingId === q.id ? "Sending…" : "Send"}
                </button>
              </div>
            ))}
          </div>
        </section>
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
const recentRow = {
  display: "grid",
  gridTemplateColumns: "1.4fr 1fr 0.9fr 0.6fr 0.7fr auto",
  gap: 8, alignItems: "center",
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)",
  fontSize: 13,
};
const searchRow = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)", background: "var(--bg-color)",
};
