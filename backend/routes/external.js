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
const { computeFirstResponseDueAt } = require("../lib/leadSla");

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

// ── Contacts: list + lookup + fetch ────────────────────────────────

router.get("/contacts", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const { status, source, createdSince, q } = req.query;

    const where = tenantWhere(req, { deletedAt: null });
    if (status) where.status = status;
    if (source) where.source = source;
    if (createdSince) {
      const since = new Date(createdSince);
      if (Number.isNaN(since.getTime())) {
        return res.status(400).json({ error: "createdSince must be a valid ISO date", code: "INVALID_QUERY" });
      }
      where.createdAt = { gte: since };
    }
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { email: { contains: q } },
        { phone: { contains: q } },
        { company: { contains: q } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true, name: true, email: true, phone: true, status: true, source: true,
          company: true, aiScore: true, assignedToId: true, createdAt: true,
        },
      }),
      prisma.contact.count({ where }),
    ]);

    res.json({ data, total, limit, offset });
  } catch (e) {
    console.error("[external] contacts list:", e.message);
    res.status(500).json({ error: "List failed" });
  }
});

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
    const { name, phone, email, source, note, utm, externalId } = req.body;
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

    // PRD §6.4: stamp the lead-side SLA timer at create time. We feed the
    // lead text into the same keyword classifier the auto-router uses; tier
    // → SLA minutes is hardcoded in lib/leadSla.js. Junk leads still get a
    // due date — it's harmless (cron won't notify on Junk-status rows because
    // the breach query gates on status='Lead').
    const slaText = [name, source, note].filter(Boolean).join(" ");
    let firstResponseDueAt = null;
    let slaMeta = null;
    try {
      slaMeta = await computeFirstResponseDueAt({
        tenantId: req.tenantId,
        text: slaText,
      });
      firstResponseDueAt = slaMeta.dueAt;
    } catch (slaErr) {
      console.error("[external] lead SLA compute failed:", slaErr.message);
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
      firstResponseDueAt,
      // [GP-CRM integration] Stable partner ID (e.g. GlobusPhone lead ULID).
      // Stored verbatim so a retry can find-and-reuse instead of duplicating.
      externalId: externalId ? String(externalId) : null,
      tenantId: req.tenantId,
    };
    let contact;
    let deduped = false;
    // [GP-CRM integration] Dedup priority: externalId first (most specific —
    // keeps partner outbox retries idempotent), then email. A partner re-POSTs
    // the same externalId on retry, so matching here reuses the existing row.
    if (externalId) {
      const byExtId = await prisma.contact.findFirst({
        where: { externalId: String(externalId), tenantId: req.tenantId },
      });
      if (byExtId) {
        contact = byExtId;
        deduped = true;
      }
    }
    if (!contact && email) {
      // Upsert on the compound unique key (email + tenantId)
      const existing = await prisma.contact.findFirst({
        where: { email, tenantId: req.tenantId },
      });
      if (existing) {
        contact = existing;
        deduped = true;
      }
    }
    if (!contact) {
      contact = await prisma.contact.create({ data: contactData });
    }

    // Attach an activity so the CRM's inbox shows the origin + junk verdict.
    // NOTE: this is a *system* activity, not a real human first-response —
    // we deliberately do NOT call markFirstResponseIfNeeded here. The SLA
    // clock starts now and only stops when staff actually log a Call/SMS/
    // Email/Note from the CRM UI (see contacts.js POST /:id/activities).
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
      _sla: slaMeta,
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

// ── Lead stage transitions (Task 9 — GP-CRM integration) ───────────
//
// GP stage → CRM status mapping (mirrors CRM_STATUS_TO_GP_STAGE on the GP side):
//   NEW / CONTACTED   → Lead
//   QUALIFIED         → Prospect
//   WON               → Customer
//   LOST              → Churned
//   DNC / DO_NOT_CALL → Junk
const GP_STAGE_TO_CRM_STATUS = {
  NEW:         "Lead",
  CONTACTED:   "Lead",
  QUALIFIED:   "Prospect",
  WON:         "Customer",
  LOST:        "Churned",
  DNC:         "Junk",
  DO_NOT_CALL: "Junk",
};
const ALLOWED_CRM_STATUSES = new Set(["Lead", "Prospect", "Customer", "Churned", "Junk"]);

