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
  kolkata: { label: "Kolkata", wikiTitle: "Kolkata", motif: "🌉", accent: "#1A6B8A", gradient: "linear-gradient(135deg,#0e4259,#1e7ea1)", aliases: ["kolkata", "calcutta"] },
  bangalore: { label: "Bangalore", wikiTitle: "Bangalore", motif: "🌿", accent: "#2E7D32", gradient: "linear-gradient(135deg,#1b4d1e,#3a9e40)", aliases: ["bangalore", "bengaluru"] },
  chennai: { label: "Chennai", wikiTitle: "Chennai", motif: "🏛️", accent: "#D4522A", gradient: "linear-gradient(135deg,#7a2f18,#d4522a)", aliases: ["chennai", "madras"] },
  hyderabad: { label: "Hyderabad", wikiTitle: "Hyderabad", motif: "🕌", accent: "#7B5EA7", gradient: "linear-gradient(135deg,#4a3564,#9b7ec8)", aliases: ["hyderabad"] },
  agra: { label: "Agra", wikiTitle: "Agra", motif: "🕌", accent: "#C49A2F", gradient: "linear-gradient(135deg,#7a5e1a,#c49a2f)", aliases: ["agra"] },
  amritsar: { label: "Amritsar", wikiTitle: "Amritsar", motif: "🛕", accent: "#C4922D", gradient: "linear-gradient(135deg,#7a5418,#c4922d)", aliases: ["amritsar"] },
  kerala: { label: "Kerala", wikiTitle: "Kerala", motif: "🌴", accent: "#1E8B4A", gradient: "linear-gradient(135deg,#0f5a2d,#28a35c)", aliases: ["kerala", "kochi", "cochin", "alleppey", "munnar", "trivandrum", "thiruvananthapuram"] },
  manali: { label: "Manali", wikiTitle: "Manali, Himachal Pradesh", motif: "🏔️", accent: "#4A86C8", gradient: "linear-gradient(135deg,#2a5180,#5a9ed8)", aliases: ["manali"] },
  shimla: { label: "Shimla", wikiTitle: "Shimla", motif: "🏔️", accent: "#5A7FAF", gradient: "linear-gradient(135deg,#334d6a,#6a90c8)", aliases: ["shimla"] },
  bangkok: { label: "Bangkok", wikiTitle: "Bangkok", motif: "🛕", accent: "#D4A017", gradient: "linear-gradient(135deg,#7a5c0e,#c49020)", aliases: ["bangkok", "thailand", "phuket", "chiangmai", "pattaya"] },
  mussoorie: { label: "Mussoorie", wikiTitle: "Mussoorie", motif: "🏔️", accent: "#5A7FAF", gradient: "linear-gradient(135deg,#334d6a,#6a90c8)", aliases: ["mussoorie", "masuri", "mussorie", "musooree"] },
  darjeeling: { label: "Darjeeling", wikiTitle: "Darjeeling", motif: "🍵", accent: "#3D7A3D", gradient: "linear-gradient(135deg,#1e4d1e,#4a9e4a)", aliases: ["darjeeling"] },
  nainital: { label: "Nainital", wikiTitle: "Nainital", motif: "🏔️", accent: "#1A7AA0", gradient: "linear-gradient(135deg,#0e4d66,#1e90bb)", aliases: ["nainital"] },
  udaipur: { label: "Udaipur", wikiTitle: "Udaipur", motif: "🏰", accent: "#A0522D", gradient: "linear-gradient(135deg,#5e2f18,#a0522d)", aliases: ["udaipur"] },
  australia: { label: "Australia", wikiTitle: "Sydney", motif: "🦘", accent: "#1A7A8E", gradient: "linear-gradient(135deg,#0e4d5f,#1e90a8)", aliases: ["australia", "sydney", "melbourne", "brisbane", "perth", "adelaide", "gold coast", "canberra"] },
  newzealand: { label: "New Zealand", wikiTitle: "New Zealand", motif: "🌿", accent: "#1A6B3A", gradient: "linear-gradient(135deg,#0e4024,#259954)", aliases: ["new zealand", "auckland", "wellington", "christchurch"] },
  canada: { label: "Canada", wikiTitle: "Canada", motif: "🍁", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a2418,#c0392b)", aliases: ["canada", "toronto", "vancouver", "montreal", "calgary"] },
  usa: { label: "USA", wikiTitle: "New York City", motif: "🗽", accent: "#2E5AAC", gradient: "linear-gradient(135deg,#1b3a6b,#3a6ea5)", aliases: ["usa", "united states", "america", "california", "florida", "las vegas"] },
  southafrica: { label: "South Africa", wikiTitle: "Cape Town", motif: "🌍", accent: "#2D8A4E", gradient: "linear-gradient(135deg,#1a5530,#3aac68)", aliases: ["south africa", "cape town", "johannesburg", "durban"] },
  egypt: { label: "Egypt", wikiTitle: "Giza Necropolis", motif: "🏺", accent: "#C49A2F", gradient: "linear-gradient(135deg,#7a5e1a,#c49a2f)", aliases: ["egypt", "cairo", "luxor", "aswan"] },
  greece: { label: "Greece", wikiTitle: "Santorini", motif: "🏛️", accent: "#1A6BA0", gradient: "linear-gradient(135deg,#0e4066,#1e88cc)", aliases: ["greece", "athens", "santorini", "mykonos", "thessaloniki"] },
  italy: { label: "Italy", wikiTitle: "Rome", motif: "🍕", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a2418,#c0392b)", aliases: ["italy", "rome", "milan", "florence", "venice", "naples"] },
  spain: { label: "Spain", wikiTitle: "Barcelona", motif: "🏖️", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a2418,#c0392b)", aliases: ["spain", "barcelona", "madrid", "seville", "malaga"] },
  switzerland: { label: "Switzerland", wikiTitle: "Switzerland", motif: "⛷️", accent: "#3A6EA5", gradient: "linear-gradient(135deg,#1b3a6b,#3a6ea5)", aliases: ["switzerland", "zurich", "geneva", "bern", "interlaken"] },
  germany: { label: "Germany", wikiTitle: "Germany", motif: "🏰", accent: "#2E5AAC", gradient: "linear-gradient(135deg,#1b3a6b,#3a6ea5)", aliases: ["germany", "berlin", "munich", "frankfurt", "hamburg"] },
  netherlands: { label: "Netherlands", wikiTitle: "Amsterdam", motif: "🌷", accent: "#E85D2B", gradient: "linear-gradient(135deg,#9a3618,#e85d2b)", aliases: ["netherlands", "holland", "amsterdam"] },
  portugal: { label: "Portugal", wikiTitle: "Lisbon", motif: "🏛️", accent: "#2E5AAC", gradient: "linear-gradient(135deg,#1b3a6b,#3a6ea5)", aliases: ["portugal", "lisbon", "porto"] },
  vietnam: { label: "Vietnam", wikiTitle: "Vietnam", motif: "🏮", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a2418,#c0392b)", aliases: ["vietnam", "hanoi", "ho chi minh", "da nang", "hoi an"] },
  cambodia: { label: "Cambodia", wikiTitle: "Angkor Wat", motif: "🛕", accent: "#C49A2F", gradient: "linear-gradient(135deg,#7a5e1a,#c49a2f)", aliases: ["cambodia", "siem reap", "phnom penh"] },
  nepal: { label: "Nepal", wikiTitle: "Nepal", motif: "🏔️", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a2418,#c0392b)", aliases: ["nepal", "kathmandu", "pokhara", "everest"] },
  srilanka: { label: "Sri Lanka", wikiTitle: "Sri Lanka", motif: "🌴", accent: "#1A6B3A", gradient: "linear-gradient(135deg,#0e4024,#259954)", aliases: ["sri lanka", "colombo", "kandy", "sigiriya"] },
  china: { label: "China", wikiTitle: "Great Wall of China", motif: "🏯", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a2418,#c0392b)", aliases: ["china", "beijing", "shanghai", "xi an", "xian", "guangzhou"] },
  southkorea: { label: "South Korea", wikiTitle: "Seoul", motif: "🏮", accent: "#3A6EA5", gradient: "linear-gradient(135deg,#1b3a6b,#3a6ea5)", aliases: ["south korea", "korea", "seoul", "busan", "jeju"] },
  russia: { label: "Russia", wikiTitle: "Moscow", motif: "🏰", accent: "#C0392B", gradient: "linear-gradient(135deg,#7a2418,#c0392b)", aliases: ["russia", "moscow", "saint petersburg", "st. petersburg"] },
  mexico: { label: "Mexico", wikiTitle: "Mexico City", motif: "🌮", accent: "#C49A2F", gradient: "linear-gradient(135deg,#7a5e1a,#c49a2f)", aliases: ["mexico", "mexico city", "cancun", "guadalajara"] },
  peru: { label: "Peru", wikiTitle: "Machu Picchu", motif: "🏔️", accent: "#2D8A4E", gradient: "linear-gradient(135deg,#1a5530,#3aac68)", aliases: ["peru", "lima", "cusco", "machu picchu"] },
  brazil: { label: "Brazil", wikiTitle: "Rio de Janeiro", motif: "🌴", accent: "#1A6B3A", gradient: "linear-gradient(135deg,#0e4024,#259954)", aliases: ["brazil", "rio", "sao paulo", "brasilia"] },
  argentina: { label: "Argentina", wikiTitle: "Buenos Aires", motif: "💃", accent: "#2E5AAC", gradient: "linear-gradient(135deg,#1b3a6b,#3a6ea5)", aliases: ["argentina", "buenos aires"] },
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
