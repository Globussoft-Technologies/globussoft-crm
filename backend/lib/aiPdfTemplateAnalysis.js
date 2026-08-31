"use strict";

// Best-effort AI-vision proposal for the G115 PDF-template content region.
// Supplements (never replaces) the existing heuristic detector in
// travelPdfTemplate.js#analyzePdfTemplate — the caller falls back to the
// heuristic box whenever this returns null (no AI configured for the
// tenant, no funded credits, a provider failure, or a malformed response).
// Goes through aiGateway.runAiRequest exclusively — provider-agnostic
// (BYOK or CRM-managed subscription), never a hardcoded model/provider.

const aiGateway = require("./aiGateway");
const { pdfBufferToImageParts } = require("./pdfToImages");

// Fixed render scale so pixel<->PDF-point conversion is exact and doesn't
// depend on pdfBufferToImageParts' own default.
const RENDER_SCALE = 1.5;

const SYSTEM_PROMPT = (imgWidth, imgHeight) => `You are analyzing a scanned travel-agency PDF template page. Identify the pixel bounding box of the BLANK/VARIABLE content area — i.e. everything that is NOT the fixed header, footer, logo, or side-branding chrome — so that CRM-generated itinerary content can be overlaid there later.
The image is exactly ${imgWidth}x${imgHeight} pixels, top-left origin.
Respond with ONLY a JSON object, no markdown fences, no commentary:
{"x": px, "y": px, "width": px, "height": px}`;

/**
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} [opts.userId]
 * @param {Buffer} opts.pdfBuffer
 * @param {{width:number,height:number}} opts.pageSize - page 1 size in PDF points
 * @returns {Promise<{contentBox:{x:number,y:number,width:number,height:number}, model:string, provider:string, previewImageBase64:string} | null>}
 */
async function proposeContentRegionWithAi({ tenantId, userId, pdfBuffer, pageSize }) {
  try {
    const images = await pdfBufferToImageParts(pdfBuffer, { maxPages: 1, scale: RENDER_SCALE });
    if (!images.length) return null; // canvas unavailable / unrenderable — heuristic-only fallback

    const imgWidthPx = Math.round((pageSize?.width || 595.28) * RENDER_SCALE);
    const imgHeightPx = Math.round((pageSize?.height || 841.89) * RENDER_SCALE);

    let resp;
    try {
      resp = await aiGateway.runAiRequest({
        tenantId,
        userId,
        task: "travel-pdf-template-region-detect",
        surface: "lib/aiPdfTemplateAnalysis.js:proposeContentRegionWithAi",
        requestedModelLabel: null,
        generationConfig: { responseMimeType: "application/json" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT(imgWidthPx, imgHeightPx) },
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this template page." },
              { type: "image", mimeType: "image/png", data: images[0].data },
            ],
          },
        ],
      });
    } catch (aiErr) {
      if (!aiErr.friendly) console.warn("[aiPdfTemplateAnalysis] AI call failed:", aiErr.message);
      return null;
    }

    let cleaned = String(resp.text || "").trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      return null;
    }
    const { x, y, width, height } = parsed || {};
    if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;

    const clampedX = Math.max(0, Math.min(x, imgWidthPx));
    const clampedY = Math.max(0, Math.min(y, imgHeightPx));
    const clampedW = Math.max(0, Math.min(width, imgWidthPx - clampedX));
    const clampedH = Math.max(0, Math.min(height, imgHeightPx - clampedY));
    if (clampedW <= 0 || clampedH <= 0) return null;

    // Pixel box (top-left origin) -> PDF-point box (bottom-left origin).
    const pageHeight = pageSize?.height || 841.89;
    const contentBox = {
      x: clampedX / RENDER_SCALE,
      y: pageHeight - (clampedY + clampedH) / RENDER_SCALE,
      width: clampedW / RENDER_SCALE,
      height: clampedH / RENDER_SCALE,
    };

    return {
      contentBox,
      model: resp.model,
      provider: resp.provider,
      previewImageBase64: images[0].data,
    };
  } catch (err) {
    console.warn("[aiPdfTemplateAnalysis] unexpected error:", err.message);
    return null;
  }
}

// ── Template structure (page roles + brand accent) ────────────────────
//
// A brand brochure is not one repeated layout — the Aviation Discovery style
// template is cover / itinerary table / costing+inclusions / contact, and each
// page needs different treatment when regenerating it with real trip data.
// This classifies every page so the renderer knows which to fill, which to
// grow for overflow, and which to reproduce untouched.
//
// Roles:
//   cover      title + intro blurb (usually page 1, often carries a hero image)
//   itinerary  the day-by-day schedule table — the page that grows
//   details    costing / inclusions / exclusions / terms
//   static     pure boilerplate (contact page, T&Cs) — copied verbatim

const TEMPLATE_ROLES = ["cover", "itinerary", "details", "static"];

