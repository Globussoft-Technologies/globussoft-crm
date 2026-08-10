const FONT_FAMILY = "Aptos, Segoe UI, Helvetica Neue, Arial, sans-serif";

const DEFAULT_REFERENCE = {
  hotelLabel: "Hotel quotation",
  city: "Goa",
  stayLabel: "2 nights",
  checkIn: "2026-08-02",
  checkOut: "2026-08-04",
  basisLabel: "Hotel wise pricing",
  sourceLabel: "Offline hotel prices",
};

const DEFAULT_HOTELS = ["Grand Hotel", "Palm Suites", "City View Inn"];
const DEFAULT_POLICY_NOTES = [
  { label: "Price view", text: "Only the hotel-wise final quoted price is shown to the customer." },
  { label: "Markup", text: "Markup is applied internally before the image is generated." },
  { label: "Availability", text: "Hotel availability and confirmation remain subject to supplier response." },
  { label: "Changes", text: "Room type, dates, and inclusions can be updated before sharing." },
];

function toText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatCurrency(value, currency = "INR") {
  const num = Number(value);
  if (!Number.isFinite(num)) return currency;
  return `${currency} ${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function truncateText(value, maxChars) {
  const text = toText(value, "");
  if (!text || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function wrapText(value, maxChars, maxLines = 2) {
  const words = toText(value, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(truncateText(word, maxChars));
      current = "";
    }

    if (lines.length === maxLines) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  if (lines.length === maxLines) {
    const joined = lines.join(" ");
    if (joined.length < words.join(" ").length) {
      lines[maxLines - 1] = truncateText(lines[maxLines - 1], maxChars);
    }
  }

  return lines;
}

function normalizeHotelTitle(value, fallback) {
  const text = toText(value, "");
  if (!text || /hotel quotation/i.test(text)) {
    return fallback;
  }
  return text;
}

function normalizeBasisLabel(value) {
  const text = toText(value, "");
  if (!text || /total|quoted|final/i.test(text)) {
    return DEFAULT_REFERENCE.basisLabel;
  }
  return text;
}

function pillText(text, width, fontSize) {
  const maxChars = Math.max(8, Math.floor((width - 24) / Math.max(5.5, fontSize * 0.56)));
  return truncateText(text, maxChars);
}

function buildPill({ x, y, width, height, fill, textFill, text, fontSize = 12, weight = 700, rx = 999 }) {
  const displayText = pillText(text, width, fontSize);
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="${rx}" fill="${fill}"/>
      <text x="${width / 2}" y="${height / 2 + Math.round(fontSize * 0.35)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${weight}" fill="${textFill}">${escapeXml(displayText)}</text>
    </g>
  `;
}

