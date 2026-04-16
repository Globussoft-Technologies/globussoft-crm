const express = require("express");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const router = express.Router();

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
    const pages = await prisma.bookingPage.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });

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
    const { title, description, durationMins, bufferMins, availability, isActive } = req.body || {};
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
        ownerId: req.user.userId || req.user.id || 1,
        durationMins: parseInt(durationMins, 10) || 30,
        bufferMins: parseInt(bufferMins, 10) || 0,
        availability: availStr,
        isActive: isActive !== false,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(page);
  } catch (err) {
    console.error("[BookingPages] Create error:", err);
    res.status(500).json({ error: "Failed to create booking page" });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.bookingPage.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Booking page not found" });

    const { title, description, durationMins, bufferMins, availability, isActive } = req.body || {};
    const data = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (durationMins !== undefined) data.durationMins = parseInt(durationMins, 10) || existing.durationMins;
    if (bufferMins !== undefined) data.bufferMins = parseInt(bufferMins, 10) || 0;
    if (availability !== undefined) data.availability = typeof availability === "string" ? availability : JSON.stringify(availability);
    if (isActive !== undefined) data.isActive = !!isActive;

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
