/**
 * External Partner API — /api/v1/external
 *
 * Consumed by sister Globussoft products:
 *   - Callified.ai  (voice + WhatsApp)
 *   - Globus Phone  (softphone)
 *
 * Auth: X-API-Key header (see middleware/externalAuth.js)
 * All endpoints are tenant-scoped to the tenant that owns the key.
 *
 * Design principles:
 *   - Versioned (/v1/) so we can evolve without breaking partners
 *   - Use-case-shaped endpoints, not generic CRUD dumps
 *   - Read endpoints return { data, total } for lists; single object for :id
 *   - Write endpoints return the created resource with status 201
 *   - Error shape: { error: "human message", code?: "MACHINE_CODE" }
 *   - Phone numbers accepted in E.164 or Indian local — normalized on input
 */
const express = require("express");
const prisma = require("../lib/prisma");
const externalAuth = require("../middleware/externalAuth");
const { classifyLead } = require("../lib/leadJunkFilter");
const { pickAssignee } = require("../lib/leadAutoRouter");

const router = express.Router();

// Public endpoint (no auth) — lets partners verify the API is reachable
// before they configure their key. Must be declared before externalAuth.
router.get("/health", (_req, res) => {
  res.json({ status: "ok", apiVersion: "v1" });
});

// Reject non-numeric :id params with 400 instead of falling through to Prisma.
router.param("id", (req, res, next, id) => {
  const n = parseInt(id, 10);
  if (Number.isNaN(n) || n < 1) {
    return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
  }
  next();
});

router.use(externalAuth);

// ── Helpers ────────────────────────────────────────────────────────

const tenantWhere = (req, extra = {}) => ({ tenantId: req.tenantId, ...extra });

// Normalize phone to a comparable form. We store phones as entered, so we
// match on any suffix that matches the last 10 digits (Indian mobiles).
const normalizedSuffix = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
};
const phoneMatches = (input) => {
  const suf = normalizedSuffix(input);
  if (!suf) return null;
  return { contains: suf };
};

const parseLimit = (v, def = 50, max = 200) => Math.min(parseInt(v) || def, max);
const parseOffset = (v) => parseInt(v) || 0;

// ── Tenant info ────────────────────────────────────────────────────

router.get("/me", async (req, res) => {
  res.json({
    tenant: {
      id: req.tenant.id,
      name: req.tenant.name,
      slug: req.tenant.slug,
      vertical: req.tenant.vertical || "generic",
      plan: req.tenant.plan,
      country: req.tenant.country || "US",
      defaultCurrency: req.tenant.defaultCurrency || "USD",
      locale: req.tenant.locale || "en-US",
      logoUrl: req.tenant.logoUrl,
      brandColor: req.tenant.brandColor,
    },
    apiKey: { id: req.apiKey.id, name: req.apiKey.name, lastUsed: req.apiKey.lastUsed },
    capabilities: {
      wellness: req.tenant.vertical === "wellness",
    },
  });
});

// ── Contacts: lookup + fetch ───────────────────────────────────────

router.get("/contacts/lookup", async (req, res) => {
  try {
    const { phone, email } = req.query;
    if (!phone && !email) return res.status(400).json({ error: "phone or email required", code: "MISSING_QUERY" });

    const where = tenantWhere(req);
    if (phone) where.phone = phoneMatches(phone);
    if (email) where.email = email;

    const contact = await prisma.contact.findFirst({
      where,
      select: {
        id: true, name: true, email: true, phone: true, status: true, source: true,
        company: true, aiScore: true, assignedToId: true, createdAt: true,
      },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found", code: "NOT_FOUND" });
    res.json(contact);
  } catch (e) {
    console.error("[external] contacts/lookup:", e.message);
    res.status(500).json({ error: "Lookup failed" });
  }
});

router.get("/contacts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const contact = await prisma.contact.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        activities: { orderBy: { createdAt: "desc" }, take: 20 },
        deals: { select: { id: true, title: true, amount: true, stage: true, createdAt: true } },
      },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json(contact);
  } catch (e) {
    console.error("[external] contacts/:id:", e.message);
    res.status(500).json({ error: "Fetch failed" });
  }
});

// ── Patients (wellness tenants only): lookup + fetch ───────────────

