import { describe, expect, test } from "vitest";

const {
  requiredKeysForModel,
  buildNotConfiguredMessage,
  buildTravelAiErrorResponse,
} = require("../../lib/travelAiError");

describe("travelAiError", () => {
  test("maps Gemini models to GEMINI_API_KEY", () => {
    expect(requiredKeysForModel("gemini-flash")).toEqual(["GEMINI_API_KEY"]);
  });

  test("builds a travel-specific not-configured message", () => {
    expect(
      buildNotConfiguredMessage({
        featureLabel: "Itinerary AI suggestions",
        modelLabel: "gemini-flash",
      }),
    ).toContain("Set GEMINI_API_KEY");
  });

  test("returns a 403 AI_NOT_CONFIGURED envelope with required keys", () => {
    const response = buildTravelAiErrorResponse(
      { code: "AI_NOT_CONFIGURED" },
      {
        featureLabel: "Marketing flyer AI image generation",
        modelLabel: "dall-e-3",
      },
    );
    expect(response).toEqual({
      status: 403,
      body: {
        error:
          "Marketing flyer AI image generation is unavailable because AI keys are not configured. Set OPENAI_API_KEY and try again.",
        code: "AI_NOT_CONFIGURED",
        requiredKeys: ["OPENAI_API_KEY"],
      },
    });
  });
});
