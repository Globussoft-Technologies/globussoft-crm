import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { normalizeLeadAssistantText } = requireCjs("../../lib/leadAssistantText");

describe("lead assistant text normalization", () => {
  test.each([
    ["hii", "hi"],
    ["Hiiii", "hi"],
    ["helo there", "hello there"],
    ["show all leed", "show all lead"],
    ["leads with compny details", "leads with company details"],
    ["tell me the emial", "tell me the email"],
    ["show leads with filtre", "show leads with filter"],
  ])("corrects a command typo without changing the surrounding request: %s", (input, expected) => {
    expect(normalizeLeadAssistantText(input)).toBe(expected);
  });

  test("does not rewrite an ambiguous record word", () => {
    expect(normalizeLeadAssistantText("show Asha Rao's leads")).toBe("show Asha Rao's leads");
  });
});
