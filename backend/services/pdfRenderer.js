/**
 * PDF Renderer — Wellness vertical
 *
 * Uses pdfkit (already in deps). Each exported function returns a Promise<Buffer>.
 *
 *   renderPrescriptionPdf(prescription, patient, clinic)
 *   renderConsentPdf(consent, patient, service, clinic, signatureDataUrl)
 *   renderBrandedInvoicePdf(invoice, contact, clinic)
 *
 * The `clinic` argument is typically the primary Location row:
 *   { name, addressLine, city, state, pincode, phone, email }
 *
 * Callers are responsible for tenant-scoped lookups.
 */

const PDFDocument = require("pdfkit");

// Slice 8 of the #902 GST & Compliance module — surfaces per-line SAC
// codes + CGST/SGST/IGST split + HSN/SAC summary in the travel invoice
// PDF. We require the two helpers as `module.exports.<fn>` indirection
// so a future vitest can spy on the surface; for the consumer it's the
// same shape.
const hsnSacMapper = require("../lib/hsnSacMapper");
const gstCalculation = require("../lib/gstCalculation");

// ── S51 logo-image fetch + in-memory LRU cache ──────────────────────
// Contract (called from renderTravelInvoicePdf):
//   fetchLogoBuffer(url, opts?) -> Promise<Buffer|null>
//
//   - Returns null on ANY fetch failure (404, network error, timeout,
//     non-image content-type, oversize body). The PDF renderer treats
//     null as "skip the doc.image() call" — invoice still renders, just
//     without a logo. Fail-soft because a flaky CDN should NOT block an
//     accountant from downloading their invoice.
//   - In-memory Map cache (process-lifetime). Max 50 entries; FIFO
//     eviction when full. TTL 1h (3_600_000 ms).
//   - HTTP timeout 5s, max content-length 5MB.
//   - opts: { axios?, ttlMs?, maxEntries?, cache? } — DI hooks for tests.
//
// axios is lazy-required inside the function so unit tests that never
// touch this code path don't pull the axios surface.
const LOGO_CACHE = new Map();
const LOGO_CACHE_TTL_MS = 60 * 60 * 1000;
const LOGO_CACHE_MAX = 50;
const LOGO_FETCH_TIMEOUT_MS = 5_000;
const LOGO_FETCH_MAX_BYTES = 5 * 1024 * 1024;

async function fetchLogoBuffer(url, opts) {
  if (!url || typeof url !== "string") return null;
  const o = opts || {};
  const ttl = typeof o.ttlMs === "number" ? o.ttlMs : LOGO_CACHE_TTL_MS;
  const max = typeof o.maxEntries === "number" ? o.maxEntries : LOGO_CACHE_MAX;
  const cache = o.cache || LOGO_CACHE;
  const now = Date.now();

  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.buf;
  if (hit) cache.delete(url);

  while (cache.size >= max) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }

  let buf = null;
  try {
    const axios = o.axios || require("axios");
    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: LOGO_FETCH_TIMEOUT_MS,
      maxContentLength: LOGO_FETCH_MAX_BYTES,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    if (!resp || !resp.data) return null;
    buf = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data);
    if (buf.length === 0 || buf.length > LOGO_FETCH_MAX_BYTES) return null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[pdfRenderer/S51] logo fetch failed for ${url}: ${err && err.message ? err.message : err}`,
    );
    return null;
  }

  cache.set(url, { buf, expiresAt: now + ttl });
  return buf;
}

function _resetLogoCache() {
  LOGO_CACHE.clear();
}

// ── Helpers ────────────────────────────────────────────────────────

function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function computeAge(dob) {
  if (!dob) return "—";
  try {
    const d = new Date(dob);
    if (isNaN(d.getTime())) return "—";
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return String(age);
  } catch {
    return "—";
  }
}

function formatDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
}

function formatMoney(n, currency = "INR") {
  const v = Number(n) || 0;
  const symbol = currency === "INR" ? "\u20B9" : currency === "USD" ? "$" : "";
  return `${symbol}${v.toFixed(2)}`;
}

function safeClinic(clinic) {
  return {
    name: clinic?.name || "Clinic",
    addressLine: clinic?.addressLine || "",
    city: clinic?.city || "",
    state: clinic?.state || "",
    pincode: clinic?.pincode || "",
    phone: clinic?.phone || "",
    email: clinic?.email || "",
  };
}

function drawClinicHeader(doc, clinic) {
  const c = safeClinic(clinic);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text(c.name);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  const addr = [c.addressLine, [c.city, c.state, c.pincode].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join("\n");
  if (addr) doc.text(addr);
  const contact = [c.phone, c.email].filter(Boolean).join("  |  ");
  if (contact) doc.text(contact);
  doc.moveDown(0.5);
  // Divider
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.7)
    .strokeColor("#999")
    .stroke();
  doc.moveDown(0.8);
  doc.fillColor("#111");
}

// Render an array of [label, value] pairs as one continued line with the
// labels bold and the values regular weight. Used by the case-history
// visit summary so "Service: …  •  Doctor: …" shows each label clearly.
function renderBoldLabeledLine(doc, pairs, x, width, sep = "   •   ") {
  const startX = x;
  doc.fillColor("#111").fontSize(10);
  pairs.forEach(([label, value], i) => {
    if (i === 0) {
      doc.font("Helvetica-Bold").text(`${label}: `, startX, doc.y, { continued: true });
    } else {
      doc.font("Helvetica").fillColor("#9ca3af").text(sep, { continued: true });
      doc.font("Helvetica-Bold").fillColor("#111").text(`${label}: `, { continued: true });
    }
    const isLast = i === pairs.length - 1;
    doc.font("Helvetica").fillColor("#333")
      .text(String(value), isLast ? { width } : { continued: true });
  });
}

// Render a free-text notes block where embedded "Label:" tokens
// (Services:, Products:, Employee:, Location: …) become bold AND start
// on their own line. The legacy free-text format mashed every labelled
// section onto one wrapping paragraph which made the structure invisible
// — e.g. "AFTProducts: …" with no separator between value and next
// label. Splitting into one line per label gives a clean list view.
function renderNotesWithBoldLabels(doc, raw, x, width) {
  if (!raw || typeof raw !== "string") return;
  doc.fillColor("#111").fontSize(10);
  const indent = 12;

  // Always lead with a bold "Notes:" header on its own line so the row
  // is clearly a notes block and not a continuation of the summary line
  // above.
  doc.font("Helvetica-Bold").fillColor("#111").text("Notes:", x, doc.y, { width });

  // Tokenize: split on the capture group so the alternating array
  // yields [pre, label, mid, label, …, post]. The "pre" before the
  // first label is any free-text that came BEFORE any labelled chunk
  // (rare in practice but we still print it). After that, every
  // (label, value) pair gets its OWN line, indented under the Notes
  // header so the structure reads as a list.
  const labelRe = /(\b[A-Z][A-Za-z][\w&/-]*:)/g;
  const parts = raw.split(labelRe);

  // Stitch into rows: { label, value }. The very first segment (parts[0])
  // is any unlabelled prefix.
  const rows = [];
  if (parts[0] && parts[0].trim()) rows.push({ label: null, value: parts[0].trim() });
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i];
    const value = (parts[i + 1] || "").trim();
    rows.push({ label, value });
  }

  for (const row of rows) {
    if (row.label) {
      doc.font("Helvetica-Bold").fillColor("#111")
        .text(`${row.label} `, x + indent, doc.y, { continued: true });
      doc.font("Helvetica").fillColor("#333")
        .text(row.value || "—", { width: width - indent });
    } else {
      doc.font("Helvetica").fillColor("#333")
        .text(row.value, x + indent, doc.y, { width: width - indent });
    }
  }
}

function parseDrugs(drugs) {
  if (!drugs) return [];
  if (Array.isArray(drugs)) return drugs;
  if (typeof drugs === "string") {
    try {
      const v = JSON.parse(drugs);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  if (typeof drugs === "object") return [drugs];
  return [];
}

// Parse Zylu-style structured `instructions` into clinical sections. Mirrors
// frontend/src/pages/wellness/PatientDetail.jsx's parseRxInstructions so the
// PDF and the on-screen modal render the same sections.
function parseRxInstructions(raw) {
  const out = { zyluId: "", chiefComplaint: "", diagnosis: "", investigations: "", advice: "", status: "", notes: "" };
  if (!raw || typeof raw !== "string") return out;
  const lines = raw.split(/\r?\n/);
  const leftover = [];
  let bucket = null;
  for (const line of lines) {
    const z = line.match(/^\s*\[ZYLU-#?(\d+)\]\s*$/i);
    if (z) { out.zyluId = z[1]; bucket = null; continue; }
    const m = line.match(/^\s*(chief complaint|diagnosis|investigations?|advice|advice\/referrals?|status|notes?)\s*:\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key.startsWith("chief")) { out.chiefComplaint = val; bucket = "chiefComplaint"; }
      else if (key.startsWith("diagnosis")) { out.diagnosis = val; bucket = "diagnosis"; }
      else if (key.startsWith("invest")) { out.investigations = val; bucket = "investigations"; }
      else if (key.startsWith("advice")) { out.advice = val; bucket = "advice"; }
      else if (key.startsWith("status")) { out.status = val; bucket = null; }
      else if (key.startsWith("note")) { out.notes = val; bucket = "notes"; }
      continue;
    }
    if (bucket && line.trim()) {
      out[bucket] = (out[bucket] ? out[bucket] + "\n" : "") + line.trim();
    } else if (line.trim()) {
      leftover.push(line.trim());
    }
  }
  if (!out.notes && leftover.length) out.notes = leftover.join("\n");
  return out;
}

// ── Branded design system (shared by Prescription + Patient Summary) ─
// Single source of truth for the colours, pills, header band, info strip,
// timeline dots, watermark and footer so both PDFs read like one product.
// Pinned vitest strings (BEFORE (N), AFTER (N), +N more, (image), Patient
// Summary, Prescription, No clinical notes recorded., etc.) stay verbatim.

const BRAND = {
  teal: "#265855",
  tealDark: "#1d4744",
  tealDeep: "#13322F",   // deeper teal for plan / wallet hero cards (white text on it)
  tealSoft: "#E8F2EE",   // pale teal — info-strip background under the header band
  blush: "#CD9481",
  gold: "#E0A04E",        // warm amber-gold accent stripe (matches the reference's golden stripe)
  cream: "#FAF6F0",
  panelBg: "#F8FAFA",
  border: "#E5E7EB",
  borderSoft: "#EEF2F2",
  textDark: "#111111",
  textBody: "#1F2937",
  textMuted: "#6B7280",
  labelMuted: "#9CA3AF",
};

// Serif font family — Playfair Display in the reference, but PDFKit only
// ships the standard 14 PostScript fonts, so we use Times-Bold for the
// elegant display-level character (brand name, section titles, patient
// name, big amounts). Names referenced via constants so the whole
// document's serif voice can swap together if a custom font is registered
// later.
const SERIF_BOLD = "Times-Bold";
const SERIF_REG = "Times-Roman";

const STATUS_PILL = {
  success: { bg: "#DCFCE7", text: "#065F46", border: "#16A34A" },
  danger:  { bg: "#FEE2E2", text: "#991B1B", border: "#DC2626" },
  warning: { bg: "#FEF3C7", text: "#92400E", border: "#D97706" },
  info:    { bg: "#DBEAFE", text: "#1E3A8A", border: "#2563EB" },
  neutral: { bg: "#F3F4F6", text: "#374151", border: "#9CA3AF" },
};

// Map a status / state string to a semantic pill kind. Keeps the pill
// vocabulary consistent across visits, prescriptions, treatment plans,
// invoices and memberships.
function statusKind(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "neutral";
  if (/(complet|paid|active|issued|approved|confirm|success|signed)/.test(v)) return "success";
  if (/(cancel|fail|expir|reject|void)/.test(v)) return "danger";
  if (/(draft|pending|schedul|hold|review)/.test(v)) return "warning";
  if (/(book|new|open|in[\s_-]?progress)/.test(v)) return "info";
  return "neutral";
}

// Rounded pill. Returns the right edge so callers can chain content
// after the pill on the same baseline.
function drawStatusPill(doc, label, x, y, opts = {}) {
  let text = String(label || "—").toUpperCase();
  const kind = opts.kind || statusKind(label);
  const palette = STATUS_PILL[kind] || STATUS_PILL.neutral;
  const padX = opts.padX != null ? opts.padX : 8;
  const padY = opts.padY != null ? opts.padY : 3;
  const fontSize = opts.fontSize || 8;
  doc.save();
  doc.font("Helvetica-Bold").fontSize(fontSize);
  // Opt-in cap: when maxWidth is supplied, truncate the label (".." — the "…"
  // glyph is absent from WinAnsi Helvetica) so the pill never overflows its
  // column. Callers that omit maxWidth keep the original auto-size behaviour.
  if (opts.maxWidth) {
    const maxTextW = opts.maxWidth - padX * 2;
    if (doc.widthOfString(text) > maxTextW) {
      const ell = "..";
      while (text.length > 1 && doc.widthOfString(text + ell) > maxTextW) {
        text = text.slice(0, -1);
      }
      text = text.replace(/\s+$/, "") + ell;
    }
  }
  const textW = doc.widthOfString(text);
  const w = textW + padX * 2;
  const h = fontSize + padY * 2;
  doc.roundedRect(x, y, w, h, h / 2).fillAndStroke(palette.bg, palette.border);
  doc.fillColor(palette.text).text(text, x + padX, y + padY, { width: textW + 2, lineBreak: false });
  doc.restore();
  return { x: x + w, y: y, w, h };
}

// Full-width branded header band. Teal background with white logo+brand
// name on the left and clinic address+phone+email on the right; a thin
// gold accent stripe sits flush below the band. Returns the y-cursor
// past the band so the caller can start the document body cleanly.
function drawBrandedHeader(doc, { brandName, tagline, clinic, logoBuffer, leftX, rightX }) {
  const c = safeClinic(clinic);
  const bandY = 0;
  const bandH = 86;
  const usableW = rightX - leftX;

  // Teal band — bleeds to the page edges so the design reads as a
  // proper letterhead rather than a margin-bound block.
  doc.save();
  doc.rect(0, bandY, doc.page.width, bandH).fill(BRAND.teal);
  doc.restore();

  // Logo disc (white circular plate with the supplied logo clipped
  // inside). Falls back to a heart glyph drawn in teal when no logo
  // buffer is supplied so the corner never reads empty.
  const discR = 24;
  const discCX = leftX + discR;
  const discCY = bandY + bandH / 2;
  doc.save();
  doc.circle(discCX, discCY, discR).fill("#FFFFFF");
  doc.restore();
  if (logoBuffer) {
    try {
      doc.save();
      doc.circle(discCX, discCY, discR - 2).clip();
      doc.image(logoBuffer, discCX - (discR - 2), discCY - (discR - 2), {
        fit: [(discR - 2) * 2, (discR - 2) * 2],
        align: "center",
        valign: "center",
      });
      doc.restore();
    } catch (_e) {
      doc.restore();
    }
  } else {
    // Simple heart silhouette in teal — two arcs + a triangle.
    const hx = discCX, hy = discCY + 2, s = 12;
    doc.save();
    doc.fillColor(BRAND.teal);
    doc.circle(hx - s / 3, hy - s / 4, s / 3).fill();
    doc.circle(hx + s / 3, hy - s / 4, s / 3).fill();
    doc.moveTo(hx - s / 1.8, hy - s / 5)
      .lineTo(hx + s / 1.8, hy - s / 5)
      .lineTo(hx, hy + s / 1.6)
      .closePath().fill();
    doc.restore();
  }

  // Brand name + tagline (left of header). Serif voice (Times-Bold) for
  // the brand name to match the reference's Playfair-Display feel; tagline
  // stays in sans uppercase with letter-spacing as the small-caps line
  // under the wordmark.
  const brandX = discCX + discR + 14;
  const brandW = usableW * 0.55 - (discR * 2 + 14);
  doc.fillColor("#FFFFFF").font(SERIF_BOLD).fontSize(22)
    .text(brandName || c.name || "Clinic", brandX, bandY + 22, { width: brandW, lineBreak: false });
  if (tagline) {
    doc.font("Helvetica").fontSize(8.5).fillColor("#E6EFEE")
      .text(String(tagline).toUpperCase(), brandX, bandY + 52, {
        width: brandW, characterSpacing: 1.6, lineBreak: false,
      });
  }

  // Clinic address + phone + email — right-rail, white-on-teal.
  const rightColW = usableW * 0.42;
  const rightColX = rightX - rightColW;
  doc.fillColor("#FFFFFF").font("Helvetica").fontSize(8.5);
  const addrLines = [];
  if (c.addressLine) addrLines.push(c.addressLine);
  const cityLine = [c.city, c.state, c.pincode].filter(Boolean).join(", ");
  if (cityLine) addrLines.push(cityLine);
  // Plain-text labels — PDFKit's standard Helvetica (WinAnsi) has no ☎/✉
  // glyphs, so those Unicode icons render as garbage ("&" / "'"). Use clear
  // ASCII labels instead.
  if (c.phone) addrLines.push(`Tel: ${c.phone}`);
  if (c.email) addrLines.push(`Email: ${c.email}`);
  // Compose the whole right-rail as one block so vertical centring is honest.
  const blockH = addrLines.length * 11;
  let ry = bandY + (bandH - blockH) / 2;
  for (const line of addrLines) {
    doc.text(line, rightColX, ry, { width: rightColW, align: "right", lineBreak: false });
    ry += 11;
  }

  // Thin gold accent stripe flush against the band.
  doc.save();
  doc.rect(0, bandY + bandH, doc.page.width, 4).fill(BRAND.gold);
  doc.restore();

  return bandY + bandH + 4;
}

// Soft-teal info strip with N evenly-spaced LABEL/value columns. Sits
// flush below the header gold-stripe and carries the document meta
// (PATIENT, PATIENT ID, GENERATED, DOCUMENT). Pale teal tint (BRAND.tealSoft)
// continues the brand voice from the header band without competing for
// attention with the body's section titles.
function drawInfoStrip(doc, pairs, { x, y, w }) {
  const stripH = 42;
  doc.save();
  doc.rect(x, y, w, stripH).fill(BRAND.tealSoft);
  doc.restore();
  const colW = w / pairs.length;
  pairs.forEach((pair, i) => {
    const cx = x + colW * i + 12;
    const cw = colW - 24;
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(BRAND.teal)
      .text(String(pair.label || "").toUpperCase(), cx, y + 9, {
        width: cw, characterSpacing: 1.3, lineBreak: false,
      });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.tealDark)
      .text(pair.value == null || pair.value === "" ? "—" : String(pair.value),
        cx, y + 23, { width: cw, lineBreak: false, ellipsis: true });
  });
  return y + stripH;
}

// Serif section title with a muted subtitle below. The reference uses a
// large display-serif chapter heading with NO underline accent — the
// generous size + subtitle pairing carries enough visual weight on its
// own. Subtitle stays in regular sans muted gray.
function drawSectionTitle(doc, title, subtitle, { x, w }) {
  doc.font(SERIF_BOLD).fontSize(26).fillColor(BRAND.tealDark)
    .text(title, x, doc.y, { width: w, lineBreak: false });
  let endY = doc.y;
  if (subtitle) {
    doc.font("Helvetica").fontSize(10).fillColor(BRAND.textMuted)
      .text(subtitle, x, doc.y + 2, { width: w, lineBreak: false });
    endY = doc.y;
  }
  doc.y = endY + 10;
}

// Small uppercase section label (e.g. "CASE HISTORY · 9 RECORDS") with a
// thin rule that runs from the end of the label out to the right edge —
// matches the reference's case-history divider. Caller supplies the
// padding; we don't move doc.y past it (caller controls content cadence).
function drawSectionLabelWithRule(doc, label, { x, w }) {
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND.teal)
    .text(String(label || "").toUpperCase(), x, doc.y, {
      characterSpacing: 1.4, lineBreak: false,
    });
  const labelW = doc.widthOfString(String(label || "").toUpperCase()) + label.length * 1.4;
  const lineY = doc.y + 5;
  const ruleStart = x + labelW + 10;
  const ruleEnd = x + w;
  if (ruleEnd > ruleStart) {
    doc.save();
    doc.moveTo(ruleStart, lineY).lineTo(ruleEnd, lineY)
      .lineWidth(0.5).strokeColor(BRAND.border).stroke();
    doc.restore();
  }
  doc.y = lineY + 8;
}

// Rounded card with optional left teal accent + optional top accent. The
// caller draws content inside the returned content-rect; the card is
// painted but no content is rendered here. `accentColor` overrides the
// default teal accent (used for cancelled visits → red accent).
function drawCardFrame(doc, { x, y, w, h, leftAccent = false, topAccent = false, bg = "#FFFFFF", border = BRAND.border, accentColor = BRAND.teal }) {
  doc.save();
  doc.roundedRect(x, y, w, h, 6).fillAndStroke(bg, border);
  if (leftAccent) {
    doc.save();
    doc.roundedRect(x, y, 4, h, 2).fill(accentColor);
    doc.restore();
  }
  if (topAccent) {
    doc.save();
    // Top accent painted as a 3pt stripe rounded at the top corners.
    // Defaults to teal; passed as red for cancelled visit cards.
    doc.rect(x + 1, y, w - 2, 3).fill(accentColor);
    doc.restore();
  }
  doc.restore();
}

// Two-column key/value grid (e.g. DOB / Gender / Source / Phone / Email
// / Status). Each cell is a small bordered card with an uppercase label
// and the value in regular weight.
function drawKvGrid(doc, rows, { x, y, w, cols = 3 }) {
  const gap = 10;
  const cellW = (w - gap * (cols - 1)) / cols;
  const cellH = 46;
  rows.forEach((row, i) => {
    const col = i % cols;
    const r = Math.floor(i / cols);
    const cx = x + col * (cellW + gap);
    const cy = y + r * (cellH + gap);
    doc.save();
    doc.roundedRect(cx, cy, cellW, cellH, 4).fillAndStroke(BRAND.panelBg, BRAND.borderSoft);
    doc.restore();
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(BRAND.textMuted)
      .text(String(row.label || "").toUpperCase(), cx + 10, cy + 9, {
        width: cellW - 20, characterSpacing: 1.1, lineBreak: false,
      });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.textDark)
      .text(row.value == null || row.value === "" ? "—" : String(row.value),
        cx + 10, cy + 23, { width: cellW - 20, lineBreak: false, ellipsis: true });
  });
  const totalRows = Math.ceil(rows.length / cols);
  return y + totalRows * cellH + (totalRows - 1) * gap;
}

// Coloured callout box (post-procedure care, warnings). Renders an icon
// glyph + bold heading + body text on a tinted background with a left
// accent stripe. `kind` selects the tone (warning|info|success). On
// return, `doc.y` is parked at the bottom of the callout so the next
// element flows directly below — callers should NOT add extra offset
// (the function used to leak doc.y from its internal text() call which
// caused callers to double-advance and triggered phantom auto-pages).
function drawCalloutBox(doc, { x, y, w, heading, body, kind = "warning" }) {
  const palette = STATUS_PILL[kind] || STATUS_PILL.warning;
  const padX = 14, padY = 12;
  doc.font("Helvetica").fontSize(9.5);
  const bodyH = body ? doc.heightOfString(body, { width: w - padX * 2 - 16 }) : 0;
  const headH = heading ? 14 : 0;
  const h = padY * 2 + headH + (heading && body ? 4 : 0) + bodyH;
  doc.save();
  doc.roundedRect(x, y, w, h, 4).fillAndStroke(palette.bg, palette.border);
  doc.rect(x, y, 4, h).fill(palette.border);
  doc.restore();
  if (heading) {
    // No leading glyph — "⚠" isn't in Helvetica's WinAnsi set and renders as
    // "&". The coloured box + left accent already mark this as a callout.
    doc.font("Helvetica-Bold").fontSize(10).fillColor(palette.text)
      .text(heading, x + padX + 4, y + padY, { width: w - padX * 2 - 8, lineBreak: false });
  }
  if (body) {
    doc.font("Helvetica").fontSize(9.5).fillColor(palette.text)
      .text(body, x + padX + 4, y + padY + headH + (heading ? 4 : 0), {
        width: w - padX * 2 - 8,
      });
  }
  // Park doc.y at the bottom of the painted callout so callers can chain
  // the next element directly with moveDown / a fresh draw at doc.y.
  doc.y = y + h;
  return y + h;
}

// Solid Rx mark (calligraphic) drawn at the top-left of each Rx card —
// reference shows a small classical Rx symbol directly above the
// medications table. Same width/height bounding as the watermark above
// to keep LineWrapper from triggering auto-pagination on the large glyph.
function drawRxMark(doc, { x, y, size = 22, color = BRAND.tealDark }) {
  doc.save();
  doc.fillColor(color).font(SERIF_BOLD).fontSize(size)
    .text("R", x, y, { lineBreak: false, width: size, height: size });
  doc.font("Times-BoldItalic").fontSize(size * 0.62)
    .text("x", x + size * 0.55, y + size * 0.35, {
      lineBreak: false, width: size * 0.62, height: size * 0.62,
    });
  doc.restore();
}

// Timeline event — vertical guide line + coloured dot + heading row.
// `dotKind` accepts the same vocabulary as statusKind so cancelled
// events render with a red dot, completed with green, etc. Returns the
// content x-position so the caller can render body text aligned with
// the heading.
function drawTimelineMarker(doc, { x, y, dotKind = "success", first = false, last = false, drawConnectors = true }) {
  const palette = STATUS_PILL[dotKind] || STATUS_PILL.success;
  const dotR = 4;
  const lineX = x + 6;
  // Fixed-length guide stubs. Skipped when the caller draws its own
  // dot-to-dot connectors (so the line spans the real gap between events
  // regardless of their height — see the case-history timeline).
  if (drawConnectors) {
    if (!first) {
      doc.save();
      doc.moveTo(lineX, y - 8).lineTo(lineX, y + dotR).lineWidth(1).strokeColor(BRAND.border).stroke();
      doc.restore();
    }
    if (!last) {
      doc.save();
      doc.moveTo(lineX, y + dotR).lineTo(lineX, y + 38).lineWidth(1).strokeColor(BRAND.border).stroke();
      doc.restore();
    }
  }
  doc.save();
  doc.circle(lineX, y + dotR, dotR).fillAndStroke(palette.border, palette.border);
  doc.restore();
  return { contentX: lineX + 14, lineX, dotR };
}

// Branded footer drawn on every page during the final buffered-pages
// flush. Caller passes the section label captured for each page index.
//
// Both text() calls below pin a `height` option to the available band
// space. Without it, pdfkit's LineWrapper treats the text as "could
// continue past page end" and silently calls continueOnNewPage even
// with lineBreak:false — producing phantom blank pages bolted onto the
// end of the document.
function drawBrandedFooter(doc, { brandName, sectionLabel, pageIndex, pageCount, leftX, rightX }) {
  const footerY = doc.page.height - 32;
  doc.save();
  doc.rect(0, footerY, doc.page.width, 32).fill(BRAND.cream);
  doc.rect(0, footerY, doc.page.width, 1).fill(BRAND.gold);
  doc.restore();
  const textY = footerY + 11;
  const textHeight = 14;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.tealDark)
    .text(brandName || "Clinic", leftX, textY, { lineBreak: false, height: textHeight });
  const rightW = rightX - leftX;
  const pageMeta = `${sectionLabel || ""}  ${sectionLabel ? "|" : ""}  Page ${pageIndex + 1} of ${pageCount}`.trim();
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.textMuted)
    .text(pageMeta, leftX, textY, { width: rightW, align: "right", lineBreak: false, height: textHeight });
}

// ── Consent templates ──────────────────────────────────────────────

const CONSENT_TEMPLATES = {
  "hair-transplant": `I hereby give my informed consent to undergo a hair transplant procedure at the above clinic. I understand that the procedure involves the surgical extraction of hair follicles from a donor area and their implantation into the recipient area. I have been informed of the risks including (but not limited to) infection, scarring, temporary shock-loss, variable graft survival, and less-than-expected density. I acknowledge that individual results may vary and that no specific outcome has been guaranteed. I confirm I have disclosed all relevant medical history, current medications and allergies.`,
  "botox-fillers": `I consent to the administration of botulinum toxin and/or dermal filler injections. I understand the procedure's purpose, technique, and the temporary nature of its effects. I have been informed of the potential risks including bruising, swelling, asymmetry, infection, vascular occlusion, and allergic reaction. I confirm I am not pregnant or breastfeeding and have disclosed all relevant medical history.`,
  "laser": `I consent to laser treatment for the indicated condition. I understand that multiple sessions may be required and that results vary between individuals. I have been informed of possible side effects including erythema, pigmentation changes, blistering, scarring, and rare adverse reactions. I agree to follow post-procedure care instructions including sun avoidance.`,
  "chemical-peel": `I consent to a chemical peel procedure. I understand the procedure involves the controlled application of a chemical solution which will cause the superficial layers of skin to exfoliate. I have been informed of risks including erythema, prolonged flaking, pigmentary changes, infection, and scarring. I agree to strict sun protection and post-care instructions.`,
  "general": `I hereby give my informed consent for the treatment/procedure described above. I acknowledge that the nature, purpose, risks and alternatives of the procedure have been explained to me and that I have had the opportunity to ask questions. I confirm that I have disclosed all relevant medical history, current medications and known allergies.`,
};

