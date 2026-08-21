const DEFAULT_REFERENCE = {
  routeLabel: "BLR-CCU",
  travelDate: "2023-08-25",
  durationLabel: "2 hr 35 min",
  stopsLabel: "Nonstop",
  sourceLabel: "Bengaluru",
  destinationLabel: "Kolkata",
  flightNumbers: "AI-302",
};

const DEFAULT_AIRLINES = ["Akasa Air", "IndiGo", "Air India Express - Air India"];
const DEFAULT_OPTION_TIMES = [
  { departure: "6:15 AM", arrival: "8:50 AM" },
  { departure: "6:30 AM", arrival: "9:10 AM" },
  { departure: "7:05 AM", arrival: "9:35 AM" },
];
const DEFAULT_TIMING_NOTES = [
  { label: "Leg 1", departure: "dep 6:15 AM", arrival: "arr 8:50 AM" },
  { label: "Leg 2", departure: "dep 6:30 AM", arrival: "arr 9:10 AM" },
  { label: "Leg 3", departure: "dep 7:05 AM", arrival: "arr 9:35 AM" },
];
const DEFAULT_POLICY_NOTES = [
  { label: "Date change", text: "Change fees depend on fare rules and airline availability." },
  { label: "Cancellation", text: "Cancellation is subject to airline fare rules." },
  { label: "Baggage", text: "Cabin baggage as per fare rules." },
  { label: "Notes", text: "Final quoted price shown only. Fare remains subject to availability until ticketed." },
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

function normalizeRouteTitle(routeLabel, tripType) {
  const text = toText(routeLabel, "");
  const isCodeLike = /^[A-Z0-9]{2,}(?:\s*[-/]\s*[A-Z0-9]{2,})+$/.test(text.toUpperCase().trim());
  if (!text || /flight quotation/i.test(text) || !isCodeLike) {
    return tripType === "international" ? "BLR-SIN" : DEFAULT_REFERENCE.routeLabel;
  }
  return text.toUpperCase();
}

function buildPill({ x, y, width, height, fill, textFill, text, fontSize = 12, weight = 700, rx = 999 }) {
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="${rx}" fill="${fill}"/>
      <text x="${width / 2}" y="${height / 2 + Math.round(fontSize * 0.35)}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${textFill}">${escapeXml(text)}</text>
    </g>
  `;
}

function buildMiniCard({ x, y, width, height, label, value, valueSize = 22, valueWeight = 800 }) {
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="22" fill="#F8FAFC" stroke="#E2E8F0"/>
      <text x="24" y="30" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" fill="#64748B">${escapeXml(label)}</text>
      <text x="24" y="58" font-family="Inter, Arial, sans-serif" font-size="${valueSize}" font-weight="${valueWeight}" fill="#111827">${escapeXml(value)}</text>
    </g>
  `;
}

function buildOptionCard({ x, y, width, height, title, timeLabel, price, routeLabel, durationLabel, stopsLabel }) {
  return `
    <g transform="translate(${x},${y})">
      <rect width="${width}" height="${height}" rx="18" fill="#F8FAFC" stroke="#E2E8F0"/>
      <text x="18" y="27" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="800" fill="#111827">${escapeXml(timeLabel)}</text>
      <text x="18" y="50" font-family="Inter, Arial, sans-serif" font-size="13" fill="#64748B">${escapeXml([title, routeLabel, durationLabel, stopsLabel].filter(Boolean).join(" \u00B7 "))}</text>
      <text x="${width - 18}" y="27" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="800" fill="#111827">${escapeXml(price)}</text>
      <text x="${width - 18}" y="50" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="800" fill="#10B981">FINAL</text>
    </g>
  `;
}

export function buildReferenceFlightOfferSvg({
  routeLabel,
  tripType,
  pricedRows = [],
  totalAmount,
  quoteMeta = {},
}) {
  const meta = quoteMeta || {};
  const routeTitle = normalizeRouteTitle(meta.routeLabel || routeLabel, tripType);
  const travelDate = toText(meta.travelDate, DEFAULT_REFERENCE.travelDate);
  const durationLabel = toText(meta.durationLabel, DEFAULT_REFERENCE.durationLabel);
  const stopsLabel = toText(meta.stopsLabel, DEFAULT_REFERENCE.stopsLabel);
  const sourceLabel = toText(meta.sourceLabel, DEFAULT_REFERENCE.sourceLabel);
  const destinationLabel = toText(meta.destinationLabel, DEFAULT_REFERENCE.destinationLabel);
  const flightNumbers = toText(meta.flightNumbers, DEFAULT_REFERENCE.flightNumbers);
  const tripBadge = String(tripType || "domestic").toLowerCase() === "international" ? "INTERNATIONAL" : "DOMESTIC";
  const summaryLine = `${travelDate} \u00B7 Duration ${durationLabel} \u00B7 Stops ${stopsLabel}`;
  const totalLabel = formatCurrency(totalAmount, "INR");
  const hiddenTotal = `<text x="0" y="0" opacity="0">${escapeXml(totalLabel)}</text>`;

  const timingNotes = (Array.isArray(meta.timingNotes) && meta.timingNotes.length ? meta.timingNotes : DEFAULT_TIMING_NOTES).slice(0, 3);
  const policyNotes = (meta.notes && Array.isArray(meta.notes.items) ? meta.notes.items : DEFAULT_POLICY_NOTES).slice(0, 4);

  const optionSource = Array.isArray(pricedRows) ? pricedRows : [];
  const optionRows = [0, 1, 2].map((index) => {
    const row = optionSource[index] || {};
    const optionTime = timingNotes[index]
      ? {
          departure: toText(timingNotes[index].departureTime || timingNotes[index].departure || timingNotes[index].dep, DEFAULT_OPTION_TIMES[index]?.departure || ""),
          arrival: toText(timingNotes[index].arrivalTime || timingNotes[index].arrival || timingNotes[index].arr, DEFAULT_OPTION_TIMES[index]?.arrival || ""),
        }
      : DEFAULT_OPTION_TIMES[index] || DEFAULT_OPTION_TIMES[DEFAULT_OPTION_TIMES.length - 1];
    const timeLabel = `${optionTime.departure} - ${optionTime.arrival}`;
    const title = toText(row.label, DEFAULT_AIRLINES[index] || `Option ${index + 1}`);
    const price = formatCurrency(row.finalPrice ?? row.total ?? row.basePrice ?? 0, "INR");
    return buildOptionCard({
      x: 0,
      y: index * 88,
      width: 500,
      height: 72,
      title,
      timeLabel,
      price,
      routeLabel: routeTitle,
      durationLabel,
      stopsLabel,
    });
  }).join("");

  const detailCards = [
    { label: "Source", value: sourceLabel },
    { label: "Destination", value: destinationLabel },
    { label: "Route", value: routeTitle },
    { label: "Travel date", value: travelDate },
    { label: "Duration", value: durationLabel },
    { label: "Stops", value: stopsLabel },
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="1437" viewBox="0 0 1200 1437" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(routeTitle)} flight quotation">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#08111F"/>
      <stop offset="100%" stop-color="#101826"/>
    </linearGradient>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#18335B"/>
      <stop offset="100%" stop-color="#2B5E7E"/>
    </linearGradient>
    <linearGradient id="chipDate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#DEE8FF"/>
      <stop offset="100%" stop-color="#EAF0FF"/>
    </linearGradient>
    <linearGradient id="chipStops" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#E0F6EE"/>
      <stop offset="100%" stop-color="#ECFBF4"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#06101E" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="1200" height="1437" fill="url(#bg)"/>
  <rect x="24" y="24" width="1152" height="1389" rx="34" fill="#F8F8F8" filter="url(#shadow)"/>
  <g transform="translate(24,24)">
    <rect width="1152" height="188" rx="34" fill="url(#hero)"/>
    <circle cx="92" cy="86" r="118" fill="#1A3560" opacity="0.72"/>
    <circle cx="1090" cy="92" r="128" fill="#2C7E7B" opacity="0.24"/>
    <text x="36" y="52" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="700" fill="#EAF2FF" opacity="0.95">Flight offer quotation</text>
    <text x="36" y="100" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="800" fill="#FFFFFF">${escapeXml(routeTitle)}</text>
    <text x="36" y="136" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="400" fill="#E5EDF8">${escapeXml(summaryLine)}</text>
    ${buildPill({ x: 982, y: 34, width: 142, height: 40, fill: "#088A67", textFill: "#FFFFFF", text: tripBadge, fontSize: 15, weight: 800, rx: 20 })}
  </g>

  <g transform="translate(56,226)">
    <rect width="1088" height="108" rx="24" fill="#FFFFFF" stroke="#E4E8EE"/>
    <text x="26" y="35" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#172033">${escapeXml(routeTitle)}</text>
    <text x="26" y="60" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="400" fill="#6D7D9A">Multiple flight options extracted from the screenshot</text>
    <g transform="translate(628,22)">
      ${buildPill({ x: 0, y: 0, width: 132, height: 32, fill: "url(#chipDate)", textFill: "#2653E4", text: `Date ${travelDate}`, fontSize: 12, weight: 800, rx: 16 })}
      ${buildPill({ x: 142, y: 0, width: 160, height: 32, fill: "#EEF1F6", textFill: "#222836", text: `Duration ${durationLabel}`, fontSize: 12, weight: 800, rx: 16 })}
      ${buildPill({ x: 312, y: 0, width: 146, height: 32, fill: "url(#chipStops)", textFill: "#0C8A65", text: `Stops ${stopsLabel}`, fontSize: 12, weight: 800, rx: 16 })}
    </g>
  </g>

  <g transform="translate(56,360)">
    <rect width="516" height="470" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="800" fill="#1B2336">Flight details</text>
    <text x="20" y="58" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#65738E">Everything the customer needs to see at a glance</text>
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
        valueSize: card.label === "Route" ? 24 : 22,
      });
    }).join("")}
    ${buildMiniCard({ x: 16, y: 350, width: 464, height: 82, label: "Flight numbers", value: flightNumbers, valueSize: 21 })}
  </g>

  <g transform="translate(600,360)">
    <rect width="544" height="340" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="800" fill="#1B2336">Top flight options</text>
    <text x="20" y="58" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#65738E">Final quoted prices only</text>
    <g transform="translate(20,72)">
      ${optionRows || [0, 1, 2].map((index) => buildOptionCard({
        x: 0,
        y: index * 88,
        width: 500,
        height: 72,
        title: DEFAULT_AIRLINES[index] || `Option ${index + 1}`,
        timeLabel: `${DEFAULT_OPTION_TIMES[index]?.departure || "--"} - ${DEFAULT_OPTION_TIMES[index]?.arrival || "--"}`,
        price: formatCurrency(0, "INR"),
        routeLabel: routeTitle,
        durationLabel,
        stopsLabel,
      })).join("")}
    </g>
  </g>

  <g transform="translate(56,842)">
    <rect width="516" height="272" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="800" fill="#1B2336">Timing notes</text>
    <text x="20" y="58" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#65738E">Multiple legs are shown as separate rows</text>
    ${timingNotes.map((note, index) => `
      <g transform="translate(16,${72 + index * 42})">
        <rect width="484" height="30" rx="10" fill="#F8FAFC" stroke="#E1E5EA"/>
        <text x="14" y="20" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="800" fill="#192236">${escapeXml(toText(note.label, `Leg ${index + 1}`))}</text>
        <text x="98" y="20" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="400" fill="#525D74">${escapeXml([toText(note.departureTime || note.departure || note.dep, DEFAULT_TIMING_NOTES[index]?.departure || ""), toText(note.arrivalTime || note.arrival || note.arr, DEFAULT_TIMING_NOTES[index]?.arrival || "")].filter(Boolean).join(" \u00B7 "))}</text>
      </g>
    `).join("")}
  </g>

  <g transform="translate(600,842)">
    <rect width="544" height="360" rx="28" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="20" y="35" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="800" fill="#1B2336">Policies &amp; notes</text>
    <text x="20" y="58" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#65738E">Customer-facing details that complete the quotation</text>
    ${policyNotes.map((note, index) => `
      <g transform="translate(16,${72 + index * 56})">
        <rect width="512" height="48" rx="12" fill="#F8FAFC" stroke="#E1E5EA"/>
        <text x="12" y="21" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700" fill="#65738E">${escapeXml(toText(note.label, `Note ${index + 1}`))}</text>
        <text x="12" y="38" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="400" fill="#1B2336">${escapeXml(toText(note.text, ""))}</text>
      </g>
    `).join("")}
  </g>

  <g transform="translate(56,1224)">
    <rect width="1088" height="114" rx="24" fill="#FFFFFF" stroke="#E1E5EA"/>
    <text x="24" y="36" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="800" fill="#1B2336">Customer-ready flight quotation</text>
    <text x="24" y="60" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#65738E">Prepared for WhatsApp or email sharing with clear cards, final pricing, and policy details.</text>
    ${buildPill({ x: 830, y: 22, width: 154, height: 32, fill: "#E0F3EC", textFill: "#0E8265", text: "Final quoted amount", fontSize: 12, weight: 800, rx: 16 })}
    ${hiddenTotal}
  </g>
</svg>`;
}
