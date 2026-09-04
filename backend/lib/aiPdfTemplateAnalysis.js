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
      // Rate-limit/quota errors are marked "friendly" (a clean message for
      // the operator), but that also used to mean this failure was NEVER
      // logged anywhere — the caller silently fell back to the heuristic box
      // with nothing in the console to explain why. Always log here; only
      // the operator-facing surface stays quiet.
      console.warn("[aiPdfTemplateAnalysis] AI call failed:", aiErr.code || "ERROR", aiErr.message);
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

For every non-static page return relativeContentBox using TOP-LEFT coordinates normalized from 0 to 1. It must cover the complete trip-specific content that needs replacing while excluding fixed logo/header/footer chrome. Be generous enough to erase every old title, row, image and paragraph; partial boxes leave old content underneath.

Return requiredFields ONLY for values you can actually SEE printed as a labelled slot in this template and that the standard itinerary data cannot supply. Do not invent fields that merely seem useful — if the template has no visible place to print it, leave it out. A labelled box reading "TRIP STYLE: Educational - Guided" is a field; a general sense that a trip has a style is not.

For each one add a "hint": one short sentence naming where it appears and what it is for, written for the person who has to fill it in, e.g. "Shown in the third box under the cover photo, next to Duration and Route." Use stable camelCase keys. Set source to "auto" for title, destination, startDate, endDate, duration, route, pax, introText, inclusions, exclusions and termsText - those are filled from the itinerary and must never be asked for. Set source to "custom" only for the visible template-specific values. Mark required true only when the template would look obviously incomplete without it. type must be "text", "textarea", "number", or "date". Do not include schedule rows because those come from itinerary items.

Also capture the reusable VISUAL SYSTEM, not the literal sample-trip content. Infer the closest values for:
- typography: "sans" or "serif"
- headingCase: "uppercase" or "title"
- coverAlignment: "left" or "center"
- heroPosition: "before-title" or "after-title"
- heroTreatment: "edge-to-edge", "inset", or "none"
- tableStyle: "grid", "minimal", or "cards"
- tableHeaderStyle: "dark", "accent", or "light"
- dayBandStyle: "solid", "outline", or "dark"
- density: "compact", "comfortable", or "airy"
- borderRadius: integer from 0 to 16
- dayBandLayout: "label-only" or "split-title" (use split-title when the day number is in a narrow left cell and a day theme/title fills the rest)
- showRouteStrip: true when each day has a slim ROUTE row below its day band
- showLearningBox: true when each day ends with a bordered learning/curriculum/reflection box
- timeColumnRatio: decimal from 0.15 to 0.40 matching the TIME column width
- continuationStyle: "repeat-day" or "table-only"
- textColor, mutedColor, secondaryColor: #RRGGBB colours sampled from the document

The purpose is to recreate the template's design essence with different itinerary content. Do not default everything to a generic travel brochure. For example, a classroom-style document with cyan bands, black table headers, square grid lines, compact rows and left-aligned cover copy must report exactly those traits; an editorial luxury document may instead use serif typography, minimal rules and airy spacing.