router.get("/patients/lookup", async (req, res) => {
  try {
    const { phone, email } = req.query;
    if (!phone && !email) return res.status(400).json({ error: "phone or email required" });

    const where = tenantWhere(req);
    if (phone) where.phone = phoneMatches(phone);
    if (email) where.email = email;

    const patient = await prisma.patient.findFirst({
      where,
      select: { id: true, name: true, email: true, phone: true, gender: true, dob: true, source: true, locationId: true, createdAt: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    res.json(patient);
  } catch (e) {
    console.error("[external] patients/lookup:", e.message);
    res.status(500).json({ error: "Lookup failed" });
  }
});

router.get("/patients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        visits: {
          orderBy: { visitDate: "desc" }, take: 20,
          select: { id: true, visitDate: true, status: true, notes: true, amountCharged: true, serviceId: true, doctorId: true },
        },
        treatmentPlans: { select: { id: true, name: true, totalSessions: true, completedSessions: true, status: true, nextDueAt: true } },
        prescriptions: { select: { id: true, createdAt: true, drugs: true }, take: 10, orderBy: { createdAt: "desc" } },
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    res.json(patient);
  } catch (e) {
    console.error("[external] patients/:id:", e.message);
    res.status(500).json({ error: "Fetch failed" });
  }
});

// ── Leads — polling + create ───────────────────────────────────────
//
// Flow supported:
//   Website    → POST /leads (website captures the lead, pushes into CRM)
//   Callified  → GET  /leads?since=<ISO>&unqualified=true (polls for new leads)
//   Callified  → POST /calls (after auto-dialing, pushes recordingUrl back)
// The CRM user plays recordings from CallLog.recordingUrl (hosted on Callified).

router.get("/leads", async (req, res) => {
  try {
    const { since, source, limit } = req.query;
    const where = tenantWhere(req, { status: "Lead" });
    if (since) where.createdAt = { gte: new Date(since) };
    if (source) where.source = source;

    const leads = await prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parseLimit(limit, 100),
      select: {
        id: true, name: true, email: true, phone: true, source: true,
        firstTouchSource: true, status: true, aiScore: true, createdAt: true,
      },
    });
    res.json({ data: leads, total: leads.length, since: since || null });
  } catch (e) {
    console.error("[external] leads list:", e.message);
    res.status(500).json({ error: "Failed to list leads" });
  }
});

// ── Inbound leads (website or Callified: new caller → Lead in CRM) ─

router.post("/leads", async (req, res) => {
  try {
    const { name, phone, email, source, note, utm } = req.body;
    if (!name && !phone && !email) {
      return res.status(400).json({ error: "name, phone, or email required", code: "INSUFFICIENT_IDENTITY" });
    }

    // Run the junk filter before persisting (rules + optional Gemini AI)
    const verdict = await classifyLead({
      tenantId: req.tenantId,
      name, phone, email, source,
    });

    // Auto-route to a specialist / telecaller (skip junk leads — they go nowhere)
    let assignee = { userId: null, reason: "junk skipped routing" };
    if (!verdict.isJunk) {
      assignee = await pickAssignee({
        tenantId: req.tenantId,
        name, phone, email, source, note,
      });
    }

    // Dedupe: if a real email was supplied and a contact already exists under
    // this tenant, reuse it (the Contact_email_tenantId_key constraint would
    // otherwise throw P2002 on every duplicate Meta/Google webhook delivery).
    // Contacts without an email get a synthetic unique address, so they can
    // never collide and always create fresh.
    const resolvedEmail = email || `lead-${Date.now()}@inbound.local`;
    const contactData = {
      name: name || (phone ? `Caller ${phone}` : "Unknown caller"),
      email: resolvedEmail,
      phone: phone || null,
      status: verdict.isJunk ? "Junk" : "Lead",
      source: source || "callified",
      firstTouchSource: source || "callified",
      aiScore: verdict.score,
      assignedToId: assignee.userId,
      tenantId: req.tenantId,
    };
    let contact;
    let deduped = false;
    if (email) {
      // Upsert on the compound unique key (email + tenantId)
      const existing = await prisma.contact.findFirst({
        where: { email, tenantId: req.tenantId },
      });
      if (existing) {
        contact = existing;
        deduped = true;
      } else {
        contact = await prisma.contact.create({ data: contactData });
      }
    } else {
      contact = await prisma.contact.create({ data: contactData });
    }

    // Attach an activity so the CRM's inbox shows the origin + junk verdict
    const activityBits = [
      note,
      utm && `utm=${JSON.stringify(utm)}`,
      verdict.reasons.length && `junk-filter: ${verdict.reasons.join("; ")}`,
    ].filter(Boolean);
    if (activityBits.length) {
      await prisma.activity.create({
        data: {
          type: verdict.isJunk ? "JunkFilter" : "Note",
          description: activityBits.join(" | "),
          contactId: contact.id,
          tenantId: req.tenantId,
        },
      });
    }

    res.status(deduped ? 200 : 201).json({
      ...contact,
      _verdict: verdict,
      _routing: assignee,
      ...(deduped ? { _deduped: true } : {}),
    });
  } catch (e) {
    console.error("[external] create lead:", e.message);
    // Belt-and-braces: if a race slipped through the explicit dedupe above
    // and we still hit P2002, return the existing row.
    if (e.code === "P2002" && req.body.email) {
      const existing = await prisma.contact.findFirst({
        where: tenantWhere(req, { email: req.body.email }),
      });
      if (existing) return res.status(200).json({ ...existing, _deduped: true });
    }
    res.status(500).json({ error: "Failed to create lead" });
  }
});