function getConsentBody(templateName) {
  const key = (templateName || "general").toLowerCase();
  return CONSENT_TEMPLATES[key] || CONSENT_TEMPLATES.general;
}

// ── 1. Prescription PDF ────────────────────────────────────────────

/**
 * Render a prescription PDF with the canonical wellness-vertical visual
 * language (branded header tile + teal section bands + uppercase-label
 * key-value rows + clean medications table). Matches the Patient Summary
 * PDF design so every clinical artefact looks like it came from the
 * same brand system.
 *
 * Signature kept 4-positional for back-compat with existing tests and
 * the older /prescriptions/:id/pdf caller; pass `opts.tenant` (for the
 * brand name) and `opts.logoBuffer` (Buffer with the logo bytes) to
 * render the full branded header. When opts is omitted, the header
 * falls back to `clinic.name` as the title and skips the logo tile.
 */
async function renderPrescriptionPdf(prescription, patient, clinic, doctor, opts = {}) {
  const { tenant = null, logoBuffer = null, treatmentName = null } = opts || {};
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  const bufPromise = streamToBuffer(doc);

  const parsed = parseRxInstructions(prescription?.instructions);
  const status = parsed.status || "Issued";
  const drugs = parseDrugs(prescription?.drugs);

  const leftX = 50;
  const pageRight = doc.page.width - doc.page.margins.right; // 545
  const usableW = pageRight - leftX;
  const contentBottom = doc.page.height - 56; // leave room for footer band

  const c = safeClinic(clinic);
  const brandName = tenant?.name || c.name || "Clinic";
  const headerTagline =
    tenant?.tagline || (brandName.toLowerCase().includes("wellness") ? "Wellness Clinic" : null);

  // Continuation pages start below the repeated header band (header is 90px).
  const CONTENT_TOP = 102;

  // Per-page section labels for the buffered-pages footer pass. Updated
  // every time we cross a new logical section so the footer reads e.g.
  // "Prescription · Page 2 of 3". Every NEW page also repeats the branded
  // header band so a multi-page Rx reads as one letterhead throughout.
  const pageSectionLabels = ["Prescription"];
  let currentSection = "Prescription";
  doc.on("pageAdded", () => {
    pageSectionLabels.push(currentSection);
    drawBrandedHeader(doc, {
      brandName, tagline: headerTagline, clinic: c, logoBuffer, leftX, rightX: pageRight,
    });
    doc.y = CONTENT_TOP;
  });

  // ── Local layout helpers (use the shared design system) ──────────
  const ensureSpace = (needed) => {
    if (doc.y + needed > contentBottom) {
      doc.addPage();
      doc.y = CONTENT_TOP;
    }
  };

  const KV_LABEL_W = 130;
  const kv = (label, value, opts2 = {}) => {
    const v = value == null || value === "" ? "—" : String(value);
    ensureSpace(18);
    const y = doc.y;
    const labelW = opts2.labelWidth || KV_LABEL_W;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.textMuted)
      .text(String(label).toUpperCase(), leftX, y + 2, {
        width: labelW, characterSpacing: 1, lineBreak: false,
      });
    doc.font("Helvetica").fontSize(10).fillColor(BRAND.textDark)
      .text(v, leftX + labelW, y, { width: usableW - labelW });
    doc.y = Math.max(doc.y, y + 16);
    doc.moveDown(0.1);
  };

  // ── Branded header band ──────────────────────────────────────────
  drawBrandedHeader(doc, {
    brandName,
    tagline: tenant?.tagline || (brandName.toLowerCase().includes("wellness") ? "Wellness Clinic" : null),
    clinic: c,
    logoBuffer,
    leftX,
    rightX: pageRight,
  });

  // ── Document meta info-strip (PATIENT / PATIENT ID / ISSUED / Rx #) ─
  const infoStripY = drawInfoStrip(
    doc,
    [
      { label: "Patient", value: patient?.name || "—" },
      { label: "Patient ID", value: patient?.id != null ? String(patient.id) : "—" },
      { label: "Issued", value: formatDate(prescription?.createdAt) },
      { label: "Document", value: prescription?.id != null ? `Rx #${prescription.id}` : "Prescription" },
    ],
    { x: leftX, y: 100, w: usableW },
  );

  doc.y = infoStripY + 18;

  // ── Title row — section title + status pill ──────────────────────
  drawSectionTitle(doc, `Prescription${prescription?.id != null ? ` #${prescription.id}` : ""}`,
    "Medication plan & clinician advice", { x: leftX, w: usableW - 120 });
  // Status pill, right-aligned with the title baseline.
  drawStatusPill(doc, status, pageRight - 80, doc.y - 32);

  // Clear gap so the subtitle never collides with the cards' top accent.
  doc.y += 16;

  // ── Patient + Prescriber as side-by-side cards ───────────────────
  const cardGap = 12;
  const cardW = (usableW - cardGap) / 2;
  const cardsTopY = doc.y;
  const cardH = 116;
  ensureSpace(cardH + 12);

  drawCardFrame(doc, { x: leftX, y: cardsTopY, w: cardW, h: cardH, topAccent: true });
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(BRAND.teal)
    .text("PATIENT", leftX + 14, cardsTopY + 12, { characterSpacing: 1.4, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(13).fillColor(BRAND.textDark)
    .text(patient?.name || "—", leftX + 14, cardsTopY + 26, { width: cardW - 28, ellipsis: true, lineBreak: false });
  let py = cardsTopY + 46;
  const pLines = [];
  if (patient?.dob) pLines.push(`DOB · ${formatDate(patient.dob)} (age ${computeAge(patient.dob)})`);
  if (patient?.gender) pLines.push(`Gender · ${patient.gender}`);
  if (patient?.phone) pLines.push(`Phone · ${patient.phone}`);
  if (patient?.email) pLines.push(`Email · ${patient.email}`);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.textBody);
  for (const line of pLines.slice(0, 4)) {
    doc.text(line, leftX + 14, py, { width: cardW - 28, ellipsis: true, lineBreak: false });
    py += 13;
  }

  const docCardX = leftX + cardW + cardGap;
  drawCardFrame(doc, { x: docCardX, y: cardsTopY, w: cardW, h: cardH, topAccent: true });
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(BRAND.teal)
    .text("PRESCRIBER", docCardX + 14, cardsTopY + 12, { characterSpacing: 1.4, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(13).fillColor(BRAND.textDark)
    .text(doctor?.name || "—", docCardX + 14, cardsTopY + 26, { width: cardW - 28, ellipsis: true, lineBreak: false });
  let dy = cardsTopY + 46;
  const dLines = [];
  if (treatmentName) dLines.push(`Treatment · ${treatmentName}`);
  if (doctor?.phone) dLines.push(`Phone · ${doctor.phone}`);
  if (doctor?.email) dLines.push(`Email · ${doctor.email}`);
  if (doctor?.registrationNumber) dLines.push(`Reg. No · ${doctor.registrationNumber}`);
  if (prescription?.visitId != null) dLines.push(`Appointment · #${prescription.visitId}`);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.textBody);
  for (const line of dLines.slice(0, 4)) {
    doc.text(line, docCardX + 14, dy, { width: cardW - 28, ellipsis: true, lineBreak: false });
    dy += 13;
  }
  doc.y = cardsTopY + cardH + 18;

  // ── Clinical Notes — only when we have content (keeps tight Rx tight) ─
  const hasClinical = parsed.chiefComplaint || parsed.diagnosis || parsed.investigations;
  if (hasClinical) {
    currentSection = "Clinical Notes";
    drawSectionTitle(doc, "Clinical Notes", "Chief complaint, diagnosis & investigations",
      { x: leftX, w: usableW });
    kv("Chief Complaint", parsed.chiefComplaint);
    kv("Diagnosis", parsed.diagnosis);
    kv("Investigations", parsed.investigations);
    doc.moveDown(0.6);
  }

  // ── Medications table — 5-column reference layout ─────────────────
  currentSection = "Medications";
  drawSectionTitle(doc, "Medications", `${drugs.length || "No"} item${drugs.length === 1 ? "" : "s"} prescribed`,
    { x: leftX, w: usableW });
  ensureSpace(40);
  // The table follows the section title directly — no decorative Rx mark.
  doc.y += 8;

  doc.x = leftX;
  const cols = [
    { label: "#",          x: leftX,        w: 36 },
    { label: "Medication", x: leftX + 36,  w: 175 },
    { label: "Dosage",     x: leftX + 211, w: 95 },
    { label: "Frequency",  x: leftX + 306, w: 120 },
    { label: "Duration",   x: leftX + 426, w: usableW - 426 },
  ];

  let tableTop = doc.y;
  if (tableTop + 30 > contentBottom) { doc.addPage(); tableTop = CONTENT_TOP; }
  // Teal header bar with white column labels.
  doc.save();
  doc.rect(leftX, tableTop, usableW, 24).fill(BRAND.teal);
  doc.restore();
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8.5);
  for (const col of cols) {
    doc.text(col.label.toUpperCase(), col.x + 8, tableTop + 8, {
      width: col.w - 16, characterSpacing: 1.1, lineBreak: false,
    });
  }

  let rowY = tableTop + 24;
  if (drugs.length === 0) {
    doc.save();
    doc.rect(leftX, rowY, usableW, 28).fill(BRAND.panelBg);
    doc.restore();
    doc.font("Helvetica-Oblique").fontSize(10).fillColor(BRAND.textMuted)
      .text("(no medications listed)", leftX, rowY + 9, { width: usableW, align: "center" });
    rowY += 28;
  } else {
    for (let i = 0; i < drugs.length; i++) {
      const d = drugs[i];
      const strength = [d.strengthValue, d.strengthUnit].filter(Boolean).join("") || d.strength || "";
      const dosageText = [d.dosage, strength].filter(Boolean).join(" ").trim() || "—";
      const subParts = [d.preparation || d.dosageForm, d.route].filter(Boolean);
      const subText = subParts.join(" · ");
      const medName = d.name || d.drug || "—";
      const freq = d.frequency || "—";
      const duration = d.duration || "—";

      // Row height — taller when there's a Form · Route subline; shorter
      // and tighter when the medication is single-line. Keeps long-list
      // prescriptions paginating around the reference's natural density
      // (50 short rows ≈ 3 pages; reference Rx with sublines ≈ 1 page).
      const rowH = subText ? 44 : 32;

      if (rowY + rowH > contentBottom) {
        doc.addPage();
        rowY = CONTENT_TOP;
        // Re-paint header on the new page so the table reads correctly.
        doc.save();
        doc.rect(leftX, rowY, usableW, 24).fill(BRAND.teal);
        doc.restore();
        doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8.5);
        for (const col of cols) {
          doc.text(col.label.toUpperCase(), col.x + 8, rowY + 8, {
            width: col.w - 16, characterSpacing: 1.1, lineBreak: false,
          });
        }
        rowY += 24;
      }
      // Zebra-stripe alternate rows.
      if (i % 2 === 1) {
        doc.save();
        doc.rect(leftX, rowY, usableW, rowH).fill(BRAND.panelBg);
        doc.restore();
      }
      // # column
      doc.font("Helvetica").fontSize(10).fillColor(BRAND.textMuted)
        .text(String(i + 1), cols[0].x + 12, rowY + rowH / 2 - 6, {
          width: cols[0].w - 16, lineBreak: false,
        });
      // MEDICATION — bold name + optional Form · Route subline
      doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.tealDark)
        .text(medName, cols[1].x + 8, subText ? rowY + 8 : rowY + rowH / 2 - 7, {
          width: cols[1].w - 16, ellipsis: true, lineBreak: false,
        });
      if (subText) {
        doc.font("Helvetica").fontSize(8.5).fillColor(BRAND.textMuted)
          .text(subText, cols[1].x + 8, rowY + 24, {
            width: cols[1].w - 16, ellipsis: true, lineBreak: false,
          });
      }
      // DOSAGE
      doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
        .text(dosageText, cols[2].x + 8, rowY + rowH / 2 - 6, {
          width: cols[2].w - 16, ellipsis: true, lineBreak: false,
        });
      // FREQUENCY pill — capped to the column so long values (e.g.
      // "THREE TIMES DAILY (TDS) AS NEEDED") truncate instead of bleeding
      // into the Duration column.
      drawStatusPill(doc, freq, cols[3].x + 8, rowY + rowH / 2 - 8, {
        kind: "success", fontSize: 8, padX: 8, padY: 3,
        maxWidth: cols[3].w - 16,
      });
      // DURATION
      doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
        .text(duration, cols[4].x + 8, rowY + rowH / 2 - 6, {
          width: cols[4].w - 16, ellipsis: true, lineBreak: false,
        });
      doc.moveTo(leftX, rowY + rowH).lineTo(pageRight, rowY + rowH)
        .lineWidth(0.3).strokeColor(BRAND.borderSoft).stroke();
      rowY += rowH;
    }
  }
  // Outline the whole table.
  doc.lineWidth(0.5).strokeColor(BRAND.border)
    .rect(leftX, tableTop, usableW, rowY - tableTop).stroke();
  doc.x = leftX;
  doc.y = rowY + 14;

  // ── Additional Advice — rendered as a coloured callout (amber). ──
  // Heading is "Instructions" so the test contract still matches when
  // the caller supplies a free-form instructions block without an
  // explicit "Advice:" prefix (which falls into parsed.notes instead).
  if (parsed.advice) {
    ensureSpace(60);
    drawCalloutBox(doc, {
      x: leftX, y: doc.y, w: usableW,
      heading: "Instructions",
      body: parsed.advice,
      kind: "warning",
    });
    doc.moveDown(0.8);
  }

  // ── Notes / Instructions callout ─────────────────────────────────
  // When the caller supplies a free-form instructions string without an
  // explicit "Advice:" label (the common Rx-detail page case), the text
  // lands in parsed.notes via parseRxInstructions's leftover bucket. We
  // surface that as an "Instructions" amber callout so the patient sees
  // the per-Rx clinician guidance directly under the table. When notes
  // are genuinely empty, fall back to a "Notes" callout with the canonical
  // "No clinical notes recorded." placeholder — vitest pins both shapes.
  ensureSpace(60);
  const notesHeading = parsed.notes ? "Instructions" : "Notes";
  drawCalloutBox(doc, {
    x: leftX, y: doc.y, w: usableW,
    heading: notesHeading,
    body: parsed.notes || "No clinical notes recorded.",
    kind: "warning",
  });
  doc.moveDown(0.6);

  // ── Doctor's signature block ─────────────────────────────────────
  // Guard against fires when doc.y was already pushed past page bottom by
  // the preceding callouts — without the ensureSpace check, text() with
  // an explicit y near contentBottom triggers pdfkit's continueOnNewPage
  // and silently adds a blank trailing page (4 phantom pages observed
  // before this guard).
  ensureSpace(46);
  const sigBaseY = Math.min(Math.max(doc.y, contentBottom - 46), contentBottom - 32);
  const sigLineY = sigBaseY + 24;
  if (doctor?.name) {
    doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
      .text(doctor.name, 340, sigLineY - 14, {
        width: 205, align: "center", lineBreak: false, height: 14,
      });
  }
  doc.moveTo(340, sigLineY).lineTo(pageRight, sigLineY)
    .lineWidth(0.5).strokeColor(BRAND.textMuted).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.textMuted)
    .text("Doctor's Signature", 340, sigLineY + 4, {
      width: 205, align: "center", lineBreak: false, height: 14,
    });

  // ── Branded footer pass (page numbers + section label) ────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawBrandedFooter(doc, {
      brandName,
      sectionLabel: pageSectionLabels[i] || "Prescription",
      pageIndex: i,
      pageCount: range.count,
      leftX,
      rightX: pageRight,
    });
  }

  doc.end();
  return bufPromise;
}

