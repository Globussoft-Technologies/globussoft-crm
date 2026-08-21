function parseDetailsJson(detailsJson) {
  if (!detailsJson) return null;
  if (typeof detailsJson === "object") return detailsJson;
  try {
    const parsed = JSON.parse(String(detailsJson));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanPlace(value) {
  if (!value) return "";
  return String(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b[A-Z]{3}\b/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.\s-]+|[,.\s-]+$/g, "")
    .trim();
}

function normalizePlace(value) {
  return cleanPlace(value).toLowerCase();
}

function titleCaseWords(value) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => /^[A-Z0-9]/.test(word));
}

function splitCandidates(value) {
  return String(value)
    .split(/\s*(?:\band\b|\/|\bor\b|→|->|\||;)\s*/i)
    .map(cleanPlace)
    .filter(Boolean);
}

function trimNoise(value) {
  return cleanPlace(
    String(value || "")
      .replace(/\bfor shopping\b/gi, "")
      .replace(/\bfarewell dinner in\b/gi, "")
      .replace(/\blunch in\b/gi, "")
      .replace(/\bdinner in\b/gi, "")
      .replace(/\bbreakfast at\b/gi, "")
      .replace(/\bbreakfast in\b/gi, "")
      .replace(/\bstroll through\b/gi, "")
      .replace(/\bleisurely walk through\b/gi, "")
      .replace(/\bwalk through\b/gi, "")
      .replace(/\bexplore\b/gi, "")
      .replace(/\bvisit\b/gi, "")
      .replace(/\blocal transfer to\b/gi, "")
      .replace(/\bshared cab\/private taxi transfer from\b/gi, "")
      .replace(/\breturn flight from\b/gi, "")
      .replace(/\bflight from\b/gi, "")
      .replace(/\bto your hotel in\b/gi, "")
      .replace(/\byour\b/gi, "")
      .replace(/\bhotel\b/gi, "")
      .replace(/\bshopping\b/gi, "")
      .replace(/\bthe mystical\b/gi, "")
      .replace(/\ban ancient royal residence\b/gi, "")
      .replace(/\bunique wooden pagoda-style temple\b/gi, "")
      .replace(/\boffering breathtaking mountain views\b/gi, "")
      .replace(/\bknown for its panoramic views and adventure sports\b/gi, "")
      .replace(/\bweather permitting\b/gi, "")
      .replace(/\bif open and permits available\b/gi, "")
  );
}

// Common place-type nouns that are confident location signals on their own,
// even lowercase ("Goa beach", "hillside temple") — used both to short-
// circuit firstUsefulCandidate's search AND, below, to exempt those same
// candidates from the stricter title-case filter that guards the generic
// sentence-fallback branch (a lowercase common noun like "beach" is still a
// real place word; it just isn't a proper noun).
const STRONG_PLACE_KEYWORDS = /\b(temple|castle|gallery|road|pass|valley|tunnel|airport|village|fort|lake|beach)\b/i;

function firstUsefulCandidate(value, destination) {
  const normalizedDestination = normalizePlace(destination);
  const candidates = splitCandidates(trimNoise(value));
  for (const candidate of candidates) {
    const normalized = normalizePlace(candidate);
    if (!normalized) continue;
    if (isGenericPlaceLabel(candidate)) continue;
    if (STRONG_PLACE_KEYWORDS.test(candidate)) {
      return cleanPlace(candidate);
    }
    if (normalizedDestination && normalized.includes(normalizedDestination)) return cleanPlace(candidate);
    if (candidate.length >= 4) return cleanPlace(candidate);
  }
  return "";
}

function matchFirst(description, patterns, destination) {
  for (const pattern of patterns) {
    const match = pattern.exec(description);
    if (match?.[1]) {
      const candidate = firstUsefulCandidate(match[1], destination);
      if (candidate) return candidate;
    }
  }
  return "";
}

function isGenericPlaceLabel(value) {
  const normalized = normalizePlace(value);
  return [
    "",
    "hotel",
    "the hotel",
    "your hotel",
    "our hotel",
    "the airport",
    "your airport transfer",
    "shopping",
    "mountain views",
    "bohemian vibes",
  ].includes(normalized);
}

export function destinationGeoQueries(destination) {
  const raw = cleanPlace(destination);
  if (!raw) return [];
  const pieces = raw
    .split(/\s*(?:→|->|—|–|\/|\||;|\s-\s)\s*/g)
    .map(cleanPlace)
    .filter(Boolean);
  return pieces.length > 0 ? [...new Set(pieces)] : [raw];
}

export function deriveItineraryItemLocation(item, destination) {
  const details = parseDetailsJson(item?.detailsJson);
  const storedLocation = cleanPlace(details?.locationName);
  if (storedLocation) return storedLocation;

  const description = String(item?.description || "").trim();
  const cleanDestination = cleanPlace(destination);
  if (!description) return cleanDestination;

  const directPlace = matchFirst(description, [
    /\bvisit\s+([^,.]+)/i,
    /\bexplore\s+([^,.]+)/i,
    /\bexcursion to\s+([^.,]+)[,.]?\s*$/i,
    /\bthrough\s+([^,.]+)/i,
    /\byour hotel in\s+([^.,]+)[,.]?\s*$/i,
    /\bhotel in\s+([^.,]+)[,.]?\s*$/i,
    /\bstay at .*? in\s+([^.,]+)[,.]?\s*$/i,
    /\bdinner back in\s+([^.,]+)[,.]?\s*$/i,
    /\blunch in\s+([^.,]+)[,.]?\s*$/i,
    /\bdinner in\s+([^.,]+)[,.]?\s*$/i,
    /\bfrom\s+.+?\bto\s+([^.,]+)[,.]?\s*$/i,
    /\bto\s+([^.,]+)[,.]?\s*$/i,
  ], cleanDestination);
  if (directPlace) return directPlace;

  const airportMatch = matchFirst(description, [
    /\bto\s+([^.,]+?\bAirport\b[^.,]*)/i,
    /\bfrom\s+([^.,]+?\bAirport\b[^.,]*)/i,
    /\b([A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&().-]*)*\s+Airport\b[^.,]*)/,
  ], cleanDestination);
  if (airportMatch) return airportMatch;

  const placeFromSentence = description
    .split(/[.!?]/)
    .map((part) => trimNoise(part))
    .map((part) => firstUsefulCandidate(part, cleanDestination))
    .find((part) => part && (titleCaseWords(part) || STRONG_PLACE_KEYWORDS.test(part)));
  if (placeFromSentence) return placeFromSentence;

  return cleanDestination;
}

export function buildItineraryGeocodeQuery(item, destination) {
  const location = deriveItineraryItemLocation(item, destination);
  const cleanDestination = cleanPlace(destination);
  if (!location) return cleanDestination;

  const normalizedLocation = normalizePlace(location);
  const normalizedDestination = normalizePlace(cleanDestination);
  if (!normalizedDestination || normalizedLocation.includes(normalizedDestination)) {
    return location;
  }
  return `${location} ${cleanDestination}`.trim();
}

export function haversineDistanceKm(aLat, aLng, bLat, bLng) {
  const lat1 = Number(aLat);
  const lng1 = Number(aLng);
  const lat2 = Number(bLat);
  const lng2 = Number(bLng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const aa =
    sinLat * sinLat +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return 6371 * c;
}

export function shouldReplaceSuspiciousCoordinates(savedLat, savedLng, resolvedLat, resolvedLng) {
  const distanceKm = haversineDistanceKm(savedLat, savedLng, resolvedLat, resolvedLng);
  return Number.isFinite(distanceKm) && distanceKm > 150;
}