// ── Activity logs: calls + messages ────────────────────────────────

router.post("/calls", async (req, res) => {
  try {
    const {
      contactId,
      phone,                             // inbound caller or outbound callee
      callerNumber, calleeNumber,        // explicit override if partner has both
      direction = "INBOUND",             // INBOUND | OUTBOUND
      durationSec,
      recordingUrl,
      status,                            // INITIATED | RINGING | CONNECTED | COMPLETED | MISSED | FAILED
      provider,                          // "callified", "globus-phone", etc.
      providerCallId,                    // partner's call ID for idempotency
      notes,
      agentUserId,
    } = req.body;

    if (!phone && !callerNumber && !calleeNumber && !contactId) {
      return res.status(400).json({ error: "phone or contactId required" });
    }

    const dir = String(direction).toUpperCase();
    const call = await prisma.callLog.create({
      data: {
        direction: dir,
        duration: durationSec ? parseInt(durationSec) : 0,
        recordingUrl: recordingUrl || null,
        status: status ? String(status).toUpperCase() : "COMPLETED",
        provider: provider || (req.apiKey?.name || "external"),
        providerCallId: providerCallId || null,
        callerNumber: callerNumber || (dir === "INBOUND" ? phone : null),
        calleeNumber: calleeNumber || (dir === "OUTBOUND" ? phone : null),
        notes: notes || null,
        contactId: contactId ? parseInt(contactId) : null,
        userId: agentUserId ? parseInt(agentUserId) : null,
        tenantId: req.tenantId,
      },
    });
    res.status(201).json(call);
  } catch (e) {
    console.error("[external] create call:", e.message);
    res.status(500).json({ error: "Failed to log call", detail: e.message });
  }
});

// PATCH /calls/:id — update a previously-pushed call (e.g. transcript landed
// 5 min after the call ended). Idempotent; only updates fields you send.
router.patch("/calls/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.callLog.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Call not found" });

    const data = {};
    const allowed = ["duration", "recordingUrl", "status", "notes", "providerCallId"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.durationSec !== undefined) data.duration = parseInt(req.body.durationSec);
    if (req.body.status !== undefined) data.status = String(req.body.status).toUpperCase();
    if (req.body.transcriptUrl !== undefined) {
      // CallLog has no transcriptUrl column — append to notes instead so it's not lost
      data.notes = `${existing.notes || ""}${existing.notes ? "\n" : ""}[transcript: ${req.body.transcriptUrl}]`;
    }

    const updated = await prisma.callLog.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[external] patch call:", e.message);
    res.status(500).json({ error: "Failed to update call" });
  }
});