// ── 2. Consent PDF ─────────────────────────────────────────────────
//
// G091 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.c) — Travel-vertical
// consent forms (PRD_TRAVEL_BILLING liability waivers, PRD_TRAVEL_VISA
// data-consent forms, PRD_TRAVEL_TMC parent consents) need the same
// brand-kit treatment the itinerary / quote / invoice PDFs already get.
//
// The 6th positional `opts` is additive and backward-compatible. Existing
// wellness callers pass 5 args — `opts` defaults to `{}` and the renderer
// behaves exactly as it did pre-G091 (clinic-header band, no sub-brand
// band, no logo, no brand-kit footer text). Travel callers (or future
// wellness multi-tenant consent flows) pass `opts.subBrand` (+ optionally
// `opts.tenant` for `subBrandConfigJson` cascade, `opts.branding` for
// per-render overrides) to opt into the brand-kit header band.
//
// Brand-kit shape consumed (mirrors the S52 sibling renderers):
//   - branding.headerColor  → top-of-page accent band (replaces the
//                             clinic-header pre-render when set).
//   - branding.thumbnailUrl → logo embedded into the band's top-right
//                             via fetchLogoBuffer (same self-mocking
//                             seam the itinerary renderer uses).
//   - opts.branding.footerText → optional small-print line ABOVE the
//                                signature block. Lets each sub-brand
//                                carry its own legal disclaimer / contact
//                                line into the rendered consent form.
async function renderConsentPdf(consent, patient, service, clinic, signatureDataUrl, opts = {}) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // Travel-vertical consent: opt into the brand-kit header band when
  // opts.subBrand is supplied. Wellness path (no subBrand) is unchanged.
  const subBrand = opts && typeof opts.subBrand === "string" && opts.subBrand
    ? opts.subBrand
    : null;
  let branding = null;
  let brandSource = null;
  if (subBrand) {
    const resolved = resolveTravelHeaderBrandKit(subBrand, opts);
    branding = resolved.branding;
    brandSource = resolved.source;

    // Resolve the per-sub-brand logo BEFORE drawing (pdfkit needs the
    // buffer synchronously). Goes through module.exports.fetchLogoBuffer
    // so unit tests can vi.spyOn(...) the seam without reaching into
    // axios. Fail-soft: null buffer → render the band without a logo
    // (back-compat with pre-G091 output shape).
    const logoBuffer = branding && branding.thumbnailUrl
      ? await module.exports.fetchLogoBuffer(branding.thumbnailUrl)
      : null;

    // Brand header band — mirrors the S52 sibling renderers'
    // 60px-high top band shape so a parent flipping between a TMC
    // itinerary and a TMC consent form sees one consistent header.
    const bandColor = branding.headerColor || INVOICE_BRAND_KIT_FALLBACKS._generic.headerColor;
    doc.rect(0, 0, doc.page.width, 60).fill(bandColor);
    const subLabel = SUB_BRAND_LABEL[subBrand] || (clinic && clinic.name) || "Consent Form";
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
      .text(subLabel, 50, 22, { align: "left" });

    // Brand logo into the header band's top-right when uploaded.
    if (logoBuffer) {
      try {
        const LOGO_W = 80;
        const LOGO_H = 40;
        const LOGO_X = doc.page.width - LOGO_W - 50;
        const LOGO_Y = 10;
        doc.image(logoBuffer, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H] });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[pdfRenderer/G091] doc.image() rejected logo buffer (consent): ${err && err.message ? err.message : err}`,
        );
      }
    }
    doc.fillColor("#111");
    doc.x = doc.page.margins.left;
    doc.y = 90;
  } else {
    drawClinicHeader(doc, clinic);
  }

  const tplName = consent?.templateName || "general";
  const title = `Consent Form — ${tplName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111").text(title, { align: "center" });
  doc.moveDown(0.6);

  if (service?.name) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#555").text(`Service: ${service.name}`, { align: "center" });
    doc.moveDown(0.6);
  }

  // Consent body
  doc.font("Helvetica").fontSize(11).fillColor("#222").text(getConsentBody(tplName), {
    align: "justify",
    width: 495,
  });
  doc.moveDown(1);

  // Patient declaration
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Declaration");
  doc.font("Helvetica").fontSize(10).fillColor("#222").text(
    `I, ${patient?.name || "—"}, confirm that I have read and understood the above. ` +
      `I have had the opportunity to ask questions and all my questions have been answered ` +
      `to my satisfaction. I voluntarily give my consent to proceed.`,
    { width: 495 },
  );
  doc.moveDown(1.2);

  // Signature
  const sigTop = doc.y;
  let sigPlaced = false;
  if (signatureDataUrl && typeof signatureDataUrl === "string") {
    const m = signatureDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
    if (m) {
      try {
        const buf = Buffer.from(m[2], "base64");
        doc.image(buf, 50, sigTop, { fit: [200, 70] });
        sigPlaced = true;
      } catch (_e) {
        // fall through to line
      }
    }
  }
  if (!sigPlaced) {
    doc.moveTo(50, sigTop + 50).lineTo(250, sigTop + 50).lineWidth(0.5).strokeColor("#444").stroke();
  }
  const labelY = sigTop + 78;
  doc.font("Helvetica").fontSize(10).fillColor("#333").text("Patient Signature", 50, labelY);
  doc.text(`Name: ${patient?.name || "—"}`, 50, labelY + 14);
  doc.text(`Signed: ${formatDate(consent?.signedAt || new Date())}`, 50, labelY + 28);

  // G091 — brand-kit footer text. Sourced from opts.branding.footerText
  // (per-render override, precedence layer 1). When set AND a sub-brand
  // is active, render a small disclaimer line at the bottom margin so
  // each sub-brand can carry its own legal note (e.g. "© 2026 Travel
  // Stall Holidays — All consents acknowledged under IT Act 2000 §43A.").
  // Wellness path (no subBrand) skips this — clinic-level footers aren't
  // managed by the brand-kit resolver.
  if (subBrand && opts && opts.branding && typeof opts.branding.footerText === "string" && opts.branding.footerText.trim()) {
    const footerY = doc.page.height - doc.page.margins.bottom - 24;
    doc.font("Helvetica").fontSize(8).fillColor("#777")
      .text(
        opts.branding.footerText.trim(),
        50,
        footerY,
        { width: doc.page.width - 100, align: "center" },
      );
  }

  // G091 — observability hint: stamp the brand-kit resolution source into
  // PDF Producer metadata so on-demand inspections can tell whether the
  // PDF picked up subBrandConfigJson or fell back to the hard-coded
  // INVOICE_BRAND_KIT_FALLBACKS palette. Same pattern S34 introduced for
  // the invoice renderer.
  if (subBrand && brandSource) {
    try {
      doc.info.Producer = `pdfkit/consent brandKit=${brandSource}`;
    } catch (_e) { /* metadata write is best-effort */ }
  }

  doc.end();
  return bufPromise;
}

// ── 3. Branded Invoice PDF ─────────────────────────────────────────

async function renderBrandedInvoicePdf(invoice, contact, clinic) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  const c = safeClinic(clinic);

  // Header block — clinic name (bold, logo placeholder) + address on left, invoice meta on right
  const headerTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111").text(c.name, 50, headerTop);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  const addr = [c.addressLine, [c.city, c.state, c.pincode].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join("\n");
  if (addr) doc.text(addr, 50, doc.y);

  // Right-hand invoice meta
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text("INVOICE", 380, headerTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(`Invoice #: ${invoice?.invoiceNum || invoice?.id || "—"}`, 380, headerTop + 26, { width: 165, align: "right" });
  doc.text(`Issued: ${formatDate(invoice?.issuedDate || new Date())}`, 380, headerTop + 40, { width: 165, align: "right" });
  doc.text(`Due: ${formatDate(invoice?.dueDate)}`, 380, headerTop + 54, { width: 165, align: "right" });
  doc.text(`Status: ${invoice?.status || "UNPAID"}`, 380, headerTop + 68, { width: 165, align: "right" });

  // Move cursor below both columns
  doc.y = Math.max(doc.y, headerTop + 90);
  doc.moveDown(0.8);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor("#999").stroke();
  doc.moveDown(0.8);

  // Bill To
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Bill To");
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(contact?.name || "—");
  if (contact?.company) doc.text(contact.company);
  if (contact?.email) doc.text(contact.email);
  if (contact?.phone) doc.text(contact.phone);
  doc.moveDown(1);

  // Table header
  const tableTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", 50, tableTop);
  doc.text("Amount", 450, tableTop, { width: 95, align: "right" });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  // Single line (flat-amount invoices)
  const lineY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(`Invoice ${invoice?.invoiceNum || invoice?.id || ""}`.trim(), 50, lineY, { width: 380 });
  const amount = Number(invoice?.amount) || 0;
  doc.text(formatMoney(amount), 450, lineY, { width: 95, align: "right" });

  // Totals
  const totalsY = lineY + 40;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Total", 350, totalsY + 8, { width: 95, align: "right" });
  doc.text(formatMoney(amount), 450, totalsY + 8, { width: 95, align: "right" });

  // Terms
  const termsY = totalsY + 60;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text("Terms", 50, termsY);
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(
    "Payment is due by the date indicated above. Please quote the invoice number on any payment or correspondence.",
    50,
    termsY + 14,
    { width: 495 },
  );

  // Footer
  const footerY = 780;
  doc.font("Helvetica").fontSize(9).fillColor("#777");
  const footerLine = [c.phone, c.email].filter(Boolean).join("  |  ");
  if (footerLine) doc.text(footerLine, 50, footerY, { width: 495, align: "center" });

  doc.end();
  return bufPromise;
}

// ── 4. Patient Summary PDF ─────────────────────────────────────────
// Full multi-page dossier: profile, case history (visits + Rx + consents
// chronologically), detailed prescriptions, treatment plans, wallet ledger,
// and memberships. One file per patient, downloadable from PatientDetail.

