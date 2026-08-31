"use strict";

// Template-faithful itinerary PDF renderer.
//
// The previous template path blanked one content box and stamped a generic
// 5-column money table into it, on every page — so a 4-page brand brochure
// (cover / schedule / costing / contact) came out as four identical pages of
// CRM-looking table. Nothing about the result read as the operator's own
// document.
//
// This renderer instead treats the uploaded PDF as a set of ROLE-TAGGED page
// blueprints (see lib/aiPdfTemplateAnalysis.js):
//
//   cover      → blank the body, draw the trip title, hero image and blurb
//   itinerary  → blank the body, draw a TIME | ACTIVITY schedule table with
//                accent-coloured "DAY I" band rows; grows onto extra copies of
//                the same template page when the schedule is long
//   details    → blank the body, draw the per-person cost line, Inclusions /
//                Exclusions / Other details lists and the terms block
//   static     → copied through untouched (contact page, boilerplate T&Cs)
//
// Because the page chrome is the ORIGINAL template page copied via pdf-lib —
// not a re-drawn approximation — the logo, address rail, footer tagline, rules
// and page furniture stay pixel-identical to what the operator uploaded. Only
// the body region is replaced.

const PDFKitDocument = require("pdfkit");
const { PDFDocument: PdfLibDocument, rgb, StandardFonts } = require("pdf-lib");
const pdfjs = require("pdfjs-dist");
const pdfRenderer = require("./pdfRenderer");
const { heuristicTemplateStructure } = require("../lib/aiPdfTemplateAnalysis");

pdfjs.GlobalWorkerOptions.disableWorker = true;

// pdfjs concatenates this with a bare filename, so it MUST end in a separator.
// Without it every base-14 font fetch fails and text extraction comes back
// empty for exactly the templates that matter here — brochures set in
// Helvetica/Times — which would silently disable page-number detection.
const STANDARD_FONT_DATA_URL = `${require("path").join(__dirname, "..", "node_modules", "pdfjs-dist", "standard_fonts")}${require("path").sep}`;

const DEFAULT_ACCENT = "#00A9CE";
const INK = "#1a1a1a";
const MUTED = "#5b6470";
// Black outline for the day-wise schedule table — a pale gray hairline read
// as barely-there in the generated PDF, unlike the crisp black-ruled table
// in the reference template it's meant to match.
const HAIRLINE = "#000000";

// ── small helpers ─────────────────────────────────────────────────────

function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// Brochures label days in Roman numerals ("DAY I", "DAY II") far more often
// than in digits; fall back to the digit for absurd day counts.
function toRoman(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > 3999) return String(n);
  const map = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  let v = num;
  for (const [val, sym] of map) {
    while (v >= val) { out += sym; v -= val; }
  }
  return out;
}

function hexToPdfLibRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

function normalizeHex(hex, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(hex || "").trim()) ? String(hex).trim() : fallback;
}

// Pick readable text for a filled band — luminance test against the accent.
function contrastInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "#ffffff";
  const int = parseInt(m[1], 16);
  const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? INK : "#ffffff";
}

function formatMoney(value, currency = "INR") {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

// A clean, short, factual line for when the operator hasn't written a cover
// blurb yet — deliberately plain rather than pulled from any AI output, so
// the cover never carries markdown syntax or content authored for a
// different purpose.
function buildFallbackIntro(itinerary) {
  const dest = itinerary.destination || "your destination";
  let days = null;
  if (itinerary.startDate && itinerary.endDate) {
    const ms = new Date(itinerary.endDate) - new Date(itinerary.startDate);
    if (Number.isFinite(ms) && ms >= 0) days = Math.floor(ms / 86400000) + 1;
  }
  return days
    ? `A ${days}-day journey to ${dest}, planned and priced for your group.`
    : `A trip to ${dest}, planned and priced for your group.`;
}

function parseBullets(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s)).filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((s) => String(s)).filter(Boolean);
  } catch { /* fall through */ }
  return String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Mirrors the route's resolveItemSchedule(): startTime/endTime/locationName are
// real columns now, but rows written before that kept them inside detailsJson.
function readSchedule(item) {
  let details = null;
  if (item && item.detailsJson) {
    try {
      const parsed = typeof item.detailsJson === "string" ? JSON.parse(item.detailsJson) : item.detailsJson;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed;
    } catch { details = null; }
  }
  const pick = (col, key) => {
    if (col != null && String(col).trim() !== "") return String(col).trim();
    const v = details && details[key];
    return v != null && String(v).trim() !== "" ? String(v).trim() : "";
  };
  return {
    startTime: pick(item && item.startTime, "startTime"),
    endTime: pick(item && item.endTime, "endTime"),
    locationName: pick(item && item.locationName, "locationName"),
  };
}

function timeRank(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.MAX_SAFE_INTEGER;
}

