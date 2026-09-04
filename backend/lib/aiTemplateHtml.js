"use strict";

// AI authoring for HTML itinerary templates.
//
// The enum-based analyser (aiPdfTemplateAnalysis.js) asks the model to pick
// values from a fixed vocabulary — typography "sans" | "serif", tableStyle
// "grid" | "minimal" | "cards". That vocabulary is the fidelity ceiling: a
// brochure set in Poppins can only ever come back as Helvetica, and a layout
// with no enum for it collapses to the nearest table.
//
// This asks for CSS instead. Models are markedly better at "write CSS to
// match this page" than at mapping a design onto 18 dropdowns, and the result
// is editable by a human when it is wrong — which no enum value ever is.
//
// Output is always validated before it is handed back: every body must parse
// as a template, and known-dangerous markup is stripped. A draft that fails
// validation is dropped rather than returned, so the caller either gets
// something renderable or nothing.

const aiGateway = require("./aiGateway");
const { pdfBufferToImageParts } = require("./pdfToImages");
const { renderTemplate } = require("./microTemplate");
const starter = require("../services/itineraryHtmlStarterTemplate");

// Elements with no place in a print body, and every one of them a way to run
// code or fetch something. The rendering browser already blocks non-webfont
// requests and the page is thrown away after the PDF is produced, so this is
// defence in depth rather than the only control — but an AI-drafted document
// should not be able to execute anything at all.
const FORBIDDEN_TAG_RE = /<\s*\/?\s*(script|iframe|object|embed|base|form|input|button|meta|link|svg|math|template|noscript)\b[^>]*>/gi;
// Inline handlers: onclick=, onerror=, onload=, ...
const EVENT_ATTR_RE = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
// javascript:/vbscript: in any attribute value.
const SCRIPT_URL_RE = /(?:javascript|vbscript)\s*:/gi;