function buildMiniCard({ x, y, width, height, label, value, valueSize = 18, valueWeight = 800, maxLines = 2 }) {
  const lines = wrapText(value, Math.max(12, Math.floor(width / 10.5)), maxLines);
  const lineHeight = Math.round(valueSize * 1.08);
  const firstBaseline = lines.length > 1 ? 56 : 58;
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="22" fill="#F8FAFC" stroke="#E2E8F0"/>
      <text x="24" y="30" font-family="${FONT_FAMILY}" font-size="13" font-weight="700" fill="#64748B">${escapeXml(label)}</text>
      <text x="24" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-size="${valueSize}" font-weight="${valueWeight}" fill="#111827">
        ${lines.map((line, index) => `<tspan x="24" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("")}
      </text>
    </g>
  `;
}

function buildOptionCard({ x, y, width, height, title, roomType, city, basis, price, nights }) {
  const leftDetail = [roomType, city, basis, nights].filter(Boolean).join(" | ");
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="18" fill="#F8FAFC" stroke="#E2E8F0"/>
      <text x="18" y="24" font-family="${FONT_FAMILY}" font-size="17" font-weight="800" fill="#111827">${escapeXml(truncateText(title, 28))}</text>
      <text x="18" y="43" font-family="${FONT_FAMILY}" font-size="11" fill="#64748B">${escapeXml(truncateText(leftDetail || "Hotel details", 48))}</text>
      <text x="${width - 18}" y="24" text-anchor="end" font-family="${FONT_FAMILY}" font-size="19" font-weight="800" fill="#111827">${escapeXml(price)}</text>
      <text x="${width - 18}" y="43" text-anchor="end" font-family="${FONT_FAMILY}" font-size="10" font-weight="800" fill="#0F766E">FINAL</text>
    </g>
  `;
}

export function buildReferenceHotelOfferSvg({ hotelLabel, pricedRows = [], quoteMeta = {} }) {
  const meta = quoteMeta || {};
  const hotelTitle = normalizeHotelTitle(meta.hotelLabel || hotelLabel, DEFAULT_REFERENCE.hotelLabel);
  const city = truncateText(toText(meta.city, DEFAULT_REFERENCE.city), 18);
  const stayLabel = truncateText(toText(meta.stayLabel, DEFAULT_REFERENCE.stayLabel), 20);
  const checkIn = toText(meta.checkIn, DEFAULT_REFERENCE.checkIn);
  const checkOut = toText(meta.checkOut, DEFAULT_REFERENCE.checkOut);
  const basisLabel = truncateText(normalizeBasisLabel(meta.basisLabel || DEFAULT_REFERENCE.basisLabel), 24);
  const sourceLabel = truncateText(toText(meta.sourceLabel, DEFAULT_REFERENCE.sourceLabel), 24);
  const summaryLine = truncateText([city, stayLabel].filter(Boolean).join(" | ") || "Final quoted price only", 58);
  const optionSource = Array.isArray(pricedRows) ? pricedRows : [];
  const optionRows = [0, 1, 2, 3].map((index) => {
    const row = optionSource[index] || {};
    const price = formatCurrency(row.total ?? row.finalPrice ?? row.basePrice ?? 0, row.currency || "INR");
    const nights = row.nights ? `${row.nights} night${Number(row.nights) === 1 ? "" : "s"}` : "";
    const basis = row.priceBasis === "per_night" ? "Per night" : row.priceBasis === "total" ? "Total" : "";
    return buildOptionCard({
      x: 0,
      y: index * 80,
      width: 500,
      height: 64,
      title: toText(row.label, DEFAULT_HOTELS[index] || `Hotel ${index + 1}`),
      roomType: toText(row.roomType),
      city,
      basis,
      price,
      nights,
    });
  }).join("");

  const detailCards = [
    { label: "City", value: city },
    { label: "Stay", value: stayLabel },
    { label: "Check-in", value: checkIn },
    { label: "Check-out", value: checkOut },
    { label: "Price view", value: "Hotel wise only" },
    { label: "Source", value: sourceLabel },
  ];

  const policyRows = [
    "Each hotel line shows the final quoted price only.",
    "Markup stays internal and is not shown to the customer.",
    "Availability and final confirmation still depend on the supplier.",
    "Room type and stay details can be edited before sharing.",
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="1456" viewBox="0 0 1200 1456" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(hotelTitle)} hotel quotation">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#08111F"/>
      <stop offset="100%" stop-color="#101826"/>
    </linearGradient>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#17324F"/>
      <stop offset="100%" stop-color="#0F766E"/>
    </linearGradient>
    <linearGradient id="chipStay" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#DEE8FF"/>
      <stop offset="100%" stop-color="#EAF0FF"/>
    </linearGradient>
    <linearGradient id="chipBasis" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#E0F6EE"/>
      <stop offset="100%" stop-color="#ECFBF4"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#06101E" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="1200" height="1456" fill="url(#bg)"/>
  <rect x="24" y="24" width="1152" height="1408" rx="34" fill="#F8F8F8" filter="url(#shadow)"/>
  <g transform="translate(24,24)">
    <rect width="1152" height="188" rx="34" fill="url(#hero)"/>
    <circle cx="92" cy="86" r="118" fill="#1A3560" opacity="0.72"/>
    <circle cx="1090" cy="92" r="128" fill="#2C7E7B" opacity="0.24"/>
    <text x="36" y="52" font-family="${FONT_FAMILY}" font-size="15" font-weight="700" fill="#EAF2FF" opacity="0.95">Hotel offer quotation</text>
    <text x="36" y="100" font-family="${FONT_FAMILY}" font-size="38" font-weight="800" fill="#FFFFFF">${escapeXml(hotelTitle)}</text>
    <text x="36" y="136" font-family="${FONT_FAMILY}" font-size="17" font-weight="400" fill="#E5EDF8">${escapeXml(summaryLine)}</text>
    ${buildPill({ x: 970, y: 34, width: 154, height: 40, fill: "#088A67", textFill: "#FFFFFF", text: "READY TO SHARE", fontSize: 14, weight: 800, rx: 20 })}
  </g>

  <g transform="translate(56,226)">
    <rect width="1088" height="108" rx="24" fill="#FFFFFF" stroke="#E4E8EE"/>
    <text x="26" y="35" font-family="${FONT_FAMILY}" font-size="24" font-weight="800" fill="#172033">${escapeXml(hotelTitle)}</text>
    <text x="26" y="60" font-family="${FONT_FAMILY}" font-size="16" font-weight="400" fill="#6D7D9A">Hotel-wise prices extracted from the uploaded screenshot</text>
    <g transform="translate(628,22)">
      ${buildPill({ x: 0, y: 0, width: 116, height: 32, fill: "url(#chipStay)", textFill: "#2653E4", text: city, fontSize: 12, weight: 800, rx: 16 })}
      ${buildPill({ x: 124, y: 0, width: 132, height: 32, fill: "#EEF1F6", textFill: "#222836", text: stayLabel, fontSize: 12, weight: 800, rx: 16 })}
      ${buildPill({ x: 264, y: 0, width: 156, height: 32, fill: "url(#chipBasis)", textFill: "#0C8A65", text: basisLabel, fontSize: 12, weight: 800, rx: 16 })}
    </g>
  </g>

  <g transform="translate(56,360)">
    <rect width="516" height="470" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="${FONT_FAMILY}" font-size="22" font-weight="800" fill="#1B2336">Hotel details</text>
    <text x="20" y="58" font-family="${FONT_FAMILY}" font-size="14" font-weight="400" fill="#65738E">The customer sees a clean summary without the internal markup split</text>
    ${detailCards.map((card, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      return buildMiniCard({
        x: col === 0 ? 16 : 256,
        y: 74 + row * 92,
        width: 224,
        height: 82,
        label: card.label,
        value: card.value,
        valueSize: card.label === "Price view" ? 19 : 18,
        maxLines: card.label === "Stay" || card.label === "Source" ? 2 : 1,
      });
    }).join("")}
    ${buildMiniCard({ x: 16, y: 350, width: 464, height: 82, label: "Customer view", value: "Hotel-wise final prices only", valueSize: 20, maxLines: 2 })}
  </g>

  <g transform="translate(600,360)">
    <rect width="544" height="396" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="${FONT_FAMILY}" font-size="22" font-weight="800" fill="#1B2336">Top hotel options</text>
    <text x="20" y="58" font-family="${FONT_FAMILY}" font-size="14" font-weight="400" fill="#65738E">Final quoted prices only</text>
    <g transform="translate(20,72)">
      ${optionRows || [0, 1, 2, 3].map((index) => buildOptionCard({
        x: 0,
        y: index * 80,
        width: 500,
        height: 64,
        title: DEFAULT_HOTELS[index] || `Hotel ${index + 1}`,
        roomType: "Room details",
        city,
        basis: basisLabel,
        price: formatCurrency(0, "INR"),
        nights: "",
      })).join("")}
    </g>
  </g>

  <g transform="translate(56,842)">
    <rect width="516" height="272" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="${FONT_FAMILY}" font-size="22" font-weight="800" fill="#1B2336">Stay notes</text>
    <text x="20" y="58" font-family="${FONT_FAMILY}" font-size="14" font-weight="400" fill="#65738E">Useful context for the operator before sharing the quote</text>
    ${DEFAULT_POLICY_NOTES.map((note, index) => `
      <g transform="translate(16,${72 + index * 42})">
        <rect width="484" height="30" rx="10" fill="#F8FAFC" stroke="#E1E5EA"/>
        <text x="14" y="20" font-family="${FONT_FAMILY}" font-size="12" font-weight="800" fill="#192236">${escapeXml(note.label)}</text>
        <text x="104" y="20" font-family="${FONT_FAMILY}" font-size="12" font-weight="400" fill="#525D74">${escapeXml(note.text)}</text>
      </g>
    `).join("")}
  </g>

  <g transform="translate(600,778)">
    <rect width="544" height="336" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="${FONT_FAMILY}" font-size="22" font-weight="800" fill="#1B2336">Share-ready notes</text>
    <text x="20" y="58" font-family="${FONT_FAMILY}" font-size="14" font-weight="400" fill="#65738E">The image stays customer-friendly while the pricing logic remains internal</text>
    ${policyRows.map((row, index) => `
      <g transform="translate(16,${72 + index * 56})">
        <rect width="512" height="40" rx="12" fill="#F8FAFC" stroke="#E1E5EA"/>
        <text x="14" y="25" font-family="${FONT_FAMILY}" font-size="13" font-weight="400" fill="#1B2336">${escapeXml(truncateText(row, 58))}</text>
      </g>
    `).join("")}
  </g>

  <g transform="translate(56,1224)">
    <rect width="1088" height="114" rx="24" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="24" y="36" font-family="${FONT_FAMILY}" font-size="19" font-weight="800" fill="#1B2336">Customer-ready hotel quotation</text>
    <text x="24" y="60" font-family="${FONT_FAMILY}" font-size="14" font-weight="400" fill="#65738E">Built from the uploaded screenshot with a clean hotel-wise layout and no customer-facing total.</text>
    ${buildPill({ x: 816, y: 22, width: 184, height: 32, fill: "#E0F3EC", textFill: "#0E8265", text: "Hotel-wise prices only", fontSize: 12, weight: 800, rx: 16 })}
  </g>
</svg>`;
}