const STRUCTURE_PROMPT = (pageCount) => `You are analyzing a ${pageCount}-page travel-brochure PDF template that a tour operator reuses for every trip they sell. This SPECIFIC PDF is just ONE EXAMPLE trip (say, a 3-day sample) — the template will be reused for trips of ANY length (a 1-day excursion, a 10-day tour, anything). Your job is to identify the reusable PATTERN each page represents, not describe this one example's literal content. If this example shows 3 days of schedule, that is illustrative only — a 5-day or 10-day trip using this same template must be able to grow the schedule freely; do not treat the example's day count as any kind of limit.

Assign each page exactly one role:
- "cover": the opening page — trip title, a hero photo, one or two introductory paragraphs. Content here is REPLACED per trip (different title/blurb/photo), but there is normally only ONE cover page regardless of trip length.
- "itinerary": the day-by-day schedule — usually a table of times and activities, one block per day. THIS is the role that grows or shrinks with trip length: a longer trip needs more of this page's design repeated, a shorter trip needs less. If this example's OWN schedule already spans more than one physical page (e.g. day 1-2 on page 2, day 3 continuing onto page 3, both with matching chrome/layout), tag ALL of those pages "itinerary" — they represent the SAME repeatable page design being reused for overflow, not separate content.
- "details": costing, inclusions, exclusions, other details, cancellation/refund terms — content that's REPLACED per trip but normally fits one page.
- "static": pure boilerplate that is IDENTICAL no matter which trip this template is used for — an "about us" / contact / follow-us page. Only use this for content that has NOTHING to do with the specific trip (no dates, no itinerary, no price) — if you're unsure whether a page's content changes per trip, prefer "details" over "static", since "static" pages are reproduced completely unchanged and anything trip-specific left on one would be wrong for every future trip.

For each page also note briefly (one short phrase) what part of it is fixed chrome (logo, address block, footer, rules — repeats identically on every page) versus what part holds the per-trip content that gets replaced, so the system knows exactly which region to blank and refill.

Also report the template's dominant brand accent colour (the colour used for table header bands, highlighted headings, rules) as a hex string.

Respond with ONLY this JSON, no markdown fences:
{"accentColor":"#RRGGBB","pages":[{"index":1,"role":"cover","note":"logo+address fixed at top; title+blurb+photo replaced below"},{"index":2,"role":"itinerary","note":"header/footer fixed; day table body replaced, grows for longer trips"}]}
Use 1-based page indexes and include every page.`;

/**
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} [opts.userId]
 * @param {Buffer} opts.pdfBuffer
 * @param {number} opts.pageCount
 * @returns {Promise<{accentColor:string|null, pages:Array<{index:number,role:string}>, model:string, provider:string} | null>}
 */
async function proposeTemplateStructureWithAi({ tenantId, userId, pdfBuffer, pageCount }) {
  try {
    // Cap at 8 pages: brochures beyond that are rare and every extra page is
    // another image in the request.
    const maxPages = Math.min(Math.max(1, Number(pageCount) || 1), 8);
    const images = await pdfBufferToImageParts(pdfBuffer, { maxPages, scale: 1.1 });
    if (!images.length) return null;

    const content = [{ type: "text", text: "Classify each page of this template, in order." }];
    images.forEach((img, i) => {
      content.push({ type: "text", text: `Page ${i + 1}:` });
      content.push(img);
    });

    let resp;
    try {
      resp = await aiGateway.runAiRequest({
        tenantId,
        userId,
        task: "travel-pdf-template-structure",
        surface: "lib/aiPdfTemplateAnalysis.js:proposeTemplateStructureWithAi",
        requestedModelLabel: null,
        generationConfig: { responseMimeType: "application/json" },
        messages: [
          { role: "system", content: STRUCTURE_PROMPT(images.length) },
          { role: "user", content },
        ],
      });
    } catch (aiErr) {
      if (!aiErr.friendly) console.warn("[aiPdfTemplateAnalysis] structure call failed:", aiErr.message);
      return null;
    }

    let cleaned = String(resp.text || "").trim();
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      return null;
    }
    if (!parsed || !Array.isArray(parsed.pages)) return null;

    const pages = parsed.pages
      .map((p) => ({
        index: Number(p?.index),
        role: TEMPLATE_ROLES.includes(String(p?.role)) ? String(p.role) : "details",
      }))
      .filter((p) => Number.isInteger(p.index) && p.index >= 1)
      .sort((a, b) => a.index - b.index);
    if (!pages.length) return null;

    const accentRaw = String(parsed.accentColor || "").trim();
    const accentColor = /^#[0-9a-f]{6}$/i.test(accentRaw) ? accentRaw : null;

    return { accentColor, pages, model: resp.model, provider: resp.provider };
  } catch (err) {
    console.warn("[aiPdfTemplateAnalysis] structure unexpected error:", err.message);
    return null;
  }
}

// Deterministic fallback for when no AI access is configured. Mirrors the
// overwhelmingly common brochure shape: cover first, schedule next, costing
// after that, and a boilerplate closing page when the deck is long enough to
// have one.
function heuristicTemplateStructure(pageCount) {
  const n = Math.max(1, Number(pageCount) || 1);
  const pages = [];
  for (let i = 1; i <= n; i += 1) {
    let role;
    if (i === 1) role = n === 1 ? "itinerary" : "cover";
    else if (i === 2) role = "itinerary";
    else if (i === n && n >= 4) role = "static";
    else role = "details";
    pages.push({ index: i, role });
  }
  return { accentColor: null, pages };
}

module.exports = {
  proposeContentRegionWithAi,
  proposeTemplateStructureWithAi,
  heuristicTemplateStructure,
  TEMPLATE_ROLES,
};