// Strip every customer-facing reference to the upstream Zylu POS — source
// values like "zylu-import", "[ZYLU-#nnn]" markers, "Zylu booking #N"
// strings — mirroring the same UI rule applied in PatientDetail.jsx.
function scrubZyluText(text) {
  if (!text || typeof text !== 'string') return text || '';
  let t = text.replace(/\bzylu\s+booking\s*#?\s*\d+\.?/gi, '').trim();
  t = t.replace(/\[\s*zylu-?#?\d+\s*\]/gi, '').trim();
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}
function scrubZyluSource(v) {
  if (!v || (typeof v === 'string' && /^zylu/i.test(v.trim()))) return null;
  return v;
}

// Parse a Visit.photosBefore / photosAfter column. Schema stores them as
// `String? @db.Text` containing a JSON array of URLs; tolerate null,
// already-decoded arrays, and malformed JSON without throwing.
function parsePhotoUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((u) => typeof u === 'string' && u.length);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string' && u.length) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function renderPatientSummaryPdf({
  patient,
  tenant,
  clinic,
  wallet,
  walletTransactions,
  memberships,
  logoBuffer,
  photoBuffers,
}) {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  const bufPromise = streamToBuffer(doc);
  const pageRight = doc.page.width - doc.page.margins.right;
  const leftX = 50;
  const usableW = pageRight - leftX;
  const contentBottom = doc.page.height - 56; // leave room for footer band

  // Continuation pages start below the repeated header band (header is 90px).
  const CONTENT_TOP = 102;

  // Per-page section labels — every time we advance into a new logical
  // section we update `currentSection`, and the `pageAdded` listener
  // propagates it to any auto-paginated page so the footer reads e.g.
  // "Patient Profile · Page 2 of 7". Every NEW page also repeats the branded
  // header band so a multi-page summary reads as one letterhead throughout.
  const pageSectionLabels = ["Patient Profile & Case History"];
  let currentSection = "Patient Profile & Case History";
  doc.on("pageAdded", () => {
    pageSectionLabels.push(currentSection);
    drawBrandedHeader(doc, {
      brandName,
      tagline: tenant?.tagline || (brandName.toLowerCase().includes("wellness") ? "Wellness Clinic" : null),
      clinic: c,
      logoBuffer,
      leftX,
      rightX: pageRight,
    });
    doc.y = CONTENT_TOP;
  });

  const ensureSpace = (needed) => {
    if (doc.y + needed > contentBottom) {
      doc.addPage();
      doc.y = CONTENT_TOP;
    }
  };

  // Local section title — calls the shared helper but reserves vertical
  // breathing room so consecutive sections don't visually collide.
  const sectionTitle = (text, subtitle) => {
    ensureSpace(50);
    doc.moveDown(1.0);
    drawSectionTitle(doc, text, subtitle, { x: leftX, w: usableW });
  };

  // Label-value row — two fixed columns (uppercase grey label, then the
  // value in normal weight). Used inside the Treatment Plans / Wallet /
  // Memberships sections for free-form rows the card grid can't hold.
  const KV_LABEL_W = 140;
  const kv = (label, value, opts = {}) => {
    const v = value == null || value === "" ? "—" : String(value);
    ensureSpace(18);
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND.textMuted)
      .text(String(label).toUpperCase(), leftX, y + 2, {
        width: opts.labelWidth || KV_LABEL_W, characterSpacing: 1, lineBreak: false,
      });
    doc.font("Helvetica").fontSize(10).fillColor(BRAND.textDark)
      .text(v, leftX + (opts.labelWidth || KV_LABEL_W), y, {
        width: usableW - (opts.labelWidth || KV_LABEL_W),
      });
    doc.y = Math.max(doc.y, y + 16);
    doc.moveDown(0.1);
  };

  const currency = wallet?.currency || patient?.currency || "INR";

  const visits = patient?.visits || [];
  const prescriptions = patient?.prescriptions || [];
  const consents = patient?.consents || [];
  const treatmentPlans = patient?.treatmentPlans || [];
  const membershipList = memberships || [];
  const transactions = walletTransactions || [];
  const hasWalletActivity = wallet && (Number(wallet.balance) !== 0 || transactions.length > 0);

  const brandName = tenant?.name || clinic?.name || "Clinic";
  const c = safeClinic(clinic);

  // ── Branded header band (logo, brand, address) ────────────────────
  drawBrandedHeader(doc, {
    brandName,
    tagline: tenant?.tagline || (brandName.toLowerCase().includes("wellness") ? "Wellness Clinic" : null),
    clinic: c,
    logoBuffer,
    leftX,
    rightX: pageRight,
  });

  // ── Document meta info-strip (PATIENT / PATIENT ID / GENERATED / DOC) ─
  const generatedAt = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
  const stripBottomY = drawInfoStrip(
    doc,
    [
      { label: "Patient", value: patient?.name || "—" },
      { label: "Patient ID", value: patient?.id != null ? String(patient.id) : "—" },
      { label: "Generated", value: generatedAt },
      { label: "Document", value: "Patient Summary" },
    ],
    { x: leftX, y: 100, w: usableW },
  );
  doc.y = stripBottomY + 24;

  // ── Profile section ──────────────────────────────────────────────
  currentSection = "Patient Profile";
  sectionTitle("Patient Profile", "Overview & demographic information");

  // Profile card — soft panel with the serif name and green ID pill.
  // (Avatar circle removed: records have no photo, so we lead with the
  // name + ID rather than an empty placeholder disc.)
  ensureSpace(110);
  const profileCardY = doc.y;
  const profileCardH = 96;
  drawCardFrame(doc, {
    x: leftX, y: profileCardY, w: usableW, h: profileCardH,
    bg: BRAND.panelBg, border: BRAND.borderSoft,
  });
  const profileTextX = leftX + 28;
  const profileTextW = usableW - (profileTextX - leftX) - 18;
  doc.font(SERIF_BOLD).fontSize(24).fillColor(BRAND.tealDark)
    .text(patient?.name || "—", profileTextX, profileCardY + 22, {
      width: profileTextW, lineBreak: false, ellipsis: true,
    });
  if (patient?.id != null) {
    drawStatusPill(doc, `Patient ID · ${patient.id}`, profileTextX, profileCardY + 56, {
      kind: "success", fontSize: 8,
    });
  }
  doc.y = profileCardY + profileCardH + 18;

  // KV grid — DOB / Gender / Source / Phone / Email / Status as cards.
  const dobValue = patient?.dob ? `${formatDate(patient.dob)} (age ${computeAge(patient.dob)})` : "—";
  const sourceValue = scrubZyluSource(patient?.source) || "—";
  const gridRows = [
    { label: "Date of Birth", value: dobValue },
    { label: "Gender", value: patient?.gender || "—" },
    { label: "Source", value: sourceValue },
    { label: "Phone", value: patient?.phone || "—" },
    { label: "Email", value: patient?.email || "—" },
    { label: "Status", value: patient?.status || "Active" },
  ];
  const gridEndY = drawKvGrid(doc, gridRows, { x: leftX, y: doc.y, w: usableW, cols: 3 });
  doc.y = gridEndY + 12;

  // Optional supplementary rows that don't fit the card grid.
  if (patient?.bloodGroup) kv("Blood Group", patient.bloodGroup);
  if (patient?.address) kv("Address", patient.address);
  if (patient?.allergies) kv("Allergies", patient.allergies);
  if (patient?.medicalHistory) kv("Medical History", patient.medicalHistory);
  if (patient?.notes) kv("Notes", patient.notes);

  doc.moveDown(1.0);

  // ── Case history (chronological) ──────────────────────────────────
  const events = [
    ...visits.map((v) => ({ kind: "Visit", date: v.visitDate, data: v })),
    ...prescriptions.map((p) => ({ kind: "Prescription", date: p.createdAt, data: p })),
    ...consents.map((c) => ({ kind: "Consent", date: c.signedAt, data: c })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (events.length > 0) {
    currentSection = "Case History";
    // Reference uses a small uppercase label with a thin rule extending
    // right (not a full chapter title) — keeps the case-history list
    // visually anchored to the Patient Profile section above.
    ensureSpace(40);
    doc.moveDown(0.4);
    drawSectionLabelWithRule(doc, `Case History · ${events.length} Records`, { x: leftX, w: usableW });

    const KIND_PILL_KIND = { Visit: "info", Prescription: "success", Consent: "warning" };

    // Track the previous event's dot centre so we can draw a continuous
    // guide line that spans the real (now roomier) gap between events,
    // instead of the fixed-length stub that broke once spacing grew.
    let prevDotCenterY = null;
    const TL_LINE_X = leftX + 6;
    const TL_DOT_R = 4;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const isFirst = i === 0;
      const isLast = i === events.length - 1;
      ensureSpace(78);

      // Status dot colour follows the actual event status (cancelled →
      // red, completed/issued/signed → green) rather than the event kind.
      const statusForDot = e.kind === "Visit" ? (e.data.status || "completed")
        : e.kind === "Prescription" ? (parseRxInstructions(e.data.instructions).status || "issued")
        : "signed";
      const eventY = doc.y;

      // Connect the previous dot to this one — but only on the same page
      // (a page break resets eventY to the top, so prevDotCenterY would be
      // BELOW it; skip the connector in that case to avoid a stray line).
      if (prevDotCenterY != null && eventY > prevDotCenterY) {
        doc.save();
        doc.moveTo(TL_LINE_X, prevDotCenterY + TL_DOT_R)
          .lineTo(TL_LINE_X, eventY)
          .lineWidth(1).strokeColor(BRAND.border).stroke();
        doc.restore();
      }

      const tl = drawTimelineMarker(doc, {
        x: leftX, y: eventY, dotKind: statusKind(statusForDot),
        first: isFirst, last: isLast, drawConnectors: false,
      });
      prevDotCenterY = eventY + TL_DOT_R;

      // Header row: date · kind pill + service / Rx number, status pill on right.
      doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.textDark)
        .text(formatDate(e.date), tl.contentX, eventY, { lineBreak: false });
      const datePillX = tl.contentX + doc.widthOfString(formatDate(e.date)) + 10;
      drawStatusPill(doc, e.kind, datePillX, eventY - 2, {
        kind: KIND_PILL_KIND[e.kind] || "neutral", fontSize: 7.5, padX: 6, padY: 2,
      });
      doc.y = eventY + 16;

      // Deterministic vertical layout for the record body so the title, the
      // doctor sub-line, and the Notes line each get real breathing room
      // (the title uses lineBreak:false, whose auto y-advance is unreliable,
      // so we position each line explicitly instead of via moveDown).
      const titleY = eventY + 16;     // title sits below the date row
      const bodyTop = titleY + 17;    // clear gap under the title
      const bodyW = usableW - (tl.contentX - leftX);
      if (e.kind === "Visit") {
        const v = e.data;
        doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.tealDark)
          .text(v.service?.name || "Visit", tl.contentX, titleY, { width: bodyW - 80, ellipsis: true, lineBreak: false });
        if (v.status) {
          drawStatusPill(doc, v.status, pageRight - 70, titleY - 1, { fontSize: 7.5, padX: 6, padY: 2 });
        }
        const sub = [];
        if (v.doctor?.name) sub.push(v.doctor.name);
        if (v.amount != null) sub.push(formatMoney(v.amount, currency));
        let lineY = bodyTop;
        if (sub.length) {
          // Doctor name (+ amount) — darker than the old muted grey so it
          // reads clearly under the title.
          doc.font("Helvetica").fontSize(9).fillColor(BRAND.textBody)
            .text(sub.join("   ·   "), tl.contentX, lineY, { width: bodyW });
          lineY = doc.y + 4;
        }
        const n = scrubZyluText(v.notes);
        if (n) {
          doc.font("Helvetica").fontSize(9).fillColor(BRAND.textBody)
            .text(`Notes: ${n}`, tl.contentX, lineY, { width: bodyW });
        } else {
          doc.y = lineY;
        }
      } else if (e.kind === "Prescription") {
        const p = e.data;
        const drugs = parseDrugs(p.drugs);
        const summary = drugs.length
          ? drugs.map((d) => d.name || d.drug || "").filter(Boolean).join(", ")
          : "(no medications listed)";
        doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.tealDark)
          .text(`Rx #${p.id} — ${summary}`, tl.contentX, titleY, { width: bodyW, ellipsis: true, lineBreak: false });
        if (p.doctor?.name) {
          doc.font("Helvetica").fontSize(9).fillColor(BRAND.textBody)
            .text(`Prescribed by ${p.doctor.name}`, tl.contentX, bodyTop, { width: bodyW });
        } else {
          doc.y = bodyTop;
        }
      } else if (e.kind === "Consent") {
        const cn = e.data;
        const title = cn.templateName || "general";
        const tail = cn.service?.name ? ` — ${cn.service.name}` : "";
        doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.tealDark)
          .text(`${title}${tail}`, tl.contentX, titleY, { width: bodyW, ellipsis: true, lineBreak: false });
        doc.font("Helvetica").fontSize(9).fillColor(BRAND.textMuted)
          .text("Consent signed", tl.contentX, bodyTop, { width: bodyW });
      }

      // Per-event bottom padding — roomier so records breathe and don't
      // read as one dense block. The continuous connector above bridges
      // whatever gap this produces.
      doc.moveDown(1.4);
    }
    doc.moveDown(0.6);
  }

  // ── Visits (detailed) — start on a fresh page ─────────────────────
  // currentSection is set BEFORE addPage so the pageAdded listener
  // captures the right section name on the new page (it fires inside
  // addPage and reads currentSection at that moment).
  if (visits.length > 0) {
    currentSection = "Visits";
    doc.addPage();
    doc.y = CONTENT_TOP;
    sectionTitle(`Visits`, `${visits.length} visit${visits.length === 1 ? "" : "s"} on record · with before / after documentation`);
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      const beforeUrls = parsePhotoUrls(v.photosBefore);
      const afterUrls = parsePhotoUrls(v.photosAfter);
      const hasPhotos = photoBuffers && (beforeUrls.length || afterUrls.length);

      // Pre-size the visit card so the rounded frame wraps the contents.
      // Header (44pt) + meta row (28pt) + optional notes (16pt) + photos
      // (200pt when present — bigger thumbnails per the reference).
      const noteText = scrubZyluText(v.notes);
      const baseH = 44 + 32 + (noteText ? 22 : 0);
      const photoH = hasPhotos ? 220 : 0;
      const cardH = baseH + photoH + 14;
      ensureSpace(cardH + 14);

      // Top accent colour follows the visit status — red for cancelled,
      // teal for everything else. Matches the reference where cancelled
      // visit cards are unmistakably red-flagged.
      const visitKind = statusKind(v.status || "completed");
      const visitAccent = visitKind === "danger" ? STATUS_PILL.danger.border : BRAND.teal;
      const cardY = doc.y;
      drawCardFrame(doc, {
        x: leftX, y: cardY, w: usableW, h: cardH,
        topAccent: true, bg: "#FFFFFF", border: BRAND.border,
        accentColor: visitAccent,
      });

      // Visit number (serif voice) + date right-aligned
      doc.font(SERIF_BOLD).fontSize(16).fillColor(BRAND.tealDark)
        .text(`Visit #${v.id}`, leftX + 16, cardY + 14, { lineBreak: false });
      doc.font("Helvetica").fontSize(10).fillColor(BRAND.textMuted)
        .text(formatDate(v.visitDate), leftX + 16, cardY + 17, {
          width: usableW - 32, align: "right", lineBreak: false,
        });

      // Three-column meta row: SERVICE / DOCTOR / STATUS
      const metaY = cardY + 38;
      const metaColW = (usableW - 32) / 3;
      const metaCols = [
        { label: "Service", value: v.service?.name || "—" },
        { label: "Doctor", value: v.doctor?.name || "—" },
        { label: "Status", value: v.status || "—", isPill: true },
      ];
      metaCols.forEach((m, idx) => {
        const mx = leftX + 16 + metaColW * idx;
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(BRAND.textMuted)
          .text(m.label.toUpperCase(), mx, metaY, {
            width: metaColW - 8, characterSpacing: 1.1, lineBreak: false,
          });
        if (m.isPill && v.status) {
          drawStatusPill(doc, v.status, mx, metaY + 12, { fontSize: 8, padX: 7, padY: 2 });
        } else {
          doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.textDark)
            .text(m.value, mx, metaY + 12, { width: metaColW - 8, lineBreak: false, ellipsis: true });
        }
      });

      // Optional 4th meta row: Amount + Payment + Notes
      let cursorY = metaY + 30;
      const extras = [];
      if (v.amount != null) extras.push(`Amount · ${formatMoney(v.amount, currency)}`);
      if (v.paymentMode) extras.push(`Payment · ${v.paymentMode}`);
      if (extras.length) {
        doc.font("Helvetica").fontSize(9).fillColor(BRAND.textMuted)
          .text(extras.join("   ·   "), leftX + 16, cursorY, {
            width: usableW - 32, lineBreak: false, ellipsis: true,
          });
        cursorY += 14;
      }
      if (noteText) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.textMuted)
          .text("Notes · ", leftX + 16, cursorY, { continued: true })
          .font("Helvetica").fillColor(BRAND.textBody).text(noteText, { width: usableW - 64 });
        cursorY = doc.y + 2;
      }

      // Before / After photo strip — green dot bullets, large hero
      // thumbnails (one per side, fills the column width). Matches the
      // reference's "Visit #977" panel layout where each side gets a
      // single big BEFORE / AFTER image rather than a strip of small ones.
      if (hasPhotos) {
        const colGap = 18;
        const colW = (usableW - 32 - colGap) / 2;
        const thumbSize = colW;     // square that fills the column width
        const thumbH = 160;          // landscape ratio close to the reference
        const MAX_PER_SIDE = 1;
        const beforeColX = leftX + 16;
        const afterColX = leftX + 16 + colW + colGap;

        const labelY = cursorY + 6;

        // Left-side: green dot bullet + "BEFORE (N)"
        doc.save();
        doc.circle(beforeColX + 3, labelY + 4, 3).fill(STATUS_PILL.success.border);
        doc.restore();
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND.textMuted)
          .text(`BEFORE (${beforeUrls.length})`, beforeColX + 12, labelY, {
            width: colW - 12, characterSpacing: 1.1, lineBreak: false,
          });

        doc.save();
        doc.circle(afterColX + 3, labelY + 4, 3).fill(STATUS_PILL.success.border);
        doc.restore();
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND.textMuted)
          .text(`AFTER (${afterUrls.length})`, afterColX + 12, labelY, {
            width: colW - 12, characterSpacing: 1.1, lineBreak: false,
          });

        const thumbY = labelY + 16;

        const drawThumbStrip = (urls, xStart) => {
          const shown = urls.slice(0, MAX_PER_SIDE);
          for (const url of shown) {
            const buf = photoBuffers.get(url);
            let rendered = false;
            if (buf) {
              try {
                doc.save();
                doc.roundedRect(xStart, thumbY, thumbSize, thumbH, 8).clip();
                doc.image(buf, xStart, thumbY, {
                  fit: [thumbSize, thumbH],
                  align: "center",
                  valign: "center",
                });
                doc.restore();
                rendered = true;
              } catch (_e) {
                doc.restore();
                rendered = false;
              }
            }
            if (!rendered) {
              doc.save();
              doc.roundedRect(xStart, thumbY, thumbSize, thumbH, 8).fill(BRAND.panelBg);
              doc.restore();
              doc.font("Helvetica").fontSize(9).fillColor(BRAND.labelMuted)
                .text("(image)", xStart, thumbY + thumbH / 2 - 5, {
                  width: thumbSize, align: "center", lineBreak: false,
                });
            }
            doc.lineWidth(0.6).strokeColor(BRAND.border)
              .roundedRect(xStart, thumbY, thumbSize, thumbH, 8).stroke();
          }
          const extras2 = urls.length - shown.length;
          if (extras2 > 0) {
            doc.font("Helvetica").fontSize(8).fillColor(BRAND.textMuted)
              .text(`+${extras2} more`, xStart, thumbY + thumbH + 4, {
                width: colW, lineBreak: false,
              });
          }
        };

        drawThumbStrip(beforeUrls, beforeColX);
        drawThumbStrip(afterUrls, afterColX);
      }

      doc.y = cardY + cardH + 12;
    }
  }

  // ── Prescriptions — flowing layout matching the reference ─────────
  // Reference (page 4) stacks Rx #96 + Rx #95 on the SAME page when there's
  // room. We start the section on a fresh page, render its header once,
  // and let subsequent Rxes flow with `ensureSpace` — a new page is only
  // added when an Rx genuinely doesn't fit the remaining vertical space.
  if (prescriptions.length > 0) {
    currentSection = "Prescriptions";
    doc.addPage();
    doc.y = CONTENT_TOP;
    sectionTitle(
      "Prescriptions",
      `${prescriptions.length} prescription${prescriptions.length === 1 ? "" : "s"} issued`,
    );
    for (let i = 0; i < prescriptions.length; i++) {
      const p = prescriptions[i];
      const parsed = parseRxInstructions(p.instructions);
      const status = parsed.status || "Issued";
      const drugs = parseDrugs(p.drugs);
      const doctor = p.doctor || null;

      // Pre-estimate the Rx block height (header card + Rx mark + table +
      // 2 callouts). If it doesn't fit on the current page, force a new
      // page so the Rx block stays visually contiguous.
      const calloutH = (parsed.advice ? 90 : 0) + 70;
      const rowsH = 24 + drugs.length * 44 + 14;
      const blockH = 100 + 36 + rowsH + calloutH + 18;
      if (i > 0) ensureSpace(blockH);

      // Rx card — header band with Rx #, date · appt #, PRESCRIBED BY
      // row, and a green ISSUED status pill (matches the reference's
      // Rx #96 / Rx #95 layout).
      const rxCardY = doc.y;
      const rxHeaderH = 100;
      drawCardFrame(doc, {
        x: leftX, y: rxCardY, w: usableW, h: rxHeaderH,
        bg: "#FFFFFF", border: BRAND.border,
      });

      // Rx number (serif) + right-aligned issued date · appt #
      doc.font(SERIF_BOLD).fontSize(18).fillColor(BRAND.tealDark)
        .text(`Rx #${p.id ?? ""}`, leftX + 18, rxCardY + 16, { lineBreak: false });
      doc.font("Helvetica").fontSize(10).fillColor(BRAND.textMuted)
        .text(
          `${formatDate(p.createdAt)}${p.visitId != null ? ` · Appt #${p.visitId}` : ""}`,
          leftX + 18, rxCardY + 20,
          { width: usableW - 36, align: "right", lineBreak: false },
        );

      // PRESCRIBED BY + STATUS row.
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(BRAND.textMuted)
        .text("PRESCRIBED BY", leftX + 18, rxCardY + 50, {
          characterSpacing: 1.3, lineBreak: false,
        });
      doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.textMuted)
        .text("STATUS", leftX + 200, rxCardY + 50, {
          characterSpacing: 1.3, lineBreak: false,
        });
      doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.textDark)
        .text(doctor?.name ? (doctor.name.startsWith("Dr.") ? doctor.name : `Dr. ${doctor.name}`) : "—",
          leftX + 18, rxCardY + 66, { width: 170, ellipsis: true, lineBreak: false });
      drawStatusPill(doc, status, leftX + 200, rxCardY + 66, { kind: "success" });

      // Decorative Rx mark in the lower-left of the header card (matches
      // the reference's small calligraphic Rx above the medication table).
      drawRxMark(doc, { x: leftX + 18, y: rxCardY + rxHeaderH - 4, size: 22 });

      doc.y = rxCardY + rxHeaderH + 26;

      // Clinical notes block (rendered as compact rows only when present).
      const hasClinical = parsed.chiefComplaint || parsed.diagnosis || parsed.investigations;
      if (hasClinical) {
        doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.tealDark)
          .text("Clinical Notes", leftX, doc.y);
        doc.moveDown(0.3);
        const medRows = [
          ["Chief Complaint", parsed.chiefComplaint || "—"],
          ["Diagnosis", parsed.diagnosis || "—"],
          ["Investigations", parsed.investigations || "—"],
        ];
        for (const [k, vv] of medRows) {
          const y = doc.y;
          doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND.textMuted)
            .text(String(k).toUpperCase(), leftX, y + 2, {
              width: 130, characterSpacing: 1, lineBreak: false,
            });
          doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
            .text(String(vv), leftX + 130, y, { width: usableW - 130 });
          doc.y = Math.max(doc.y, y + 16);
        }
        doc.moveDown(0.4);
      }

      // Prescription Medications table — reference's 5-column layout:
      //   #  |  MEDICATION (with Form · Route subline)  |  DOSAGE
      //   |  FREQUENCY (rendered as a green pill)  |  DURATION
      // No "Instructions" column on the reference; per-drug instructions
      // flow into the post-table Notes block instead.
      const tableTop = doc.y;
      const cols = [
        { label: "#",          x: leftX,        w: 36 },
        { label: "Medication", x: leftX + 36,  w: 175 },
        { label: "Dosage",     x: leftX + 211, w: 95 },
        { label: "Frequency",  x: leftX + 306, w: 120 },
        { label: "Duration",   x: leftX + 426, w: usableW - 426 },
      ];
      doc.save();
      doc.rect(leftX, tableTop, usableW, 24).fill(BRAND.teal);
      doc.restore();
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8.5);
      for (const col of cols) {
        doc.text(col.label.toUpperCase(), col.x + 8, tableTop + 8, {
          width: col.w - 16, characterSpacing: 1.1, lineBreak: false,
        });
      }

      let rowY = tableTop + 24;
      if (drugs.length === 0) {
        doc.save();
        doc.rect(leftX, rowY, usableW, 28).fill(BRAND.panelBg);
        doc.restore();
        doc.font("Helvetica-Oblique").fontSize(10).fillColor(BRAND.textMuted)
          .text("(no medications listed)", leftX, rowY + 9, { width: usableW, align: "center" });
        rowY += 28;
      } else {
        for (let di = 0; di < drugs.length; di++) {
          const d = drugs[di];
          const strength = [d.strengthValue, d.strengthUnit].filter(Boolean).join("") || d.strength || "";
          // DOSAGE: combine free-text dosage + strength on one line.
          const dosageText = [d.dosage, strength].filter(Boolean).join(" ").trim() || "—";
          // MEDICATION subline: Form · Route (e.g. "Topical · scalp").
          const subParts = [d.preparation || d.dosageForm, d.route].filter(Boolean);
          const subText = subParts.join(" · ");
          const medName = d.name || d.drug || "—";
          const freq = d.frequency || "—";
          const duration = d.duration || "—";

          // Row height — taller when there's a Form · Route subline, tight
          // when it's a single-line medication. Matches the reference's
          // natural row density (two-line rows ≈ 44pt, one-liners ≈ 32pt).
          const rowH = subText ? 44 : 32;

          if (rowY + rowH > contentBottom) {
            doc.addPage();
            rowY = CONTENT_TOP;
            doc.save();
            doc.rect(leftX, rowY, usableW, 24).fill(BRAND.teal);
            doc.restore();
            doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8.5);
            for (const col of cols) {
              doc.text(col.label.toUpperCase(), col.x + 8, rowY + 8, {
                width: col.w - 16, characterSpacing: 1.1, lineBreak: false,
              });
            }
            rowY += 24;
          }
          if (di % 2 === 1) {
            doc.save();
            doc.rect(leftX, rowY, usableW, rowH).fill(BRAND.panelBg);
            doc.restore();
          }
          // # column — small muted number, vertically centred.
          doc.font("Helvetica").fontSize(10).fillColor(BRAND.textMuted)
            .text(String(di + 1), cols[0].x + 12, rowY + rowH / 2 - 6, {
              width: cols[0].w - 16, lineBreak: false,
            });
          // MEDICATION — bold name + optional Form · Route subline.
          doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.tealDark)
            .text(medName, cols[1].x + 8, subText ? rowY + 8 : rowY + rowH / 2 - 7, {
              width: cols[1].w - 16, ellipsis: true, lineBreak: false,
            });
          if (subText) {
            doc.font("Helvetica").fontSize(8.5).fillColor(BRAND.textMuted)
              .text(subText, cols[1].x + 8, rowY + 24, {
                width: cols[1].w - 16, ellipsis: true, lineBreak: false,
              });
          }
          // DOSAGE — regular weight, dark body.
          doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
            .text(dosageText, cols[2].x + 8, rowY + rowH / 2 - 6, {
              width: cols[2].w - 16, ellipsis: true, lineBreak: false,
            });
          // FREQUENCY — green pill, vertically centred.
          drawStatusPill(doc, freq, cols[3].x + 8, rowY + rowH / 2 - 8, {
            kind: "success", fontSize: 8, padX: 8, padY: 3,
          });
          // DURATION — regular weight.
          doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
            .text(duration, cols[4].x + 8, rowY + rowH / 2 - 6, {
              width: cols[4].w - 16, ellipsis: true, lineBreak: false,
            });
          doc.moveTo(leftX, rowY + rowH).lineTo(pageRight, rowY + rowH)
            .lineWidth(0.3).strokeColor(BRAND.borderSoft).stroke();
          rowY += rowH;
        }
      }
      doc.lineWidth(0.5).strokeColor(BRAND.border)
        .rect(leftX, tableTop, usableW, rowY - tableTop).stroke();
      doc.x = leftX;
      doc.y = rowY + 14;

      // Post-procedure care advice — amber callout (matches the reference's
      // "Post-Procedure Care" callout under Rx #96).
      if (parsed.advice) {
        drawCalloutBox(doc, {
          x: leftX, y: doc.y, w: usableW,
          heading: "Post-Procedure Care",
          body: parsed.advice,
          kind: "warning",
        });
        doc.moveDown(0.8);
      }
      doc.x = leftX;
      // Notes block — same amber callout shape as Post-Procedure Care so
      // the two read as a coherent pair. The reference's Rx #95 panel uses
      // a cream/amber "Notes:" box with the "No clinical notes recorded."
      // fallback when clinical notes are absent. The pinned string stays
      // verbatim for the vitest contract.
      drawCalloutBox(doc, {
        x: leftX, y: doc.y, w: usableW,
        heading: "Notes",
        body: parsed.notes || "No clinical notes recorded.",
        kind: "warning",
      });
      doc.moveDown(0.8);
    }
  }

  // ── Treatment plans (dark-teal hero cards) ────────────────────────
  // Reference uses a deep-teal card with cream/white text + a serif
  // amount on the right. The left accent stripe is brighter teal so the
  // cards read as a hierarchy of brand layers (header band > plan cards
  // > body content).
  if (treatmentPlans.length > 0) {
    // New page so the financial summary opens cleanly. currentSection set
    // BEFORE addPage so the new page's footer carries the right label.
    currentSection = "Treatment Plans & Wallet";
    doc.addPage();
    doc.y = CONTENT_TOP;
    sectionTitle("Treatment Plans & Wallet", "Financial summary");

    drawSectionLabelWithRule(doc, `Treatment Plans · ${treatmentPlans.length}`, { x: leftX, w: usableW });
    doc.moveDown(0.2);

    for (let i = 0; i < treatmentPlans.length; i++) {
      const t = treatmentPlans[i];
      const rowH = 72;
      ensureSpace(rowH + 12);
      const ry = doc.y;

      // Dark-teal hero card with a brighter teal left accent.
      doc.save();
      doc.roundedRect(leftX, ry, usableW, rowH, 6).fill(BRAND.tealDeep);
      doc.roundedRect(leftX, ry, 4, rowH, 2).fill(BRAND.teal);
      doc.restore();

      // Plan title (serif voice, cream/white)
      doc.font(SERIF_BOLD).fontSize(14).fillColor("#FFFFFF")
        .text(`Plan #${t.id} · ${t.service?.name || "—"}`, leftX + 22, ry + 16, {
          width: usableW - 240, ellipsis: true, lineBreak: false,
        });
      if (t.status) {
        drawStatusPill(doc, t.status, leftX + 22, ry + 42, {
          kind: "success", fontSize: 8, padX: 8,
        });
      }

      // Right-aligned amount (serif, cream/white) — matches the reference's
      // "₹ 1,25,000.00" treatment plan amount style.
      if (t.totalPrice != null) {
        doc.font(SERIF_BOLD).fontSize(20).fillColor("#FAF6F0")
          .text(formatMoney(t.totalPrice, currency), leftX, ry + 24, {
            width: usableW - 22, align: "right", lineBreak: false,
          });
      }

      // Sessions / notes — small cream subtitle inline after the status pill.
      const subBits = [];
      if (t.sessionsTotal != null || t.sessionsCompleted != null) {
        subBits.push(`Sessions ${t.sessionsCompleted ?? 0} / ${t.sessionsTotal ?? "—"}`);
      }
      if (t.notes) subBits.push(scrubZyluText(t.notes));
      if (subBits.length) {
        doc.font("Helvetica").fontSize(9).fillColor("#CFE3DE")
          .text(subBits.join("   ·   "), leftX + 22 + 84, ry + 46, {
            width: usableW - 280, lineBreak: false, ellipsis: true,
          });
      }
      doc.y = ry + rowH + 10;
    }
    doc.moveDown(0.6);
  }

  // ── Wallet ────────────────────────────────────────────────────────
  if (hasWalletActivity) {
    if (treatmentPlans.length === 0) {
      currentSection = "Wallet";
      doc.addPage();
      doc.y = CONTENT_TOP;
      sectionTitle("Wallet", "Financial summary");
    }
    drawSectionLabelWithRule(doc, "Wallet", { x: leftX, w: usableW });
    doc.moveDown(0.2);

    const walletCardH = 86;
    ensureSpace(walletCardH + 12);
    const wy = doc.y;
    // Deep-teal hero card matching the treatment-plan cards above —
    // cream/white label + serif balance + credit-card glyph on the right.
    doc.save();
    doc.roundedRect(leftX, wy, usableW, walletCardH, 6).fill(BRAND.tealDeep);
    doc.restore();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#CFE3DE")
      .text("CURRENT BALANCE", leftX + 22, wy + 18, {
        characterSpacing: 1.5, lineBreak: false,
      });
    doc.font(SERIF_BOLD).fontSize(28).fillColor("#FAF6F0")
      .text(formatMoney(wallet.balance, currency), leftX + 22, wy + 34, { lineBreak: false });
    doc.font("Helvetica").fontSize(9).fillColor("#CFE3DE")
      .text(`Currency · ${currency}`, leftX + 22, wy + 68, { lineBreak: false });

    // Credit-card glyph on the right — cream rectangle with a magnetic
    // stripe + accent strip beneath, matches the reference's wallet card.
    const glyphX = pageRight - 80;
    const glyphY = wy + 26;
    doc.save();
    doc.roundedRect(glyphX, glyphY, 56, 34, 5).fillAndStroke("#FAF6F0", BRAND.gold);
    doc.rect(glyphX + 4, glyphY + 22, 14, 3).fill(BRAND.tealDeep);
    doc.rect(glyphX + 32, glyphY + 22, 20, 3).fill(BRAND.gold);
    doc.restore();
    doc.y = wy + walletCardH + 14;

    if (transactions.length > 0) {
      drawSectionLabelWithRule(doc, `Recent Transactions · ${transactions.length}`, { x: leftX, w: usableW });
      doc.moveDown(0.2);
      const tableTop = doc.y;
      const cols = [
        { label: "Date", x: leftX, w: 90 },
        { label: "Type", x: leftX + 90, w: 110 },
        { label: "Amount", x: leftX + 200, w: 90 },
        { label: "Reason", x: leftX + 290, w: usableW - 290 },
      ];
      doc.save();
      doc.rect(leftX, tableTop, usableW, 22).fill(BRAND.teal);
      doc.restore();
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8.5);
      for (const cc of cols) doc.text(cc.label, cc.x + 4, tableTop + 7, { width: cc.w - 8, lineBreak: false });
      let rowY = tableTop + 22;
      for (let ti = 0; ti < transactions.length; ti++) {
        const tx = transactions[ti];
        const cells = [
          formatDate(tx.createdAt),
          String(tx.type || "").replace(/_/g, " "),
          `${tx.amount >= 0 ? "+" : ""}${formatMoney(tx.amount, currency)}`,
          tx.reason || "—",
        ];
        const heights = cells.map((val, idx) => doc.heightOfString(String(val), { width: cols[idx].w - 8 }));
        const rowH = Math.max(18, ...heights) + 6;
        if (rowY + rowH > contentBottom) {
          doc.addPage();
          rowY = CONTENT_TOP;
        }
        if (ti % 2 === 1) {
          doc.save();
          doc.rect(leftX, rowY, usableW, rowH).fill(BRAND.panelBg);
          doc.restore();
        }
        const amtKind = (Number(tx.amount) || 0) >= 0 ? "success" : "danger";
        doc.font("Helvetica").fontSize(9).fillColor(BRAND.textBody);
        cells.forEach((val, idx) => {
          // Color the amount column with semantic intent.
          if (idx === 2) {
            doc.fillColor(STATUS_PILL[amtKind].border)
              .font("Helvetica-Bold")
              .text(String(val), cols[idx].x + 4, rowY + 5, { width: cols[idx].w - 8 });
            doc.font("Helvetica").fillColor(BRAND.textBody);
          } else {
            doc.text(String(val), cols[idx].x + 4, rowY + 5, { width: cols[idx].w - 8 });
          }
        });
        doc.moveTo(leftX, rowY + rowH).lineTo(pageRight, rowY + rowH)
          .lineWidth(0.3).strokeColor(BRAND.borderSoft).stroke();
        rowY += rowH;
      }
      doc.lineWidth(0.5).strokeColor(BRAND.border)
        .rect(leftX, tableTop, usableW, rowY - tableTop).stroke();
      doc.y = rowY + 12;
    }
  }

  // ── Memberships ───────────────────────────────────────────────────
  if (membershipList.length > 0) {
    // currentSection set BEFORE the ensureSpace check that may trigger
    // addPage, so the new page (if any) gets the right footer label.
    currentSection = "Memberships";
    ensureSpace(80);
    sectionTitle("Memberships", `${membershipList.length} membership${membershipList.length === 1 ? "" : "s"}`);
    for (let i = 0; i < membershipList.length; i++) {
      const m = membershipList[i];
      const rowH = 70;
      ensureSpace(rowH + 10);
      const ry = doc.y;
      drawCardFrame(doc, { x: leftX, y: ry, w: usableW, h: rowH, leftAccent: true });

      doc.font("Helvetica-Bold").fontSize(13).fillColor(BRAND.tealDark)
        .text(m.plan?.name || "Plan", leftX + 18, ry + 12, {
          width: usableW - 200, ellipsis: true, lineBreak: false,
        });
      doc.font("Helvetica").fontSize(9).fillColor(BRAND.textMuted)
        .text(`Membership #${m.id}`, leftX + 18, ry + 30, { lineBreak: false });

      const mBits = [];
      if (m.startDate) mBits.push(`Start · ${formatDate(m.startDate)}`);
      if (m.endDate) mBits.push(`End · ${formatDate(m.endDate)}`);
      doc.font("Helvetica").fontSize(9).fillColor(BRAND.textMuted)
        .text(mBits.join("   ·   "), leftX + 18, ry + 46, {
          width: usableW - 200, ellipsis: true, lineBreak: false,
        });

      if (m.status) drawStatusPill(doc, m.status, pageRight - 80, ry + 14);
      if (m.plan?.price != null) {
        doc.font("Helvetica-Bold").fontSize(14).fillColor(BRAND.tealDark)
          .text(formatMoney(m.plan.price, m.plan.currency || currency), leftX, ry + 38, {
            width: usableW - 16, align: "right", lineBreak: false,
          });
      }
      doc.y = ry + rowH + 8;
    }
  }

  // ── Branded footer pass (page numbers + section label) ────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawBrandedFooter(doc, {
      brandName,
      sectionLabel: pageSectionLabels[i] || "Patient Summary",
      pageIndex: i,
      pageCount: range.count,
      leftX,
      rightX: pageRight,
    });
  }

  doc.end();
  return bufPromise;
}

// ── POS receipt PDF (D17 Arc 1 slice 6) ────────────────────────────
//
// Pure helper: caller fetches tenant-scoped sale/lines/payments/patient/
// tenant rows via prisma and passes plain objects in — we turn them into
// PDF bytes ready for res.send() or disk write. Layout per PRD §3.7 +
// §6.4; mirrors renderBrandedInvoicePdf primitives (A4, 50pt margin).
//
// NOTE: this helper was lost when PR #916 merged a stale rewrite of
// pdfRenderer.js (slice 6 had landed via commit 4ee88c47 prior). Restored
// here against the original spec so backend/test/services/pdfRenderer-
// pos-receipt.test.js can pin the contract again.