Respond with ONLY this JSON, no markdown fences:
{"accentColor":"#RRGGBB","design":{"typography":"sans","headingCase":"uppercase","coverAlignment":"left","heroPosition":"before-title","heroTreatment":"edge-to-edge","tableStyle":"grid","tableHeaderStyle":"dark","dayBandStyle":"solid","dayBandLayout":"split-title","showRouteStrip":true,"showLearningBox":true,"timeColumnRatio":0.2,"continuationStyle":"repeat-day","density":"compact","borderRadius":0,"textColor":"#1A1A1A","mutedColor":"#667085","secondaryColor":"#111111"},"requiredFields":[{"key":"tripStyle","label":"Trip style","type":"text","required":true,"source":"custom","pageIndex":1,"hint":"Third box under the cover photo, beside Duration and Route."}],"pages":[{"index":1,"role":"cover","relativeContentBox":{"x":0.08,"y":0.13,"width":0.84,"height":0.72},"note":"logo+address fixed at top; title+blurb+photo replaced below"},{"index":2,"role":"itinerary","relativeContentBox":{"x":0.08,"y":0.13,"width":0.84,"height":0.76},"note":"header/footer fixed; day table body replaced, grows for longer trips"}]}
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

    // "low" fidelity per image. gpt-4o-mini — far and away the most common
    // BYOK model here — counts image tokens at roughly 33x the gpt-4o rate,
    // so six full-page brochure scans at default fidelity measured 154k
    // PROMPT TOKENS on a single request. That one call consumed most of a
    // typical key's per-minute allowance, so anything else (including this
    // feature's own second call) came straight back as a 429, and the
    // caller silently degraded to the design-less heuristic. At "low" the
    // same six pages cost a fixed ~17k. Page role, palette, table treatment
    // and density all read fine from a 512px page thumbnail — this call
    // never needed pixel-accurate detail, unlike the region detector above,
    // which is deliberately left at full fidelity.
    const lowDetailImages = images.map((img) => ({ ...img, detail: "low" }));

    // The response contract is restated HERE, in the final user turn, as well
    // as in the system prompt. With a large image payload ahead of it, a
    // bare "classify each page" instruction was frequently answered with a
    // bare `pages` array — no accentColor, no design, no requiredFields —
    // which normalised to design:null and left every generated PDF on the
    // generic fallback styling no matter how good the template was.
    const ASK = `Return ONE JSON object with ALL FOUR top-level keys: "accentColor", "design", "requiredFields" and "pages". A reply containing only "pages" is incomplete. Fill in every "design" field from what you can see. The "pages" array MUST contain exactly ${images.length} entries, one per page, with index 1 through ${images.length} — do not stop early and do not omit a page just because it looks similar to another.`;

    const buildContent = (leadText) => {
      const content = [{ type: "text", text: leadText }];
      lowDetailImages.forEach((img, i) => {
        content.push({ type: "text", text: `Page ${i + 1}:` });
        content.push(img);
      });
      return content;
    };

    const callModel = async (leadText) => {
      try {
        return await aiGateway.runAiRequest({
          tenantId,
          userId,
          task: "travel-pdf-template-structure",
          surface: "lib/aiPdfTemplateAnalysis.js:proposeTemplateStructureWithAi",
          requestedModelLabel: null,
          generationConfig: { responseMimeType: "application/json" },
          messages: [
            { role: "system", content: STRUCTURE_PROMPT(images.length) },
            { role: "user", content: buildContent(leadText) },
          ],
        });
      } catch (aiErr) {
        // See the matching note in proposeContentRegionWithAi above — a
        // "friendly" rate-limit error used to vanish with no log line, which
        // is exactly what made a design-less heuristic fallback look like a
        // renderer bug instead of the AI call having been throttled.
        console.warn("[aiPdfTemplateAnalysis] structure call failed:", aiErr.code || "ERROR", aiErr.message);
        return null;
      }
    };

    const parseResponse = (resp) => {
      if (!resp) return null;
      let cleaned = String(resp.text || "").trim();
      const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) cleaned = fence[1].trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (_e) {
        console.warn("[aiPdfTemplateAnalysis] structure response was not valid JSON");
        return null;
      }
      if (!parsed || !Array.isArray(parsed.pages)) {
        console.warn("[aiPdfTemplateAnalysis] structure response had no pages array");
        return null;
      }
      return parsed;
    };

    let resp = await callModel(ASK);
    let parsed = parseResponse(resp);

    // One retry, and only for the specific half-answer that actually bites:
    // usable page roles but no design block. Without it that answer is kept
    // as-is and the template is stuck on generic styling until someone
    // notices and re-uploads — the exact loop this feature kept landing in.
    if (parsed && !normalizeTemplateDesign(parsed.design)) {
      console.warn("[aiPdfTemplateAnalysis] structure response omitted \"design\" — retrying once");
      const retryResp = await callModel(`${ASK}\n\nYour previous reply left out the "design" object. It is required: report typography, headingCase, coverAlignment, heroPosition, heroTreatment, tableStyle, tableHeaderStyle, dayBandStyle, dayBandLayout, showRouteStrip, showLearningBox, timeColumnRatio, continuationStyle, density, borderRadius, textColor, mutedColor and secondaryColor for THIS document.`);
      const retryParsed = parseResponse(retryResp);
      if (retryParsed && normalizeTemplateDesign(retryParsed.design)) parsed = retryParsed;
    }

    if (!parsed) return null;

    const pages = parsed.pages
      .map((p) => ({
        index: Number(p?.index),
        role: TEMPLATE_ROLES.includes(String(p?.role)) ? String(p.role) : "details",
        relativeContentBox: normalizeRelativeBox(p?.relativeContentBox),
      }))
      .filter((p) => Number.isInteger(p.index) && p.index >= 1 && p.index <= images.length)
      .sort((a, b) => a.index - b.index);
    if (!pages.length) return null;

    // Models routinely describe only the first few pages of a long template
    // and stop. A short list is not harmless: the renderer would leave the
    // undescribed pages unclassified, and the operator's review dialog would
    // not even list them, so nobody could correct it. Fill the gaps from the
    // deterministic heuristic so callers always receive one entry per page.
    if (pages.length < images.length) {
      const seen = new Set(pages.map((p) => p.index));
      const heuristic = heuristicTemplateStructure(images.length).pages;
      for (const hp of heuristic) {
        if (seen.has(hp.index)) continue;
        pages.push({ index: hp.index, role: hp.role, relativeContentBox: null });
      }
      pages.sort((a, b) => a.index - b.index);
      console.warn(
        `[aiPdfTemplateAnalysis] model described ${seen.size}/${images.length} pages; filled the rest heuristically`,
      );
    }

    const accentRaw = String(parsed.accentColor || "").trim();
    const accentColor = /^#[0-9a-f]{6}$/i.test(accentRaw) ? accentRaw : null;

    return {
      accentColor,
      design: normalizeTemplateDesign(parsed.design),
      requiredFields: normalizeRequiredFields(parsed.requiredFields),
      pages,
      model: resp.model,
      provider: resp.provider,
    };
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
  return { accentColor: null, design: null, pages };
}

