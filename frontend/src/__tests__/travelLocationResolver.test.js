import { describe, expect, test, vi } from "vitest";
import {
  buildItineraryGeocodeQuery,
  deriveItineraryItemLocation,
  destinationGeoQueries,
  haversineDistanceKm,
  isCoordinateNearAnyAnchor,
  resolveItineraryMapItems,
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

  test("validates map pins against destination anchors", () => {
    const goa = [{ lat: 15.2993, lng: 74.1240 }];
    expect(isCoordinateNearAnyAnchor(15.5553, 73.7517, goa)).toBe(true);
    expect(isCoordinateNearAnyAnchor(6.5244, 3.3792, goa)).toBe(false);
    expect(isCoordinateNearAnyAnchor(15.5553, 73.7517, [])).toBe(false);
  });

  describe("resolveItineraryMapItems", () => {
    const goa = { lat: 15.2993, lng: 74.124 };

    test("keeps manual coordinates even when they are far from the destination", async () => {
      const manualItem = {
        id: 1,
        description: "Regional airport transfer",
        latitude: 6.5244,
        longitude: 3.3792,
        draftedByAi: false,
      };
      const geocodePlace = vi.fn().mockResolvedValue(goa);

      const result = await resolveItineraryMapItems({
        items: [manualItem], destination: "Goa", geocodePlace,
      });

      expect(result).toEqual([manualItem]);
      expect(geocodePlace).toHaveBeenCalledTimes(1);
    });

    test("uses a nearby repair for an AI outlier without changing the source item", async () => {
      const aiItem = {
        id: 2,
        description: "Visit Baga Beach",
        latitude: 6.5244,
        longitude: 3.3792,
        draftedByAi: true,
      };
      const geocodePlace = vi.fn()
        .mockResolvedValueOnce(goa)
        .mockResolvedValueOnce({ lat: 15.5553, lng: 73.7517 });

      const result = await resolveItineraryMapItems({
        items: [aiItem], destination: "Goa", geocodePlace,
      });

      expect(result[0]).toMatchObject({ latitude: 15.5553, longitude: 73.7517 });
      expect(aiItem).toMatchObject({ latitude: 6.5244, longitude: 3.3792 });
    });

    test("keeps the saved AI pin when repair fails", async () => {
      const aiItem = {
        id: 3,
        description: "Unknown stop",
        latitude: 6.5244,
        longitude: 3.3792,
        draftedByAi: true,
      };
      const geocodePlace = vi.fn()
        .mockResolvedValueOnce(goa)
        .mockResolvedValueOnce(null);

      await expect(resolveItineraryMapItems({
        items: [aiItem], destination: "Goa", geocodePlace,
      })).resolves.toEqual([aiItem]);
    });

    test("stops after cancellation and does not return stale results", async () => {
      let cancelled = false;
      const aiItem = {
        id: 4,
        description: "Visit Baga Beach",
        latitude: 6.5244,
        longitude: 3.3792,
        draftedByAi: true,
      };
      const geocodePlace = vi.fn()
        .mockResolvedValueOnce(goa)
        .mockImplementationOnce(async () => {
          cancelled = true;
          return { lat: 15.5553, lng: 73.7517 };
        });

      const result = await resolveItineraryMapItems({
        items: [aiItem],
        destination: "Goa",
        geocodePlace,
        isCancelled: () => cancelled,
      });

      expect(result).toBeNull();
    });

    test("caps automatic repair requests for large itineraries", async () => {
      const items = Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        description: `Stop ${index + 1}`,
        latitude: 6.5244,
        longitude: 3.3792,
        draftedByAi: true,
      }));
      const geocodePlace = vi.fn().mockResolvedValue(goa);

      const result = await resolveItineraryMapItems({
        items, destination: "Goa", geocodePlace, maxRepairs: 3,
      });

      expect(result).toHaveLength(12);
      expect(geocodePlace).toHaveBeenCalledTimes(4); // one anchor + three repairs
    });
  });
});