function generatePosReceiptPdf(opts) {
  const {
    sale = {},
    lines = [],
    payments = [],
    patient = null,
    tenant = null,
  } = opts || {};

  const currency = sale.currency || "INR";
  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // ── Top header: tenant name + address + invoice meta ──────────────
  const tenantName = (tenant && tenant.name) || "Clinic";
  const addrParts = tenant
    ? [
        tenant.addressLine,
        [tenant.city, tenant.state, tenant.pincode].filter(Boolean).join(", "),
      ].filter(Boolean)
    : [];
  const tenantContact = tenant
    ? [tenant.phone, tenant.email].filter(Boolean).join("  |  ")
    : "";

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111").text(tenantName, 50, 50);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  if (addrParts.length > 0) doc.text(addrParts.join("\n"), 50, doc.y);
  if (tenantContact) doc.text(tenantContact, 50, doc.y);

  // Right-column: invoice number + completedAt
  const invoiceNumber = `INV-${sale.id != null ? sale.id : "?"}`;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111")
    .text("RECEIPT", 380, 50, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(invoiceNumber, 380, 70, { width: 165, align: "right" });
  doc.text(formatDate(sale.completedAt || new Date()), 380, 84, {
    width: 165,
    align: "right",
  });

  // Advance below both columns
  doc.y = Math.max(doc.y, 110);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor("#999").stroke();
  doc.moveDown(0.8);
  doc.fillColor("#111");

  // ── Patient block ─────────────────────────────────────────────────
  if (patient) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Customer", 50, doc.y);
    doc.font("Helvetica").fontSize(10).fillColor("#222");
    if (patient.name) doc.text(patient.name, 50, doc.y);
    if (patient.phone) doc.text(patient.phone, 50, doc.y);
    doc.moveDown(0.6);
  }

  // ── Line items table ──────────────────────────────────────────────
  const tableTop = doc.y;
  const colX = { desc: 50, qty: 300, unit: 370, total: 460 };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
  doc.text("Unit Price", colX.unit, tableTop, { width: 80, align: "right" });
  doc.text("Line Total", colX.total, tableTop, { width: 85, align: "right" });
  doc.moveTo(50, tableTop + 14)
    .lineTo(545, tableTop + 14)
    .lineWidth(0.5)
    .strokeColor("#bbb")
    .stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  if (!Array.isArray(lines) || lines.length === 0) {
    doc.fillColor("#777").text("(No line items.)", colX.desc, rowY, { width: 480 });
    rowY += 18;
  } else {
    for (const ln of lines) {
      if (rowY > 700) {
        doc.addPage();
        rowY = 60;
      }
      const qty = Number(ln.qty) || 0;
      const unit = Number(ln.unitPrice) || 0;
      const total = ln.lineTotal != null ? Number(ln.lineTotal) : qty * unit;
      doc.fillColor("#222");
      doc.text(String(ln.description || "—"), colX.desc, rowY, { width: 240 });
      doc.text(String(qty), colX.qty, rowY, { width: 50, align: "right" });
      doc.text(fmt(unit), colX.unit, rowY, { width: 80, align: "right" });
      doc.text(fmt(total), colX.total, rowY, { width: 85, align: "right" });
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  // ── Totals block (right-aligned) ──────────────────────────────────
  const subtotal = Number(sale.subtotal) || 0;
  const discount = Number(sale.discount) || 0;
  const tax = Number(sale.tax) || 0;
  const grandTotal =
    sale.grandTotal != null
      ? Number(sale.grandTotal)
      : subtotal - discount + tax;

  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  let ty = totalsY + 8;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(subtotal), 450, ty, { width: 95, align: "right" });
  ty += 16;

  // Discount + Tax rows only render when non-zero (PRD §6.4: hide-or-zero
  // is acceptable; we hide to keep the receipt visually tight).
  if (discount > 0) {
    doc.text("Discount", 350, ty, { width: 95, align: "right" });
    doc.text(`-${fmt(discount)}`, 450, ty, { width: 95, align: "right" });
    ty += 16;
  }
  if (tax > 0) {
    doc.text("Tax", 350, ty, { width: 95, align: "right" });
    doc.text(fmt(tax), 450, ty, { width: 95, align: "right" });
    ty += 16;
  }

  // Grand-total line (bold)
  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Grand Total", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 22;

  doc.y = ty + 8;

  // ── Payments section (split-tender shows every row) ───────────────
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Payments", 50, doc.y);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  if (!Array.isArray(payments) || payments.length === 0) {
    doc.fillColor("#777").text("(No payments recorded.)", 50, doc.y, { width: 480 });
  } else {
    for (const p of payments) {
      const method = String(p.method || "—");
      const amount = Number(p.amount) || 0;
      doc.fillColor("#222").text(`${method} ... ${fmt(amount)}`, 50, doc.y);
    }
  }
  doc.moveDown(1.2);

  // ── Footer: thank-you + powered-by ────────────────────────────────
  const footerY = doc.page.height - doc.page.margins.bottom - 36;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.4).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(10).fillColor("#333").text(
    "Thank you for your visit",
    50,
    footerY + 8,
    { width: doc.page.width - 100, align: "center" },
  );
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#888").text(
    "Powered by Globussoft CRM",
    50,
    footerY + 22,
    { width: doc.page.width - 100, align: "center" },
  );

  doc.end();
  return bufPromise;
}

// ── Travel CRM — diagnostic report ──────────────────────────────────
//
// PRD §4.2: "Auto-generated branded PDF report — sub-brand logo/colors/
// fonts; sent by WhatsApp + email immediately on completion."

const SUB_BRAND_LABEL = {
  tmc: "TMC — School Trips",
  rfu: "RFU — Umrah Readiness",
  travelstall: "Travel Stall — Family Travel",
  visasure: "Visa Sure — Visa Readiness",
};
const SUB_BRAND_ACCENT = {
  tmc: "#0B4F6C",
  rfu: "#2F7A4D",
  travelstall: "#122647",
  visasure: "#7A2F5C",
};

// ---------------------------------------------------------------------------
// Brand-kit-aware invoice PDF defaults — S34 (TRAVEL_BIG_SCOPE_BACKLOG.md,
// PRD_TRAVEL_BILLING.md "Per-sub-brand PDF invoice templates").
//
// Same shape as the S13 itinerary-template selector
// (backend/routes/travel_itinerary_templates.js, commit 1541a063) — same key
// set, same fallback hex values per sub-brand, same precedence chain. The
// FALLBACKS constant is replicated VERBATIM from S13 to keep cross-doc
// consistency between itinerary templates + invoice PDFs (an admin who
// configures a sub-brand block once gets matching colors across both surfaces).
//
// On PDF render, when the caller doesn't override branding, we read
// `tenant.subBrandConfigJson` (legacy admin-curated per-sub-brand kit) and
// resolve deterministic defaults for the invoice's `subBrand` (or top-level /
// generic fall-through).
//
// Q22 (Yasin brand pack) is the content-blocker for the actual logo asset URLs
// + final-approved hex codes; until then `subBrandConfigJson` is typically
// empty/null in production, so this slice falls back to a hard-coded
// sensible-default palette per sub-brand. When the brand pack lands, an ADMIN
// PATCH of the tenant's subBrandConfigJson (single update) cascades into every
// future invoice + itinerary render — no per-route edit needed.
//
// JSON shape consumed (one of):
//   { tmc:        { thumbnailUrl?, primaryColor?, accentColor?,
//                   headerColor?, fontFamily? },
//     rfu:        { ... }, travelstall: { ... }, visasure: { ... },
//     // optional top-level fallback used when invoice has no subBrand
//     thumbnailUrl?, primaryColor?, accentColor?, headerColor?, fontFamily?
//   }
//
// Output (consumed by renderTravelInvoicePdf):
//   - branding.headerColor   ← cfg.headerColor   (top-band fill)
//   - branding.primaryColor  ← cfg.primaryColor  (totals + section accents)
//   - branding.accentColor   ← cfg.accentColor   (divider rules, secondary)
//   - branding.fontFamily    ← cfg.fontFamily    (reserved — pdfkit is
//                                                 limited to Helvetica /
//                                                 Times / Courier built-ins,
//                                                 so this field is recorded
//                                                 for forward-compat once
//                                                 we wire a custom font
//                                                 loader; today it's a
//                                                 metadata-only field).
//   - branding.thumbnailUrl  ← cfg.thumbnailUrl  (logo for top-band; null
//                                                 fallback means "skip logo
//                                                 image" — operator hasn't
//                                                 uploaded one yet).
//   - branding._source       ← "subBrandConfig" | "fallback"
//
// Caller precedence (highest first):
//   1. Explicit per-render override (opts.branding.*)
//   2. Per-sub-brand block in subBrandConfigJson[subBrand]
//   3. Top-level block in subBrandConfigJson
//   4. Hard-coded fallback per sub-brand (INVOICE_BRAND_KIT_FALLBACKS below)
//
// Backward compat: wellness invoices (renderBrandedInvoicePdf) don't have
// a `subBrand` and don't pass through this selector at all — that path is
// unchanged. Travel invoices without a subBrand (defensive — TravelInvoice's
// schema requires subBrand so this is a paranoid fallback) drop to _generic.
const INVOICE_BRAND_KIT_FIELDS = [
  "thumbnailUrl",
  "primaryColor",
  "accentColor",
  "headerColor",
  "fontFamily",
];

// Per-sub-brand fallback defaults — replicated VERBATIM from S13's
// BRAND_KIT_FALLBACKS (backend/routes/travel_itinerary_templates.js:123-129).
// Colors are WCAG-AA on white; Inter is the same family Marketing Flyer Studio
// + main app use. thumbnailUrl=null because Q22 hasn't landed (operator
// uploads on save).
const INVOICE_BRAND_KIT_FALLBACKS = {
  tmc:         { thumbnailUrl: null, primaryColor: "#1F4E79", accentColor: "#F2B544", headerColor: "#1F4E79", fontFamily: "Inter, sans-serif" },
  rfu:         { thumbnailUrl: null, primaryColor: "#0B5345", accentColor: "#D4AC0D", headerColor: "#0B5345", fontFamily: "Inter, sans-serif" },
  travelstall: { thumbnailUrl: null, primaryColor: "#C0392B", accentColor: "#F39C12", headerColor: "#922B21", fontFamily: "Inter, sans-serif" },
  visasure:    { thumbnailUrl: null, primaryColor: "#283747", accentColor: "#5DADE2", headerColor: "#283747", fontFamily: "Inter, sans-serif" },
  _generic:    { thumbnailUrl: null, primaryColor: "#1F4E79", accentColor: "#F2B544", headerColor: "#1F4E79", fontFamily: "Inter, sans-serif" },
};

function parseInvoiceSubBrandConfig(jsonString) {
  if (!jsonString || typeof jsonString !== "string") return {};
  try {
    const obj = JSON.parse(jsonString);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj;
  } catch (_e) {
    // Malformed JSON → return empty so we fall through to hard-coded
    // fallback. Don't throw — a bad admin-saved blob shouldn't kill an
    // invoice download.
    return {};
  }
}

// S52 — alias for the parser so the generic name (`parseTravelSubBrandConfig`)
// is available to sibling travel PDF helpers (itinerary / quote / diagnostic /
// tmc-readiness / travelstall-personalised) that now consume the same selector.
// `parseInvoiceSubBrandConfig` is kept as the S34 export name for back-compat
// with the existing brand-kit test suite + the invoice renderer.
const parseTravelSubBrandConfig = parseInvoiceSubBrandConfig;

// Pick brand-kit fields for a given sub-brand from the parsed config blob.
// Sub-brand block first, then top-level fallback, then hard-coded
// per-sub-brand defaults. Returns { fields: {...}, source: "..." } where
// source ∈ {"subBrandConfig" | "fallback"} for downstream callers + tests
// that want to assert the resolution path.
function resolveInvoiceBrandKit(cfg, subBrand) {
  const out = {};
  let usedConfig = false;
  const subBlock = subBrand && cfg && typeof cfg[subBrand] === "object" && !Array.isArray(cfg[subBrand])
    ? cfg[subBrand]
    : null;

  for (const f of INVOICE_BRAND_KIT_FIELDS) {
    if (subBlock && subBlock[f] !== undefined && subBlock[f] !== null && subBlock[f] !== "") {
      out[f] = subBlock[f];
      usedConfig = true;
    } else if (cfg && cfg[f] !== undefined && cfg[f] !== null && cfg[f] !== "") {
      out[f] = cfg[f];
      usedConfig = true;
    }
  }

  // Backfill missing fields from the hard-coded fallback so the returned
  // object is always shape-complete. Source remains "subBrandConfig" if at
  // least one field came from config; "fallback" only when ZERO fields came
  // from config.
  const fallbackKey = subBrand && INVOICE_BRAND_KIT_FALLBACKS[subBrand] ? subBrand : "_generic";
  const fallback = INVOICE_BRAND_KIT_FALLBACKS[fallbackKey];
  for (const f of INVOICE_BRAND_KIT_FIELDS) {
    if (out[f] === undefined) out[f] = fallback[f];
  }

  return { fields: out, source: usedConfig ? "subBrandConfig" : "fallback" };
}

// S52 — alias the resolver under the generic name (`resolveTravelBrandKit`)
// so sibling travel PDF helpers don't carry an "Invoice" suffix when reading
// it. Same body, same shape, same precedence chain. Keeping the original
// `resolveInvoiceBrandKit` name as an alias retains the S34 test surface +
// the invoice renderer's call-site verbatim.
const resolveTravelBrandKit = resolveInvoiceBrandKit;

// S52 — shared brand-kit resolution helper for the 5 sibling travel PDF
// helpers (itinerary / quote / diagnostic / tmc-readiness / travelstall-
// personalised). Each renderer threads `opts.tenant` + `opts.branding` and
// calls this once at top-of-body to resolve the effective brand kit.
//
// Precedence (matches S34 for invoice PDFs):
//   1. opts.branding override fields (per-render explicit, layer 1)
//   2. tenant.subBrandConfigJson[subBrand] (per-sub-brand config, layer 2)
//   3. tenant.subBrandConfigJson top-level keys (top-level fallback, layer 3)
//   4. INVOICE_BRAND_KIT_FALLBACKS[subBrand] (hard-coded, layer 4)
//
// Returns { branding, source } where:
//   - branding has every BRAND_KIT_FIELD shape-complete (headerColor,
//     primaryColor, accentColor, thumbnailUrl, fontFamily).
//   - source ∈ {"subBrandConfig", "fallback"} for observability (the invoice
//     renderer stamps it into PDF Producer metadata; the sibling renderers
//     don't currently surface it but the same field is available).
//
// Sibling helpers used to read `accent = SUB_BRAND_ACCENT[sub] || "#111111"`.
// After S52, the call site reads `branding.headerColor` from this helper,
// which sources from tenant.subBrandConfigJson when available and falls back
// to INVOICE_BRAND_KIT_FALLBACKS otherwise. The SUB_BRAND_ACCENT constant is
// retained for any non-travel call sites (none today, but leaving it in case
// a future deletion would surface an unexpected consumer).
function resolveTravelHeaderBrandKit(subBrand, opts = {}) {
  const tenant = opts && opts.tenant;
  const cfg = parseTravelSubBrandConfig(tenant && tenant.subBrandConfigJson);
  const { fields, source } = resolveTravelBrandKit(cfg, subBrand);
  const callerBranding = (opts && opts.branding && typeof opts.branding === "object")
    ? opts.branding
    : {};
  const branding = { ...fields, ...callerBranding };
  return { branding, source };
}
// ---------------------------------------------------------------------------

function resolveAnswerLabel(question, rawAnswer) {
  if (rawAnswer == null) return "—";
  if (Array.isArray(question?.options) && question.options.length > 0) {
    const lookup = (val) => {
      const opt = question.options.find((o) => o && o.value === val);
      return opt ? (opt.label || opt.value) : String(val);
    };
    if (Array.isArray(rawAnswer)) return rawAnswer.map(lookup).join(", ");
    return lookup(rawAnswer);
  }
  if (Array.isArray(rawAnswer)) return rawAnswer.join(", ");
  return String(rawAnswer);
}

// ── Travel CRM — dynamic viewer-identity watermark (PRD §4.7, gap A3) ──
//
// applyViewerWatermark(doc, { viewerName, viewerEmail, timestamp })
//
// Draws a light diagonal repeating "<name> · <email> · <ISO timestamp>"
// text watermark across the CURRENT page so a leaked/forwarded travel
// document identifies who pulled it and when. Distinct from the wellness
// design-system watermark (a static brand mark) — this one is per-viewer
// and only applied when a renderer is called with `opts.viewerWatermark`
// (default OFF, so existing callers + pinned vitest output are
// byte-stable).
//
// Drawn FIRST on each page so real content paints over it — at 0.08 fill
// opacity the body text stays fully readable. Cursor (doc.x/doc.y) and
// graphics state are restored afterwards so the watermark never disturbs
// the calling renderer's layout flow. Exported for unit tests + reused
// via the module.exports self-mocking seam (same pattern as
// fetchLogoBuffer) so vitest can spy on application.
function applyViewerWatermark(doc, viewer = {}) {
  // Re-entrancy guard: this helper is wired to the document's pageAdded
  // hook, and doc.text() can itself trigger pdfkit auto-pagination.
  // Auto-paging is suppressed below (maxY shadow) but belt-and-braces:
  // never let a nested pageAdded re-enter the draw loop.
  if (doc._viewerWatermarkActive) return;

  const name = viewer.viewerName != null ? String(viewer.viewerName).trim() : "";
  const email = viewer.viewerEmail != null ? String(viewer.viewerEmail).trim() : "";
  const ts = viewer.timestamp != null && String(viewer.timestamp).trim() !== ""
    ? String(viewer.timestamp).trim()
    : new Date().toISOString();
  const label = [name, email, ts].filter(Boolean).join(" · ");
  if (!label) return;

  const w = doc.page.width;
  const h = doc.page.height;
  const prevX = doc.x;
  const prevY = doc.y;
  const page = doc.page;
  // pdfkit auto-adds a page when a text line lands past page.maxY() —
  // for a watermark that intentionally tiles beyond the page bounds
  // (rotation coverage), that would addPage → fire pageAdded → recurse.
  // Shadow maxY() with an own-property no-limit stub for the duration of
  // the draw; rows past the physical page are simply clipped, which is
  // exactly what a watermark wants.
  const hadOwnMaxY = Object.prototype.hasOwnProperty.call(page, "maxY");
  const prevMaxY = page.maxY;
  page.maxY = () => Number.MAX_SAFE_INTEGER;
  doc._viewerWatermarkActive = true;
  doc.save();
  try {
    // Diagonal repeat: rotate the canvas around the page centre, then lay
    // the label out in evenly spaced rows spanning beyond the page bounds
    // so the rotation leaves no unwatermarked corners.
    doc.rotate(-35, { origin: [w / 2, h / 2] });
    doc.font("Helvetica").fontSize(11).fillColor("#000").fillOpacity(0.08);
    const stepY = 90;
    for (let y = -h; y < h * 2; y += stepY) {
      doc.text(label, -w / 2, y, { width: w * 2, align: "center", lineBreak: false });
    }
  } finally {
    doc.restore();
    if (hadOwnMaxY) page.maxY = prevMaxY;
    else delete page.maxY; // fall back to the PDFPage prototype method
    doc._viewerWatermarkActive = false;
    // pdfkit's q/Q save/restore covers the PDF graphics state, but the
    // JS-side opacity/cursor trackers are ours to put back.
    doc.fillOpacity(1);
    doc.x = prevX;
    doc.y = prevY;
  }
}

// ── Travel CRM — branded itinerary PDF (PRD §6.1) ────────────────────
// Ported from the canonical implementation; the routes
// (travel_itineraries.js / travel_travelstall.js) reference these two
// renderers but they were missing from this worktree's pdfRenderer.js,
// so every /itineraries/:id/pdf + personalised-pdf call 500'd.
//
// S52 — `opts.tenant` (optional) threads `tenant.subBrandConfigJson` into
// the shared brand-kit selector so an admin POST to that column cascades
// into this PDF too. `opts.branding` (optional) per-render override is the
// highest-precedence layer. When `opts` is omitted (legacy caller), the
// renderer falls back to INVOICE_BRAND_KIT_FALLBACKS per sub-brand — same
// palette the invoice renderer uses, so the four travel sub-brands now
// share one curated color set. Pre-S52, the header color came from the
// legacy SUB_BRAND_ACCENT constant; that constant is retained for any
// non-travel call site but no longer consulted here.
async function renderTravelItineraryPdf(itinerary, contact, opts = {}) {
  const sub = itinerary.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  const { branding } = resolveTravelHeaderBrandKit(sub, opts);
  const accent = branding.headerColor || INVOICE_BRAND_KIT_FALLBACKS._generic.headerColor;
  const currency = itinerary.currency || "INR";
  const items = Array.isArray(itinerary.items) ? itinerary.items : [];

  // S65 — fetch the per-sub-brand logo (if any) BEFORE we start drawing.
  // pdfkit's doc.image() needs the buffer synchronously, so we resolve the
  // remote URL up front. Goes through module.exports.fetchLogoBuffer so
  // unit tests can vi.spyOn(...) the seam without reaching into axios.
  // Fail-soft: on any error, the helper returns null and we render a
  // logo-less header band (back-compat with pre-S65 output).
  const logoBuffer = branding.thumbnailUrl
    ? await module.exports.fetchLogoBuffer(branding.thumbnailUrl)
    : null;

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // PRD §4.7 (gap A3) — per-viewer watermark, opt-in via
  // opts.viewerWatermark ({ viewerName, viewerEmail, timestamp }).
  // Default OFF so existing callers/tests are unaffected. Re-applied on
  // every page the items table spills onto via the pageAdded hook.
  if (opts.viewerWatermark) {
    module.exports.applyViewerWatermark(doc, opts.viewerWatermark);
    doc.on("pageAdded", () => module.exports.applyViewerWatermark(doc, opts.viewerWatermark));
  }

  // Brand header band
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text(
    `Itinerary v${itinerary.version || 1}`,
    50, 42, { align: "left" },
  );

  // S65 — embed brand logo into the header band's top-right (80×40 fit box
  // at right edge). doc.image() throws on invalid buffers; wrap in try/catch
  // so a malformed logo can't 500 the download. The brand color band still
  // renders behind the logo regardless.
  if (logoBuffer) {
    try {
      const LOGO_W = 80;
      const LOGO_H = 40;
      const LOGO_X = doc.page.width - LOGO_W - 50;
      const LOGO_Y = 10;
      doc.image(logoBuffer, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H] });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pdfRenderer/S65] doc.image() rejected logo buffer (itinerary): ${err && err.message ? err.message : err}`,
      );
    }
  }

  doc.fillColor("#111").moveDown(2);

  // Customer block
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(contact?.name || "Customer", 50, 90);
  const metaLine = [contact?.email, contact?.phone].filter(Boolean).join("  •  ");
  if (metaLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(metaLine);
  doc.moveDown(0.5);

  // Trip-summary block
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text(itinerary.destination || "Destination TBD");
  const dateLine = [
    itinerary.startDate && `From ${formatDate(itinerary.startDate)}`,
    itinerary.endDate && `to ${formatDate(itinerary.endDate)}`,
  ].filter(Boolean).join(" ");
  if (dateLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(dateLine);
  doc.fillColor("#111").moveDown(0.8);

  // Destination hero banner — a real photo of the destination (resolved by the
  // route via lib/destinationImage and passed in as opts.heroBuffer; null on a
  // restricted/offline server, in which case we simply skip it). Banner-cropped
  // upstream, so fit:[W,150] renders it full-width. doc.image throws on a bad
  // buffer, so wrap it — a bad photo must never 500 the download.
  if (opts.heroBuffer) {
    try {
      const BANNER_W = doc.page.width - 100;
      const BANNER_H = 150;
      const by = doc.y;
      doc.image(opts.heroBuffer, 50, by, { fit: [BANNER_W, BANNER_H], align: "center", valign: "center" });
      doc.y = by + BANNER_H + 12;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[pdfRenderer] hero image rejected (itinerary): ${err && err.message ? err.message : err}`);
    }
  }

  // Items table
  if (items.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#777").text("(No items on this itinerary yet — quote pending.)");
  } else {
    // Table header
    const colX = { type: 50, desc: 115, qty: 360, unit: 410, total: 480 };
    const tableTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
    doc.text("Type", colX.type, tableTop);
    doc.text("Description", colX.desc, tableTop);
    doc.text("Markup", colX.qty, tableTop);
    doc.text("Unit cost", colX.unit, tableTop);
    doc.text("Total", colX.total, tableTop);
    doc.moveTo(50, tableTop + 14)
      .lineTo(doc.page.width - 50, tableTop + 14)
      .lineWidth(0.5).strokeColor(accent).stroke();
    doc.font("Helvetica").fontSize(10).fillColor("#111");

    let y = tableTop + 22;
    const sorted = [...items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const it of sorted) {
      // Page-break headroom
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 50;
      }
      doc.text(String(it.itemType || "—"), colX.type, y, { width: 60 });
      doc.text(String(it.description || ""), colX.desc, y, { width: 240 });
      const markupStr = it.markup != null ? formatMoney(Number(it.markup), currency) : "—";
      const unitStr = it.unitCost != null ? formatMoney(Number(it.unitCost), currency) : "—";
      const totalStr = it.totalPrice != null ? formatMoney(Number(it.totalPrice), currency) : "—";
      doc.text(markupStr, colX.qty, y, { width: 50, align: "right" });
      doc.text(unitStr, colX.unit, y, { width: 65, align: "right" });
      doc.text(totalStr, colX.total, y, { width: 60, align: "right" });
      y += 24;
    }
    doc.y = y + 6;
  }

  // Grand total band
  if (itinerary.totalAmount != null) {
    doc.moveDown(0.8);
    const totalY = doc.y;
    doc.rect(50, totalY, doc.page.width - 100, 40).fillAndStroke("#f4f6f8", accent);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#555")
      .text("Grand total", 60, totalY + 10);
    doc.font("Helvetica-Bold").fontSize(16).fillColor(accent)
      .text(formatMoney(Number(itinerary.totalAmount), currency), 60, totalY + 8, {
        width: doc.page.width - 120, align: "right",
      });
    doc.fillColor("#111").y = totalY + 50;
  }

  // Footer
  // G091 — when the caller passes `opts.branding.footerText` (per-render
  // override, precedence layer 1), append it on a second line BELOW the
  // standard "Itinerary #N — Pricing subject to availability …" line so
  // each sub-brand can carry its own legal disclaimer / hotline note
  // without rewriting the itinerary's chrome. Empty / null `footerText`
  // leaves the byte-shape pre-G091 (single-line footer preserved).
  const footerY = doc.page.height - doc.page.margins.bottom - 32;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777")
    .text(
      `${brandLabel} — Itinerary #${itinerary.id || "?"} v${itinerary.version || 1}. ` +
        `Pricing subject to availability at the time of booking.`,
      50, footerY + 8, { width: doc.page.width - 100, align: "center" },
    );
  const brandFooterText = (opts && opts.branding && typeof opts.branding.footerText === "string")
    ? opts.branding.footerText.trim()
    : "";
  if (brandFooterText) {
    doc.font("Helvetica").fontSize(8).fillColor("#999")
      .text(brandFooterText, 50, footerY + 20, { width: doc.page.width - 100, align: "center" });
  }

  doc.end();
  return bufPromise;
}

