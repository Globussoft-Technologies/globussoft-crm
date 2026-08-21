import { describe, expect, test } from "vitest";
import {
  buildItineraryGeocodeQuery,
  deriveItineraryItemLocation,
  destinationGeoQueries,
  haversineDistanceKm,
  shouldReplaceSuspiciousCoordinates,
} from "../lib/travelLocationResolver";

describe("travelLocationResolver", () => {
  test("keeps multi-word destinations intact", () => {
    expect(destinationGeoQueries("Delhi - Agra - Jaipur")).toEqual([
      "Delhi",
      "Agra",
      "Jaipur",
    ]);
    expect(destinationGeoQueries("Manali")).toEqual(["Manali"]);
  });

  test("prefers stored locationName from detailsJson", () => {
    expect(
      deriveItineraryItemLocation(
        {
          description: "Leisurely walk through Old Manali village.",
          detailsJson: JSON.stringify({ locationName: "Old Manali" }),
        },
        "Manali",
      ),
    ).toBe("Old Manali");
  });

  test("extracts destination-side place from transport descriptions", () => {
    expect(
      deriveItineraryItemLocation(
        {
          description: "Shared cab/private taxi transfer from Kullu Airport to your hotel in Manali.",
        },
        "Manali",
      ),
    ).toBe("Manali");

    expect(
      deriveItineraryItemLocation(
        {
          description: "Return flight from Kullu (Bhuntar Airport - KUU) to Bengaluru.",
        },
        "Manali",
      ),
    ).toBe("Bengaluru");
  });

  test("falls back to destination instead of geocoding vague sentences", () => {
    expect(
      deriveItineraryItemLocation(
        { description: "Breakfast at the hotel." },
        "Manali",
      ),
    ).toBe("Manali");
  });

  test("extracts a clean anchor from compound sightseeing text", () => {
    expect(
      deriveItineraryItemLocation(
        {
          description:
            "Visit the mystical Hadimba Devi Temple, unique wooden pagoda-style temple, and stroll through Manali's Mall Road for shopping.",
        },
        "Manali",
      ),
    ).toBe("Hadimba Devi Temple");

    expect(
      deriveItineraryItemLocation(
        {
          description:
            "Lunch in Naggar/Kullu and a farewell dinner in Manali.",
        },
        "Manali",
      ),
    ).toBe("Naggar");
  });

  test("builds destination-aware geocode queries", () => {
    expect(
      buildItineraryGeocodeQuery(
        { description: "Local transfer to Naggar Castle and Hadimba Temple." },
        "Manali",
      ),
    ).toBe("Naggar Castle Manali");

    expect(
      buildItineraryGeocodeQuery(
        { description: "Breakfast at the hotel." },
        "Manali",
      ),
    ).toBe("Manali");
  });

  test("flags far-away saved coordinates as suspicious", () => {
    expect(haversineDistanceKm(32.2432, 77.1892, 32.2396, 77.1887)).toBeLessThan(2);
    expect(
      shouldReplaceSuspiciousCoordinates(19.4326, -99.1332, 12.9716, 77.5946),
    ).toBe(true);
    expect(
      shouldReplaceSuspiciousCoordinates(32.2432, 77.1892, 32.2396, 77.1887),
    ).toBe(false);
  });
});