function normalizeTemplateDesign(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pick = (key, allowed, fallback) => allowed.includes(String(raw[key])) ? String(raw[key]) : fallback;
  const color = (key, fallback) => /^#[0-9a-f]{6}$/i.test(String(raw[key] || "").trim())
    ? String(raw[key]).trim()
    : fallback;
  const radius = Math.max(0, Math.min(16, Math.round(Number(raw.borderRadius) || 0)));
  return {
    typography: pick("typography", ["sans", "serif"], "sans"),
    headingCase: pick("headingCase", ["uppercase", "title"], "title"),
    coverAlignment: pick("coverAlignment", ["left", "center"], "left"),
    heroPosition: pick("heroPosition", ["before-title", "after-title"], "after-title"),
    heroTreatment: pick("heroTreatment", ["edge-to-edge", "inset", "none"], "inset"),
    tableStyle: pick("tableStyle", ["grid", "minimal", "cards"], "grid"),
    tableHeaderStyle: pick("tableHeaderStyle", ["dark", "accent", "light"], "light"),
    dayBandStyle: pick("dayBandStyle", ["solid", "outline", "dark"], "solid"),
    dayBandLayout: pick("dayBandLayout", ["label-only", "split-title"], "label-only"),
    showRouteStrip: Boolean(raw.showRouteStrip),
    showLearningBox: Boolean(raw.showLearningBox),
    timeColumnRatio: Math.max(0.15, Math.min(0.4, Number(raw.timeColumnRatio) || 0.2)),
    continuationStyle: pick("continuationStyle", ["repeat-day", "table-only"], "repeat-day"),
    density: pick("density", ["compact", "comfortable", "airy"], "comfortable"),
    borderRadius: radius,
    textColor: color("textColor", "#1A1A1A"),
    mutedColor: color("mutedColor", "#5B6470"),
    secondaryColor: color("secondaryColor", "#111111"),
  };
}

function normalizeRelativeBox(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const cx = Math.max(0, Math.min(1, x));
  const cy = Math.max(0, Math.min(1, y));
  return {
    x: cx,
    y: cy,
    width: Math.max(0.1, Math.min(width, 1 - cx)),
    height: Math.max(0.1, Math.min(height, 1 - cy)),
  };
}

function normalizeRequiredFields(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.slice(0, 30).map((field) => {
    const key = String(field?.key || "").trim().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 60);
    if (!key || seen.has(key)) return null;
    seen.add(key);
    return {
      key,
      label: String(field?.label || key).trim().slice(0, 100),
      type: ["text", "textarea", "number", "date"].includes(field?.type) ? field.type : "text",
      required: Boolean(field?.required),
      source: field?.source === "auto" ? "auto" : "custom",
      pageIndex: Math.max(1, Number.parseInt(field?.pageIndex, 10) || 1),
      // Where this value appears in the template, in the operator's words.
      // Without it the editor could only show a bare label like "Trip style",
      // which tells whoever is filling it in nothing about what it is for or
      // where it will show up.
      hint: String(field?.hint || "").trim().slice(0, 160),
    };
  }).filter(Boolean);
}

module.exports = {
  proposeContentRegionWithAi,
  proposeTemplateStructureWithAi,
  heuristicTemplateStructure,
  normalizeTemplateDesign,
  normalizeRelativeBox,
  normalizeRequiredFields,
  TEMPLATE_ROLES,
};
