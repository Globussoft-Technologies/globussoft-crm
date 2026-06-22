// Destination-aware visual theme for public travel pages (itinerary share,
// microsite). Pure + deterministic so it's unit-testable. Provides the
// non-photo theming (cultural motif, accent colour, gradient) plus the
// Wikipedia article title used to fetch a real destination photo (the actual
// image fetch lives in utils/destinationPhotos.js — keyless via the Wikipedia
// API). Photo source note: an earlier keyless image CDN (LoremFlickr) returned
// 403, so photos now come from Wikipedia.
//
// Returns { key, label, motif, accent, gradient, wikiTitle }.

// Small stable string hash → unsigned int (for the fallback hue).
function hashInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Curated destinations. `aliases` are matched as substrings of the normalized
// destination, so "Paris, France" and "Varanasi (Banaras)" both resolve.
// `wikiTitle` is the Wikipedia article title for the photo lookup (only set
// when it differs from a simple title-case of the destination).
const CURATED = {
  paris: { label: "Paris", wikiTitle: "Paris", motif: "🗼", accent: "#2E5AAC", gradient: "linear-gradient(135deg,#1b3a6b,#3a6ea5)", aliases: ["paris"] },
  varanasi: { label: "Varanasi", wikiTitle: "Varanasi", motif: "🛕", accent: "#C4622D", gradient: "linear-gradient(135deg,#7a3b12,#c4622d)", aliases: ["varanasi", "banaras", "banarash", "benares", "kashi"] },
  dubai: { label: "Dubai", wikiTitle: "Dubai", motif: "🕌", accent: "#C89A4E", gradient: "linear-gradient(135deg,#8a6d2f,#d9b15e)", aliases: ["dubai", "abu dhabi", "uae"] },
  london: { label: "London", wikiTitle: "London", motif: "🎡", accent: "#3D4C7A", gradient: "linear-gradient(135deg,#2a3354,#56689e)", aliases: ["london", "united kingdom", "uk"] },
  goa: { label: "Goa", wikiTitle: "Goa", motif: "🏖️", accent: "#1FA3A3", gradient: "linear-gradient(135deg,#0e6e6e,#2bbcb0)", aliases: ["goa"] },
  makkah: { label: "Makkah", wikiTitle: "Mecca", motif: "🕋", accent: "#1F6E4A", gradient: "linear-gradient(135deg,#123f2c,#2a8a5c)", aliases: ["makkah", "mecca", "makka", "umrah", "hajj"] },
  madinah: { label: "Madinah", wikiTitle: "Medina", motif: "🕌", accent: "#2C7A6B", gradient: "linear-gradient(135deg,#194a42,#36988a)", aliases: ["madinah", "medina", "madina"] },
  mumbai: { label: "Mumbai", wikiTitle: "Mumbai", motif: "🌆", accent: "#9A4E8E", gradient: "linear-gradient(135deg,#5e2f57,#b15ea3)", aliases: ["mumbai", "bombay"] },
  delhi: { label: "Delhi", wikiTitle: "Delhi", motif: "🏛️", accent: "#B5482F", gradient: "linear-gradient(135deg,#6e2a1b,#c4583b)", aliases: ["delhi", "new delhi"] },
  jaipur: { label: "Jaipur", wikiTitle: "Jaipur", motif: "🏰", accent: "#D06A3F", gradient: "linear-gradient(135deg,#8a3f1f,#e0824e)", aliases: ["jaipur", "rajasthan"] },
  bali: { label: "Bali", wikiTitle: "Bali", motif: "🌴", accent: "#1F9E6B", gradient: "linear-gradient(135deg,#0f6a45,#2bbf83)", aliases: ["bali", "indonesia"] },
  singapore: { label: "Singapore", wikiTitle: "Singapore", motif: "🦁", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a241b,#d14a3a)", aliases: ["singapore"] },
  maldives: { label: "Maldives", wikiTitle: "Maldives", motif: "🏝️", accent: "#1597B8", gradient: "linear-gradient(135deg,#0b5f76,#27aecb)", aliases: ["maldives"] },
  istanbul: { label: "Istanbul", wikiTitle: "Istanbul", motif: "🕌", accent: "#9B59B6", gradient: "linear-gradient(135deg,#5e2f6e,#a866c0)", aliases: ["istanbul", "turkey", "turkiye"] },
  tokyo: { label: "Tokyo", wikiTitle: "Tokyo", motif: "🗾", accent: "#D14A6A", gradient: "linear-gradient(135deg,#5e2438,#c0405e)", aliases: ["tokyo", "japan", "kyoto", "osaka"] },
  newyork: { label: "New York", wikiTitle: "New York City", motif: "🗽", accent: "#34495E", gradient: "linear-gradient(135deg,#222f3d,#4a6078)", aliases: ["new york", "nyc", "manhattan"] },
};

function resolveKey(norm) {
  if (!norm) return null;
  for (const [key, entry] of Object.entries(CURATED)) {
    if (entry.aliases.some((a) => norm.includes(a))) return key;
  }
  return null;
}

/**
 * Resolve a destination string to a visual theme. Always returns a usable
 * object — unknown destinations get a deterministic generated theme.
 */
export function destinationTheme(destinationRaw) {
  const norm = normalize(destinationRaw);
  const key = resolveKey(norm);

  if (key) {
    const e = CURATED[key];
    return { key, label: e.label, motif: e.motif, accent: e.accent, gradient: e.gradient, wikiTitle: e.wikiTitle };
  }

  const seed = norm || "travel";
  const hue = hashInt(seed) % 360;
  return {
    key: null,
    label: destinationRaw || "Your trip",
    motif: "✈️",
    accent: `hsl(${hue},58%,42%)`,
    gradient: `linear-gradient(135deg,hsl(${hue},52%,28%),hsl(${(hue + 45) % 360},58%,44%))`,
    wikiTitle: null, // resolver falls back to the cleaned destination string
  };
}

export default destinationTheme;
