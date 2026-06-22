// Unit tests for lib/airportResolver.js — city/airport name → IATA. NODE_ENV=
// 'test' makes llmRouter stub, so the LLM branch is a no-op and resolution
// relies on the IATA-code passthrough + static alias map (the no-key demo path).

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const { resolveToIata, isIataCode } = requireCJS("../../lib/airportResolver");

describe("isIataCode", () => {
  it("accepts 3 letters, rejects everything else", () => {
    expect(isIataCode("DEL")).toBe(true);
    expect(isIataCode("del")).toBe(true);
    expect(isIataCode("Delhi")).toBe(false);
    expect(isIataCode("DE")).toBe(false);
    expect(isIataCode("")).toBe(false);
  });
});

describe("resolveToIata", () => {
  it("passes through an IATA code (uppercased)", async () => {
    expect(await resolveToIata("blr")).toEqual({ iata: "BLR", source: "code" });
    expect(await resolveToIata("  JED ")).toEqual({ iata: "JED", source: "code" });
  });

  it("resolves common city names via the static map (case-insensitive)", async () => {
    expect((await resolveToIata("Delhi")).iata).toBe("DEL");
    expect((await resolveToIata("new delhi")).iata).toBe("DEL");
    expect((await resolveToIata("Bengaluru")).iata).toBe("BLR");
    expect((await resolveToIata("Bangalore")).iata).toBe("BLR");
    expect((await resolveToIata("Jeddah")).iata).toBe("JED");
    expect((await resolveToIata("Madinah")).iata).toBe("MED");
    expect((await resolveToIata("mumbai")).source).toBe("map");
  });

  it("returns null for an unknown place when no LLM key (stub mode)", async () => {
    expect(await resolveToIata("Some Tiny Village Nobody Knows")).toBe(null);
    expect(await resolveToIata("")).toBe(null);
  });
});