// Elements whose CONTENT must go with them. Dropping only the tags would
// leave the script body as visible text, so a stripped <script>alert(1)</script>
// would print "alert(1)" in the middle of the brochure.
const CONTENT_BEARING_RE = /<\s*(script|style|iframe|object|embed|template|noscript|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

function sanitizeTemplateHtml(html) {
  return String(html || "")
    .replace(CONTENT_BEARING_RE, "")
    .replace(FORBIDDEN_TAG_RE, "")
    .replace(EVENT_ATTR_RE, "")
    .replace(SCRIPT_URL_RE, "");
}

// CSS can also fetch and (historically) execute. url() is the only real vector
// left once JS is gone; webfont imports are handled separately and explicitly.
function sanitizeTemplateCss(css) {
  return String(css || "")
    .replace(/<\s*\/?\s*style\b[^>]*>/gi, "")
    .replace(SCRIPT_URL_RE, "")
    .replace(/expression\s*\(/gi, "");
}

const CONTEXT_DOC = [
  "accent               brand colour, e.g. #00A9CE",
  "title                trip title",
  "subtitle / hasSubtitle",
  "introText            cover blurb",
  "hero / hasHero       destination photo, already a data: URI",
  "days[]               label ('DAY I'), number, title/hasTitle,",
  "                     route/hasRoute, learning/hasLearning, items[]",
  "days[].items[]       time, endTime, hasTime, location/hasLocation, activity",
  "inclusions[] exclusions[] otherDetails[] terms[]   arrays of strings",
  "perPerson groupTotal hasPrice",
  "fields[]             label, value  (template-specific, this page only)",
].join("\n");

const SYSTEM_PROMPT = (roles) => `You are recreating a travel brochure's page layouts as HTML and CSS, so a CRM can regenerate the same document with different trip content.

You are given one image per page of a blank brand template. The page CHROME (logo, address block, header rule, footer) is already preserved separately — you must NOT recreate it. Reproduce ONLY the body content area of each page: the part that changes per trip.

Page roles, in order: ${roles}
- cover: trip title, hero photo, intro paragraph
- itinerary: the day-by-day schedule. It MUST grow to any number of days.
- details: costing, inclusions, exclusions, terms
- static: skip entirely, emit nothing for it

TEMPLATING
Bodies use a logic-less template language. ONLY these forms exist:
  {{ value }}                     escaped output
  {{#each list}} ... {{/each}}    iterate; {{this}} for scalars, {{@number}} for a 1-based counter
  {{#if flag}} ... {{else}} ... {{/if}}
  {{#unless flag}} ... {{/unless}}
There are NO expressions, comparisons, filters or function calls. Use the pre-computed has* booleans instead.

AVAILABLE DATA
${CONTEXT_DOC}

RULES
- Match the template's real look: font family, weights, casing, colours sampled from the image, rule weights, table treatment, spacing.
- Real webfonts are supported and encouraged: @import from https://fonts.googleapis.com only. Pick the closest match to what you see.
- Use var(--accent) where the brand colour belongs; the wrapper div sets it.
- Sizes in pt. The body is placed into a fixed content box, so do NOT add page margins, headers, footers or page numbers.
- The schedule must handle any number of days and rows; never hardcode this example's day count.
- No <script>, <iframe>, <form>, <link>, or event handler attributes.
- One shared stylesheet for all pages, returned once as bodyCss.

Return ONLY this JSON, no markdown fences:
{"bodyCss":"...","pages":[{"index":1,"bodyHtml":"..."}]}
Include one entry per NON-static page. Escape newlines inside the JSON strings.`;

/**
 * Draft HTML/CSS bodies for a template's pages from its page images.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} [opts.userId]
 * @param {Buffer} opts.pdfBuffer          the template's source PDF
 * @param {Array<{index:number, role:string}>} opts.pages  confirmed page roles
 * @returns {Promise<{bodyCss:string, pages:Array<{index:number, bodyHtml:string}>, model:string, provider:string} | null>}
 */
async function proposeTemplateHtmlWithAi({ tenantId, userId, pdfBuffer, pages }) {
  try {
    const roleList = (pages || []).map((p) => `${p.index}=${p.role}`).join(", ") || "1=cover";
    const maxPages = Math.min(Math.max(1, (pages || []).length || 1), 8);
    const images = await pdfBufferToImageParts(pdfBuffer, { maxPages, scale: 1.1 });
    if (!images.length) return null;

    // Low fidelity for the same reason the structure analyser uses it:
    // gpt-4o-mini bills image tokens at ~33x, and full-fidelity page scans
    // pushed a single request past 150k prompt tokens, which trips rate
    // limits and degrades instruction-following.
    const content = [
      {
        type: "text",
        text: "Recreate the body of each page below as HTML/CSS. Here is a working example of the expected output shape and template syntax, for a different brand:\n\n"
          + `CSS:\n${starter.STARTER_CSS.slice(0, 900)}\n\nCOVER BODY:\n${starter.COVER_HTML}\n\nITINERARY BODY:\n${starter.ITINERARY_HTML}\n\nNow do the same for THIS template, matching its own fonts, colours and layout.`,
      },
    ];
    images.forEach((img, i) => {
      content.push({ type: "text", text: `Page ${i + 1}:` });
      content.push({ ...img, detail: "low" });
    });

    let resp;
    try {
      resp = await aiGateway.runAiRequest({
        tenantId,
        userId,
        task: "travel-pdf-template-html",
        surface: "lib/aiTemplateHtml.js:proposeTemplateHtmlWithAi",
        requestedModelLabel: null,
        messages: [
          { role: "system", content: SYSTEM_PROMPT(roleList) },
          { role: "user", content },
        ],
      });
    } catch (aiErr) {
      console.warn("[aiTemplateHtml] AI call failed:", aiErr.code || "ERROR", aiErr.message);
      return null;
    }

    let cleaned = String(resp.text || "").trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      console.warn("[aiTemplateHtml] response was not valid JSON");
      return null;
    }
    if (!parsed || !Array.isArray(parsed.pages)) {
      console.warn("[aiTemplateHtml] response had no pages array");
      return null;
    }

    const bodyCss = sanitizeTemplateCss(parsed.bodyCss);
    const outPages = [];
    for (const page of parsed.pages) {
      const index = Number(page && page.index);
      if (!Number.isInteger(index) || index < 1) continue;
      const bodyHtml = sanitizeTemplateHtml(page.bodyHtml);
      if (!bodyHtml.trim()) continue;
      // A body that does not parse would silently fall back to the built-in
      // renderer at PDF time, which reads as "the AI did nothing". Drop it
      // here instead so the caller can see exactly which pages it got.
      try {
        renderTemplate(bodyHtml, {});
      } catch (err) {
        console.warn(`[aiTemplateHtml] page ${index} body did not parse, dropped:`, err.message);
        continue;
      }
      outPages.push({ index, bodyHtml });
    }
    if (!outPages.length) return null;

    return { bodyCss, pages: outPages, model: resp.model, provider: resp.provider };
  } catch (err) {
    console.warn("[aiTemplateHtml] unexpected error:", err.message);
    return null;
  }
}

module.exports = {
  proposeTemplateHtmlWithAi,
  sanitizeTemplateHtml,
  sanitizeTemplateCss,
};
