// Generic CRM address suggestions backed by Google Places Autocomplete (New).
// Kept separate from geocodeProxy.js so travel and wellness continue using
// the existing Photon/OpenStreetMap flow unchanged.

const https = require("https");

const GOOGLE_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const REQUEST_TIMEOUT_MS = 8000;

function parseGoogleSuggestions(data, limit = 6) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 10);
  return (data?.suggestions || [])
    .map((suggestion) => suggestion?.placePrediction)
    .filter((prediction) => prediction?.placeId && prediction?.text?.text)
    .slice(0, safeLimit)
    .map((prediction) => ({
      place_id: prediction.placeId,
      display_name: prediction.text.text,
      name: prediction.structuredFormat?.mainText?.text || "",
      secondary_text: prediction.structuredFormat?.secondaryText?.text || "",
      provider: "google",
    }));
}

function requestGoogleSuggestions(query, limit = 6, apiKey = "") {
  const input = String(query || "").trim();
  if (!input || !apiKey) return Promise.resolve([]);

  const body = JSON.stringify({
    input,
    languageCode: "en",
    includePureServiceAreaBusinesses: true,
  });

  return new Promise((resolve, reject) => {
    const request = https.request(
      GOOGLE_AUTOCOMPLETE_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
        },
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => { raw += chunk; });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            return reject(Object.assign(new Error(`Google address lookup HTTP ${response.statusCode}`), { status: 502 }));
          }
          try {
            resolve(parseGoogleSuggestions(JSON.parse(raw), limit));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(Object.assign(new Error("Google address lookup timeout"), { status: 504 }));
    });
    request.write(body);
    request.end();
  });
}

module.exports = {
  GOOGLE_AUTOCOMPLETE_URL,
  parseGoogleSuggestions,
  requestGoogleSuggestions,
};