router.patch("/leads/:id/stage", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { stage, status: directStatus } = req.body;

    // Resolve to a CRM status string from either GP stage vocab or a direct status.
    let newStatus;
    if (stage) {
      newStatus = GP_STAGE_TO_CRM_STATUS[String(stage).toUpperCase()];
      if (!newStatus) {
        return res.status(400).json({
          error: `Unknown stage '${stage}'. Expected: NEW, CONTACTED, QUALIFIED, WON, LOST, DNC, DO_NOT_CALL`,
          code: "INVALID_STAGE",
        });
      }
    } else if (directStatus) {
      if (!ALLOWED_CRM_STATUSES.has(directStatus)) {
        return res.status(400).json({
          error: `Unknown status '${directStatus}'. Expected: Lead, Prospect, Customer, Churned, Junk`,
          code: "INVALID_STATUS",
        });
      }
      newStatus = directStatus;
    } else {
      return res.status(400).json({ error: "stage or status required", code: "MISSING_STAGE" });
    }

    const existing = await prisma.contact.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Lead not found" });

    const contact = await prisma.contact.update({ where: { id }, data: { status: newStatus } });

    // Notify registered webhooks that the stage changed (fire-and-forget,
    // only when it actually changed so re-sending the same stage is idempotent).
    if (existing.status !== newStatus) {
      try {
        const { deliverWebhooks } = require("../lib/webhookDelivery");
        await deliverWebhooks("lead.stage_changed", {
          id: contact.id,
          status: contact.status,
          previousStatus: existing.status,
          assignedToId: contact.assignedToId,
          tenantId: req.tenantId,
        }, req.tenantId);
      } catch (_e) { /* fire-and-forget */ }
    }

    res.json(contact);
  } catch (e) {
    console.error("[external] patch lead stage:", e.message);
    res.status(500).json({ error: "Failed to update lead stage" });
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

    // [GP-CRM integration] When no contactId is supplied, auto-link the call to
    // a contact by phone suffix so it appears on the contact's CRM timeline.
    // Uses the same last-10-digit suffix match as /contacts/lookup. Best-effort:
    // a lookup miss or error must never block call logging.
    let resolvedContactId = contactId ? parseInt(contactId) : null;
    if (!resolvedContactId) {
      const lookupPhone = dir === "INBOUND" ? (callerNumber || phone) : (calleeNumber || phone);
      const suf = normalizedSuffix(lookupPhone);
      if (suf) {
        try {
          const linked = await prisma.contact.findFirst({
            where: { tenantId: req.tenantId, phone: { contains: suf } },
            select: { id: true },
          });
          if (linked) resolvedContactId = linked.id;
        } catch (_) {
          // best-effort — contact lookup failure must not block call logging
        }
      }
    }

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
        contactId: resolvedContactId,
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

// ── Voice transcripts: retrieve by call or date range ─────────────

router.get("/transcripts", async (req, res) => {
  try {
    const { callId, from, to, limit, offset } = req.query;
    const where = tenantWhere(req);

    // Filter by specific call if provided
    if (callId) {
      where.id = parseInt(callId);
    } else if (from || to) {
      // Filter by date range
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const calls = await prisma.callLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parseLimit(limit, 50),
      skip: parseOffset(offset),
      select: {
        id: true,
        duration: true,
        notes: true,
        direction: true,
        recordingUrl: true,
        provider: true,
        providerCallId: true,
        status: true,
        callerNumber: true,
        calleeNumber: true,
        createdAt: true,
        contact: { select: { id: true, name: true, phone: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    });

    // Extract transcript from notes if it contains [transcript: ...]
    const withTranscripts = calls.map(call => {
      let transcript = null;
      if (call.notes) {
        const match = call.notes.match(/\[transcript:\s*(.+?)\]/);
        if (match) transcript = match[1].trim();
      }
      return { ...call, transcript };
    });

    res.json({ data: withTranscripts, total: withTranscripts.length });
  } catch (e) {
    console.error("[external] transcripts:", e.message);
    res.status(500).json({ error: "Failed to fetch transcripts" });
  }
});

// ── Update transcript for a call ──────────────────────────────────

router.post("/transcripts", async (req, res) => {
  try {
    const { callId, transcript, transcriptUrl } = req.body;
    if (!callId) return res.status(400).json({ error: "callId required" });
    if (!transcript && !transcriptUrl) {
      return res.status(400).json({ error: "transcript or transcriptUrl required" });
    }

    const id = parseInt(callId);
    const existing = await prisma.callLog.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Call not found" });

    const data = {};
    if (transcriptUrl) {
      // Append transcript URL to notes
      const transcriptNote = `[transcript: ${transcriptUrl}]`;
      data.notes = `${existing.notes || ""}${existing.notes ? "\n" : ""}${transcriptNote}`;
    }
    if (transcript) {
      // Store transcript in notes with a marker
      const transcriptNote = `[transcript-text]\n${transcript}\n[/transcript-text]`;
      data.notes = `${existing.notes || ""}${existing.notes ? "\n" : ""}${transcriptNote}`;
    }

    const updated = await prisma.callLog.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[external] create transcript:", e.message);
    res.status(500).json({ error: "Failed to save transcript" });
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

// ── Webhook self-serve subscription (Task 11 — GP-CRM integration) ──
//
// Partners register a callback URL + event pattern(s) they want to receive.
// One Webhook row is created per event pattern. Supports exact-match
// ("lead.new") and wildcard ("lead.*") — deliverWebhooks() in
// lib/webhookDelivery.js queries for both forms on every emission.
// The subscription owner FK is req.apiKey.userId (the user the key belongs to);
// we deliberately avoid req.user.id (the JWT key is userId, and reading
// req.user.id is an ESLint error in routes/).

router.post("/webhooks", async (req, res) => {
  try {
    const { url, event, events } = req.body;
    if (!url) return res.status(400).json({ error: "url required", code: "MISSING_URL" });

    try { new URL(url); } catch (_e) {
      return res.status(400).json({ error: "url must be a valid HTTP or HTTPS URL", code: "INVALID_URL" });
    }

    // Accept a single event string, an array of events, or either field name.
    const eventList = Array.isArray(events)
      ? events
      : events
        ? [events]
        : event
          ? [event]
          : [];
    if (eventList.length === 0) {
      return res.status(400).json({ error: "event or events required", code: "MISSING_EVENT" });
    }

    const created = await Promise.all(
      eventList.map((ev) =>
        prisma.webhook.create({
          data: {
            event: String(ev),
            targetUrl: url,
            isActive: true,
            tenantId: req.tenantId,
            userId: req.apiKey.userId,
          },
        })
      )
    );

    res.status(201).json({ created });
  } catch (e) {
    console.error("[external] create webhook:", e.message);
    res.status(500).json({ error: "Failed to register webhook" });
  }
});

router.get("/webhooks", async (req, res) => {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: tenantWhere(req, { isActive: true }),
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: webhooks, total: webhooks.length });
  } catch (e) {
    console.error("[external] list webhooks:", e.message);
    res.status(500).json({ error: "Failed to list webhooks" });
  }
});

router.delete("/webhooks/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.webhook.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Webhook not found" });
    // Soft-deactivate (isActive=false) — keeps the audit trail; never hard-delete.
    await prisma.webhook.update({ where: { id }, data: { isActive: false } });
    res.json({ deactivated: true });
  } catch (e) {
    console.error("[external] deactivate webhook:", e.message);
    res.status(500).json({ error: "Failed to deactivate webhook" });
  }
});

module.exports = router;
