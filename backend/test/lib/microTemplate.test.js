// microTemplate — the logic-less renderer behind HTML itinerary templates.
//
// These templates are drafted by an LLM and edited by non-engineers, so the
// contract that matters is: interpolate and loop correctly, escape by default,
// and fail loudly on malformed input rather than emitting half a page. Each
// test below pins one of those.

import { describe, it, expect } from "vitest";

const { renderTemplate, escapeHtml } = require("../../lib/microTemplate");

describe("microTemplate", () => {
  describe("interpolation", () => {
    it("escapes by default so itinerary text cannot inject markup", () => {
      expect(renderTemplate("<p>{{x}}</p>", { x: '<img src=x onerror="alert(1)">' })).toBe(
        "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
      );
    });

    it("emits raw HTML only for the explicit triple-brace form", () => {
      expect(renderTemplate("{{{x}}}", { x: "<b>hi</b>" })).toBe("<b>hi</b>");
    });

    it("renders a missing key as empty rather than 'undefined'", () => {
      expect(renderTemplate("a{{nope}}b", {})).toBe("ab");
    });

    it("resolves dotted paths", () => {
      expect(renderTemplate("{{a.b.c}}", { a: { b: { c: "deep" } } })).toBe("deep");
    });

    it("still prints a zero value", () => {
      expect(renderTemplate("n={{n}}", { n: 0 })).toBe("n=0");
    });
  });

  describe("each", () => {
    it("iterates scalars via {{this}} — how inclusions/terms lists render", () => {
      expect(renderTemplate("{{#each xs}}[{{this}}]{{/each}}", { xs: ["a", "b"] })).toBe("[a][b]");
    });

    it("exposes @number for human-facing day numbering", () => {
      expect(
        renderTemplate("{{#each xs}}{{@number}}:{{n}} {{/each}}", { xs: [{ n: "x" }, { n: "y" }] }),
      ).toBe("1:x 2:y ");
    });

    it("exposes @index/@first/@last", () => {
      expect(
        renderTemplate("{{#each xs}}{{@index}}{{#if @first}}F{{/if}}{{#if @last}}L{{/if}} {{/each}}", {
          xs: [1, 2],
        }),
      ).toBe("0F 1L ");
    });

    it("reaches outward to enclosing scope, so a day loop can use {{accent}}", () => {
      expect(
        renderTemplate("{{#each xs}}{{this}}-{{accent}} {{/each}}", { accent: "#000", xs: ["a"] }),
      ).toBe("a-#000 ");
    });

    it("nests — days containing items, the core schedule shape", () => {
      expect(
        renderTemplate("{{#each ds}}D{{#each items}}({{t}}){{/each}}{{/each}}", {
          ds: [{ items: [{ t: "1" }, { t: "2" }] }, { items: [{ t: "3" }] }],
        }),
      ).toBe("D(1)(2)D(3)");
    });

    it("renders nothing when the value is not an array", () => {
      expect(renderTemplate("{{#each xs}}X{{/each}}", { xs: "not-an-array" })).toBe("");
    });
  });

  describe("if / unless", () => {
    it("treats an empty array as falsey so an empty day list takes {{else}}", () => {
      expect(renderTemplate("{{#if xs}}Y{{else}}N{{/if}}", { xs: [] })).toBe("N");
      expect(renderTemplate("{{#if xs}}Y{{else}}N{{/if}}", { xs: [1] })).toBe("Y");
    });

    it("treats 0 and empty string as falsey", () => {
      expect(renderTemplate("{{#if n}}Y{{else}}N{{/if}}", { n: 0 })).toBe("N");
      expect(renderTemplate("{{#if s}}Y{{else}}N{{/if}}", { s: "" })).toBe("N");
    });

    it("renders exactly one branch — never both", () => {
      expect(renderTemplate("{{#if x}}Y{{else}}N{{/if}}", { x: true })).toBe("Y");
      expect(renderTemplate("{{#if x}}Y{{else}}N{{/if}}", { x: false })).toBe("N");
    });

    it("keeps else-branches straight when nested inside each", () => {
      expect(
        renderTemplate("{{#each xs}}{{#if ok}}+{{else}}-{{/if}}{{/each}}", {
          xs: [{ ok: 1 }, { ok: 0 }, { ok: 1 }],
        }),
      ).toBe("+-+");
    });

    it("supports unless", () => {
      expect(renderTemplate("{{#unless x}}none{{/unless}}", { x: [] })).toBe("none");
      expect(renderTemplate("{{#unless x}}none{{/unless}}", { x: [1] })).toBe("");
    });
  });

  describe("malformed templates", () => {
    // The caller treats a throw as "fall back to the built-in renderer", which
    // is far safer than emitting a partially-rendered page.
    it("throws on an unclosed block", () => {
      expect(() => renderTemplate("{{#if x}}oops", {})).toThrow(/unclosed/);
    });

    it("throws on a stray closing tag", () => {
      expect(() => renderTemplate("{{/each}}", {})).toThrow(/unexpected/);
    });

    it("throws on a mismatched closing tag", () => {
      expect(() => renderTemplate("{{#if x}}a{{/each}}", {})).toThrow();
    });

    it("throws on {{else}} outside a conditional", () => {
      expect(() => renderTemplate("{{else}}", {})).toThrow(/else/);
    });
  });

  describe("escapeHtml", () => {
    it("covers the five characters that matter in attribute and text context", () => {
      expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    });
  });
});