// ── Travel CRM — Travel Stall personalised 3-5 destination PDF (PRD §4.5)
// Downstream artefact of the llmRouter bulk-text consumer.
//
// S52 — header band sources from the shared brand-kit selector. `payload.tenant`
// (optional) threads `tenant.subBrandConfigJson` into the resolver so an admin
// POST to that column cascades into this PDF. `payload.branding` (optional)
// per-render override wins (precedence layer 1). When neither is supplied
// (legacy caller), the renderer falls back to INVOICE_BRAND_KIT_FALLBACKS.
// travelstall — the S13-aligned palette (headerColor #922B21). Pre-S52 this
// was the legacy SUB_BRAND_ACCENT.travelstall (#122647 navy). The new color
// is what S34's invoice renderer ships today; we adopt the same so the four
// travel sub-brands share one curated palette. Logo embedding remains pending
// Q22 brand assets — the `branding.thumbnailUrl` field is plumbed end-to-end
// but the Travel Stall personalised template doesn't yet doc.image() the
// logo (only the invoice renderer does that today via S51's fetchLogoBuffer).
async function renderTravelStallPersonalisedPdf(payload) {
  const sub = "travelstall";
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel Stall";
  // S52 — resolve via the shared brand-kit selector. The payload object may
  // carry `tenant` and `branding` keys; treat the whole payload as the opts
  // bag so route handlers can pass tenant alongside contact/destinations.
  const { branding } = resolveTravelHeaderBrandKit(sub, {
    tenant: payload && payload.tenant,
    branding: payload && payload.branding,
  });
  const accent = branding.headerColor || INVOICE_BRAND_KIT_FALLBACKS.travelstall.headerColor;
  const contact = payload?.contact || {};
  const destinations = Array.isArray(payload?.destinations) ? payload.destinations.slice(0, 5) : [];
  const budget = payload?.budget != null ? Number(payload.budget) : null;
  const durationDays = payload?.durationDays != null ? Number(payload.durationDays) : null;
  const diagnostic = payload?.diagnostic || null;
  const proseText = String(payload?.proseText || "");
  const generatedAt = payload?.generatedAt || new Date().toISOString();

  // S65 — fetch the per-sub-brand logo (if any) BEFORE we start drawing.
  // Same pattern as renderTravelInvoicePdf — module.exports indirection
  // keeps the CJS self-mocking seam intact for vitest spies.
  const logoBuffer = branding.thumbnailUrl
    ? await module.exports.fetchLogoBuffer(branding.thumbnailUrl)
    : null;

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // Brand header band — STUB: placeholder until Q22 brand assets land.
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Personalised Recommendations", 50, 42, { align: "left" });

  // S65 — embed brand logo into the header band's top-right (80×40 fit box).
  // Fail-soft try/catch matches the invoice renderer.
  if (logoBuffer) {
    try {
      const LOGO_W = 80;
      const LOGO_H = 40;
      const LOGO_X = doc.page.width - LOGO_W - 50;
      const LOGO_Y = 10;
      doc.image(logoBuffer, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H] });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pdfRenderer/S65] doc.image() rejected logo buffer (travelstall): ${err && err.message ? err.message : err}`,
      );
    }
  }

  doc.fillColor("#111").moveDown(2);

  // Customer block
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(contact?.name || "Customer", 50, 90);
  const metaLine = [contact?.email, contact?.phone].filter(Boolean).join("  •  ");
  if (metaLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(metaLine);
  doc.moveDown(0.4);

  // Trip parameters band
  const params = [];
  if (durationDays) params.push(`${durationDays} day${durationDays === 1 ? "" : "s"}`);
  if (budget != null) params.push(`Budget: ${formatMoney(budget, "INR")}`);
  if (diagnostic?.recommendedTier) params.push(`Tier: ${diagnostic.recommendedTier}`);
  if (params.length > 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#555").text(params.join("  •  "));
  }
  doc.moveDown(0.6);

  // Personalised prose (LLM output)
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Why these destinations");
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(10).fillColor("#222").text(
    proseText || "(personalised summary unavailable)",
    { width: doc.page.width - 100, align: "justify" },
  );
  doc.moveDown(0.8);

  // Destination cards
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Suggested destinations");
  doc.moveDown(0.4);

  if (destinations.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#777")
      .text("(Advisor will populate destinations from your preferences during the next call.)");
  } else {
    const cardWidth = (doc.page.width - 100 - 20) / 2; // 2 cards per row, 20px gutter
    const cardHeight = 110;
    let col = 0;
    let cardY = doc.y;
    for (let i = 0; i < destinations.length; i++) {
      const dest = destinations[i];
      const cardX = 50 + col * (cardWidth + 20);
      // Card border
      doc.rect(cardX, cardY, cardWidth, cardHeight)
        .lineWidth(0.7).strokeColor(accent).stroke();
      // STUB: placeholder image slot — Q22 brand pack supplies real photos
      doc.rect(cardX + 8, cardY + 8, 60, 60).fillAndStroke("#eef1f5", "#cdd3da");
      doc.font("Helvetica").fontSize(7).fillColor("#888")
        .text("photo", cardX + 8, cardY + 32, { width: 60, align: "center" });
      doc.fillColor("#111");
      // Destination name + short prose
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
        .text(dest, cardX + 78, cardY + 12, { width: cardWidth - 86 });
      doc.font("Helvetica").fontSize(9).fillColor("#444")
        .text(
          `Suggested for your ${diagnostic?.classificationLabel || diagnostic?.classification || "family"} profile.`,
          cardX + 78, cardY + 30, { width: cardWidth - 86 },
        );
      // Advance column
      col++;
      if (col >= 2) {
        col = 0;
        cardY += cardHeight + 14;
      }
    }
    doc.y = (col === 0 ? cardY : cardY + cardHeight + 14);
  }

  // Footer — brand strip + generated-at timestamp + STUB marker.
  const footerY = doc.page.height - doc.page.margins.bottom - 32;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777")
    .text(
      `${brandLabel} — Personalised Recommendations. Generated ${formatDate(generatedAt)}. ` +
        `Branding placeholder — final assets pending.`,
      50, footerY + 8, { width: doc.page.width - 100, align: "center" },
    );

  doc.end();
  return bufPromise;
}

// Brand logo for travel report headers. Drop a PNG at
// backend/assets/brand-logo.png and it is embedded automatically; until then
// the header falls back to a drawn emblem badge (see renderTravelDiagnosticPdf).
// Cached after first read. (Travel Stall's own brand pack is pending Q22.)
let _travelHeaderLogo;
function loadTravelHeaderLogo() {
  if (_travelHeaderLogo !== undefined) return _travelHeaderLogo;
  try {
    const fsMod = require("fs");
    const pathMod = require("path");
    const p = pathMod.join(__dirname, "..", "assets", "brand-logo.png");
    _travelHeaderLogo = fsMod.existsSync(p) ? fsMod.readFileSync(p) : null;
  } catch {
    _travelHeaderLogo = null;
  }
  return _travelHeaderLogo;
}

// S52 — `opts.tenant` (optional) threads `tenant.subBrandConfigJson` into
// the shared brand-kit selector; `opts.branding` (optional) per-render
// override wins. `opts.logoBuffer` (pre-S52) is retained — that path is
// route-resolved from S3 / tenant assets and still drawn into the header.
// When neither tenant nor branding is supplied (legacy caller), the
// header color falls back to INVOICE_BRAND_KIT_FALLBACKS[subBrand]. Pre-S52
// the color came from SUB_BRAND_ACCENT[sub]; the four travel sub-brands
// now share the S13-aligned palette.
async function renderTravelDiagnosticPdf(diagnostic, contact, bank, opts = {}) {
  const sub = diagnostic.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  const { branding } = resolveTravelHeaderBrandKit(sub, opts);
  const accent = branding.headerColor || INVOICE_BRAND_KIT_FALLBACKS._generic.headerColor;

  let questions = [];
  try {
    const parsed = JSON.parse(bank?.questionsJson || "{}");
    questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch { /* fall through with empty questions */ }
  let answers = {};
  try {
    answers = JSON.parse(diagnostic.answersJson || "{}");
  } catch { /* leave empty */ }

  // S65 — when the brand-kit selector surfaces a thumbnailUrl AND the route
  // didn't already pass an explicit opts.logoBuffer, fetch the remote logo
  // through the shared LRU cache. Explicit logoBuffer (route-resolved from
  // S3 / tenant) stays as the highest-precedence layer (pre-S65 contract).
  // Fail-soft: null buffer falls back to the bundled asset → emblem badge.
  let brandKitLogoBuf = null;
  if (!opts.logoBuffer && branding.thumbnailUrl) {
    brandKitLogoBuf = await module.exports.fetchLogoBuffer(branding.thumbnailUrl);
  }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // PRD §4.7 (gap A3) — per-viewer watermark, opt-in via
  // opts.viewerWatermark. Default OFF (existing diagnostic callers and
  // pinned tests are unaffected). Re-applied on overflow pages.
  if (opts.viewerWatermark) {
    module.exports.applyViewerWatermark(doc, opts.viewerWatermark);
    doc.on("pageAdded", () => module.exports.applyViewerWatermark(doc, opts.viewerWatermark));
  }

  // ── Header band: brand logo (left) + label ──────────────────────────
  const headerH = 66;
  doc.rect(0, 0, doc.page.width, headerH).fill(accent);
  let headerTextX = 50;
  // Logo priority: opts.logoBuffer (route-resolved S3 / tenant — pre-S65) →
  // branding.thumbnailUrl fetched via S65 cache → bundled asset → emblem
  // badge. The diagnostic renderer keeps its left-aligned 36×36 emblem slot
  // (existing layout) — that's distinct from S65's 80×40 top-right slot
  // used by the other 4 sibling renderers, because the diagnostic header
  // band was designed left-anchored before S65.
  const logoBuf = opts.logoBuffer || brandKitLogoBuf || loadTravelHeaderLogo();
  let logoDrawn = false;
  if (logoBuf) {
    try {
      doc.image(logoBuf, 50, 15, { fit: [36, 36] });
      logoDrawn = true;
      headerTextX = 98;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) {
    // Emblem fallback: white rounded badge + brand initial in the accent.
    const bx = 50, by = 15, bs = 36;
    doc.roundedRect(bx, by, bs, bs, 8).fill("#ffffff");
    const initial = (brandLabel || "T").trim().charAt(0).toUpperCase();
    doc.font("Helvetica-Bold").fontSize(20).fillColor(accent)
      .text(initial, bx, by + 8, { width: bs, align: "center" });
    headerTextX = 98;
  }
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff").text(brandLabel, headerTextX, 18);
  doc.font("Helvetica").fontSize(10).fillColor("#fff").text("Diagnostic Report", headerTextX, 42);

  // ── Body: flow downward from just below the header band ──────────────
  doc.fillColor("#111");
  doc.x = 50;
  doc.y = headerH + 24;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111").text(contact?.name || "Customer");
  const metaLine = [contact?.email, contact?.phone].filter(Boolean).join("  •  ");
  if (metaLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(metaLine);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  doc.text(`Bank version: v${bank?.version ?? "?"}`);
  doc.text(`Submitted: ${formatDate(diagnostic.createdAt || new Date())}`);
  doc.moveDown(0.8);

  // ── Classification box: draw at current y, render inside, then advance ──
  const boxTop = doc.y;
  const boxH = 74;
  doc.rect(50, boxTop, doc.page.width - 100, boxH).fillAndStroke("#f4f6f8", accent);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#555").text("Classification", 62, boxTop + 12);
  doc.font("Helvetica-Bold").fontSize(16).fillColor(accent)
    .text(diagnostic.classificationLabel || diagnostic.classification || "—", 62, boxTop + 28);
  doc.font("Helvetica").fontSize(10).fillColor("#333")
    .text(`Score: ${diagnostic.score != null ? Number(diagnostic.score).toFixed(2) : "—"}`, 62, boxTop + 52);
  if (diagnostic.recommendedTier) {
    doc.font("Helvetica").fontSize(10).fillColor("#333")
      .text(`Recommended tier: ${diagnostic.recommendedTier}`, 300, boxTop + 52);
  }
  doc.x = 50;
  doc.y = boxTop + boxH + 18;
  doc.fillColor("#111");

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Your answers", { underline: false });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor("#111");

  if (questions.length === 0) {
    doc.fillColor("#777").text("(No question bank snapshot available.)");
  } else {
    questions.forEach((q, idx) => {
      const num = idx + 1;
      const qText = q?.text || `Question ${num}`;
      const ans = resolveAnswerLabel(q, answers[q?.id]);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#333")
        .text(`${num}. ${qText}`);
      doc.font("Helvetica").fontSize(10).fillColor("#111")
        .text(`   ${ans}`);
      doc.moveDown(0.4);
    });
  }

  // PRD_TMC_CURRICULUM_MAPPING §3 FR-7 — "Why these destinations fit your
  // curriculum" section, driven by the cached curriculumFitJson snapshot.
  // Rendered only when present; non-TMC reports (null cache) are unchanged.
  let curriculumFit = null;
  try {
    curriculumFit = diagnostic.curriculumFitJson ? JSON.parse(diagnostic.curriculumFitJson) : null;
  } catch { /* ignore a malformed cache — omit the section */ }
  if (
    curriculumFit &&
    Array.isArray(curriculumFit.recommendations) &&
    curriculumFit.recommendations.length
  ) {
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111")
      .text("Why these destinations fit your curriculum");
    const ctxBits = [curriculumFit.curriculum, curriculumFit.grade, curriculumFit.subject]
      .filter(Boolean)
      .join("  •  ");
    if (ctxBits) doc.font("Helvetica").fontSize(9).fillColor("#777").text(ctxBits);
    doc.moveDown(0.4);
    curriculumFit.recommendations.forEach((rec) => {
      const fit = rec.fitScore != null ? `  (fit ${rec.fitScore}/100)` : "";
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(accent)
        .text(`${rec.destination || "Destination"}${fit}`);
      (rec.reasons || []).forEach((reason) => {
        const lead = reason.subject ? `${reason.subject}: ` : "";
        const body = reason.learningOutcome || reason.rationale || "";
        if (lead || body) {
          doc.font("Helvetica").fontSize(9.5).fillColor("#333").text(`   • ${lead}${body}`);
        }
      });
      doc.moveDown(0.3);
    });
  }

  const footerY = doc.page.height - doc.page.margins.bottom - 32;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777")
    .text(
      `Generated by ${brandLabel}. This report is informational; pricing and tier recommendations follow on consultation.`,
      50, footerY + 8, { width: doc.page.width - 100, align: "center" },
    );

  doc.end();
  return bufPromise;
}

// ── TMC School-Readiness Report PDF (T8 — PRD §3.5) ──────────────────
//
// Renders the school-facing readiness report per PRD §3.5: a 10-section
// document built from:
//   - engineOutput        (state + icpTier + flags from T2 engine)
//   - narrative           (guarded LLM Job A output OR Layer-3 fallback
//                          from T7 — 6 string fields)
//   - standingFacts       (§3.5.5 config: trust / runway / academic_calendar
//                          / board_policy_hooks / assurance — literally
//                          injected by the renderer, never by the LLM)
//   - boardHook           (resolved §3.5.1 board policy hook string —
//                          empty when school's curriculum isn't on the
//                          map; renderer omits the line in that case)
//   - runwayDisplay       (resolved §3.5.2 runway display string for the
//                          school's geo_preference — used in §5 cost-of-
//                          waiting AND §8 assurance framing)
//   - schoolAnswers       (Q1-Q12 — used for cover page school name +
//                          contact name/role + ambition restatement)
//   - bookingUrl          (DD-5.4 — Google Meet slot picker URL OR config
//                          fallback URL; placeholder text if not provided)
//   - catalogueMatched    (NOT used for trip names — only present so a
//                          future "summary card" layout can pull aggregate
//                          metadata. Per PRD §3.5: never name a trip or
//                          destination in the school-facing report.)
//
// HARD CONTRACT (PRD §3.5):
//   - NEVER writes a trip name, destination, or price.
//   - Peer-proof numbers come from standingFacts.trust LITERALLY:
//       "over 50" schools / "more than 100,000" students since 2015 /
//       14018 last year / 12055 day / 1658 overnight / 305 international.
//     Numbers are NEVER inflated, NEVER blended into all-time totals
//     (§11.4 international stays honest at 305).
//   - Runway display + lead_days come from standingFacts.runway, never
//     hardcoded in the renderer.
//   - Board hook is rendered ONLY when boardHook is a non-empty string.
//
// Returns Promise<Buffer> (matches sibling renderers' contract).
// S52 — accepts `tenant` (optional) for the shared brand-kit selector
// (reads `tenant.subBrandConfigJson` → tmc block → headerColor) and
// `branding` (optional) for per-render explicit override (precedence
// layer 1). Pre-S52 the report used `SUB_BRAND_ACCENT.tmc` (#0B4F6C).
// The TMC report is always sub-brand "tmc" so the resolver always reads
// the tmc block; when neither tenant nor branding is supplied (legacy
// caller), the renderer falls back to INVOICE_BRAND_KIT_FALLBACKS.tmc
// (#1F4E79, the S13-aligned palette).
async function renderTmcReadinessReport({
  engineOutput = null,
  narrative = null,
  standingFacts = null,
  boardHook = "",
  runwayDisplay = "",
  schoolAnswers = null,
  bookingUrl = "",
  catalogueMatched = [], // kept on the API for forward-compat; not rendered as named trips per §3.5
  tenant = null,
  branding: brandingOverride = null,
} = {}) {
  // Defensively coerce — the route handler passes structured JSON but
  // a malformed call shouldn't bomb the PDF generation.
  const n = (narrative && typeof narrative === "object") ? narrative : {};
  const sa = (schoolAnswers && typeof schoolAnswers === "object") ? schoolAnswers : {};
  const sf = (standingFacts && typeof standingFacts === "object") ? standingFacts : {};
  const trust = (sf.trust && typeof sf.trust === "object") ? sf.trust : {};
  const assurance = (sf.assurance && typeof sf.assurance === "object") ? sf.assurance : {};
  const profile = (sa.school_profile && typeof sa.school_profile === "object") ? sa.school_profile : {};
  const contact = (sa.contact && typeof sa.contact === "object") ? sa.contact : {};

  const schoolName = String(profile.school_name || sa.school_name || "Your school").trim();
  const contactName = String(contact.contact_name || sa.contact_name || "").trim();
  const contactRole = String(contact.contact_role || sa.contact_role || "").trim();
  const eState = engineOutput && engineOutput.state ? String(engineOutput.state) : "";
  // engineOutput is allowed but never surfaces destinations / trip names.

  // PRD §3.5.3 verified peer-proof numbers. Pull from config when present;
  // fall back to PRD §11.4 verbatim. We render the figures literally — the
  // §11.4 honesty rule is "305 stays 305, never inflated, never blended."
  const schoolsSince2015 = String(trust.schools_served_since_2015 || "over 50");
  const studentsSince2015 = String(trust.students_moved_since_2015 || "more than 100,000");
  const studentsLastYear = Number.isFinite(Number(trust.students_moved_last_year))
    ? Number(trust.students_moved_last_year)
    : 14018;
  const dayStudents = Number.isFinite(Number(trust.day_students_last_year))
    ? Number(trust.day_students_last_year)
    : 12055;
  const overnightStudents = Number.isFinite(Number(trust.overnight_students_last_year))
    ? Number(trust.overnight_students_last_year)
    : 1658;
  const internationalStudents = Number.isFinite(Number(trust.international_students_last_year))
    ? Number(trust.international_students_last_year)
    : 305; // PRD §11.4 — honest at 305

  // The §3.6 assurance block reads from the config; empty fields are
  // OMITTED per PRD §3.5.5 — never filled with placeholder text.
  const supervisionRatio = String(assurance.supervision_ratio || "").trim();
  const tourDirectors = String(assurance.tour_directors || "").trim();
  const safetyRecord = String(assurance.safety_record_line || trust.safety_record_line || "").trim();
  const medicalProtocol = String(assurance.medical_emergency_protocol || "").trim();
  const vendorVetting = String(assurance.vendor_transport_vetting || "").trim();
  const governancePack = Array.isArray(assurance.governance_pack) ? assurance.governance_pack : [];

  // S52 — TMC readiness report is fixed sub-brand "tmc"; pull the header
  // color from the shared brand-kit selector so admin-curated palettes
  // cascade in via `tenant.subBrandConfigJson`. Per-render override via
  // `branding` is precedence layer 1.
  const { branding: tmcBranding } = resolveTravelHeaderBrandKit("tmc", {
    tenant,
    branding: brandingOverride,
  });
  const accent = tmcBranding.headerColor || INVOICE_BRAND_KIT_FALLBACKS.tmc.headerColor;

  // G105 — booking URL resolver. Precedence:
  //   1. Explicit `bookingUrl` arg from caller (e.g. env override).
  //   2. tenant.subBrandConfigJson.tmc.bookingLinkUrl (admin-curated).
  //   3. Empty string → renderer surfaces the "executive will reach out" fallback.
  let resolvedBookingUrl = String(bookingUrl || "").trim();
  if (!resolvedBookingUrl && tenant && typeof tenant.subBrandConfigJson === "string") {
    try {
      const parsedCfg = JSON.parse(tenant.subBrandConfigJson);
      const tmcCfg = parsedCfg && typeof parsedCfg === "object" ? parsedCfg.tmc : null;
      if (tmcCfg && typeof tmcCfg.bookingLinkUrl === "string" && tmcCfg.bookingLinkUrl) {
        resolvedBookingUrl = tmcCfg.bookingLinkUrl;
      }
    } catch (_e) { /* malformed cfg — keep empty */ }
  }

  // S65 — fetch the TMC sub-brand logo (if any) BEFORE drawing the cover.
  // pdfkit's doc.image() needs the buffer synchronously; resolve up front.
  const tmcLogoBuffer = tmcBranding.thumbnailUrl
    ? await module.exports.fetchLogoBuffer(tmcBranding.thumbnailUrl)
    : null;

  // Document scaffold.
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);
  const pageW = doc.page.width;
  const pageMargin = 50;
  const contentW = pageW - pageMargin * 2;

  // ── Section 1: Cover ────────────────────────────────────────────────
  doc.rect(0, 0, pageW, 110).fill(accent);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(20)
    .text("TMC", pageMargin, 30, { align: "left" });
  doc.fillColor("#fff").font("Helvetica").fontSize(11)
    .text("Student experiential readiness profile", pageMargin, 56);
  doc.fillColor("#fff").font("Helvetica").fontSize(9)
    .text("Diagnostic-led, never destination-led.", pageMargin, 74);

  // S65 — embed brand logo in the cover band's top-right (80×40 fit box at
  // right edge). The 110px-tall cover band gives more vertical room than
  // the sibling renderers' 60px header, so we keep the same 80×40 fit slot
  // for visual consistency across all 5 travel PDFs. Fail-soft try/catch.
  if (tmcLogoBuffer) {
    try {
      const LOGO_W = 80;
      const LOGO_H = 40;
      const LOGO_X = pageW - LOGO_W - pageMargin;
      const LOGO_Y = 30;
      doc.image(tmcLogoBuffer, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H] });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pdfRenderer/S65] doc.image() rejected logo buffer (tmc-readiness): ${err && err.message ? err.message : err}`,
      );
    }
  }

  doc.fillColor(BRAND.textDark).font("Helvetica-Bold").fontSize(16)
    .text(schoolName, pageMargin, 140, { width: contentW });
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.textMuted)
    .text(`Prepared for ${contactName || "the leadership team"}${contactRole ? `, ${contactRole}` : ""}`, pageMargin, 168, { width: contentW });
  doc.text(`Date: ${formatDate(new Date())}`, pageMargin, 184, { width: contentW });
  if (eState) {
    const stateLabel = eState === "strong_match"
      ? "Strong readiness fit identified"
      : eState === "partial_match"
        ? "Partial readiness fit — see report"
        : "Custom concept recommended";
    doc.fillColor(accent).font("Helvetica-Bold").fontSize(10).text(stateLabel, pageMargin, 200);
  }
  doc.moveDown(2);
  doc.y = Math.max(doc.y, 230);

  // ── Section 2: Your ambition, in your words ─────────────────────────
  renderTmcReportSection(doc, {
    num: 2,
    title: "Your ambition, in your words",
    body: n.ambition_restatement || "",
    accent,
  });

  // ── Section 3: Your students' readiness profile ─────────────────────
  renderTmcReportSection(doc, {
    num: 3,
    title: "Your students' readiness profile",
    body: n.readiness_profile || "",
    accent,
  });

  // ── Section 4: What becomes possible ────────────────────────────────
  renderTmcReportSection(doc, {
    num: 4,
    title: "What becomes possible",
    body: n.what_becomes_possible || "",
    accent,
  });

  // ── Section 5: The cost of waiting (+ runway append per PRD §3.5.2) ──
  let costBody = n.cost_of_waiting || "";
  if (runwayDisplay) {
    costBody = costBody
      ? `${costBody}\n\nPlanning runway for the trip you're considering: ${runwayDisplay}.`
      : `Planning runway for the trip you're considering: ${runwayDisplay}.`;
  }
  renderTmcReportSection(doc, {
    num: 5,
    title: "The cost of waiting",
    body: costBody,
    accent,
  });

  // ── Section 6: Schools already moving (peer-proof block §3.5.3) ─────
  // Literal injection from standingFacts. NEVER inflated. NEVER blended.
  // PRD §11.4 — international stays honest at 305.
  const peerBody = [
    `Since 2015, TMC has served ${schoolsSince2015} schools across India, moving ${studentsSince2015} students.`,
    `Last year alone, we moved ${studentsLastYear.toLocaleString("en-IN")} students — ${dayStudents.toLocaleString("en-IN")} on day programmes, ${overnightStudents.toLocaleString("en-IN")} on overnight domestic programmes, and ${internationalStudents} on international programmes.`,
    `International is our emerging tier — a smaller, more committed set of schools choosing it deliberately.`,
  ].join(" ");
  renderTmcReportSection(doc, {
    num: 6,
    title: "Schools already moving",
    body: peerBody,
    accent,
  });

  // ── Section 7: How this benefits your institution (+ board hook) ────
  let benefitBody = n.institutional_benefit || "";
  if (boardHook) {
    benefitBody = benefitBody
      ? `${benefitBody}\n\nCurriculum alignment: ${boardHook}`
      : `Curriculum alignment: ${boardHook}`;
  }
  renderTmcReportSection(doc, {
    num: 7,
    title: "How this benefits your institution",
    body: benefitBody,
    accent,
  });

  // ── Section 8: Your decision, de-risked (assurance §3.5.4) ──────────
  let assuranceBody = n.assurance_framing || "";
  const assuranceLines = [];
  if (supervisionRatio) assuranceLines.push(`Supervision: ${supervisionRatio}.`);
  if (tourDirectors) assuranceLines.push(`Tour directors: ${tourDirectors}.`);
  if (safetyRecord) assuranceLines.push(`Safety record: ${safetyRecord}.`);
  if (medicalProtocol) assuranceLines.push(`Medical/emergency: ${medicalProtocol}.`);
  if (vendorVetting) assuranceLines.push(`Vendor + transport: ${vendorVetting}.`);
  if (governancePack.length > 0) {
    assuranceLines.push(`Governance pack provided: ${governancePack.join("; ")}.`);
  }
  const assuranceCombined = assuranceBody
    ? [assuranceBody, ...assuranceLines].filter(Boolean).join("\n\n")
    : assuranceLines.join("\n");
  renderTmcReportSection(doc, {
    num: 8,
    title: "Your decision, de-risked",
    body: assuranceCombined,
    accent,
  });

  // ── Section 9: How TMC works ────────────────────────────────────────
  const howWeWorkBody = [
    `Every TMC trip starts with a diagnostic like the one you just completed. We never pick a destination first.`,
    `${schoolsSince2015} schools and ${studentsSince2015} students since 2015 is the operating record this model produced.`,
  ].join(" ");
  renderTmcReportSection(doc, {
    num: 9,
    title: "How TMC works",
    body: howWeWorkBody,
    accent,
  });

  // ── Section 10: Single CTA ──────────────────────────────────────────
  if (doc.y > doc.page.height - 200) doc.addPage();
  doc.y = Math.max(doc.y, doc.y + 4);
  doc.rect(pageMargin, doc.y, contentW, 110).fillAndStroke(BRAND.tealSoft, accent);
  const ctaY = doc.y - 105;
  doc.font("Helvetica-Bold").fontSize(13).fillColor(accent)
    .text("Your students are ready.", pageMargin + 14, ctaY + 12, { width: contentW - 28 });
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
    .text(
      "The calendar is the only thing between this profile and a programme that runs next year. " +
      "Book a 30-minute conversation with the TMC team to walk through this report together.",
      pageMargin + 14,
      ctaY + 36,
      { width: contentW - 28 },
    );
  if (resolvedBookingUrl) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(accent)
      .text(`Book your slot: ${resolvedBookingUrl}`, pageMargin + 14, ctaY + 84, { width: contentW - 28 });
  } else {
    doc.font("Helvetica").fontSize(9).fillColor(BRAND.textMuted)
      .text(
        "Your TMC executive will reach out within one working day to share their calendar.",
        pageMargin + 14,
        ctaY + 84,
        { width: contentW - 28 },
      );
  }
  doc.y = ctaY + 120;

  // Footer with attribution.
  const footerY = doc.page.height - doc.page.margins.bottom - 28;
  doc.moveTo(pageMargin, footerY).lineTo(pageW - pageMargin, footerY)
    .lineWidth(0.5).strokeColor(BRAND.border).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(BRAND.textMuted)
    .text(
      "TMC — School Trips. Diagnostic-led, never destination-led. " +
      "Trust + runway + assurance figures verified by TMC; renderer-injected per readiness-report standing-facts policy.",
      pageMargin, footerY + 8, { width: contentW, align: "center" },
    );

  doc.end();
  return bufPromise;
}

