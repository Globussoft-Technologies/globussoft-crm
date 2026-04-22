/**
 * Wellness vertical routes — clinical CRM modules.
 *
 * All endpoints below are tenant-scoped and require auth (mounted under the
 * global auth guard in server.js).
 *
 * Mounted at: /api/wellness
 */
const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

// ── Patients ───────────────────────────────────────────────────────

router.get("/patients", async (req, res) => {
  try {
    const { q, limit = 50, offset = 0 } = req.query;
    const where = tenantWhere(req);
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { phone: { contains: q } },
        { email: { contains: q } },
      ];
    }
    const [patients, total] = await Promise.all([
      prisma.patient.findMany({
        where,
        take: Math.min(parseInt(limit), 200),
        skip: parseInt(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.patient.count({ where }),
    ]);
    res.json({ patients, total });
  } catch (e) {
    console.error("[wellness] list patients error:", e.message);
    res.status(500).json({ error: "Failed to list patients" });
  }
});

router.get("/patients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        visits: {
          orderBy: { visitDate: "desc" },
          include: { service: true, doctor: { select: { id: true, name: true, email: true } } },
        },
        prescriptions: { orderBy: { createdAt: "desc" } },
        consents: { orderBy: { signedAt: "desc" }, include: { service: true } },
        treatmentPlans: { include: { service: true } },
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    res.json(patient);
  } catch (e) {
    console.error("[wellness] get patient error:", e.message);
    res.status(500).json({ error: "Failed to load patient" });
  }
});

router.post("/patients", async (req, res) => {
  try {
    const { name, email, phone, dob, gender, bloodGroup, allergies, notes, source, contactId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const patient = await prisma.patient.create({
      data: {
        name,
        email,
        phone,
        dob: dob ? new Date(dob) : null,
        gender,
        bloodGroup,
        allergies,
        notes,
        source,
        contactId: contactId ? parseInt(contactId) : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(patient);
  } catch (e) {
    console.error("[wellness] create patient error:", e.message);
    res.status(500).json({ error: "Failed to create patient" });
  }
});

router.put("/patients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.patient.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Patient not found" });

    const data = {};
    const allowed = ["name", "email", "phone", "gender", "bloodGroup", "allergies", "notes", "source", "photoUrl"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.dob !== undefined) data.dob = req.body.dob ? new Date(req.body.dob) : null;

    const updated = await prisma.patient.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update patient error:", e.message);
    res.status(500).json({ error: "Failed to update patient" });
  }
});

// ── Visits ─────────────────────────────────────────────────────────

router.get("/visits", async (req, res) => {
  try {
    const { patientId, doctorId, status, from, to, limit = 100, offset = 0 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    if (doctorId) where.doctorId = parseInt(doctorId);
    if (status) where.status = status;
    if (from || to) {
      where.visitDate = {};
      if (from) where.visitDate.gte = new Date(from);
      if (to) where.visitDate.lte = new Date(to);
    }
    const visits = await prisma.visit.findMany({
      where,
      take: Math.min(parseInt(limit), 500),
      skip: parseInt(offset),
      orderBy: { visitDate: "desc" },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    res.json(visits);
  } catch (e) {
    console.error("[wellness] list visits error:", e.message);
    res.status(500).json({ error: "Failed to list visits" });
  }
});

router.get("/visits/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const visit = await prisma.visit.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        patient: true,
        service: true,
        doctor: { select: { id: true, name: true, email: true } },
        prescriptions: true,
        consumptions: true,
      },
    });
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    res.json(visit);
  } catch (e) {
    console.error("[wellness] get visit error:", e.message);
    res.status(500).json({ error: "Failed to load visit" });
  }
});

