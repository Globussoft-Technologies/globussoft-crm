import { describe, expect, test } from "vitest";
import { readableForegroundColor } from "../utils/colorContrast";

describe("readableForegroundColor", () => {
  test("uses a dark foreground on the light local accent", () => {
    expect(readableForegroundColor("#C8EF24")).toBe("#122647");
  });

  test("uses a light foreground on a saturated live blue accent", () => {
    expect(readableForegroundColor("#403BE3")).toBe("#FFFFFF");
  });

  test("accepts rgb values returned by a brand configuration", () => {
    expect(readableForegroundColor("rgb(200, 154, 78)")).toBe("#122647");
  });
});