/**
 * Helper for the TMC readiness report — renders one numbered section
 * with title + body, paginating when needed. Pure layout helper; never
 * touches engineOutput or names a trip. Body is plain text (no HTML).
 */
function renderTmcReportSection(doc, { num, title, body, accent }) {
  const pageMargin = 50;
  const pageW = doc.page.width;
  const contentW = pageW - pageMargin * 2;

  // Soft page-break guard — drop to next page if the section header
  // would otherwise sit at the very bottom.
  if (doc.y > doc.page.height - 120) doc.addPage();

  doc.y = Math.max(doc.y, doc.y + 6);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(accent)
    .text(`${num}. ${title}`, pageMargin, doc.y, { width: contentW });
  doc.moveDown(0.3);

  const text = String(body || "").trim() || "—";
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.textBody)
    .text(text, pageMargin, doc.y, {
      width: contentW,
      align: "left",
      lineGap: 2,
    });
  doc.moveDown(0.7);
}

// ── Travel CRM — quote PDF (DD-5.6) ─────────────────────────────────
// S52 — optional second `opts` arg (back-compat with single-arg legacy
// callers) threads `opts.tenant` + `opts.branding` into the shared
// brand-kit selector. Precedence chain (highest first):
//   1. `quote.brandKit.accent` (pre-S52 inline override — preserved
//      so the existing quote-template callers keep working)
//   2. `opts.branding.*`        (S52 per-render explicit override)
//   3. `opts.tenant.subBrandConfigJson[subBrand]` (S52 admin config)
//   4. `opts.tenant.subBrandConfigJson` top-level (S52 admin config)
//   5. INVOICE_BRAND_KIT_FALLBACKS[subBrand]      (S52 hard-coded)
// Pre-S52 fallback was SUB_BRAND_ACCENT[sub]; the four travel sub-brands
// now share the S13-aligned palette through #5.
async function renderTravelQuotePdf(quote, opts = {}) {
  const q = quote || {};
  const sub = q.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  const { branding } = resolveTravelHeaderBrandKit(sub, opts);
  // Layer 1 — legacy `q.brandKit.accent` inline override still wins (back-
  // compat with pre-S52 quote-template callers). Layer 2 — branding.headerColor
  // from the shared selector. Layer 3 — hard-coded fallback (defensive — every
  // sub-brand has a fallback entry so this fires only on unknown sub-brand).
  const accent = (q.brandKit && q.brandKit.accent)
    || branding.headerColor
    || INVOICE_BRAND_KIT_FALLBACKS._generic.headerColor;
  const currency = q.currency || "INR";
  const rawItems = Array.isArray(q.items)
    ? q.items
    : Array.isArray(q.lines)
      ? q.lines
      : [];
  const items = rawItems;
  const taxTreatment = q.taxTreatment === "inclusive" ? "inclusive" : "exclusive";

  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  // S65 — resolve logo URL BEFORE drawing. Precedence:
  //   1. q.brandKit.logoUrl  — pre-S65 inline override (the quote-template
  //      caller could carry an explicit logo URL alongside the accent
  //      override). Honored if present to preserve back-compat with any
  //      template that supplied logoUrl.
  //   2. branding.thumbnailUrl — admin-curated via tenant.subBrandConfigJson.
  // Either way, the buffer is fetched through module.exports.fetchLogoBuffer
  // so vitest spies catch it. Fail-soft on any network / parse error.
  const quoteLogoUrl = (q.brandKit && q.brandKit.logoUrl) || branding.thumbnailUrl || null;
  const logoBuffer = quoteLogoUrl
    ? await module.exports.fetchLogoBuffer(quoteLogoUrl)
    : null;

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Quote", 50, 42, { align: "left" });

  // S65 — embed brand logo into the header band's top-right (80×40 fit box).
  // Replaces the pre-S65 `[Logo: <url>]` text-placeholder that the quote
  // renderer used to emit when q.brandKit.logoUrl was set. Fail-soft: a
  // malformed buffer falls through to a logo-less header band.
  if (logoBuffer) {
    try {
      const LOGO_W = 80;
      const LOGO_H = 40;
      const LOGO_X = doc.page.width - LOGO_W - 50;
      const LOGO_Y = 10;
      doc.image(logoBuffer, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H] });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pdfRenderer/S65] doc.image() rejected logo buffer (quote): ${err && err.message ? err.message : err}`,
      );
    }
  }

  doc.fillColor("#111").moveDown(2);

  const metaTop = 80;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
    .text("QUOTE", 380, metaTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(`Quote #: ${q.quoteNumber || q.id || "—"}`, 380, metaTop + 26, { width: 165, align: "right" });
  doc.text(`Issued: ${formatDate(q.issuedDate || new Date())}`, 380, metaTop + 40, { width: 165, align: "right" });
  doc.text(`Valid until: ${formatDate(q.validUntil)}`, 380, metaTop + 54, { width: 165, align: "right" });
  doc.text(`Status: ${q.status || "Draft"}`, 380, metaTop + 68, { width: 165, align: "right" });

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Quote For", 50, metaTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(q.customerName || "—", 50, metaTop + 18);
  if (q.customerEmail) doc.text(q.customerEmail, 50, doc.y);
  if (q.customerPhone) doc.text(q.customerPhone, 50, doc.y);

  doc.y = Math.max(doc.y, metaTop + 100);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor(accent).stroke();
  doc.moveDown(0.8);

  const isInterstate = !!q.placeOfSupplyInterstate;
  const isGstAware = items.some(
    (it) =>
      (typeof it.lineType === "string" && it.lineType.length > 0) ||
      Number(it.gstPercent) > 0,
  );
  const tableTop = doc.y;
  const colX = isGstAware
    ? {
      desc: 50,
      sac: 270,
      gst: 315,
      qty: 380,
      unit: 415,
      total: 475,
    }
    : {
      desc: 50,
      qty: 340,
      unit: 400,
      total: 470,
    };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  if (isGstAware) {
    doc.text("SAC", colX.sac, tableTop, { width: 40, align: "left" });
    doc.text("Tax", colX.gst, tableTop, { width: 60, align: "right" });
    doc.text("Qty", colX.qty, tableTop, { width: 30, align: "right" });
    doc.text("Unit", colX.unit, tableTop, { width: 55, align: "right" });
    doc.text("Total", colX.total, tableTop, { width: 70, align: "right" });
  } else {
    doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
    doc.text("Unit", colX.unit, tableTop, { width: 60, align: "right" });
    doc.text("Total", colX.total, tableTop, { width: 75, align: "right" });
  }
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  let computedSubtotal = 0;
  const normalisedLines = [];
  // G020 (PRD §3.2 FR-3.2.3) — render the quantity column with a dimension
  // suffix when the line carries dimension metadata. e.g. "4 pax" instead
  // of bare "4" when dimension="perPax". Falls through to bare qty when
  // dimension is null/unknown (back-compat with pre-G020 lines).
  function fmtQty(qty, dimension) {
    if (qty === 0) return "—";
    const n = String(qty);
    switch (dimension) {
      case "perPax": return `${n} pax`;
      case "perRoomPerNight": return `${n} rm-night`;
      case "perTrip": return `${n} trip`;
      case "flatRate": return n;
      default: return n;
    }
  }
  if (items.length === 0) {
    doc.fillColor("#777").text("(No line items on this quote yet.)", colX.desc, rowY, { width: 480 });
    rowY += 18;
  } else {
    for (const it of items) {
      if (rowY > 700) { doc.addPage(); rowY = 60; }
      const qty = Number(it.qty != null ? it.qty : it.quantity) || 0;
      const unit = Number(it.unitPrice) || 0;
      const total = it.totalPrice != null
        ? Number(it.totalPrice)
        : it.amount != null
          ? Number(it.amount)
          : qty * unit;
      computedSubtotal += total;
      if (isGstAware) {
        const sacCode = hsnSacMapper.sacForLineType(it.lineType);
        const gstPct = Number(it.gstPercent) || 0;
        const taxable = it.taxableValue != null
          ? Number(it.taxableValue)
          : total;
        const split = gstCalculation.computeGstSplit({
          taxableAmount: taxable,
          gstPercent: gstPct,
          isInterstate,
        });
        let gstCell = "—";
        if (gstPct > 0) {
          if (isInterstate) {
            gstCell = `${gstPct}% IGST ${fmt(split.igst)}`;
          } else {
            const half = gstPct / 2;
            const halfStr = Number.isInteger(half) ? String(half) : half.toFixed(1);
            gstCell = `${halfStr}+${halfStr}% CGST/SGST ${fmt(split.cgst + split.sgst)}`;
          }
        }
        normalisedLines.push({
          lineType: it.lineType,
          taxableValue: taxable,
          gstPercent: gstPct,
        });
        doc.fillColor("#222");
        doc.text(String(it.description || "—"), colX.desc, rowY, { width: 210 });
        doc.text(sacCode == null ? "—" : sacCode, colX.sac, rowY, { width: 40, align: "left" });
        doc.fontSize(8);
        doc.text(gstCell, colX.gst, rowY, { width: 60, align: "right" });
        doc.fontSize(10);
        doc.text(fmtQty(qty, it.dimension), colX.qty, rowY, { width: 30, align: "right" });
        doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 55, align: "right" });
        doc.text(fmt(total), colX.total, rowY, { width: 70, align: "right" });
      } else {
        doc.fillColor("#222");
        doc.text(String(it.description || "—"), colX.desc, rowY, { width: 280 });
        doc.text(fmtQty(qty, it.dimension), colX.qty, rowY, { width: 50, align: "right" });
        doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 60, align: "right" });
        doc.text(fmt(total), colX.total, rowY, { width: 75, align: "right" });
      }
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  const subtotal = q.subtotal != null ? Number(q.subtotal) : computedSubtotal;
  const gstAmount = q.gstAmount != null ? Number(q.gstAmount) : 0;
  const grandTotal = q.totalAmount != null
    ? Number(q.totalAmount)
    : (taxTreatment === "exclusive" ? subtotal + gstAmount : subtotal);

  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  let ty = totalsY + 8;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(subtotal), 450, ty, { width: 95, align: "right" });
  ty += 16;

  if (taxTreatment === "exclusive") {
    doc.text("GST", 350, ty, { width: 95, align: "right" });
    doc.text(fmt(gstAmount), 450, ty, { width: 95, align: "right" });
    ty += 16;
  }

  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Total", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 18;

  if (taxTreatment === "inclusive") {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#666");
    doc.text("Includes GST", 350, ty, { width: 195, align: "right" });
    ty += 14;
  }
  doc.y = ty + 8;

  const hsnSummary = hsnSacMapper.groupLinesBySac(normalisedLines);
  if (hsnSummary.length > 0) {
    if (doc.y > 680) { doc.addPage(); }
    doc.moveDown(0.8);
    const summaryTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#333")
      .text("HSN/SAC Summary", 50, summaryTop);
    let sy = summaryTop + 16;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
    doc.text("SAC", 50, sy, { width: 50, align: "left" });
    doc.text("Description", 105, sy, { width: 230, align: "left" });
    doc.text("Rate", 340, sy, { width: 55, align: "right" });
    doc.text("Taxable Value", 400, sy, { width: 95, align: "right" });
    doc.text("Lines", 500, sy, { width: 45, align: "right" });
    sy += 12;
    doc.moveTo(50, sy).lineTo(545, sy).lineWidth(0.4).strokeColor("#bbb").stroke();
    sy += 4;
    doc.font("Helvetica").fontSize(9).fillColor("#222");
    for (const row of hsnSummary) {
      if (sy > 720) { doc.addPage(); sy = 60; }
      doc.text(row.sacCode, 50, sy, { width: 50, align: "left" });
      doc.text(row.description, 105, sy, { width: 230, align: "left" });
      doc.text(
        `${row.gstPercent}%`,
        340, sy, { width: 55, align: "right" },
      );
      doc.text(fmt(row.taxableValue), 400, sy, { width: 95, align: "right" });
      doc.text(String(row.count), 500, sy, { width: 45, align: "right" });
      doc.fillColor("#777").fontSize(7);
      doc.text(`${row.sacCode} / ${row.gstPercent}%`, 105, sy + 9, { width: 230, align: "left" });
      doc.fillColor("#222").fontSize(9);
      sy += 18;
    }
    doc.y = sy + 4;
  }

  doc.moveDown(1);
  const validityY = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor("#333")
    .text(`Valid until ${formatDate(q.validUntil)}`, 50, validityY, { width: 495 });
  doc.moveDown(2.5);

  const sigY = Math.max(doc.y, 700);
  doc.moveTo(50, sigY).lineTo(250, sigY).lineWidth(0.5).strokeColor("#444").stroke();
  doc.font("Helvetica").fontSize(9).fillColor("#555")
    .text("Authorised signature", 50, sigY + 4);

  const footerY = doc.page.height - doc.page.margins.bottom - 24;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.4).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777").text(
    `${brandLabel} — Quote #${q.quoteNumber || q.id || "?"}. ` +
      "Pricing valid until the date shown; subject to availability at booking.",
    50, footerY + 6, { width: doc.page.width - 100, align: "center" },
  );

  doc.end();
  return bufPromise;
}

const generateTravelQuotePdf = renderTravelQuotePdf;

// ── Travel CRM — invoice PDF (Arc 2 #901 slice 2) ───────────────────

function docTypeHeader(docType) {
  switch (docType) {
    case "Proforma": return "PROFORMA INVOICE";
    case "CreditNote": return "CREDIT NOTE";
    case "DebitNote": return "DEBIT NOTE";
    case "TravelVoucher": return "TRAVEL VOUCHER";
    case "TaxInvoice":
    default:
      return "TAX INVOICE";
  }
}

function docTypeFooter(docType) {
  switch (docType) {
    case "Proforma":
      return "This is a Proforma Invoice — not a tax invoice. No GST credit allowed.";
    case "CreditNote":
      return "Credit Note — reduces customer payable";
    case "DebitNote":
      return "Debit Note — increases customer payable";
    case "TravelVoucher":
      return "Voucher — non-billable; document of service entitlement";
    case "TaxInvoice":
    default:
      return "This is a Tax Invoice as per GST Rules";
  }
}

const VOUCHER_FULFILLMENT_TYPES = new Set([
  "per_pax",
  "per_room",
  "per_night",
  "per_trip",
  "addon",
  "other",
]);

function voucherSubtypeForLine(lineType) {
  switch (lineType) {
    case "per_night":
    case "per_room":
      return "Hotel";
    case "per_pax":
      return "Activity";
    case "per_trip":
      return "Transfer";
    case "addon":
      return "Add-on";
    case "other":
      return "Service";
    default:
      return String(lineType || "Service");
  }
}

function formatVoucherServiceRange(startDate, endDate) {
  const start = startDate ? formatDate(startDate) : null;
  const end = endDate ? formatDate(endDate) : null;
  if (start && end) {
    if (start === end) return start;
    return `${start} → ${end}`;
  }
  return start || end || "—";
}