router.post("/visits", async (req, res) => {
  try {
    const { patientId, serviceId, doctorId, visitDate, status, vitals, notes, amountCharged, treatmentPlanId } = req.body;
    if (!patientId) return res.status(400).json({ error: "patientId is required" });

    const visit = await prisma.visit.create({
      data: {
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        doctorId: doctorId ? parseInt(doctorId) : null,
        treatmentPlanId: treatmentPlanId ? parseInt(treatmentPlanId) : null,
        visitDate: visitDate ? new Date(visitDate) : new Date(),
        status: status || "completed",
        vitals: vitals ? (typeof vitals === "object" ? JSON.stringify(vitals) : vitals) : null,
        notes,
        amountCharged: amountCharged ? parseFloat(amountCharged) : null,
        tenantId: req.user.tenantId,
      },
    });

    // If linked to a treatment plan, increment completedSessions
    if (visit.treatmentPlanId && (visit.status === "completed")) {
      await prisma.treatmentPlan.update({
        where: { id: visit.treatmentPlanId },
        data: { completedSessions: { increment: 1 } },
      });
    }

    res.status(201).json(visit);
  } catch (e) {
    console.error("[wellness] create visit error:", e.message);
    res.status(500).json({ error: "Failed to create visit" });
  }
});

router.put("/visits/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.visit.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Visit not found" });

    const data = {};
    const allowed = ["status", "vitals", "notes", "photosBefore", "photosAfter", "amountCharged"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.visitDate !== undefined) data.visitDate = new Date(req.body.visitDate);

    const updated = await prisma.visit.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update visit error:", e.message);
    res.status(500).json({ error: "Failed to update visit" });
  }
});

// ── Prescriptions ──────────────────────────────────────────────────

