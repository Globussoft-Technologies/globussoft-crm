import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Send, Trash2, Plane, Search, Clock3, ChevronLeft, Building2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { fetchApi } from "../../utils/api";
import FlightOfferImageGenerator from "./FlightOfferImageGenerator";
import { useNotify } from "../../utils/notify";

const DEFAULT_CURRENCY = "INR";
const LEGACY_RECENT_QUOTES_KEY = "flight-quick-quote:recent";
const MAX_OPTIONS = 4;

const pageWrap = {
  padding: 24,
  maxWidth: 1200,
  margin: "0 auto",
  animation: "fadeIn 0.4s ease-out",
};

const headerRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  flexWrap: "wrap",
  marginBottom: 16,
};

const titleBlock = {
  display: "grid",
  gap: 8,
  maxWidth: 780,
};

const title = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  margin: 0,
  fontSize: "1.75rem",
  fontWeight: 600,
};

const subTitle = {
  margin: 0,
  color: "var(--text-secondary)",
  fontSize: "0.95rem",
  lineHeight: 1.6,
};

const sectionShell = {
  padding: 16,
  marginBottom: 16,
};

const sectionHeader = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  flexWrap: "wrap",
};

const customerGrid = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  marginTop: 12,
};


const sectionTitle = {
  margin: 0,
  fontSize: 18,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const countPill = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 36,
  padding: "3px 10px",
  borderRadius: 999,
  background: "var(--subtle-bg)",
  border: "1px solid var(--border-color)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 700,
};

const iconDangerBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--danger-color, #ef4444)",
  cursor: "pointer",
};

const tableWrap = {
  marginTop: 14,
  overflowX: "auto",
};

const tableStyle = {
  width: "100%",
  minWidth: 760,
  borderCollapse: "separate",
  borderSpacing: 0,
};

const thStyle = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "12px",
  fontSize: 14,
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-color)",
};

const helperText = {
  fontSize: 13,
  color: "var(--text-secondary)",
  lineHeight: 1.6,
};

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 10,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  outline: "none",
};

const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: 10,
  border: "none",
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  padding: "10px 16px",
  fontWeight: 700,
  cursor: "pointer",
};

const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: 10,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  padding: "10px 16px",
  fontWeight: 700,
  cursor: "pointer",
};

const summaryCard = {
  border: "1px solid var(--border-color)",
  borderRadius: 14,
  background: "var(--surface-color)",
  padding: 14,
};

const mutedCard = {
  border: "1px dashed var(--border-color)",
  borderRadius: 14,
  background: "var(--subtle-bg)",
  padding: 14,
  color: "var(--text-secondary)",
};

const actionRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  marginTop: 20,
  marginBottom: 16,
};

function blankOption() {
  return {
    airline: "",
    flightNumber: "",
    from: "",
    to: "",
    departAt: "",
    arriveAt: "",
    farePerPax: "",
    cabinClass: "Economy",
    baggage: "",
    returnFlightNumber: "",
    returnDepartAt: "",
    returnArriveAt: "",
  };
}

function toText(value) {
  return String(value == null ? "" : value).trim();
}

function toNumberText(value) {
  const text = toText(value);
  if (!text) return "";
  const num = Number(text);
  return Number.isFinite(num) ? String(num) : "";
}

function buildOptionPayload(option, tripMode) {
  const payload = {
    airline: toText(option.airline),
    flightNumber: toText(option.flightNumber) || null,
    fareClass: toText(option.cabinClass) || null,
    pricePerPax: Number(option.farePerPax),
    route: { from: toText(option.from), to: toText(option.to) },
    departAt: toText(option.departAt) || null,
    arriveAt: toText(option.arriveAt) || null,
    baggage: toText(option.baggage) || null,
  };

  if (tripMode === "roundtrip" && (toText(option.returnDepartAt) || toText(option.returnArriveAt))) {
    payload.returnLeg = {
      airline: toText(option.airline),
      flightNumber: toText(option.returnFlightNumber) || toText(option.flightNumber) || null,
      fareClass: toText(option.cabinClass) || null,
      route: { from: toText(option.to), to: toText(option.from) },
      departAt: toText(option.returnDepartAt) || null,
      arriveAt: toText(option.returnArriveAt) || null,
      baggage: toText(option.baggage) || null,
    };
  }

  return payload;
}