function extractTravellerListFromInvoice(invoice, lines) {
  if (invoice && invoice.travellerList) {
    if (Array.isArray(invoice.travellerList)) {
      const cleaned = invoice.travellerList
        .map((n) => String(n).trim())
        .filter(Boolean);
      if (cleaned.length > 0) return cleaned.join(", ");
    } else if (typeof invoice.travellerList === "string") {
      const s = invoice.travellerList.trim();
      if (s) return s;
    }
  }
  if (Array.isArray(lines)) {
    for (const line of lines) {
      if (!line || !line.notes) continue;
      const m = String(line.notes).match(/Travellers?:\s*(.+)/i);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return "—";
}

async function renderTravelInvoicePdf(opts) {
  const o = opts || {};
  const invoice = o.invoice || {};
  const lines = Array.isArray(o.lines)
    ? o.lines
    : Array.isArray(invoice.lines)
      ? invoice.lines
      : [];
  const tenant = o.tenant || null;

  const sub = invoice.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";

  // S34 — resolve brand-kit colors from tenant.subBrandConfigJson with
  // per-sub-brand fallbacks. Caller can override per-render via opts.branding
  // (highest precedence, layer 1). When tenant or subBrandConfigJson is null,
  // we fall through to INVOICE_BRAND_KIT_FALLBACKS (sensible WCAG-AA per
  // sub-brand defaults, replicated from S13's itinerary-template selector
  // so colors are consistent across both surfaces).
  const cfg = parseInvoiceSubBrandConfig(tenant && tenant.subBrandConfigJson);
  const { fields: brandKit, source: brandSource } = resolveInvoiceBrandKit(cfg, sub);
  // Per-render explicit overrides win (precedence layer 1). Callers can pass
  // { branding: { headerColor: "#000", ... } } to opts to bypass the kit.
  const callerBranding = (o.branding && typeof o.branding === "object") ? o.branding : {};
  const branding = { ...brandKit, ...callerBranding };

  // S51 — fetch the per-sub-brand logo (if any) BEFORE we start drawing.
  // pdfkit's doc.image() needs the buffer synchronously, so we resolve the
  // remote URL up front. Goes through module.exports.fetchLogoBuffer so
  // unit tests can vi.spyOn(...) the seam without reaching into axios.
  // Fail-soft: on any error, the helper returns null and we render a
  // logo-less header band (back-compat with pre-S51 output).
  const logoBuffer = branding.thumbnailUrl
    ? await module.exports.fetchLogoBuffer(branding.thumbnailUrl)
    : null;
  // The header band fill — was bare SUB_BRAND_ACCENT[sub] pre-S34. Now
  // sources from the brand-kit so the admin-curated palette wins.
  const accent = branding.headerColor || INVOICE_BRAND_KIT_FALLBACKS._generic.headerColor;
  // primaryColor drives the "Total Due" line + section accents downstream.
  // accentColor drives secondary dividers (header band underline).
  const primaryColor = branding.primaryColor || INVOICE_BRAND_KIT_FALLBACKS._generic.primaryColor;
  // _brandingSource: stamped into PDF Producer metadata so we can observe in
  // a tester / smoke check which resolution path fired without parsing PDF
  // body text. Values: "subBrandConfig" | "fallback".
  void brandSource;

  const currency = invoice.currency || "INR";
  const docType = invoice.docType || "TaxInvoice";
  const docHeaderTitle = docTypeHeader(docType);
  const docFooterText = docTypeFooter(docType);

  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      // S34 — stamp brand-kit resolution path into PDF Producer metadata so
      // downstream observers (tests, ops greps) can see whether the rendered
      // colors came from subBrandConfigJson or from the hard-coded fallback
      // without parsing body-text. Format: "Globussoft CRM (brand-kit: <src>)"
      Producer: `Globussoft CRM (brand-kit: ${brandSource})`,
    },
  });
  const bufPromise = streamToBuffer(doc);

  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  const bandSubLabel = docHeaderTitle
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  doc.fillColor("#fff").fontSize(10).text(bandSubLabel, 50, 42, { align: "left" });

  // S51 — embed brand logo into the header band's top-right (80×40 fit
  // box at right edge). doc.image() throws on invalid buffers; wrap in
  // try/catch so a malformed logo can't 500 the download. The brand
  // color band still renders behind the logo regardless.
  if (logoBuffer) {
    try {
      const LOGO_W = 80;
      const LOGO_H = 40;
      const LOGO_X = doc.page.width - LOGO_W - 50;
      const LOGO_Y = 10;
      doc.image(logoBuffer, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H] });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pdfRenderer/S51] doc.image() rejected logo buffer: ${err && err.message ? err.message : err}`,
      );
    }
  }

  doc.fillColor("#111").moveDown(2);

  const metaTop = 80;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
    .text(docHeaderTitle, 380, metaTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(
    `Invoice #: ${invoice.invoiceNum || invoice.id || "—"}`,
    380, metaTop + 26, { width: 165, align: "right" },
  );
  doc.text(
    `Issued: ${formatDate(invoice.issuedDate || invoice.createdAt || new Date())}`,
    380, metaTop + 40, { width: 165, align: "right" },
  );
  doc.text(
    `Due: ${formatDate(invoice.dueDate)}`,
    380, metaTop + 54, { width: 165, align: "right" },
  );
  doc.text(
    `Status: ${invoice.status || "Draft"}`,
    380, metaTop + 68, { width: 165, align: "right" },
  );

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Bill To", 50, metaTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(invoice.contactName || "—", 50, metaTop + 18);
  if (invoice.contactEmail) doc.text(invoice.contactEmail, 50, doc.y);
  if (invoice.contactPhone) doc.text(invoice.contactPhone, 50, doc.y);

  doc.y = Math.max(doc.y, metaTop + 100);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor(accent).stroke();
  doc.moveDown(0.8);

  if (docType === "TravelVoucher") {
    const voucherLines = (lines || []).filter(
      (l) => l && VOUCHER_FULFILLMENT_TYPES.has(l.lineType || "other"),
    );
    const travellers = extractTravellerListFromInvoice(invoice, lines);

    const vTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
      .text("Voucher Details", 50, vTop);
    let vy = vTop + 16;

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555")
      .text("Travellers:", 50, vy, { width: 65, continued: false });
    doc.font("Helvetica").fontSize(9).fillColor("#222")
      .text(travellers, 115, vy, { width: 430 });
    vy = Math.max(vy + 14, doc.y + 4);

    if (voucherLines.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777")
        .text(
          "(No fulfillment lines yet — add Hotel / Transfer / Activity lines to populate this block.)",
          50, vy, { width: 495 },
        );
      vy += 16;
    } else {
      const colVX = { subtype: 50, desc: 130, conf: 305, date: 405 };
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
      doc.text("Subtype", colVX.subtype, vy, { width: 70, align: "left" });
      doc.text("Description", colVX.desc, vy, { width: 165, align: "left" });
      doc.text("Supplier Conf #", colVX.conf, vy, { width: 90, align: "left" });
      doc.text("Service Date", colVX.date, vy, { width: 140, align: "left" });
      vy += 12;
      doc.moveTo(50, vy).lineTo(545, vy).lineWidth(0.4).strokeColor("#bbb").stroke();
      vy += 4;
      doc.font("Helvetica").fontSize(9).fillColor("#222");
      for (const line of voucherLines) {
        if (vy > 720) {
          doc.addPage();
          vy = 60;
        }
        const subtype = voucherSubtypeForLine(line.lineType);
        const confNum = line.bookingRef || line.pnr || "—";
        const range = formatVoucherServiceRange(
          line.serviceStartDate,
          line.serviceEndDate,
        );
        doc.text(subtype, colVX.subtype, vy, { width: 70, align: "left" });
        doc.text(String(line.description || "—"), colVX.desc, vy, {
          width: 165,
          align: "left",
        });
        doc.text(String(confNum), colVX.conf, vy, { width: 90, align: "left" });
        doc.text(range, colVX.date, vy, { width: 140, align: "left" });
        vy += 16;
      }
    }
    doc.y = vy + 6;
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.4).strokeColor("#ddd").stroke();
    doc.moveDown(0.6);
  }

  const isInterstate = !!invoice.placeOfSupplyInterstate;
  const tableTop = doc.y;
  const colX = {
    desc: 50,
    sac: 270,
    gst: 315,
    qty: 380,
    unit: 415,
    total: 475,
  };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  doc.text("SAC", colX.sac, tableTop, { width: 40, align: "left" });
  doc.text("GST", colX.gst, tableTop, { width: 60, align: "right" });
  doc.text("Qty", colX.qty, tableTop, { width: 30, align: "right" });
  doc.text("Unit", colX.unit, tableTop, { width: 55, align: "right" });
  doc.text("Amount", colX.total, tableTop, { width: 70, align: "right" });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  let computedSubtotal = 0;
  if (lines.length === 0) {
    doc.fillColor("#777").text(
      "(No line items on this invoice yet.)",
      colX.desc, rowY, { width: 480 },
    );
    rowY += 18;
  } else {
    for (const line of lines) {
      if (rowY > 700) { doc.addPage(); rowY = 60; }
      const qty = Number(line.quantity) || 0;
      const unit = Number(line.unitPrice) || 0;
      const amount = line.amount != null ? Number(line.amount) : qty * unit;
      computedSubtotal += amount;
      const sacCode = hsnSacMapper.sacForLineType(line.lineType);
      const gstPct = Number(line.gstPercent) || 0;
      const taxable = line.taxableValue != null
        ? Number(line.taxableValue)
        : amount;
      const split = gstCalculation.computeGstSplit({
        taxableAmount: taxable,
        gstPercent: gstPct,
        isInterstate,
      });
      let gstCell = "—";
      if (gstPct > 0) {
        if (isInterstate) {
          gstCell = `${gstPct}% IGST ${fmt(split.igst)}`;
        } else {
          const half = gstPct / 2;
          const halfStr = Number.isInteger(half) ? String(half) : half.toFixed(1);
          gstCell = `${halfStr}+${halfStr}% CGST/SGST ${fmt(split.cgst + split.sgst)}`;
        }
      }
      doc.fillColor("#222");
      doc.text(String(line.description || "—"), colX.desc, rowY, { width: 210 });
      doc.text(sacCode == null ? "—" : sacCode, colX.sac, rowY, { width: 40, align: "left" });
      doc.fontSize(8);
      doc.text(gstCell, colX.gst, rowY, { width: 60, align: "right" });
      doc.fontSize(10);
      doc.text(qty === 0 ? "—" : String(qty), colX.qty, rowY, { width: 30, align: "right" });
      doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 55, align: "right" });
      doc.text(fmt(amount), colX.total, rowY, { width: 70, align: "right" });
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  const grandTotal = invoice.totalAmount != null
    ? Number(invoice.totalAmount)
    : computedSubtotal;

  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  let ty = totalsY + 8;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(computedSubtotal), 450, ty, { width: 95, align: "right" });
  ty += 16;

  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  // S34 — paint "Total Due" label in the sub-brand's primaryColor so the
  // page's most-load-bearing figure is brand-tinted. Numeric value stays
  // #111 (high-contrast black) for readability.
  doc.font("Helvetica-Bold").fontSize(11).fillColor(primaryColor);
  doc.text("Total Due", 350, ty, { width: 95, align: "right" });
  doc.fillColor("#111");
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 18;
  doc.y = ty + 8;

  const hsnSummary = hsnSacMapper.groupLinesBySac(lines);
  if (hsnSummary.length > 0) {
    if (doc.y > 680) { doc.addPage(); }
    doc.moveDown(0.8);
    const summaryTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#333")
      .text("HSN/SAC Summary", 50, summaryTop);
    let sy = summaryTop + 16;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
    doc.text("SAC", 50, sy, { width: 50, align: "left" });
    doc.text("Description", 105, sy, { width: 230, align: "left" });
    doc.text("Rate", 340, sy, { width: 55, align: "right" });
    doc.text("Taxable Value", 400, sy, { width: 95, align: "right" });
    doc.text("Lines", 500, sy, { width: 45, align: "right" });
    sy += 12;
    doc.moveTo(50, sy).lineTo(545, sy).lineWidth(0.4).strokeColor("#bbb").stroke();
    sy += 4;
    doc.font("Helvetica").fontSize(9).fillColor("#222");
    for (const row of hsnSummary) {
      if (sy > 720) { doc.addPage(); sy = 60; }
      doc.text(row.sacCode, 50, sy, { width: 50, align: "left" });
      doc.text(row.description, 105, sy, { width: 230, align: "left" });
      doc.text(
        `${row.gstPercent}%`,
        340, sy, { width: 55, align: "right" },
      );
      doc.text(fmt(row.taxableValue), 400, sy, { width: 95, align: "right" });
      doc.text(String(row.count), 500, sy, { width: 45, align: "right" });
      doc.fillColor("#777").fontSize(7);
      doc.text(`${row.sacCode} / ${row.gstPercent}%`, 105, sy + 9, { width: 230, align: "left" });
      doc.fillColor("#222").fontSize(9);
      sy += 18;
    }
    doc.y = sy + 4;
  }

  doc.moveDown(1);
  const termsY = doc.y;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text("Payment Terms", 50, termsY);
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(
    invoice.dueDate
      ? `Payment is due by ${formatDate(invoice.dueDate)}. Please quote invoice number ${invoice.invoiceNum || invoice.id || ""} on any payment or correspondence.`
      : "Please quote the invoice number on any payment or correspondence.",
    50, termsY + 14, { width: 495 },
  );

  doc.moveDown(1);
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#444").text(
    docFooterText,
    50, doc.y, { width: 495 },
  );

  const footerY = doc.page.height - doc.page.margins.bottom - 24;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.4).strokeColor("#bbb").stroke();
  const tenantLine = tenant && tenant.name ? `${tenant.name} — ` : "";
  doc.font("Helvetica").fontSize(8).fillColor("#777").text(
    `${tenantLine}${brandLabel} — ${docHeaderTitle} #${invoice.invoiceNum || invoice.id || "?"}.`,
    50, footerY + 6, { width: doc.page.width - 100, align: "center" },
  );

  doc.end();
  return bufPromise;
}

const generateTravelInvoicePdf = renderTravelInvoicePdf;

// ─── G036 — Supplier PO PDF renderer ─────────────────────────────────
//
// Renders a TravelPurchaseOrder for printing / supplier dispatch. Mirrors
// the structure of renderTravelInvoicePdf: brand-coloured header band,
// supplier "Ship To" block, line items table, totals panel, payment terms
// footer.
//
// Inputs:
//   purchaseOrder: { id, poNumber, status, currency, subtotal, taxAmount,
//                    totalAmount, notes, sentAt, acknowledgedAt,
//                    fulfilledAt, createdAt, bookingId, supplier? }
//   supplier:      { id, name, subBrand, supplierCategory, contactPerson,
//                    phone, email, gstin, addressLine, paymentTermsDays }
//   lines:         [{ lineType, description, quantity, unitPrice,
//                     lineTotal, pnr, bookingRef, sortOrder }]
//   tenant:        { id, name, subBrandConfigJson } (subBrandConfig drives
//                    header colour via the existing brand-kit selector)
//   tenantSubBrand: explicit sub-brand override (passed by route — equals
//                    supplier.subBrand). Falls back to "_generic".
//
// Returns: Promise<Buffer> of the rendered PDF.
async function renderSupplierPo(opts) {
  const o = opts || {};
  const po = o.purchaseOrder || {};
  const supplier = o.supplier || {};
  const lines = Array.isArray(o.lines) ? o.lines : [];
  const tenant = o.tenant || null;
  const sub = o.tenantSubBrand || supplier.subBrand || null;

  // Re-use the same brand-kit selector the invoice renderer uses. Falls
  // back to INVOICE_BRAND_KIT_FALLBACKS._generic when no sub-brand match.
  const cfg = parseInvoiceSubBrandConfig(tenant && tenant.subBrandConfigJson);
  const { fields: brandKit } = resolveInvoiceBrandKit(cfg, sub);
  const accent = brandKit.headerColor || INVOICE_BRAND_KIT_FALLBACKS._generic.headerColor;
  const primaryColor = brandKit.primaryColor || INVOICE_BRAND_KIT_FALLBACKS._generic.primaryColor;
  const brandLabel = SUB_BRAND_LABEL[sub] || (tenant && tenant.name) || "Travel CRM";

  const currency = po.currency || "INR";
  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: { Producer: "Globussoft CRM (supplier-po)" },
  });
  const bufPromise = streamToBuffer(doc);

  // ── Header band ──
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Purchase Order", 50, 42, { align: "left" });

  // ── Meta block (top-right) ──
  const metaTop = 80;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
    .text("Purchase Order", 380, metaTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(`PO #: ${po.poNumber || po.id || "—"}`, 380, metaTop + 26, { width: 165, align: "right" });
  doc.text(
    `Issued: ${formatDate(po.createdAt || new Date())}`,
    380, metaTop + 40, { width: 165, align: "right" },
  );
  doc.text(`Status: ${po.status || "draft"}`, 380, metaTop + 54, { width: 165, align: "right" });
  if (po.sentAt) {
    doc.text(`Sent: ${formatDate(po.sentAt)}`, 380, metaTop + 68, { width: 165, align: "right" });
  }

  // ── "Ship To" supplier block (top-left) ──
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Supplier", 50, metaTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(supplier.name || "—", 50, metaTop + 18);
  if (supplier.contactPerson) doc.text(supplier.contactPerson, 50, doc.y);
  if (supplier.email) doc.text(supplier.email, 50, doc.y);
  if (supplier.phone) doc.text(supplier.phone, 50, doc.y);
  if (supplier.addressLine) doc.text(supplier.addressLine, 50, doc.y, { width: 320 });
  if (supplier.gstin) doc.text(`GSTIN: ${supplier.gstin}`, 50, doc.y);

  doc.y = Math.max(doc.y, metaTop + 110);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor(accent).stroke();
  doc.moveDown(0.8);

  // ── Line items table ──
  const tableTop = doc.y;
  const colX = { desc: 50, type: 280, qty: 360, unit: 410, total: 475 };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop, { width: 225 });
  doc.text("Type", colX.type, tableTop, { width: 75, align: "left" });
  doc.text("Qty", colX.qty, tableTop, { width: 40, align: "right" });
  doc.text("Unit", colX.unit, tableTop, { width: 60, align: "right" });
  doc.text("Amount", colX.total, tableTop, { width: 70, align: "right" });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  let computedSubtotal = 0;
  let computedTax = 0;
  let computedTotal = 0;
  if (lines.length === 0) {
    doc.fillColor("#777").text("(No lines on this PO yet.)", colX.desc, rowY, { width: 480 });
    rowY += 18;
  } else {
    for (const line of lines) {
      if (rowY > 700) { doc.addPage(); rowY = 60; }
      const qty = Number(line.quantity) || 0;
      const unit = Number(line.unitPrice) || 0;
      const total = line.lineTotal != null ? Number(line.lineTotal) : qty * unit;
      computedTotal += total;
      if (line.lineType === "service") computedSubtotal += total;
      if (line.lineType === "tax") computedTax += total;
      doc.fillColor("#222");
      const descMain = String(line.description || "—");
      doc.text(descMain, colX.desc, rowY, { width: 225 });
      // Render PNR/bookingRef as a secondary line under the description
      // when present (supplier-reconciliation cue).
      const reconParts = [];
      if (line.pnr) reconParts.push(`PNR ${line.pnr}`);
      if (line.bookingRef) reconParts.push(`Ref ${line.bookingRef}`);
      if (reconParts.length > 0) {
        doc.fillColor("#666").fontSize(8);
        doc.text(reconParts.join(" • "), colX.desc, doc.y, { width: 225 });
        doc.fontSize(10).fillColor("#222");
      }
      doc.text(String(line.lineType || "service"), colX.type, rowY, { width: 75 });
      doc.text(qty === 0 ? "—" : String(qty), colX.qty, rowY, { width: 40, align: "right" });
      doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 60, align: "right" });
      doc.text(fmt(total), colX.total, rowY, { width: 70, align: "right" });
      rowY = Math.max(rowY + 20, doc.y + 4);
    }
  }
  doc.y = rowY + 4;

  // ── Totals panel (bottom-right) ──
  const subtotalShown = po.subtotal != null ? Number(po.subtotal) : computedSubtotal;
  const taxShown = po.taxAmount != null ? Number(po.taxAmount) : computedTax;
  const totalShown = po.totalAmount != null ? Number(po.totalAmount) : computedTotal;

  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  let ty = totalsY + 8;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(subtotalShown), 450, ty, { width: 95, align: "right" });
  ty += 16;
  if (taxShown !== 0) {
    doc.text("Tax", 350, ty, { width: 95, align: "right" });
    doc.text(fmt(taxShown), 450, ty, { width: 95, align: "right" });
    ty += 16;
  }
  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(primaryColor);
  doc.text("PO Total", 350, ty, { width: 95, align: "right" });
  doc.fillColor("#111");
  doc.text(fmt(totalShown), 450, ty, { width: 95, align: "right" });
  ty += 18;
  doc.y = ty + 8;

  // ── Payment terms footer ──
  doc.moveDown(1);
  const termsY = doc.y;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text("Payment Terms", 50, termsY);
  const termsText = supplier.paymentTermsDays
    ? `Net ${supplier.paymentTermsDays} days from PO issue date.`
    : "As agreed with supplier.";
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(termsText, 50, termsY + 14, { width: 495 });

  if (po.notes) {
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text("Notes", 50, doc.y);
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(String(po.notes), 50, doc.y, { width: 495 });
  }

  doc.moveDown(1);
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#444").text(
    "This purchase order is issued pursuant to the supplier agreement. Please acknowledge by quoting the PO number on any correspondence.",
    50, doc.y, { width: 495 },
  );

  const footerY = doc.page.height - doc.page.margins.bottom - 24;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.4).strokeColor("#bbb").stroke();
  const tenantLine = tenant && tenant.name ? `${tenant.name} — ` : "";
  doc.font("Helvetica").fontSize(8).fillColor("#777").text(
    `${tenantLine}${brandLabel} — Purchase Order #${po.poNumber || po.id || "?"}.`,
    50, footerY + 6, { width: doc.page.width - 100, align: "center" },
  );

  doc.end();
  return bufPromise;
}

module.exports = {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderBrandedInvoicePdf,
  renderPatientSummaryPdf,
  generatePosReceiptPdf,
  // Exported for vitest coverage of the customer-facing zylu mask.
  scrubZyluText,
  scrubZyluSource,
  // Exported so route + tests can share the same visit-photo URL parser.
  parsePhotoUrls,
  // Travel CRM exports — ported from main worktree to satisfy
  // travel_invoices / travel_quotes route handlers and the
  // slice-2/8/13/18 gate specs (#900/#901/#902).
  renderTravelDiagnosticPdf,
  renderTmcReadinessReport,
  renderTravelItineraryPdf,
  // PRD §4.7 (gap A3) — per-viewer diagonal watermark for travel docs.
  // Exported for unit tests AND consumed internally via the
  // module.exports self-mocking seam so vitest can spy on application.
  applyViewerWatermark,
  renderTravelStallPersonalisedPdf,
  renderTravelQuotePdf,
  generateTravelQuotePdf,
  renderTravelInvoicePdf,
  generateTravelInvoicePdf,
  // PRD_TRAVEL_SUPPLIER_MASTER G036 — supplier PO PDF.
  renderSupplierPo,
  voucherSubtypeForLine,
  formatVoucherServiceRange,
  extractTravellerListFromInvoice,
  // S34 — brand-kit selector helpers exported so unit tests (and any
  // future routes that need to preview brand-kit resolution before
  // rendering the PDF) can exercise the same code path the renderer uses.
  INVOICE_BRAND_KIT_FIELDS,
  INVOICE_BRAND_KIT_FALLBACKS,
  parseInvoiceSubBrandConfig,
  resolveInvoiceBrandKit,
  // S52 — generic-named aliases so sibling travel PDF helpers + their
  // tests can read the selector under a name that doesn't carry an
  // "Invoice" suffix (the same helper body powers itinerary / quote /
  // diagnostic / tmc-readiness / travelstall-personalised PDFs after
  // the brand-kit adoption sweep). + shared header-brand-kit resolver
  // for one-call use inside the renderers.
  parseTravelSubBrandConfig,
  resolveTravelBrandKit,
  resolveTravelHeaderBrandKit,
  // S51 — logo-image fetch + LRU cache. Exported via module.exports so the
  // renderer can call `module.exports.fetchLogoBuffer(...)` (the CJS self-
  // mocking seam pattern) and vitest cases can vi.spyOn(...) the surface
  // without touching axios. `_resetLogoCache` is a test-only nuker so the
  // module-level cache doesn't bleed between cases.
  fetchLogoBuffer,
  _resetLogoCache,
};