router.post("/messages", async (req, res) => {
  try {
    const {
      channel = "whatsapp",       // whatsapp | sms
      direction = "INBOUND",
      to, from, phone,
      contactId,
      content, body, text,
      mediaUrl, mediaType,
      providerMsgId,
      status,                     // QUEUED | SENT | DELIVERED | READ | FAILED | RECEIVED
    } = req.body;

    if (!phone && !to && !from && !contactId) {
      return res.status(400).json({ error: "phone, to/from, or contactId required" });
    }
    const msgBody = body || content || text || "";
    if (!msgBody && !mediaUrl) return res.status(400).json({ error: "body or mediaUrl required" });

    const dir = String(direction).toUpperCase();
    const toField = to || (dir === "OUTBOUND" ? phone : null) || "";
    const fromField = from || (dir === "INBOUND" ? phone : null);

    const common = {
      to: toField, from: fromField || null, direction: dir,
      status: status ? String(status).toUpperCase() : (dir === "INBOUND" ? "RECEIVED" : "SENT"),
      providerMsgId: providerMsgId || null,
      contactId: contactId ? parseInt(contactId) : null,
      tenantId: req.tenantId,
    };

    let message;
    if (channel === "whatsapp") {
      message = await prisma.whatsAppMessage.create({
        data: { ...common, body: msgBody, mediaUrl: mediaUrl || null, mediaType: mediaType || null },
      });
    } else {
      message = await prisma.smsMessage.create({
        data: { ...common, body: msgBody },
      });
    }
    res.status(201).json(message);
  } catch (e) {
    console.error("[external] create message:", e.message);
    res.status(500).json({ error: "Failed to log message", detail: e.message });
  }
});

// ── Catalog reads: services, staff, locations ──────────────────────

router.get("/services", async (req, res) => {
  try {
    const where = tenantWhere(req, { isActive: true });
    if (req.query.category) where.category = req.query.category;
    if (req.query.tier) where.ticketTier = req.query.tier;

    const services = await prisma.service.findMany({
      where,
      orderBy: [{ ticketTier: "desc" }, { name: "asc" }],
      take: parseLimit(req.query.limit),
      skip: parseOffset(req.query.offset),
    });
    res.json({ data: services, total: services.length });
  } catch (e) {
    console.error("[external] services:", e.message);
    res.status(500).json({ error: "Failed to list services" });
  }
});

router.get("/staff", async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: tenantWhere(req),
      select: { id: true, name: true, email: true, role: true, wellnessRole: true },
      orderBy: { name: "asc" },
    });
    res.json({ data: staff, total: staff.length });
  } catch (e) {
    console.error("[external] staff:", e.message);
    res.status(500).json({ error: "Failed to list staff" });
  }
});

router.get("/locations", async (req, res) => {
  try {
    const locations = await prisma.location.findMany({
      where: tenantWhere(req, { isActive: true }),
      orderBy: { name: "asc" },
    });
    res.json({ data: locations, total: locations.length });
  } catch (e) {
    console.error("[external] locations:", e.message);
    res.status(500).json({ error: "Failed to list locations" });
  }
});

// ── Appointments: list by date, create new ─────────────────────────

router.get("/appointments", async (req, res) => {
  try {
    const { date, from, to, status, locationId } = req.query;
    const where = tenantWhere(req);
    if (status) where.status = status;
    if (locationId) where.locationId = parseInt(locationId);

    if (date) {
      const d = new Date(date);
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end = new Date(d);   end.setHours(23, 59, 59, 999);
      where.visitDate = { gte: start, lte: end };
    } else if (from || to) {
      where.visitDate = {};
      if (from) where.visitDate.gte = new Date(from);
      if (to)   where.visitDate.lte = new Date(to);
    }

    const visits = await prisma.visit.findMany({
      where,
      orderBy: { visitDate: "asc" },
      take: parseLimit(req.query.limit, 100),
      skip: parseOffset(req.query.offset),
      include: {
        patient: { select: { id: true, name: true, phone: true, email: true } },
        service: { select: { id: true, name: true, durationMin: true, basePrice: true } },
        doctor:  { select: { id: true, name: true } },
      },
    });
    res.json({ data: visits, total: visits.length });
  } catch (e) {
    console.error("[external] appointments:", e.message);
    res.status(500).json({ error: "Failed to list appointments" });
  }
});

router.post("/appointments", async (req, res) => {
  try {
    const { patientId, serviceId, doctorId, locationId, slotStart, notes, status = "booked" } = req.body;
    if (!patientId) return res.status(400).json({ error: "patientId required" });
    if (!slotStart) return res.status(400).json({ error: "slotStart required (ISO datetime)" });

    const visit = await prisma.visit.create({
      data: {
        visitDate: new Date(slotStart),
        status,
        notes: notes || null,
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        doctorId: doctorId ? parseInt(doctorId) : null,
        locationId: locationId ? parseInt(locationId) : null,
        tenantId: req.tenantId,
      },
    });
    res.status(201).json(visit);
  } catch (e) {
    console.error("[external] create appointment:", e.message);
    res.status(500).json({ error: "Failed to create appointment", detail: e.message });
  }
});

module.exports = router;