function formatCurrency(value, currency = DEFAULT_CURRENCY) {
  const num = Number(value);
  if (!Number.isFinite(num)) return currency;
  return `${currency} ${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 KB";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function previewMarkup(rules, fare, { forcedRuleId = null } = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const activeRule = forcedRuleId != null
    ? list.find((rule) => Number(rule?.id) === Number(forcedRuleId))
    : list[0];

  if (!activeRule) return { markupAmount: 0, rule: null };

  const markupType = String(activeRule.markupType || activeRule.type || activeRule.calculationType || "").toLowerCase();
  const markupValue = Number(activeRule.markupValue ?? activeRule.value ?? activeRule.amount ?? 0);
  if (!Number.isFinite(markupValue)) return { markupAmount: 0, rule: activeRule };

  const markupAmount = markupType.includes("percent")
    ? Math.round((fare * markupValue / 100) * 100) / 100
    : markupValue;

  return { markupAmount, rule: activeRule };
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildFlightOfferImageSvg({
  contactName,
  subBrandLabel,
  routeLabel,
  travelDate,
  tripModeLabel,
  currency,
  totalAmount,
  pricedOptions,
}) {
  const optionRows = (Array.isArray(pricedOptions) ? pricedOptions : []).slice(0, 4).map((option, index) => `
    <g transform="translate(0,${index * 154})">
      <rect x="0" y="0" width="1060" height="136" rx="22" fill="#F9FAFB" stroke="#E2E8F0"/>
      <text x="26" y="36" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#111827">${escapeXml(option.airline || `Option ${index + 1}`)}</text>
      <text x="26" y="60" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="600" fill="#6B7280">${escapeXml([option.flightNumber, option.cabinClass].filter(Boolean).join(" � ") || "Flight details")}</text>
      <text x="26" y="88" font-family="Inter, Arial, sans-serif" font-size="14" fill="#374151">${escapeXml([option.from, option.to].filter(Boolean).join(" -> ") || "Route on request")}</text>
      <text x="26" y="112" font-family="Inter, Arial, sans-serif" font-size="13" fill="#6B7280">${escapeXml([option.departAt, option.arriveAt].filter(Boolean).join("  �  ") || "Timing on request")}</text>
      <text x="1038" y="60" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#111827">${escapeXml(formatCurrency(option.total, currency))}</text>
      <text x="1038" y="84" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700" fill="#10B981">Final quoted price</text>
    </g>
  `).join("");
  const totalLabel = formatCurrency(totalAmount, currency);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="1600" viewBox="0 0 1200 1600" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(routeLabel || "Flight quotation")}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1D4ED8"/>
      <stop offset="100%" stop-color="#0F766E"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#0B1220" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="1200" height="1600" fill="url(#bg)"/>
  <rect x="48" y="44" width="1104" height="1512" rx="34" fill="#FFFFFF" filter="url(#shadow)"/>
  <rect x="48" y="44" width="1104" height="176" rx="34" fill="url(#hero)"/>
  <rect x="48" y="176" width="1104" height="40" fill="#FFFFFF"/>
  <text x="80" y="102" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="700" fill="#E0F2FE" opacity="0.95">Flight offer quotation</text>
  <text x="80" y="148" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="800" fill="#FFFFFF">${escapeXml(routeLabel || "Flight quotation")}</text>
  <text x="80" y="178" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="600" fill="#E2E8F0">${escapeXml(contactName || "Customer")} � ${escapeXml(tripModeLabel || "One way")} � ${escapeXml(travelDate || "Date on request")}</text>
  <rect x="876" y="86" width="236" height="50" rx="25" fill="#0F9D58"/>
  <text x="994" y="118" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="#FFFFFF">${escapeXml(subBrandLabel || "FINAL PRICE ONLY")}</text>
  <g transform="translate(80,258)">
    <rect x="0" y="0" width="330" height="132" rx="24" fill="#F8FAFC" stroke="#E2E8F0"/>
    <text x="24" y="36" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" fill="#64748B">Customer</text>
    <text x="24" y="68" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#111827">${escapeXml(contactName || "Customer")}</text>
    <text x="24" y="96" font-family="Inter, Arial, sans-serif" font-size="13" fill="#475569">Prepared for WhatsApp or email sharing.</text>
  </g>
  <g transform="translate(435,258)">
    <rect x="0" y="0" width="330" height="132" rx="24" fill="#F8FAFC" stroke="#E2E8F0"/>
    <text x="24" y="36" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" fill="#64748B">Travel date</text>
    <text x="24" y="68" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#111827">${escapeXml(travelDate || "On request")}</text>
    <text x="24" y="96" font-family="Inter, Arial, sans-serif" font-size="13" fill="#475569">${escapeXml(routeLabel || "Route to be confirmed")}</text>
  </g>
  <g transform="translate(790,258)">
    <rect x="0" y="0" width="258" height="132" rx="24" fill="#F8FAFC" stroke="#E2E8F0"/>
    <text x="24" y="36" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" fill="#64748B">Quoted total</text>
    <text x="24" y="76" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="800" fill="#111827">${escapeXml(totalLabel)}</text>
    <text x="24" y="100" font-family="Inter, Arial, sans-serif" font-size="13" fill="#475569">Final quoted price only</text>
  </g>
  <g transform="translate(80,440)">
    <text x="0" y="0" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#111827">Flight details</text>
    <text x="0" y="28" font-family="Inter, Arial, sans-serif" font-size="14" fill="#6B7280">Professional quote layout with the final price only.</text>
  </g>
  <g transform="translate(80,492)">${optionRows || `
    <rect x="0" y="0" width="1060" height="120" rx="22" fill="#F9FAFB" stroke="#E2E8F0"/>
    <text x="530" y="68" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#64748B">Add a priced flight option to generate the quote image.</text>
  `}</g>
  <g transform="translate(80,1176)">
    <rect x="0" y="0" width="1060" height="196" rx="24" fill="#F8FAFC" stroke="#E2E8F0"/>
    <text x="24" y="34" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="#111827">Policies &amp; notes</text>
    <text x="24" y="64" font-family="Inter, Arial, sans-serif" font-size="13" fill="#475569">Final quoted price shown only. Fare remains subject to availability and airline confirmation until ticketed.</text>
    <text x="24" y="100" font-family="Inter, Arial, sans-serif" font-size="13" fill="#475569">Cancellation and change policies can be added later if required.</text>
    <text x="24" y="134" font-family="Inter, Arial, sans-serif" font-size="13" fill="#475569">No markup breakdown is shown to the customer.</text>
  </g>
</svg>`;
}

function buildSvgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export default function FlightQuoteAgent() {
  const notify = useNotify();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState([]);
  const [contactQuery, setContactQuery] = useState("");
  const [selectedContactId, setSelectedContactId] = useState("");
  const [subBrand, setSubBrand] = useState("tmc");
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [tripMode, setTripMode] = useState("oneway");
  const [rules, setRules] = useState([]);
  const [markupRuleId] = useState("");
  const [flightSearch, setFlightSearch] = useState({ from: "", to: "", date: "", cabinClass: "Economy" });
  const [searchSummary, setSearchSummary] = useState("");
  const [flightOptions, setFlightOptions] = useState([blankOption()]);
  const [previewPick, setPreviewPick] = useState("auto");
  const [recentQuotes, setRecentQuotes] = useState([]);
  const [creatingQuote, setCreatingQuote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchApi("/api/contacts?status=Customer")
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.contacts) ? res.contacts : Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        setContacts(list);
      })
      .catch(() => {
        if (!cancelled) setContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ subBrand, scope: "flight", active: "true" });
    fetchApi(`/api/travel/markup-rules?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setRules(Array.isArray(res?.rules) ? res.rules : []);
      })
      .catch(() => {
        if (!cancelled) setRules([]);
      });
    return () => {
      cancelled = true;
    };
  }, [subBrand]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LEGACY_RECENT_QUOTES_KEY) || "[]");
      if (Array.isArray(saved)) setRecentQuotes(saved);
    } catch {
      setRecentQuotes([]);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LEGACY_RECENT_QUOTES_KEY, JSON.stringify(recentQuotes.slice(0, 5)));
    } catch {
      // ignore storage failures in tests or restricted environments
    }
  }, [recentQuotes]);

  const filteredContacts = useMemo(() => {
    const query = contactQuery.trim().toLowerCase();
    if (!query) return contacts;
    return contacts.filter((contact) => {
      const haystack = [contact?.name, contact?.email, contact?.phone, contact?.company]
        .map((value) => toText(value).toLowerCase())
        .join(" ");
      return haystack.includes(query);
    });
  }, [contacts, contactQuery]);

  const selectedContact = useMemo(
    () => contacts.find((contact) => String(contact.id) === String(selectedContactId)),
    [contacts, selectedContactId],
  );

  const activeMarkupRuleId = markupRuleId ? Number(markupRuleId) : null;
  const pricedOptions = useMemo(() => flightOptions
    .map((option, index) => {
      const fare = Number(option.farePerPax);
      if (!option.airline || !Number.isFinite(fare)) return null;
      const { markupAmount } = previewMarkup(rules, fare, {
        forcedRuleId: activeMarkupRuleId,
        userId: null,
      });
      return {
        index: index + 1,
        airline: toText(option.airline),
        flightNumber: toText(option.flightNumber),
        from: toText(option.from),
        to: toText(option.to),
        departAt: toText(option.departAt),
        arriveAt: toText(option.arriveAt),
        baggage: toText(option.baggage),
        cabinClass: toText(option.cabinClass) || "Economy",
        fare,
        markupAmount,
        total: Math.round((fare + markupAmount) * 100) / 100,
      };
    })
    .filter(Boolean), [flightOptions, rules, activeMarkupRuleId]);
  const totalQuotedAmount = pricedOptions.reduce((sum, option) => sum + (Number(option.total) || 0), 0);
  const routeLabel = [flightSearch.from, flightSearch.to].filter(Boolean).join(" -> ") || (pricedOptions[0] ? [pricedOptions[0].from, pricedOptions[0].to].filter(Boolean).join(" -> ") : "Flight quotation");
  const tripModeLabel = tripMode === "roundtrip" ? "Round trip" : "One way";
  const subBrandLabel = subBrand === "tmc" ? "TMC" : subBrand === "rfu" ? "RFU" : subBrand === "travelstall" ? "Travel Stall" : subBrand;
  const downloadFileName = `flight-quote-${String(routeLabel || "quote").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "image"}.svg`;

  const previewLabel = previewPick === "auto" ? "Auto (priority pick)" : `Option ${Number(previewPick) + 1}`;

  const updateOption = (index, patch) => {
    setFlightOptions((prev) => prev.map((option, rowIndex) => (rowIndex === index ? { ...option, ...patch } : option)));
  };

  const addOption = () => {
    setFlightOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, blankOption()]));
  };

  const removeOption = (index) => {
    setFlightOptions((prev) => (prev.length <= 1 ? prev : prev.filter((_, rowIndex) => rowIndex !== index)));
  };


  const runSearch = () => {
    if (!toText(flightSearch.from) || !toText(flightSearch.to) || !toText(flightSearch.date)) {
      notify.error("Enter the flight origin, destination, and date before searching.");
      return;
    }
    setSearchSummary(`Searching ${flightSearch.from} -> ${flightSearch.to} on ${flightSearch.date} (${flightSearch.cabinClass}).`);
  };


  const createQuote = async () => {
    const contactId = Number(selectedContactId);
    if (!selectedContactId || !Number.isInteger(contactId)) {
      notify.error("Select a customer before creating the quote.");
      return;
    }

    const options = flightOptions
      .map((option) => buildOptionPayload(option, tripMode))
      .filter((option) => option.airline && Number.isFinite(option.pricePerPax));

    if (options.length === 0) {
      notify.error("Add at least one flight option with an airline and price.");
      return;
    }

    setCreatingQuote(true);
    try {
      const response = await fetchApi("/api/v1/flight-plugin/agent-quotes", {
        method: "POST",
        body: JSON.stringify({ contactId, subBrand, currency, markupRuleId: null, options }),
      });

      const nextQuote = {
        id: String(Date.now()),
        title: `${selectedContact?.name || "Customer"} � ${options[0].route.from || "Flight"} -> ${options[0].route.to || "route"}`,
        customer: selectedContact?.name || `Contact #${contactId}`,
        totalWithMarkup: response?.totalWithMarkup ?? response?.items?.[0]?.totalWithMarkup ?? "",
        currency: response?.currency || currency,
        pdfUrl: response?.pdfUrl || "",
        createdAt: new Date().toLocaleDateString(),
      };

      setRecentQuotes((prev) => [nextQuote, ...prev].slice(0, 5));
      notify.success("Flight quote created.");
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create flight quote.");
    } finally {
      setCreatingQuote(false);
    }
  };

  return (
    <div style={pageWrap} data-testid="flight-quote-agent">
      <header style={headerRow}>
        <div style={titleBlock}>
          <h1 style={title}>
            <Plane size={26} aria-hidden /> Flight quick-quote
          </h1>
          <p style={subTitle}>
            Manual fallback for the Chrome flight plugin. Enter up to 4 options, let markup rules apply server-side, then share the branded quote.
          </p>
        </div>
        <button type="button" onClick={() => navigate("/travel/pricing-rules")} style={secondaryBtn}>
          <ChevronLeft size={16} aria-hidden /> Pricing rules
        </button>
      </header>
      <FlightOfferImageGenerator />

      <section className="glass" style={sectionShell}>
        <h2 style={sectionTitle}>
          Customer
        </h2>
        <div style={customerGrid}>
          <input
            aria-label="Search contacts"
            placeholder="Search contacts by name or phone"
            value={contactQuery}
            onChange={(e) => setContactQuery(e.target.value)}
            style={fieldStyle}
          />
          <select
            aria-label="Select contact"
            value={selectedContactId}
            onChange={(e) => setSelectedContactId(e.target.value)}
            style={fieldStyle}
          >
            <option value="">Select contact...</option>
            {filteredContacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}{contact.phone ? ` � ${contact.phone}` : ""}
              </option>
            ))}
          </select>
          <select aria-label="Sub-brand" value={subBrand} onChange={(e) => setSubBrand(e.target.value)} style={fieldStyle}>
            <option value="tmc">TMC</option>
            <option value="rfu">RFU</option>
            <option value="travelstall">Travel Stall</option>
          </select>
          <input
            aria-label="Currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            style={fieldStyle}
          />
        </div>
      </section>
      <section className="glass" style={sectionShell}>
        <div>
          <h2 style={sectionTitle}>
            <Search size={18} aria-hidden /> Search flights
          </h2>
          <p style={{ margin: "8px 0 0", ...helperText }}>
            Pull live options and drop one into a row below. Uses TBO when configured, else an AI web estimate, else sample data.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <button type="button" onClick={() => setTripMode("oneway")} style={tripMode === "oneway" ? primaryBtn : secondaryBtn}>
            One way
          </button>
          <button type="button" onClick={() => setTripMode("roundtrip")} style={tripMode === "roundtrip" ? primaryBtn : secondaryBtn}>
            Round trip
          </button>
        </div>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", marginTop: 14 }}>
          <input
            aria-label="Flight from"
            placeholder="From city or code"
            value={flightSearch.from}
            onChange={(e) => setFlightSearch((prev) => ({ ...prev, from: e.target.value }))}
            style={fieldStyle}
          />
          <input
            aria-label="Flight to"
            placeholder="To city or code"
            value={flightSearch.to}
            onChange={(e) => setFlightSearch((prev) => ({ ...prev, to: e.target.value }))}
            style={fieldStyle}
          />
          <input
            aria-label="Flight date"
            placeholder="dd-mm-yyyy"
            value={flightSearch.date}
            onChange={(e) => setFlightSearch((prev) => ({ ...prev, date: e.target.value }))}
            style={fieldStyle}
          />
          <select
            aria-label="Cabin class"
            value={flightSearch.cabinClass}
            onChange={(e) => setFlightSearch((prev) => ({ ...prev, cabinClass: e.target.value }))}
            style={fieldStyle}
          >
            <option>Economy</option>
            <option>Premium Economy</option>
            <option>Business</option>
            <option>First</option>
          </select>
          <button type="button" onClick={runSearch} style={primaryBtn}>
            <Search size={14} aria-hidden /> Search
          </button>
        </div>
        {searchSummary ? <div style={{ marginTop: 10, ...helperText }}>{searchSummary}</div> : null}
      </section>

      <section className="glass" style={sectionShell}>
        <div style={sectionHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={sectionTitle}>
              <Building2 size={18} aria-hidden /> Flight options
            </h2>
            <span style={countPill}>{flightOptions.length}/{MAX_OPTIONS}</span>
          </div>
          <button
            type="button"
            onClick={addOption}
            disabled={flightOptions.length >= MAX_OPTIONS}
            style={{ ...secondaryBtn, opacity: flightOptions.length >= MAX_OPTIONS ? 0.5 : 1 }}
          >
            <Plus size={14} aria-hidden /> Add option
          </button>
        </div>

        <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
          {flightOptions.map((option, index) => (
            <div key={`legacy-option-${index}`} style={summaryCard}>
              <div style={sectionHeader}>
                <strong>Option {index + 1}</strong>
                <button
                  type="button"
                  aria-label={`Remove option ${index + 1}`}
                  onClick={() => removeOption(index)}
                  disabled={flightOptions.length <= 1}
                  style={{ ...iconDangerBtn, opacity: flightOptions.length <= 1 ? 0.45 : 1 }}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>

              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", marginTop: 12 }}>
                <input
                  aria-label={`Airline ${index + 1}`}
                  placeholder="Airline (e.g. AI)"
                  value={option.airline}
                  onChange={(e) => updateOption(index, { airline: e.target.value })}
                  style={fieldStyle}
                />
                <input
                  aria-label={`Flight number ${index + 1}`}
                  placeholder="Flight no. (e.g. AI-302)"
                  value={option.flightNumber}
                  onChange={(e) => updateOption(index, { flightNumber: e.target.value })}
                  style={fieldStyle}
                />
                <input
                  aria-label={`From ${index + 1}`}
                  placeholder="From (IATA, e.g. DEL)"
                  value={option.from}
                  onChange={(e) => updateOption(index, { from: e.target.value })}
                  style={fieldStyle}
                />
                <input
                  aria-label={`To ${index + 1}`}
                  placeholder="To (IATA, e.g. JED)"
                  value={option.to}
                  onChange={(e) => updateOption(index, { to: e.target.value })}
                  style={fieldStyle}
                />
                <input
                  aria-label={`Departure ${index + 1}`}
                  placeholder="dd-mm-yyyy  --:--"
                  value={option.departAt}
                  onChange={(e) => updateOption(index, { departAt: e.target.value })}
                  style={fieldStyle}
                />
                <input
                  aria-label={`Arrival ${index + 1}`}
                  placeholder="dd-mm-yyyy  --:--"
                  value={option.arriveAt}
                  onChange={(e) => updateOption(index, { arriveAt: e.target.value })}
                  style={fieldStyle}
                />
                <input
                  aria-label={`Fare ${index + 1}`}
                  placeholder="Fare per pax"
                  value={option.farePerPax}
                  onChange={(e) => updateOption(index, { farePerPax: toNumberText(e.target.value) })}
                  style={fieldStyle}
                />
                <select
                  aria-label={`Class ${index + 1}`}
                  value={option.cabinClass}
                  onChange={(e) => updateOption(index, { cabinClass: e.target.value })}
                  style={fieldStyle}
                >
                  <option>Economy</option>
                  <option>Premium Economy</option>
                  <option>Business</option>
                  <option>First</option>
                </select>
                <input
                  aria-label={`Baggage ${index + 1}`}
                  placeholder="Baggage (e.g. 15kg + 7kg)"
                  value={option.baggage}
                  onChange={(e) => updateOption(index, { baggage: e.target.value })}
                  style={fieldStyle}
                />
              </div>

              {tripMode === "roundtrip" ? (
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", marginTop: 12 }}>
                  <input
                    aria-label={`Return flight number ${index + 1}`}
                    placeholder="Return flight no."
                    value={option.returnFlightNumber}
                    onChange={(e) => updateOption(index, { returnFlightNumber: e.target.value })}
                    style={fieldStyle}
                  />
                  <input
                    aria-label={`Return departure ${index + 1}`}
                    placeholder="Return date/time"
                    value={option.returnDepartAt}
                    onChange={(e) => updateOption(index, { returnDepartAt: e.target.value })}
                    style={fieldStyle}
                  />
                  <input
                    aria-label={`Return arrival ${index + 1}`}
                    placeholder="Return arrival"
                    value={option.returnArriveAt}
                    onChange={(e) => updateOption(index, { returnArriveAt: e.target.value })}
                    style={fieldStyle}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section id="pricing-markup" className="glass" style={sectionShell}>
        <h2 style={sectionTitle}>
          <Building2 size={18} aria-hidden /> Markup preview
        </h2>
        <div style={{ marginTop: 12 }}>
          <select aria-label="Markup preview" value={previewPick} onChange={(e) => setPreviewPick(e.target.value)} style={fieldStyle}>
            <option value="auto">Auto (priority pick)</option>
            {flightOptions.map((_, index) => (
              <option key={`preview-${index}`} value={String(index)}>
                Option {index + 1}
              </option>
            ))}
          </select>
          <div style={{ marginTop: 10, ...helperText }}>
            <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{previewLabel}</div>
            {flightOptions.map((_, index) => (
              <div key={`preview-row-${index}`} style={{ marginTop: 6 }}>
                Option {index + 1}: enter a fare to preview
              </div>
            ))}
            <div style={{ marginTop: 6 }}>Preview only. The server recomputes markup on submit.</div>
          </div>
        </div>
      </section>




      <div style={actionRow}>
        <button type="button" onClick={createQuote} disabled={creatingQuote} style={{ ...primaryBtn, opacity: creatingQuote ? 0.7 : 1 }}>
          {creatingQuote ? <Loader2 size={14} className="spin" aria-hidden /> : <Send size={14} aria-hidden />} Create quote
        </button>
      </div>



      <section className="glass" style={sectionShell}>
        <h2 style={sectionTitle}>
          <Clock3 size={18} aria-hidden /> Recent flight quotes
        </h2>
        <p style={{ margin: "8px 0 0", ...helperText }}>
          Saved as draft itineraries. Click one to open it, download the PDF, or re-send.
        </p>
        {recentQuotes.length === 0 ? (
          <div style={{ ...mutedCard, marginTop: 14 }}>No recent flight quotes yet.</div>
        ) : (
          <div style={tableWrap}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Quote</th>
                  <th style={thStyle}>Customer</th>
                  <th style={thStyle}>Amount</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Date</th>
                  <th style={{ ...thStyle, width: 92 }} />
                </tr>
              </thead>
              <tbody>
                {recentQuotes.map((quote) => (
                  <tr key={quote.id}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 700 }}>{quote.title}</div>
                    </td>
                    <td style={tdStyle}>{quote.customer}</td>
                    <td style={tdStyle}>{quote.currency} {formatCurrency(quote.totalWithMarkup, quote.currency)}</td>
                    <td style={tdStyle}>{quote.status || "Sent"}</td>
                    <td style={tdStyle}>{quote.createdAt}</td>
                    <td style={tdStyle}>
                      {quote.pdfUrl ? (
                        <a href={quote.pdfUrl} target="_blank" rel="noreferrer" style={{ ...secondaryBtn, textDecoration: "none", padding: "8px 12px" }}>
                          <Send size={14} aria-hidden /> Send
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-tertiary)" }}>�</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}