// Group items into ascending day buckets, each internally ordered by time then
// position. Items with no dayNumber collect into a trailing untitled bucket so
// nothing silently disappears from the customer's copy.
function groupItemsByDay(items) {
  const byDay = new Map();
  for (const it of items || []) {
    const key = it.dayNumber != null ? Number(it.dayNumber) : null;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(it);
  }
  const numbered = [...byDay.keys()].filter((k) => k != null).sort((a, b) => a - b);
  const groups = numbered.map((day) => ({
    day,
    label: `DAY ${toRoman(day)}`,
    items: sortDay(byDay.get(day)),
  }));
  if (byDay.has(null)) {
    groups.push({ day: null, label: "ADDITIONAL", items: sortDay(byDay.get(null)) });
  }
  return groups;
}

function sortDay(list) {
  return [...list].sort((a, b) => {
    const ta = timeRank(readSchedule(a).startTime);
    const tb = timeRank(readSchedule(b).startTime);
    if (ta !== tb) return ta - tb;
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

// ── page-number restamping ────────────────────────────────────────────
//
// A brochure's page number is part of its printed chrome, so it rides along
// when a template page is copied. The moment a real trip needs more pages
// than the reference example had — a long schedule repeating the itinerary
// page — every copy carries the SAME baked-in number, so a 4-page output
// reads 1, 2, 2, 3. This locates each template page's own number so the
// renderer can white it out and stamp the correct one.
//
// Returns an array indexed by source page: { x, y, width, height, size,
// rightAligned } or null when that page has no detectable number (many
// templates don't number at all — then nothing is touched).
async function detectPageNumberSlots(pdfBuffer, pageSizes) {
  try {
    const data = new Uint8Array(pdfBuffer);
    const doc = await pdfjs.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
    const slots = [];
    for (let i = 0; i < doc.numPages; i += 1) {
      const pageHeight = pageSizes[i] ? pageSizes[i].height : 841.89;
      const pageWidth = pageSizes[i] ? pageSizes[i].width : 595.28;
      let slot = null;
      try {
        const page = await doc.getPage(i + 1);
        const content = await page.getTextContent();
        const wanted = String(i + 1);
        for (const item of content.items || []) {
          if (String(item.str || "").trim() !== wanted) continue;
          const tx = item.transform || [];
          const y = Number(tx[5]);
          // Footer band only — a stray "2" inside body copy must not match.
          if (!Number.isFinite(y) || y > pageHeight * 0.15) continue;
          const x = Number(tx[4]);
          const w = Number(item.width) || 8;
          const h = Number(item.height) || 10;
          slot = { x, y, width: w, height: h, size: h, rightAligned: x > pageWidth / 2 };
          break;
        }
      } catch { slot = null; }
      slots.push(slot);
    }
    return slots;
  } catch {
    return [];
  }
}

// ── content-box PDFKit scaffolding ────────────────────────────────────

// Every section renders into its own PDFKit document whose page IS the content
// box, so the stamped result maps 1:1 onto the template page with no scaling.
function newSectionDoc(box) {
  const doc = new PDFKitDocument({
    size: [box.width, box.height],
    margin: 0,
    autoFirstPage: true,
  });
  let displayFont = "Helvetica-Bold";
  try {
    displayFont = pdfRenderer.applyRupeeCapableFonts(doc) || displayFont;
  } catch { /* standard fonts are a fine fallback */ }
  return { doc, displayFont };
}

// A two-tone heading: accent-coloured lead words then the rest in ink, which is
// the house style of most brochure templates ("**Tour Details** | Costing").
function drawSplitHeading(doc, { lead, rest, x, width, y, accent, size = 17 }) {
  doc.font("Helvetica-Bold").fontSize(size).fillColor(accent);
  doc.text(lead, x, y, { width, continued: Boolean(rest) });
  if (rest) {
    doc.fillColor(INK).text(rest, { width });
  }
  return doc.y;
}

function drawBulletList(doc, { title, items, x, width, y, accent, bottom, onPageBreak }) {
  let cursor = y;
  if (!items.length) return cursor;

  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
  doc.text(title, x, cursor, { width });
  cursor = doc.y + 4;

  doc.font("Helvetica").fontSize(9.5).fillColor(INK);
  for (const entry of items) {
    const textWidth = width - 14;
    const h = doc.heightOfString(entry, { width: textWidth }) + 3;
    if (cursor + h > bottom) {
      cursor = onPageBreak();
      doc.font("Helvetica").fontSize(9.5).fillColor(INK);
    }
    doc.circle(x + 3.5, cursor + 4.6, 1.7).fillColor(accent).fill();
    doc.fillColor(INK).text(entry, x + 14, cursor, { width: textWidth });
    cursor = doc.y + 3;
  }
  return cursor + 6;
}

// ── section: cover ────────────────────────────────────────────────────

async function renderCoverSection({ box, data, accent }) {
  const { doc } = newSectionDoc(box);
  const padX = 18;
  const x = padX;
  const width = box.width - padX * 2;
  // A larger bottom margin than the other sections use — the content box's
  // OWN bottom edge is only as accurate as whoever confirmed it, and a cover
  // that fills the box aggressively (the image now expands to use whatever
  // room the blurb doesn't need) is the section most likely to visibly reach
  // a mis-sized box's lower edge, where a template's footer chrome usually
  // sits. This extra margin is a safety buffer, not a fix for a wrong box —
  // a box that's genuinely too tall still needs re-confirming in the
  // template's region-confirm step.
  const bottom = box.height - 22;
  let y = 16;

  doc.font("Helvetica-Bold").fontSize(22).fillColor(INK);
  doc.text(data.title, x, y, { width, align: "center" });
  y = doc.y + 16;
  const afterTitleY = y;

  const paragraphs = String(data.introText || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Figure out how tall the blurb will be BEFORE sizing the hero image. A
  // short blurb (or none at all) used to leave the image capped at a fixed
  // fraction of the page regardless, so the page ended in a big empty gap
  // below the text — the image now claims whatever room the text doesn't
  // need, so a short-blurb cover reads as filled rather than half-empty.
  const TEXT_GAP = 10;
  const TEXT_SIZE = 10.5;
  const measureTextHeight = (fs) => {
    doc.font("Helvetica").fontSize(fs);
    return paragraphs.reduce((h, p) => h + doc.heightOfString(p, { width, lineGap: 2.5 }) + TEXT_GAP, 0);
  };
  const estimatedTextH = paragraphs.length ? measureTextHeight(TEXT_SIZE) : (data.subtitle ? 20 : 0);

  if (data.heroBuffer) {
    // Whatever's left after title + (estimated) text, capped so the image
    // never crowds out the page entirely even when there's no text at all.
    const maxHeroH = Math.min(bottom - afterTitleY - estimatedTextH - 18, box.height * 0.62);
    if (maxHeroH > 60) {
      try {
        const img = doc.openImage(data.heroBuffer);
        // Fill the allocated box the way CSS `background-size: cover` would
        // — scale to whichever dimension needs LESS enlarging, then crop the
        // overflow — instead of shrinking to fit both dimensions. The
        // destination photo is often fetched as a short, wide banner crop;
        // fitting it to both box dimensions left it rendering short no
        // matter how much vertical room the box actually had, which is what
        // produced a small photo sitting above a lot of dead space. Filling
        // + cropping guarantees the image always occupies the full budgeted
        // height.
        const coverScale = Math.max(width / img.width, maxHeroH / img.height);
        const drawW = img.width * coverScale;
        const drawH = img.height * coverScale;
        const drawX = x + (width - drawW) / 2;
        doc.save();
        doc.rect(x, y, width, maxHeroH).clip();
        doc.image(data.heroBuffer, drawX, y - (drawH - maxHeroH) / 2, { width: drawW, height: drawH });
        doc.restore();
        y += maxHeroH + 18;
      } catch {
        // Unreadable image — fall back to the plain fit call, still advancing
        // by a measured-ish amount rather than the full cap.
        try {
          doc.image(data.heroBuffer, x, y, { fit: [width, maxHeroH], align: "center" });
          y += maxHeroH + 18;
        } catch { /* no hero at all — the blurb simply starts higher */ }
      }
    }
  }

  // Shrink the body a step at a time until the whole blurb fits. Previously an
  // over-long blurb was silently truncated mid-way (the loop just `break`ed),
  // so the customer's copy quietly lost sentences.
  if (paragraphs.length) {
    let size = TEXT_SIZE;
    while (size > 7.5 && y + measureTextHeight(size) > bottom) size -= 0.5;

    doc.font("Helvetica").fontSize(size).fillColor(INK);
    for (const p of paragraphs) {
      doc.text(p, x, y, { width, align: "left", lineGap: 2.5 });
      y = doc.y + TEXT_GAP;
    }
  } else if (data.subtitle) {
    doc.font("Helvetica").fontSize(11).fillColor(MUTED);
    doc.text(data.subtitle, x, y, { width, align: "center" });
  }

  return streamToBuffer(doc);
}

// ── section: itinerary schedule table ─────────────────────────────────

// Breathing room after each day's table before the next day's band starts —
// without it, consecutive day tables read as one unbroken block. A hard cap
// on days-per-page was tried and reverted: it forced a short trailing day
// onto its own near-blank page instead of letting it sit under the day
// before it, which looked worse than the crowding it was meant to fix.
const DAY_GAP = 16;

async function renderItinerarySection({ box, data, accent }) {
  const { doc } = newSectionDoc(box);
  const padX = 14;
  const x = padX;
  const width = box.width - padX * 2;
  const bottom = box.height - 12;
  const bandInk = contrastInk(accent);

  const timeW = 68;
  const actW = width - timeW;
  const showTimeColumn = data.dayGroups.some((g) => g.items.some((it) => readSchedule(it).startTime));

  let y = 6;

  // Heading — "<Trip title> Itinerary", accent lead + ink tail.
  y = drawSplitHeading(doc, {
    lead: data.title, rest: "  Itinerary", x, width, y, accent, size: 16,
  }) + 10;

  const colX = showTimeColumn ? [x, x + timeW] : [x];
  const colW = showTimeColumn ? [timeW, actW] : [width];

  const drawHeaderRow = (atY) => {
    const h = 22;
    doc.rect(x, atY, width, h).fillAndStroke("#ffffff", HAIRLINE);
    doc.lineWidth(0.9).strokeColor(HAIRLINE);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK);
    if (showTimeColumn) {
      doc.text("TIME", colX[0], atY + 7, { width: colW[0], align: "center" });
      doc.moveTo(x + timeW, atY).lineTo(x + timeW, atY + h).stroke();
      doc.text("ACTIVITY", colX[1], atY + 7, { width: colW[1], align: "center" });
    } else {
      doc.text("ACTIVITY", colX[0], atY + 7, { width: colW[0], align: "center" });
    }
    return atY + h;
  };

  const BAND_H = 20;
  const drawDayBand = (atY, label) => {
    doc.rect(x, atY, width, BAND_H).fillAndStroke(accent, accent);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(bandInk);
    doc.text(label, x, atY + 6, { width, align: "center" });
    return atY + BAND_H;
  };

  // Starting a new physical page always redraws the column header, and — when
  // a day's rows are still mid-flow — repeats that day's band marked "(cont.)".
  // Without it an overflow page opened with orphaned rows and no indication of
  // which day they belonged to, which is exactly what made the continuation
  // page read as a random, incomplete fragment.
  const startPage = (atY, continuingLabel) => {
    doc.addPage();
    let ny = drawHeaderRow(atY);
    if (continuingLabel) ny = drawDayBand(ny, `${continuingLabel} (cont.)`);
    return ny;
  };

  y = drawHeaderRow(y);

  for (const group of data.dayGroups) {
    // Keep the band with at least one row of its day — a band stranded alone
    // at the foot of a page with no rows looks broken. Otherwise let however
    // many days actually FIT on a page share it (with the gap below keeping
    // them visually separate) — a hard "N days per page" cap was tried and
    // rejected: it forced a short trailing day onto its own nearly-blank
    // page instead of letting it sit naturally under the day before it.
    if (y + BAND_H + 30 > bottom) {
      y = startPage(6, null);
    }
    y = drawDayBand(y, group.label);

    for (const item of group.items) {
      const sched = readSchedule(item);
      const activity = sched.locationName && !item.description.includes(sched.locationName)
        ? `${item.description} — ${sched.locationName}`
        : item.description;

      doc.font("Helvetica").fontSize(9.5);
      const textW = (showTimeColumn ? colW[1] : colW[0]) - 14;
      const textH = doc.heightOfString(activity, { width: textW });
      const rowH = Math.max(24, textH + 13);

      if (y + rowH > bottom) {
        y = startPage(6, group.label);
      }

      doc.rect(x, y, width, rowH).fillAndStroke("#ffffff", HAIRLINE);
      doc.lineWidth(0.9).strokeColor(HAIRLINE);

      if (showTimeColumn) {
        doc.font("Helvetica").fontSize(9.5).fillColor(INK);
        doc.text(sched.startTime || "", colX[0] + 4, y + 7, { width: colW[0] - 8, align: "center" });
        doc.moveTo(x + timeW, y).lineTo(x + timeW, y + rowH).stroke();
        doc.fillColor(INK).text(activity, colX[1] + 7, y + 7, { width: textW });
      } else {
        doc.fillColor(INK).text(activity, colX[0] + 7, y + 7, { width: textW });
      }
      y += rowH;
    }

    // Breathing room before the next day's band, so consecutive tables never
    // read as one unbroken block.
    y += DAY_GAP;
  }

  if (!data.dayGroups.length) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor(MUTED);
    doc.text("Day-by-day plan to be confirmed.", x, y + 12, { width, align: "center" });
  }

  return streamToBuffer(doc);
}

// ── section: operator-supplied replacement copy for a page ────────────
//
// Lets an otherwise-"static" page (contact / about-us / closing note) be
// rewritten per template without re-authoring the source PDF. A line ending
// in ":" or written in Title Case reads as a heading; everything else is body
// copy. Centred, matching how closing pages are conventionally set.
async function renderCustomTextSection({ box, text, accent }) {
  const { doc } = newSectionDoc(box);
  const padX = 20;
  const x = padX;
  const width = box.width - padX * 2;
  const bottom = box.height - 14;
  let y = 18;

  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { y += 7; continue; }
    const isHeading = line.endsWith(":") || (line.length < 46 && /^[A-Z]/.test(line) && !/[.!?]$/.test(line));
    doc.font(isHeading ? "Helvetica-Bold" : "Helvetica").fontSize(isHeading ? 11.5 : 10);
    doc.fillColor(isHeading ? accent : INK);
    const h = doc.heightOfString(line, { width, lineGap: 2 });
    if (y + h > bottom) break;
    doc.text(line, x, y, { width, align: "center", lineGap: 2 });
    y = doc.y + (isHeading ? 6 : 4);
  }

  return streamToBuffer(doc);
}

// ── section: costing + inclusions + terms ─────────────────────────────

async function renderDetailsSection({ box, data, accent }) {
  const { doc } = newSectionDoc(box);
  const padX = 14;
  const x = padX;
  const width = box.width - padX * 2;
  const bottom = box.height - 12;

  let y = 6;
  const nextPage = () => {
    doc.addPage();
    return 6;
  };

  y = drawSplitHeading(doc, {
    lead: "Tour Details",
    rest: data.perPersonLabel ? "  |  Costing & Inclusions" : "  |  Inclusions",
    x, width, y, accent, size: 16,
  }) + 8;

  // Headline price line — per-person is what a school or family actually
  // compares, so it leads; the group total sits underneath as context.
  if (data.perPersonLabel) {
    doc.font("Helvetica-Bold").fontSize(12).fillColor(accent);
    doc.text(data.perPersonLabel, x, y, { width, continued: true });
    doc.fillColor(INK).font("Helvetica-Bold").text("  All-inclusive tour cost", { width });
    y = doc.y + 3;
    if (data.groupTotalLabel) {
      doc.font("Helvetica").fontSize(9).fillColor(MUTED);
      doc.text(data.groupTotalLabel, x, y, { width });
      y = doc.y + 10;
    } else {
      y += 8;
    }
  }

  y = drawBulletList(doc, { title: "Inclusions", items: data.inclusions, x, width, y, accent, bottom, onPageBreak: nextPage });
  y = drawBulletList(doc, { title: "Exclusions", items: data.exclusions, x, width, y, accent, bottom, onPageBreak: nextPage });
  y = drawBulletList(doc, { title: "Other Details", items: data.otherDetails, x, width, y, accent, bottom, onPageBreak: nextPage });

  if (data.termsText) {
    const lines = String(data.termsText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (y + 30 > bottom) y = nextPage();
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
    doc.text("Terms & Cancellation", x, y, { width });
    y = doc.y + 6;

    // Same bulleted-list treatment as Inclusions/Exclusions above, so a
    // refund ladder (one condition per line) reads as a clean list instead
    // of a run of plain paragraph lines butted up against each other. A
    // short line ending in ":" reads as a sub-heading, sitting flush left
    // with no bullet, exactly like the section headings elsewhere on this page.
    const textW = width - 14;
    for (const line of lines) {
      const isHeading = line.endsWith(":") && line.length < 70;
      doc.font(isHeading ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(INK);
      const lineWidth = isHeading ? width : textW;
      const h = doc.heightOfString(line, { width: lineWidth }) + (isHeading ? 5 : 4);
      if (y + h > bottom) {
        y = nextPage();
        doc.font(isHeading ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(INK);
      }
      if (isHeading) {
        doc.text(line, x, y, { width, lineGap: 1.5 });
      } else {
        doc.circle(x + 3.5, y + 4.6, 1.5).fillColor(accent).fill();
        doc.fillColor(INK).text(line, x + 14, y, { width: textW, lineGap: 1.5 });
      }
      y = doc.y + (isHeading ? 3 : 4);
    }
  }

  return streamToBuffer(doc);
}

// ── style-spec normalisation ──────────────────────────────────────────

// Produces one entry per template page: its role and the box to blank+fill.
// Falls back to the legacy single contentBox (and finally to a safe inset)
// whenever the richer spec is absent, so older templates keep rendering.
function resolveSpec({ styleSpec, regions, srcPageSizes }) {
  const spec = (() => {
    if (!styleSpec) return null;
    if (typeof styleSpec === "object") return styleSpec;
    try { return JSON.parse(styleSpec); } catch { return null; }
  })();

  const accent = normalizeHex(spec && spec.accentColor, DEFAULT_ACCENT);
  const legacyBox = regions && regions.contentBox ? regions.contentBox : null;
  const legacySize = regions && regions.pageSize ? regions.pageSize : null;
  const perPageLegacy = regions && Array.isArray(regions.pages) ? regions.pages : [];
  // A box the OPERATOR reviewed and confirmed in the region dialog. It has to
  // outrank every auto-detected box: the confirm step exists precisely because
  // the heuristic got it wrong, so silently preferring the heuristic anyway
  // made that dialog decorative. That's what left the tail of the reference
  // PDF's own body text visible under the generated cover — the operator had
  // widened the box to cover it, and the narrower heuristic box won regardless.
  // One reviewed box applies to every page (the dialog only ever asks for one).
  const operatorBox = regions && regions.confirmedByOperator === true && regions.contentBox
    ? regions.contentBox
    : null;

  // Templates uploaded/edited before page-role classification existed (or
  // where the AI pass failed and no heuristic ran) carry no `spec.pages` at
  // all. Leaving every page's role as null used to fall through to the
  // "ensure a schedule page exists" promotion below, which — with every page
  // untagged — always grabbed page 1 (almost always the COVER) and stamped
  // the day-by-day table onto it, while every other page (costing, contact)
  // just passed through as an untouched, still-blanked page. Falling back to
  // the same deterministic cover/itinerary/details/static pattern used at
  // upload time fixes both: the schedule lands on a real interior page, and
  // the trailing page (contact/boilerplate) stays untouched deliberately
  // instead of by accident.
  const fallbackRoles = (!spec || !Array.isArray(spec.pages) || spec.pages.length === 0)
    ? heuristicTemplateStructure(srcPageSizes.length).pages
    : null;

  const pages = srcPageSizes.map((size, i) => {
    const specPage = spec && Array.isArray(spec.pages)
      ? spec.pages.find((p) => Number(p.index) === i + 1)
      : null;
    const fallbackPage = fallbackRoles ? fallbackRoles.find((p) => p.index === i + 1) : null;
    const role = specPage && specPage.role ? String(specPage.role) : (fallbackPage ? fallbackPage.role : null);

    // Box precedence. The operator-confirmed box only ever comes from
    // reviewing PAGE 1 (analyze-pdf always previews the first page), so it
    // only gets first say on page 1 itself. Applying that single page-1 box
    // to every other page uniformly was a real bug: a template whose pages
    // need different margins — a cover's larger bottom clearance vs. an
    // interior page's smaller one — got the SAME box everywhere regardless,
    // so pages that needed more room had their content visibly overlap the
    // template's own footer/chrome. Every other page prefers its OWN
    // detected box (explicit per-page spec box, then the analyzer's
    // per-page box) — calibrated for that specific page — and only falls
    // back to the operator's page-1 box if this page has no detection of
    // its own at all.
    const legacyPage = perPageLegacy.find((p) => Number(p.page) === i + 1);
    const perPageDetectedBox = (specPage && specPage.contentBox) || (legacyPage && legacyPage.contentBox) || null;
    let box = i === 0 ? (operatorBox || perPageDetectedBox) : (perPageDetectedBox || operatorBox);
    if (!box) box = legacyBox;

    box = scaleBoxToPage(box, legacySize, size);
    return { index: i, role, box, customText: specPage && specPage.customText ? String(specPage.customText) : null };
  });

  return { accent, pages };
}

// The analyzer measured boxes against the page size it saw; if the actual page
// differs (a re-uploaded template at another size) scale rather than clip.
function scaleBoxToPage(box, fromSize, toSize) {
  const fallback = {
    x: toSize.width * 0.06,
    y: toSize.height * 0.12,
    width: toSize.width * 0.88,
    height: toSize.height * 0.74,
  };
  if (!box || !Number.isFinite(Number(box.width)) || !Number.isFinite(Number(box.height))) return fallback;

  let { x, y, width, height } = {
    x: Number(box.x) || 0,
    y: Number(box.y) || 0,
    width: Number(box.width),
    height: Number(box.height),
  };

  if (fromSize && Number(fromSize.width) > 0 && Number(fromSize.height) > 0) {
    const sx = toSize.width / Number(fromSize.width);
    const sy = toSize.height / Number(fromSize.height);
    x *= sx; width *= sx; y *= sy; height *= sy;
  }

  x = Math.max(0, Math.min(x, toSize.width - 20));
  y = Math.max(0, Math.min(y, toSize.height - 20));
  width = Math.max(60, Math.min(width, toSize.width - x));
  height = Math.max(60, Math.min(height, toSize.height - y));
  return { x, y, width, height };
}

// Plain text of a template's own "static" page(s) (contact/closing/boilerplate)
// — what an operator sees today if they don't override it. Powers the
// itinerary Details tab's "current template content" preview box, so the
// operator can see exactly what they're replacing before they type a
// replacement, instead of guessing from the PDF thumbnail alone.
async function getStaticPageText(templateSourceBuffer, styleSpec) {
  if (!Buffer.isBuffer(templateSourceBuffer) || templateSourceBuffer.length === 0) return "";
  try {
    const srcPdf = await PdfLibDocument.load(templateSourceBuffer);
    const srcPageSizes = srcPdf.getPages().map((p) => p.getSize());
    const { pages } = resolveSpec({ styleSpec, regions: null, srcPageSizes });
    const staticIndexes = pages.filter((p) => p.role === "static").map((p) => p.index);
    if (!staticIndexes.length) return "";

    const data = new Uint8Array(templateSourceBuffer);
    const doc = await pdfjs.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
    const parts = [];
    for (const idx of staticIndexes) {
      try {
        const page = await doc.getPage(idx + 1);
        const content = await page.getTextContent();
        const text = (content.items || [])
          .map((it) => String(it.str || ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) parts.push(text);
      } catch { /* unreadable page — skip it, others may still extract */ }
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

// ── main entry ────────────────────────────────────────────────────────

/**
 * Render an itinerary onto its brand template.
 *
 * @param {object} itinerary  Itinerary row incl. `items`
 * @param {object} contact    { name, email, phone } — may be null
 * @param {object} opts
 * @param {Buffer} opts.templateBuffer  the uploaded template PDF
 * @param {object|string} [opts.styleSpec]  ItineraryTemplate.pdfStyleSpecJson
 * @param {object} [opts.regions]           legacy pdfTemplateRegions
 * @param {Buffer} [opts.heroBuffer]        destination image for the cover
 * @returns {Promise<Buffer>}
 */
async function renderItineraryOnTemplate(itinerary, contact, opts = {}) {
  const { templateBuffer, styleSpec, regions, heroBuffer } = opts;
  if (!Buffer.isBuffer(templateBuffer) || templateBuffer.length === 0) {
    throw new Error("renderItineraryOnTemplate requires a templateBuffer");
  }

  const srcPdf = await PdfLibDocument.load(templateBuffer);
  const srcPages = srcPdf.getPages();
  if (!srcPages.length) throw new Error("Template PDF has no pages");
  const srcPageSizes = srcPages.map((p) => p.getSize());

  const { accent, pages: pageSpecs } = resolveSpec({ styleSpec, regions, srcPageSizes });

  const items = Array.isArray(itinerary.items) ? itinerary.items : [];
  const dayGroups = groupItemsByDay(items);
  const currency = itinerary.currency || "INR";
  const pax = Number(itinerary.pax) > 0 ? Number(itinerary.pax) : 1;
  const total = itinerary.totalAmount != null ? Number(itinerary.totalAmount) : null;

  const data = {
    title: String(itinerary.title || itinerary.destination || "Itinerary"),
    subtitle: contact && contact.name ? `Prepared for ${contact.name}` : null,
    // draftSummary was a broken fallback here: it's LLM output written for a
    // completely different surface (an internal/customer text summary), full
    // of markdown ("**bold**", "- bullet" lines) that was never meant to be
    // dropped verbatim into a brochure cover — that's exactly the wall of
    // "**Flights:**" / "**Sightseeing Adventures:**" text seen bleeding past
    // the page edge. If the operator hasn't written a real cover blurb, fall
    // back to one clean, short, deterministic line instead of someone else's
    // AI output for an unrelated purpose.
    introText: String(itinerary.introText || "").trim() || buildFallbackIntro(itinerary),
    heroBuffer,
    dayGroups,
    inclusions: parseBullets(itinerary.inclusionsJson),
    exclusions: parseBullets(itinerary.exclusionsJson),
    otherDetails: parseBullets(itinerary.otherDetailsJson),
    termsText: itinerary.termsText || "",
    staticPageText: itinerary.staticPageText || "",
    // Planning-only itineraries (moneyEnabled: false, the default for a new
    // itinerary) never show a price on the brochure — the whole point of the
    // toggle is a trip plan with no cost/tally attached anywhere.
    perPersonLabel: itinerary.moneyEnabled && total != null ? formatMoney(total / pax, currency) : null,
    groupTotalLabel: itinerary.moneyEnabled && total != null && pax > 1
      ? `Group total for ${pax} travellers: ${formatMoney(total, currency)}`
      : null,
  };

  // If the template carries no page tagged "cover", the trip's title / hero
  // photo / blurb never render ANYWHERE — page 1 just passes through as
  // whatever it originally was (often a near-blank divider page in some
  // brand templates), which is exactly the "why is the first page blank"
  // symptom this fixes. Covers are conventionally the first page, so promote
  // page 1 itself rather than guessing at another page. Must run before the
  // itinerary-page fallback below so that fallback doesn't also try to claim
  // page 1.
  const hasCoverPage = pageSpecs.some((p) => p.role === "cover");
  if (!hasCoverPage && pageSpecs.length) {
    pageSpecs[0].role = "cover";
  }

  // If the template carries no page tagged "itinerary", the schedule would be
  // dropped entirely — promote the first non-cover fillable page so the trip
  // plan always reaches the customer.
  const hasItineraryPage = pageSpecs.some((p) => p.role === "itinerary");
  if (!hasItineraryPage) {
    const target = pageSpecs.find((p) => p.role !== "cover" && p.role !== "static") || pageSpecs[pageSpecs.length - 1];
    if (target) target.role = "itinerary";
  }

  // Collapse RUNS of consecutive same-role growable pages into one logical
  // section. This matters exactly when a reference example's own day count
  // happened to need more than one physical page — say a 3-day sample whose
  // schedule spilled onto pages 2 AND 3, both tagged "itinerary". Treating
  // those as two independent pages would call the schedule generator twice,
  // stamping the SAME full day-by-day content onto page-2-styled AND
  // page-3-styled sheets — the whole itinerary duplicated. A run instead
  // becomes ONE section: the first page's box/chrome is the repeatable
  // background, and however many pages the REAL trip's content needs (3, 5,
  // 12 — never bounded by what the example happened to show) are produced by
  // copying that one page design as many times as required. "cover" is never
  // grouped (a brochure has exactly one) and neither is "static" (each
  // static page is independent fixed content — an "about us" page and a
  // "contact" page might both be tagged static without being the same page).
  const GROWABLE_ROLES = new Set(["itinerary", "details"]);
  // Itinerary-level replacement text (set per-trip in the Details tab) always
  // wins over any default baked into the template itself — a template is
  // reused across many unrelated trips, so a fixed override that lived only
  // on the template applied identically to every one of them regardless of
  // whether it was relevant.
  const staticText = String(data.staticPageText || "").trim() || null;
  const renderUnits = [];
  for (const pageSpec of pageSpecs) {
    const prev = renderUnits[renderUnits.length - 1];
    if (prev && prev.grouped && pageSpec.role === prev.role) continue; // absorbed into the run
    renderUnits.push({
      role: pageSpec.role,
      index: pageSpec.index,
      box: pageSpec.box,
      customText: pageSpec.role === "static" && staticText ? staticText : pageSpec.customText,
      grouped: GROWABLE_ROLES.has(pageSpec.role),
    });
  }

  const out = await PdfLibDocument.create();
  const white = rgb(1, 1, 1);
  const accentRgb = hexToPdfLibRgb(accent);
  // Which source page each emitted page came from, so page numbers can be
  // corrected afterwards for any page whose position shifted.
  const emitted = [];

  for (const pageSpec of renderUnits) {
    // Static pages (contact / boilerplate) pass through byte-for-byte —
    // UNLESS the operator supplied replacement copy for that page, in which
    // case its body is blanked and their text rendered instead. Without this
    // a static page was completely uneditable: the only way to change a
    // closing/contact page was to re-author the source PDF.
    if ((pageSpec.role === "static" || !pageSpec.role) && !pageSpec.customText) {
      const [copied] = await out.copyPages(srcPdf, [pageSpec.index]);
      const page = out.addPage(copied);
      emitted.push({ page, srcIndex: pageSpec.index });
      continue;
    }

    const box = pageSpec.box;
    let contentBuf;
    if (pageSpec.customText) {
      contentBuf = await renderCustomTextSection({ box, text: pageSpec.customText, accent });
    } else if (pageSpec.role === "cover") {
      contentBuf = await renderCoverSection({ box, data, accent });
    } else if (pageSpec.role === "itinerary") {
      contentBuf = await renderItinerarySection({ box, data, accent });
    } else {
      contentBuf = await renderDetailsSection({ box, data, accent });
    }

    const contentPdf = await PdfLibDocument.load(contentBuf);
    const contentCount = contentPdf.getPageCount();
    const embedded = await out.embedPdf(contentPdf, [...Array(contentCount).keys()]);

    // One output page per generated content page — a long schedule simply adds
    // more copies of the SAME template page, so its chrome repeats correctly
    // instead of borrowing the next page's design.
    for (let i = 0; i < contentCount; i += 1) {
      const [copied] = await out.copyPages(srcPdf, [pageSpec.index]);
      const page = out.addPage(copied);
      emitted.push({ page, srcIndex: pageSpec.index });
      page.drawRectangle({
        x: box.x, y: box.y, width: box.width, height: box.height, color: white,
      });
      page.drawPage(embedded[i], {
        x: box.x, y: box.y, width: box.width, height: box.height,
      });
      // Continuation marker so a reader knows the table runs on.
      if (contentCount > 1 && i < contentCount - 1 && accentRgb) {
        page.drawRectangle({
          x: box.x, y: box.y - 3, width: box.width, height: 1.5, color: accentRgb,
        });
      }
    }
  }

  // Correct page numbers, but ONLY on pages whose position actually moved
  // (an overflow copy, or anything after one). Pages still sitting at their
  // original index keep their printed number untouched, so a template that
  // renders 1:1 is never altered and carries zero risk from this pass.
  const needsRenumber = emitted.some((e, i) => e.srcIndex !== i);
  if (needsRenumber) {
    try {
      const slots = await detectPageNumberSlots(templateBuffer, srcPageSizes);
      if (slots.some(Boolean)) {
        const font = await out.embedFont(StandardFonts.HelveticaBold);
        emitted.forEach((entry, i) => {
          const slot = slots[entry.srcIndex];
          if (!slot || entry.srcIndex === i) return; // unchanged page — leave as printed
          const label = String(i + 1);
          const size = slot.size || 10;
          const textW = font.widthOfTextAtSize(label, size);
          entry.page.drawRectangle({
            x: slot.x - 3,
            y: slot.y - 4,
            width: Math.max(slot.width, textW) + 8,
            height: slot.height + 8,
            color: white,
          });
          entry.page.drawText(label, {
            x: slot.rightAligned ? slot.x + slot.width - textW : slot.x,
            y: slot.y,
            size,
            font,
            color: rgb(0, 0, 0),
          });
        });
      }
    } catch (numErr) {
      // Renumbering is cosmetic — never fail a render over it.
      console.warn("[itineraryTemplatePdf] page renumbering skipped:", numErr.message);
    }
  }

  return Buffer.from(await out.save());
}

module.exports = {
  renderItineraryOnTemplate,
  getStaticPageText,
  // exported for unit tests
  toRoman,
  groupItemsByDay,
  parseBullets,
  readSchedule,
  resolveSpec,
  scaleBoxToPage,
  contrastInk,
};
