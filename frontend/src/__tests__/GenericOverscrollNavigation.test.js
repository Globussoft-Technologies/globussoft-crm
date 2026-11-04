import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

describe("Generic CRM viewport overscroll", () => {
  it("blocks horizontal browser-history gestures on both document roots", () => {
    expect(css).toMatch(
      /html\[data-vertical="generic"\],\s*body\[data-vertical="generic"\]\s*\{\s*overscroll-behavior-x:\s*none;/,
    );
  });

  it("does not apply the viewport history guard to other verticals", () => {
    expect(css).not.toMatch(
      /(?:html|body)\[data-vertical="(?:wellness|travel)"\][^{]*\{[^}]*overscroll-behavior-x:\s*none;/,
    );
  });
});