router.get("/prescriptions", async (req, res) => {
  try {
    const { patientId, limit = 50 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    const items = await prisma.prescription.findMany({
      where,
      take: Math.min(parseInt(limit), 200),
      orderBy: { createdAt: "desc" },
      include: {
        patient: { select: { id: true, name: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list prescriptions error:", e.message);
    res.status(500).json({ error: "Failed to list prescriptions" });
  }
});

router.post("/prescriptions", async (req, res) => {
  try {
    const { visitId, patientId, doctorId, drugs, instructions } = req.body;
    if (!visitId || !patientId || !drugs) {
      return res.status(400).json({ error: "visitId, patientId, drugs are required" });
    }
    const rx = await prisma.prescription.create({
      data: {
        visitId: parseInt(visitId),
        patientId: parseInt(patientId),
        doctorId: doctorId ? parseInt(doctorId) : req.user.id,
        drugs: typeof drugs === "object" ? JSON.stringify(drugs) : drugs,
        instructions,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(rx);
  } catch (e) {
    console.error("[wellness] create prescription error:", e.message);
    res.status(500).json({ error: "Failed to create prescription" });
  }
});

// ── Consent forms ──────────────────────────────────────────────────

router.get("/consents", async (req, res) => {
  try {
    const { patientId, limit = 50 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    const items = await prisma.consentForm.findMany({
      where,
      take: Math.min(parseInt(limit), 200),
      orderBy: { signedAt: "desc" },
      include: {
        patient: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
      },
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list consents error:", e.message);
    res.status(500).json({ error: "Failed to list consents" });
  }
});

router.post("/consents", async (req, res) => {
  try {
    const { patientId, serviceId, templateName, signatureSvg } = req.body;
    if (!patientId || !templateName) {
      return res.status(400).json({ error: "patientId and templateName are required" });
    }
    const consent = await prisma.consentForm.create({
      data: {
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        templateName,
        signatureSvg,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(consent);
  } catch (e) {
    console.error("[wellness] create consent error:", e.message);
    res.status(500).json({ error: "Failed to create consent" });
  }
});

// ── Treatment plans ────────────────────────────────────────────────

router.get("/treatments", async (req, res) => {
  try {
    const { patientId, status } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    if (status) where.status = status;
    const plans = await prisma.treatmentPlan.findMany({
      where,
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
      },
      orderBy: { startedAt: "desc" },
    });
    res.json(plans);
  } catch (e) {
    console.error("[wellness] list treatments error:", e.message);
    res.status(500).json({ error: "Failed to list treatment plans" });
  }
});

router.post("/treatments", async (req, res) => {
  try {
    const { name, totalSessions, totalPrice, patientId, serviceId, nextDueAt } = req.body;
    if (!name || !totalSessions || !patientId) {
      return res.status(400).json({ error: "name, totalSessions, patientId required" });
    }
    const plan = await prisma.treatmentPlan.create({
      data: {
        name,
        totalSessions: parseInt(totalSessions),
        totalPrice: totalPrice ? parseFloat(totalPrice) : 0,
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        nextDueAt: nextDueAt ? new Date(nextDueAt) : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(plan);
  } catch (e) {
    console.error("[wellness] create treatment error:", e.message);
    res.status(500).json({ error: "Failed to create treatment plan" });
  }
});

// ── Services (catalog) ─────────────────────────────────────────────

router.get("/services", async (req, res) => {
  try {
    const services = await prisma.service.findMany({
      where: tenantWhere(req, { isActive: true }),
      orderBy: [{ ticketTier: "desc" }, { name: "asc" }],
    });
    res.json(services);
  } catch (e) {
    console.error("[wellness] list services error:", e.message);
    res.status(500).json({ error: "Failed to list services" });
  }
});

router.post("/services", async (req, res) => {
  try {
    const { name, category, ticketTier, basePrice, durationMin, targetRadiusKm, description } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const svc = await prisma.service.create({
      data: {
        name,
        category,
        ticketTier: ticketTier || "medium",
        basePrice: basePrice ? parseFloat(basePrice) : 0,
        durationMin: durationMin ? parseInt(durationMin) : 30,
        targetRadiusKm: targetRadiusKm !== undefined && targetRadiusKm !== null ? parseInt(targetRadiusKm) : null,
        description,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(svc);
  } catch (e) {
    console.error("[wellness] create service error:", e.message);
    res.status(500).json({ error: "Failed to create service" });
  }
});

router.put("/services/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.service.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Service not found" });
    const data = {};
    const allowed = ["name", "category", "ticketTier", "basePrice", "durationMin", "targetRadiusKm", "description", "isActive"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    const updated = await prisma.service.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update service error:", e.message);
    res.status(500).json({ error: "Failed to update service" });
  }
});

// ── Agent recommendations ──────────────────────────────────────────

router.get("/recommendations", async (req, res) => {
  try {
    const { status = "pending" } = req.query;
    const items = await prisma.agentRecommendation.findMany({
      where: tenantWhere(req, status === "all" ? {} : { status }),
      orderBy: [
        { priority: "desc" }, // high > medium > low alphabetically — close enough
        { createdAt: "desc" },
      ],
      take: 50,
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list recommendations error:", e.message);
    res.status(500).json({ error: "Failed to list recommendations" });
  }
});

router.post("/recommendations/:id/approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rec = await prisma.agentRecommendation.findFirst({ where: tenantWhere(req, { id }) });
    if (!rec) return res.status(404).json({ error: "Recommendation not found" });
    const updated = await prisma.agentRecommendation.update({
      where: { id },
      data: { status: "approved", resolvedById: req.user.id, resolvedAt: new Date() },
    });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] approve recommendation error:", e.message);
    res.status(500).json({ error: "Failed to approve" });
  }
});

router.post("/recommendations/:id/reject", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rec = await prisma.agentRecommendation.findFirst({ where: tenantWhere(req, { id }) });
    if (!rec) return res.status(404).json({ error: "Recommendation not found" });
    const updated = await prisma.agentRecommendation.update({
      where: { id },
      data: { status: "rejected", resolvedById: req.user.id, resolvedAt: new Date() },
    });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] reject recommendation error:", e.message);
    res.status(500).json({ error: "Failed to reject" });
  }
});

// ── Locations (multi-clinic) ───────────────────────────────────────

router.get("/locations", async (req, res) => {
  try {
    const locations = await prisma.location.findMany({
      where: tenantWhere(req),
      orderBy: { name: "asc" },
    });
    res.json(locations);
  } catch (e) {
    console.error("[wellness] list locations error:", e.message);
    res.status(500).json({ error: "Failed to list locations" });
  }
});

router.post("/locations", async (req, res) => {
  try {
    const { name, addressLine, city, state, pincode, country, phone, email, latitude, longitude, hours } = req.body;
    if (!name || !addressLine || !city) {
      return res.status(400).json({ error: "name, addressLine, city are required" });
    }
    const loc = await prisma.location.create({
      data: {
        name, addressLine, city,
        state: state || null,
        pincode: pincode || null,
        country: country || "India",
        phone: phone || null,
        email: email || null,
        latitude: latitude !== undefined ? parseFloat(latitude) : null,
        longitude: longitude !== undefined ? parseFloat(longitude) : null,
        hours: hours ? (typeof hours === "object" ? JSON.stringify(hours) : hours) : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(loc);
  } catch (e) {
    console.error("[wellness] create location error:", e.message);
    res.status(500).json({ error: "Failed to create location" });
  }
});

router.put("/locations/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.location.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Location not found" });

    const data = {};
    const allowed = ["name", "addressLine", "city", "state", "pincode", "country", "phone", "email", "latitude", "longitude", "hours", "isActive"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];

    const updated = await prisma.location.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update location error:", e.message);
    res.status(500).json({ error: "Failed to update location" });
  }
});

// ── Owner dashboard aggregation ────────────────────────────────────

router.get("/dashboard", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const locationId = req.query.locationId ? parseInt(req.query.locationId) : undefined;
    const todayStart = startOfDay();
    const todayEnd = endOfDay();
    const yesterdayStart = startOfDay(new Date(Date.now() - 86400000));
    const yesterdayEnd = endOfDay(new Date(Date.now() - 86400000));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

    const visitWhere = (extra = {}) => ({ tenantId, ...(locationId ? { locationId } : {}), ...extra });

    const [
      todayVisits,
      yesterdayVisits,
      pendingRecommendations,
      activeTreatmentPlans,
      newLeadsToday,
      thirtyDayVisits,
      totalPatients,
      totalServices,
      totalLocations,
    ] = await Promise.all([
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: todayStart, lte: todayEnd } }),
        select: { id: true, status: true, amountCharged: true, serviceId: true },
      }),
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: yesterdayStart, lte: yesterdayEnd } }),
        select: { id: true, status: true, amountCharged: true },
      }),
      prisma.agentRecommendation.findMany({
        where: { tenantId, status: "pending" },
        orderBy: { priority: "desc" },
        take: 5,
      }),
      prisma.treatmentPlan.count({ where: { tenantId, status: "active" } }),
      prisma.contact.count({
        where: { tenantId, status: "Lead", createdAt: { gte: todayStart, lte: todayEnd } },
      }),
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: thirtyDaysAgo } }),
        select: { visitDate: true, amountCharged: true },
      }),
      prisma.patient.count({ where: { tenantId, ...(locationId ? { locationId } : {}) } }),
      prisma.service.count({ where: { tenantId, isActive: true } }),
      prisma.location.count({ where: { tenantId, isActive: true } }),
    ]);

    const sum = (arr, k) => arr.reduce((s, x) => s + (parseFloat(x[k]) || 0), 0);

    // Bucket revenue by day for the 30-day strip
    const dayBuckets = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayBuckets[key] = 0;
    }
    for (const v of thirtyDayVisits) {
      const key = v.visitDate.toISOString().slice(0, 10);
      if (key in dayBuckets) dayBuckets[key] += parseFloat(v.amountCharged) || 0;
    }
    const revenueTrend = Object.entries(dayBuckets).map(([date, revenue]) => ({ date, revenue }));

    // Rough occupancy: completed visits today / theoretical capacity (assume 8 slots/day)
    const completedToday = todayVisits.filter((v) => v.status === "completed").length;
    const capacity = 8 * 17; // 17 staff × 8 slots — generous baseline
    const occupancyPct = Math.min(100, Math.round((completedToday / capacity) * 100));

    res.json({
      today: {
        visits: todayVisits.length,
        completed: completedToday,
        expectedRevenue: sum(todayVisits, "amountCharged"),
        occupancyPct,
        newLeads: newLeadsToday,
      },
      yesterday: {
        visits: yesterdayVisits.length,
        completed: yesterdayVisits.filter((v) => v.status === "completed").length,
        revenue: sum(yesterdayVisits, "amountCharged"),
      },
      pendingApprovals: pendingRecommendations.length,
      pendingRecommendations,
      activeTreatmentPlans,
      revenueTrend,
      totals: { patients: totalPatients, services: totalServices, locations: totalLocations },
    });
  } catch (e) {
    console.error("[wellness] dashboard error:", e.message);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

module.exports = router;
