const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const router = express.Router();

// Wave 7D — PRD Gap §6 item 8 — image upload for the Mini Website rich editor.
// Mirrors the pattern from routes/landing_pages.js (multer disk storage under
// `backend/uploads/`). The directory is created on demand so a fresh checkout
// works without bootstrap. Files are PNG/JPEG/WebP only, max 4 MB.
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "booking-pages");
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* best-effort */ }
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = /^\.(png|jpe?g|webp)$/i.test(ext) ? ext.toLowerCase() : ".png";
      const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      cb(null, `bp-${stamp}${safeExt}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype || "")) return cb(null, true);
    return cb(new Error("Only PNG / JPEG / WebP images are allowed"));
  },
});

// Wave 7D — coerce the rich-content fields into the safe DB shape. Keeps the
// route validation logic close to the column definitions so a future Prisma
// migration that flips a column type can update one place.
function coerceFeaturedServiceIds(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map((n) => parseInt(n, 10)).filter(Number.isFinite));
    } catch { /* fall through */ }
    return undefined;
  }
  if (Array.isArray(raw)) return JSON.stringify(raw.map((n) => parseInt(n, 10)).filter(Number.isFinite));
  return undefined;
}
function coerceHoursJson(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") {
    try { JSON.parse(raw); return raw; } catch { return undefined; }
  }
  if (typeof raw === "object") return JSON.stringify(raw);
  return undefined;
}
function parseFeaturedServiceIds(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map((n) => parseInt(n, 10)).filter(Number.isFinite) : [];
  } catch { return []; }
}
function parseHoursJson(raw) {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

// ── Helpers ──────────────────────────────────────────────────────

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function slugify(text) {
  return String(text || "page")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "page";
}

function parseAvailability(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function timeToMinutes(t) {
  const [h, m] = String(t).split(":").map(n => parseInt(n, 10) || 0);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Build slot list for a given date (YYYY-MM-DD), excluding already-booked times.
async function buildSlotsForDate(page, dateStr) {
  const availability = parseAvailability(page.availability);
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  if (isNaN(date.getTime())) return [];

  const dayName = DAY_NAMES[date.getUTCDay()];
  const windows = Array.isArray(availability[dayName]) ? availability[dayName] : [];
  if (windows.length === 0) return [];

  const duration = page.durationMins || 30;
  const buffer = page.bufferMins || 0;
  const step = duration + buffer;

  // Build candidate slots
  const candidates = [];
  for (const win of windows) {
    if (!win || !win.start || !win.end) continue;
    const startMin = timeToMinutes(win.start);
    const endMin = timeToMinutes(win.end);
    for (let m = startMin; m + duration <= endMin; m += step) {
      const slotStart = new Date(date);
      slotStart.setUTCHours(Math.floor(m / 60), m % 60, 0, 0);
      candidates.push({ time: minutesToTime(m), iso: slotStart.toISOString() });
    }
  }

  if (candidates.length === 0) return [];

  // Filter against existing bookings on that date
  const dayStart = new Date(date);
  const dayEnd = new Date(date);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const existing = await prisma.booking.findMany({
    where: {
      bookingPageId: page.id,
      status: { not: "CANCELED" },
      scheduledAt: { gte: dayStart, lt: dayEnd },
    },
    select: { scheduledAt: true, durationMins: true },
  });

  const takenIso = new Set(existing.map(b => new Date(b.scheduledAt).toISOString()));
  const now = Date.now();
  return candidates.filter(c => !takenIso.has(c.iso) && new Date(c.iso).getTime() > now);
}

// ── Authenticated CRUD (CRM users) ───────────────────────────────

router.get("/", verifyToken, async (req, res) => {
  try {
    // #920 slice 40: ?fields=summary slim-shape opt-in. Mirrors slices 1-39.
    // The default list returns the full BookingPage row including heavy
    // @db.Text columns — availability (JSON), logoUrl, heroImageUrl,
    // heroSubheadline, featuredServiceIds (JSON-string array), hoursJson
    // (JSON-string weekday map), and the description blob. Picker /
    // dropdown UI (link-to-booking-page form fields, slug-collision check,
    // settings → "default booking page" selector) doesn't need any of
    // that — only id + slug + title + isActive + durationMins +
    // bufferMins + createdAt + updatedAt + the bookingCount roll-up.
    // When the caller passes ?fields=summary we project to that minimal
    // set. Opt-in additive — existing callers (no ?fields, or any
    // non-exact value) get the full row shape unchanged so the
    // BookingPages.jsx library page continues to render hero / featured
    // services / hours / etc. on each card.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        slug: true,
        title: true,
        isActive: true,
        durationMins: true,
        bufferMins: true,
        createdAt: true,
        updatedAt: true,
      };
    }
    const pages = await prisma.bookingPage.findMany(findManyArgs);

    const ids = pages.map(p => p.id);
    let counts = {};
    if (ids.length) {
      const grouped = await prisma.booking.groupBy({
        by: ["bookingPageId"],
        where: { bookingPageId: { in: ids }, tenantId: req.user.tenantId, status: { not: "CANCELED" } },
        _count: { _all: true },
      });
      counts = Object.fromEntries(grouped.map(g => [g.bookingPageId, g._count._all]));
    }

    res.json(pages.map(p => ({ ...p, bookingCount: counts[p.id] || 0 })));
  } catch (err) {
    console.error("[BookingPages] List error:", err);
    res.status(500).json({ error: "Failed to fetch booking pages" });
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const {
      title, description, durationMins, bufferMins, availability, isActive,
      logoUrl, heroImageUrl, heroHeadline, heroSubheadline,
      featuredServiceIds, contactPhone, contactEmail, hoursJson,
    } = req.body || {};
    if (!title) return res.status(400).json({ error: "title is required" });

    const baseSlug = slugify(title);
    const slug = `${baseSlug}-${Date.now().toString(36)}`;

    const availStr = typeof availability === "string"
      ? availability
      : JSON.stringify(availability || {
          monday: [{ start: "09:00", end: "17:00" }],
          tuesday: [{ start: "09:00", end: "17:00" }],
          wednesday: [{ start: "09:00", end: "17:00" }],
          thursday: [{ start: "09:00", end: "17:00" }],
          friday: [{ start: "09:00", end: "17:00" }],
          saturday: [],
          sunday: [],
        });

    const page = await prisma.bookingPage.create({
      data: {
        slug,
        title,
        description: description || null,
        ownerId: req.user.userId || 1,
        durationMins: parseInt(durationMins, 10) || 30,
        bufferMins: parseInt(bufferMins, 10) || 0,
        availability: availStr,
        isActive: isActive !== false,
        tenantId: req.user.tenantId,
        // Wave 7D rich-content fields (all optional)
        logoUrl: logoUrl || null,
        heroImageUrl: heroImageUrl || null,
        heroHeadline: heroHeadline || null,
        heroSubheadline: heroSubheadline || null,
        featuredServiceIds: coerceFeaturedServiceIds(featuredServiceIds) || null,
        contactPhone: contactPhone || null,
        contactEmail: contactEmail || null,
        hoursJson: coerceHoursJson(hoursJson) || null,
      },
    });
    res.status(201).json(page);
  } catch (err) {
    console.error("[BookingPages] Create error:", err);
    res.status(500).json({ error: "Failed to create booking page" });
  }
});

// ============================================================================
// GET /api/booking-pages/stats — tenant-wide booking-page rollup
//
// First /stats endpoint on the BookingPage surface. Powers the Booking-Pages
// library page header (totalPages / activeCount KPI strip + associated
// bookings rollup). Mirrors the canonical pattern from travel-suppliers /
// commission-profiles / billing / accounting stats endpoints:
//   - tenant-scoped on req.user.tenantId
//   - optional ?from / ?to ISO date bounds on BookingPage.createdAt
//   - 400 INVALID_DATE on unparseable bounds (independent validation)
//   - empty-tenant short-circuit returns zeroed envelope
//   - no audit row written (anodyne read-only meta surface)
//
// Aggregates returned:
//   - totalPages — count of BookingPage rows in scope
//   - activeCount — count where isActive=true
//   - byVertical — single-key map of tenant.vertical → count
//     (BookingPage rows in a tenant-scoped query all share the same vertical
//     by definition, so this is the tenant's vertical with the total count.
//     Surfaced as a map so the shape forward-compats with a future
//     migration that adds BookingPage.vertical for cross-tenant superset
//     queries — frontends keying off byVertical[v] keep working.)
//   - totalBookings — count of associated Booking rows (excludes CANCELED)
//   - lastCreatedAt — max BookingPage.createdAt ISO string or null
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family or `:id="stats"` would be parsed as an id and parseInt
// would yield NaN → 404.
// ============================================================================
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // Optional ISO date bounds on BookingPage.createdAt — independent
    // validation so a bad ?from short-circuits before parsing ?to.
    const where = { tenantId };
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    const pages = await prisma.bookingPage.findMany({
      where,
      select: { id: true, isActive: true, createdAt: true },
    });

    // Empty-tenant short-circuit. Mirrors travel-suppliers /stats shape.
    if (pages.length === 0) {
      return res.json({
        totalPages: 0,
        activeCount: 0,
        byVertical: {},
        totalBookings: 0,
        lastCreatedAt: null,
      });
    }

    // Counts + lastCreatedAt in a single pass.
    let activeCount = 0;
    let lastCreatedAt = null;
    for (const p of pages) {
      if (p.isActive) activeCount += 1;
      const ts = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastCreatedAt || ts > lastCreatedAt) lastCreatedAt = ts;
      }
    }

    // byVertical: one-shot Tenant lookup. BookingPage rows in a tenant-scoped
    // query all share the same vertical, so this collapses to a single bucket.
    // Defensive fallback to '_unknown' if tenant row is missing (shouldn't
    // happen with the FK constraint, but keeps the response shape stable).
    const byVertical = {};
    const tenant = await prisma.tenant
      .findUnique({ where: { id: tenantId }, select: { vertical: true } })
      .catch(() => null);
    const vKey = tenant && tenant.vertical ? String(tenant.vertical) : "_unknown";
    byVertical[vKey] = pages.length;

    // totalBookings — associated Booking rows across the visible page set,
    // excluding CANCELED so the count matches the user's mental model of
    // "live bookings" (same exclusion as the GET / list count subquery).
    const pageIds = pages.map((p) => p.id);
    const totalBookings = await prisma.booking.count({
      where: {
        bookingPageId: { in: pageIds },
        tenantId,
        status: { not: "CANCELED" },
      },
    });

    res.json({
      totalPages: pages.length,
      activeCount,
      byVertical,
      totalBookings,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[BookingPages] Stats error:", err);
    res.status(500).json({ error: "Failed to fetch booking-page stats" });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.bookingPage.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Booking page not found" });

    const {
      title, description, durationMins, bufferMins, availability, isActive,
      logoUrl, heroImageUrl, heroHeadline, heroSubheadline,
      featuredServiceIds, contactPhone, contactEmail, hoursJson,
    } = req.body || {};
    const data = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (durationMins !== undefined) data.durationMins = parseInt(durationMins, 10) || existing.durationMins;
    if (bufferMins !== undefined) data.bufferMins = parseInt(bufferMins, 10) || 0;
    if (availability !== undefined) data.availability = typeof availability === "string" ? availability : JSON.stringify(availability);
    if (isActive !== undefined) data.isActive = !!isActive;
    // Wave 7D rich-content fields. Allow null clears via explicit null.
    if (logoUrl !== undefined) data.logoUrl = logoUrl || null;
    if (heroImageUrl !== undefined) data.heroImageUrl = heroImageUrl || null;
    if (heroHeadline !== undefined) data.heroHeadline = heroHeadline || null;
    if (heroSubheadline !== undefined) data.heroSubheadline = heroSubheadline || null;
    if (featuredServiceIds !== undefined) {
      const coerced = coerceFeaturedServiceIds(featuredServiceIds);
      data.featuredServiceIds = coerced === undefined ? null : coerced;
    }
    if (contactPhone !== undefined) data.contactPhone = contactPhone || null;
    if (contactEmail !== undefined) data.contactEmail = contactEmail || null;
    if (hoursJson !== undefined) {
      const coerced = coerceHoursJson(hoursJson);
      data.hoursJson = coerced === undefined ? null : coerced;
    }

    const updated = await prisma.bookingPage.update({ where: { id: existing.id }, data });
    res.json(updated);
  } catch (err) {
    console.error("[BookingPages] Update error:", err);
    res.status(500).json({ error: "Failed to update booking page" });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.bookingPage.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Booking page not found" });

    await prisma.booking.deleteMany({ where: { bookingPageId: existing.id, tenantId: req.user.tenantId } });
    await prisma.bookingPage.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[BookingPages] Delete error:", err);
    res.status(500).json({ error: "Failed to delete booking page" });
  }
});

router.get("/:id/bookings", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const page = await prisma.bookingPage.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!page) return res.status(404).json({ error: "Booking page not found" });

    const bookings = await prisma.booking.findMany({
      where: { bookingPageId: page.id, tenantId: req.user.tenantId },
      orderBy: { scheduledAt: "desc" },
      take: 200,
    });
    res.json(bookings);
  } catch (err) {
    console.error("[BookingPages] Bookings list error:", err);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

router.post("/:id/cancel/:bookingId", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const bookingId = parseInt(req.params.bookingId, 10);
    const page = await prisma.bookingPage.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!page) return res.status(404).json({ error: "Booking page not found" });

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, bookingPageId: page.id, tenantId: req.user.tenantId },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELED" },
    });
    res.json(updated);
  } catch (err) {
    console.error("[BookingPages] Cancel error:", err);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
});

// Wave 7D — POST /:id/upload — accept a logo or hero image upload, return
// a relative URL the editor can stash into logoUrl / heroImageUrl. Multer
// stores the file under backend/uploads/booking-pages/. The kind query
// param distinguishes "logo" vs "hero" but only affects bookkeeping —
// both end up at the same /uploads URL prefix.
router.post("/:id/upload", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const existing = await prisma.bookingPage.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) {
      // Clean up the orphaned upload before bailing.
      if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch { /* swallow */ } }
      return res.status(404).json({ error: "Booking page not found" });
    }
    if (!req.file) return res.status(400).json({ error: "file is required (multipart field 'file')" });
    const url = `/uploads/booking-pages/${req.file.filename}`;
    const kind = (req.query.kind || req.body.kind || "logo") === "hero" ? "hero" : "logo";
    const data = kind === "hero" ? { heroImageUrl: url } : { logoUrl: url };
    const updated = await prisma.bookingPage.update({ where: { id: existing.id }, data });
    res.status(201).json({ success: true, kind, url, page: updated });
  } catch (err) {
    console.error("[BookingPages] Upload error:", err);
    if (err && /file too large|allowed/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to upload image" });
  }
});

// ── Public routes (no auth, mounted under /booking-pages/public/*) ─

router.get("/public/:slug", async (req, res) => {
  try {
    const page = await prisma.bookingPage.findUnique({ where: { slug: req.params.slug } });
    if (!page || !page.isActive) return res.status(404).json({ error: "Booking page not found" });

    const owner = await prisma.user.findUnique({
      where: { id: page.ownerId },
      select: { name: true, email: true },
    }).catch(() => null);

    // Build slots for next 14 days
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const slots = await buildSlotsForDate(page, dateStr);
      days.push({ date: dateStr, dayName: DAY_NAMES[d.getUTCDay()], slotCount: slots.length });
    }

    res.json({
      slug: page.slug,
      title: page.title,
      description: page.description,
      durationMins: page.durationMins,
      bufferMins: page.bufferMins,
      ownerName: owner?.name || owner?.email || "Host",
      availability: parseAvailability(page.availability),
      days,
      // Wave 7D — surface rich-content fields on the public payload so
      // the iframe / mini-website widget can render the logo, hero, and
      // featured-services block alongside the slot picker.
      logoUrl: page.logoUrl || null,
      heroImageUrl: page.heroImageUrl || null,
      heroHeadline: page.heroHeadline || null,
      heroSubheadline: page.heroSubheadline || null,
      featuredServiceIds: parseFeaturedServiceIds(page.featuredServiceIds),
      contactPhone: page.contactPhone || null,
      contactEmail: page.contactEmail || null,
      hours: parseHoursJson(page.hoursJson),
    });
  } catch (err) {
    console.error("[BookingPages] Public details error:", err);
    res.status(500).json({ error: "Failed to load booking page" });
  }
});

router.get("/public/:slug/slots", async (req, res) => {
  try {
    const page = await prisma.bookingPage.findUnique({ where: { slug: req.params.slug } });
    if (!page || !page.isActive) return res.status(404).json({ error: "Booking page not found" });

    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
    }

    const slots = await buildSlotsForDate(page, date);
    res.json({ date, durationMins: page.durationMins, slots });
  } catch (err) {
    console.error("[BookingPages] Public slots error:", err);
    res.status(500).json({ error: "Failed to load slots" });
  }
});

router.post("/public/:slug/book", async (req, res) => {
  try {
    const page = await prisma.bookingPage.findUnique({ where: { slug: req.params.slug } });
    if (!page || !page.isActive) return res.status(404).json({ error: "Booking page not found" });

    const { contactName, contactEmail, contactPhone, scheduledAt, notes } = req.body || {};
    if (!contactName || !contactEmail || !scheduledAt) {
      return res.status(400).json({ error: "contactName, contactEmail and scheduledAt are required" });
    }

    const when = new Date(scheduledAt);
    if (isNaN(when.getTime())) return res.status(400).json({ error: "Invalid scheduledAt" });
    if (when.getTime() <= Date.now()) return res.status(400).json({ error: "scheduledAt must be in the future" });

    // Validate slot is still available for that day
    const dateStr = when.toISOString().slice(0, 10);
    const slots = await buildSlotsForDate(page, dateStr);
    const wantedIso = when.toISOString();
    if (!slots.some(s => s.iso === wantedIso)) {
      return res.status(409).json({ error: "Selected time is no longer available" });
    }

    // Link to existing contact when email matches in this tenant
    const existingContact = await prisma.contact.findFirst({
      where: { email: contactEmail, tenantId: page.tenantId },
      select: { id: true },
    }).catch(() => null);

    const meetingUrl = `https://meet.globusdemos.com/${page.slug}-${Date.now().toString(36)}`;

    const booking = await prisma.booking.create({
      data: {
        bookingPageId: page.id,
        contactName,
        contactEmail,
        contactPhone: contactPhone || null,
        scheduledAt: when,
        durationMins: page.durationMins,
        meetingUrl,
        notes: notes || null,
        status: "CONFIRMED",
        contactId: existingContact?.id || null,
        tenantId: page.tenantId,
      },
    });

    if (req.io) req.io.emit("booking_created", { bookingPageId: page.id, bookingId: booking.id });

    res.status(201).json({
      success: true,
      message: "Booking confirmed",
      booking: {
        id: booking.id,
        scheduledAt: booking.scheduledAt,
        durationMins: booking.durationMins,
        meetingUrl: booking.meetingUrl,
        status: booking.status,
      },
    });
  } catch (err) {
    console.error("[BookingPages] Public book error:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

module.exports = router;
