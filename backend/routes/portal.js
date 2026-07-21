const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const multer = require("multer");
const prisma = require("../lib/prisma");
const digilockerClient = require("../services/digilockerClient");
const s3Service = require("../services/s3Service");
const passportOcrClient = require("../services/passportOcrClient");
const { scoreDiagnostic, parseBank } = require("../lib/travelDiagnosticScoring");
const { notifyMany } = require("../lib/notificationService");
const { writeAudit } = require("../lib/audit");
const visaDocStore = require("../lib/visaDocStore");
const { buildForm: buildReviewForm, validateSubmission: validateReviewSubmission } = require("../lib/travelReviewQuestions");
const travelPortalNotifications = require("../lib/travelPortalNotificationService");

// Memory-storage multer for the travel customer's profile avatar — 5 MB cap,
// image-only (s3Service.uploadImage re-gates the mimetype). Mirrors the staff
// avatar uploader in routes/auth.js.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const avatarUploadHandler = (req, res, next) => {
  avatarUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "Image must be 5 MB or smaller" : err.message;
      return res.status(400).json({ error: msg, code: err.code });
    }
    if (err) return next(err);
    next();
  });
};

const { JWT_SECRET } = require("../config/secrets");
const PORTAL_TOKEN_TTL = "7d";

// In-memory reset token store: token -> { contactId, expiresAt }
const resetTokens = new Map();

// ─── Inline portal JWT middleware ───────────────────────────────────────────
const verifyPortalToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Portal token required" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== "PORTAL") {
      return res.status(401).json({ error: "Invalid portal token" });
    }
    req.portal = decoded;
    next();
  } catch (err) {
    if (err && err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Portal session expired" });
    }
    res.status(401).json({ error: "Invalid portal token" });
  }
};

// ─── PUBLIC ENDPOINTS ───────────────────────────────────────────────────────

// POST /api/portal/login — { email, password }
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    // Contact.email is not @unique in schema (multi-tenant — same email can
    // belong to contacts in different tenants). findUnique throws a Prisma
    // validation error, caught by the catch block as a 500. findFirst returns
    // the first match by id (deterministic) and 401s when there's no portal
    // user with this email.
    const contact = await prisma.contact.findFirst({ where: { email } });
    if (!contact || !contact.portalPasswordHash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, contact.portalPasswordHash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { contactId: contact.id, tenantId: contact.tenantId, type: "PORTAL" },
      JWT_SECRET,
      { expiresIn: PORTAL_TOKEN_TTL }
    );

    res.json({
      token,
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        company: contact.company,
        avatarUrl: contact.avatarUrl || null,
      },
    });
  } catch (err) {
    console.error("[Portal][login]", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/portal/register — self-service Customer Portal sign-up.
// { email, password, name?, registrationTenantId }
//
// This is the "travel customer" registration path: the customer-register page
// routes here when the chosen Organization is a TRAVEL tenant, so a customer
// becomes a portal-capable Contact (Contact.portalPasswordHash) and lands in
// the Travel Customer Portal — NOT a staff CRM User. Returns the same
// { token, contact } shape as /login so the page can sign them straight in.
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, registrationTenantId, verificationToken } = req.body || {};
    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }
    // tenantId is stripped from bodies by stripDangerous middleware, so the
    // page sends the chosen org under `registrationTenantId` (mirrors
    // /api/auth/customer/register).
    const tenantId = Number(registrationTenantId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "registrationTenantId must be a valid number" });
    }

    // Email OTP gate (purpose "customer-register"). Enforced at the route layer
    // (production by default, overridable via REQUIRE_EMAIL_OTP).
    const emailOtp = require("../lib/emailOtp");
    const otpGate = emailOtp.enforceRegistrationOtp(verificationToken, email, "customer-register");
    if (!otpGate.ok) return res.status(otpGate.status).json({ error: otpGate.error, code: otpGate.code });
    const emailVerifiedAt = otpGate.emailVerifiedAt;
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters and include a letter and a number",
      });
    }

    // The portal is a travel-vertical surface — only allow sign-up against a
    // travel tenant so we don't create stray portal contacts elsewhere.
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, vertical: true },
    });
    if (!tenant) return res.status(400).json({ error: "Invalid organization" });
    if (tenant.vertical !== "travel") {
      return res.status(400).json({ error: "Portal sign-up is only available for travel organizations" });
    }

    const em = email.trim().toLowerCase();
    const nm = (typeof name === "string" && name.trim()) ? name.trim() : em.split("@")[0];
    const hash = await bcrypt.hash(password, 10);

    // Link onto an existing Contact (e.g. an advisor-created lead) if one
    // exists for this email+tenant; otherwise create a fresh portal Contact.
    const existing = await prisma.contact.findFirst({
      where: { email: em, tenantId },
      select: { id: true, portalPasswordHash: true, name: true },
    });
    if (existing && existing.portalPasswordHash) {
      return res.status(409).json({ error: "This email is already registered. Please sign in." });
    }

    const contact = existing
      ? await prisma.contact.update({
          where: { id: existing.id },
          data: { portalPasswordHash: hash, name: existing.name || nm, emailVerifiedAt },
        })
      : await prisma.contact.create({
          data: {
            name: nm,
            email: em,
            subBrand: "travelstall",
            status: "Lead",
            tenantId,
            portalPasswordHash: hash,
            emailVerifiedAt,
          },
        });

    const token = jwt.sign(
      { contactId: contact.id, tenantId: contact.tenantId, type: "PORTAL" },
      JWT_SECRET,
      { expiresIn: PORTAL_TOKEN_TTL }
    );
    return res.status(201).json({
      token,
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        company: contact.company || null,
        avatarUrl: contact.avatarUrl || null,
      },
    });
  } catch (err) {
    console.error("[Portal][register]", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/portal/set-password — { email, currentPassword?, newPassword }
router.post("/set-password", async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ error: "email and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // findFirst not findUnique — Contact.email isn't unique in schema.
    const contact = await prisma.contact.findFirst({ where: { email } });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    if (contact.portalPasswordHash) {
      // Existing password — require current
      if (!currentPassword) {
        return res.status(400).json({ error: "currentPassword is required to change existing password" });
      }
      const valid = await bcrypt.compare(currentPassword, contact.portalPasswordHash);
      if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.contact.update({
      where: { id: contact.id },
      data: { portalPasswordHash: hash },
    });
    res.json({ status: "ok", code: "PORTAL_PASSWORD_SET" }); // #550
  } catch (err) {
    console.error("[Portal][set-password]", err);
    res.status(500).json({ error: "Failed to set password" });
  }
});

// POST /api/portal/forgot — { email }
router.post("/forgot", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });

    // findFirst not findUnique — Contact.email isn't unique in schema.
    const contact = await prisma.contact.findFirst({ where: { email } });
    // Always return success to prevent enumeration
    if (contact) {
      const token = crypto.randomBytes(32).toString("hex");
      resetTokens.set(token, {
        contactId: contact.id,
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
      });
      // In production this would email the link to the contact
      console.log(`[Portal][forgot] Reset token for ${email}: ${token}`);
    }
    res.json({ status: "ack", code: "RESET_LINK_REQUESTED" }); // #550
  } catch (err) {
    console.error("[Portal][forgot]", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// POST /api/portal/reset — { token, newPassword }
router.post("/reset", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: "token and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const entry = resetTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      resetTokens.delete(token);
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.contact.update({
      where: { id: entry.contactId },
      data: { portalPasswordHash: hash },
    });
    resetTokens.delete(token);

    res.json({ status: "ok", code: "PASSWORD_RESET_OK" }); // #550
  } catch (err) {
    console.error("[Portal][reset]", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ─── AUTHENTICATED PORTAL ENDPOINTS ─────────────────────────────────────────

// GET /api/portal/me
router.get("/me", verifyPortalToken, async (req, res) => {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: req.portal.contactId },
      select: {
        id: true, name: true, email: true, phone: true, company: true,
        title: true, status: true, tenantId: true, createdAt: true,
      },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json(contact);
  } catch (err) {
    console.error("[Portal][me]", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// GET /api/portal/tickets
router.get("/tickets", verifyPortalToken, async (req, res) => {
  try {
    // Ticket model doesn't have contactId — return tickets in the contact's tenant
    const tickets = await prisma.ticket.findMany({
      where: { tenantId: req.portal.tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(tickets);
  } catch (err) {
    console.error("[Portal][tickets]", err);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// POST /api/portal/tickets — create on behalf of the logged-in contact
router.post("/tickets", verifyPortalToken, async (req, res) => {
  try {
    const { subject, description, priority } = req.body;
    if (!subject) return res.status(400).json({ error: "subject is required" });
    const ticket = await prisma.ticket.create({
      data: {
        subject,
        description: description || null,
        priority: priority || "Low",
        status: "Open",
        tenantId: req.portal.tenantId,
      },
    });

    // Auto-apply SLA if a policy exists for (tenant, priority). Mirrors the
    // exact pattern at routes/tickets.js:80 + routes/support.js:60. Portal-
    // submitted tickets need the same SLA timer as agent-created ones, else
    // the SLA breach dashboard silently under-counts inbound work.
    try {
      const sla = await prisma.slaPolicy.findFirst({
        where: { tenantId: req.portal.tenantId, priority: ticket.priority, isActive: true },
      });
      if (sla) {
        const now = new Date(ticket.createdAt);
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            slaResponseDue: new Date(now.getTime() + sla.responseMinutes * 60000),
            slaResolveDue: new Date(now.getTime() + sla.resolveMinutes * 60000),
          },
        });
      }
    } catch (_e) { /* SLA is non-critical */ }

    res.status(201).json(ticket);
  } catch (err) {
    console.error("[Portal][create ticket]", err);
    res.status(500).json({ error: "Failed to create ticket" });
  }
});

// GET /api/portal/invoices?fields=summary
router.get("/invoices", verifyPortalToken, async (req, res) => {
  try {
    // #920 slice 33: ?fields=summary slim-shape opt-in. Mirrors slices 1-30.
    // The default portal invoice list returns the full Invoice row including
    // recurrence metadata (isRecurring, recurFrequency, nextRecurDate,
    // parentInvoiceId), the wellness-vertical visit join column (visitId),
    // legalEntityCode, paidAt, dealId, tenantId, and timestamps — none of
    // which the customer-portal invoice ledger UI needs to render rows
    // (invoice #, amount, status chip, due date, issued date). When the
    // caller passes ?fields=summary we project to the minimal column set
    // for portal ledger rows. Opt-in additive — existing callers (no
    // ?fields, or any non-exact value) get the full row shape unchanged.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
      orderBy: { issuedDate: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        invoiceNum: true,
        amount: true,
        status: true,
        dueDate: true,
        issuedDate: true,
      };
    }
    const invoices = await prisma.invoice.findMany(findManyArgs);
    res.json(invoices);
  } catch (err) {
    console.error("[Portal][invoices]", err);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
});

// GET /api/portal/contracts
router.get("/contracts", verifyPortalToken, async (req, res) => {
  try {
    const contracts = await prisma.contract.findMany({
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(contracts);
  } catch (err) {
    console.error("[Portal][contracts]", err);
    res.status(500).json({ error: "Failed to fetch contracts" });
  }
});

// ─── Travel customer-portal — itineraries + trips ─────────────────────
//
// End-users (travel customers) logged into the portal need to see their
// own trips. The shape is "give me everything booked under my Contact"
// so the customer dashboard can render trips + itineraries + payment
// status in one fetch. Travel-tenants only: a non-travel-tenant Contact
// gets an empty array (the wellness-tenant portal still works for
// tickets/invoices via the routes above).

async function requireTravelPortalTenant(req, res, next) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.portal.tenantId },
      select: { vertical: true },
    });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });
    if (tenant.vertical !== "travel") {
      return res.status(403).json({
        error: "Travel-tenant feature",
        code: "NOT_TRAVEL_TENANT",
      });
    }
    next();
  } catch (err) {
    console.error("[Portal][travel-tenant-guard]", err);
    res.status(500).json({ error: "Tenant lookup failed" });
  }
}

// GET /api/portal/travel/itineraries — accepted itineraries for this contact
router.get("/travel/itineraries", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itineraries = await prisma.itinerary.findMany({
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
      orderBy: { startDate: "desc" },
      include: {
        items: { orderBy: { position: "asc" } },
      },
    });
    // Attach a web-check-in "due" flag per trip: any active WebCheckin row
    // (pending/reminded) whose flight departs within the next 36h. Drives the
    // portal's "Have you checked in? Yes/No" banner (2026-06-16). The Yes
    // action flips those rows to "done" → flag clears + reminders stop.
    const ids = itineraries.map((i) => i.id);
    let dueByItin = {};
    if (ids.length) {
      const now = new Date();
      const horizon = new Date(now.getTime() + 37 * 3600000);
      const wcRows = await prisma.webCheckin.findMany({
        where: {
          tenantId: req.portal.tenantId,
          itineraryId: { in: ids },
          status: { in: ["pending", "reminded"] },
          departureAt: { gte: now, lte: horizon },
        },
        select: { itineraryId: true },
      });
      dueByItin = Object.fromEntries(wcRows.map((w) => [w.itineraryId, true]));
    }
    // Post-trip review state per trip (2026-06-16): "submitted" | "available"
    // (trip ended + paid + non-visasure, not yet reviewed) | "none". Drives the
    // portal "Leave a review" surface on completed trips.
    let reviewByItin = {};
    if (ids.length) {
      const rows = await prisma.travelTripReview.findMany({
        where: { tenantId: req.portal.tenantId, itineraryId: { in: ids } },
        select: { itineraryId: true, status: true },
      });
      reviewByItin = Object.fromEntries(rows.map((r) => [r.itineraryId, r.status]));
    }
    const nowMs = Date.now();
    const reviewState = (i) => {
      if (reviewByItin[i.id] === "submitted") return "submitted";
      const ended = i.endDate && new Date(i.endDate).getTime() < nowMs;
      // Any committed booking (accepted / paid) is reviewable once it's over —
      // payment state doesn't gate a review. Matches cron/travelReviewEngine.js.
      const committed = ["accepted", "advance_paid", "fully_paid"].includes(i.status);
      if (ended && committed && i.subBrand !== "visasure") return "available";
      return "none";
    };
    res.json(itineraries.map((i) => ({ ...i, webCheckinDue: Boolean(dueByItin[i.id]), reviewState: reviewState(i) })));
  } catch (err) {
    console.error("[Portal][travel/itineraries]", err);
    res.status(500).json({ error: "Failed to fetch itineraries" });
  }
});

// ─── Customer accept / decline of an offered itinerary ───────────────
//
// Accepting or declining an OFFER is the customer's decision (PRD §6.1) —
// not the advisor's. These endpoints let the logged-in customer respond to
// the itineraries shown in their portal. Strictly scoped to the customer's
// OWN itineraries (contactId match) + their tenant. Status meaning:
//   draft | sent | revised  → awaiting the customer's decision (decidable)
//   accepted                → customer accepted (next step: pay advance)
//   rejected                → customer declined
//   advance_paid|fully_paid → already paid; cannot be changed here

const DECIDABLE_ITIN_STATUSES = ["draft", "sent", "revised"];

async function loadPortalOwnedItinerary(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid itinerary id", code: "BAD_ID" });
    return null;
  }
  const itin = await prisma.itinerary.findFirst({
    where: { id, tenantId: req.portal.tenantId, contactId: req.portal.contactId },
    select: {
      id: true, status: true, subBrand: true, destination: true,
      // cancellation-flow fields (2026-06-19)
      cancellationStatus: true, advancePaidAmount: true, currency: true,
      // trip dates — used to block a cancellation request once the trip has
      // already departed (you can't cancel a trip that's already underway/over).
      startDate: true, endDate: true,
    },
  });
  if (!itin) {
    res.status(404).json({ error: "Booking not found", code: "NOT_FOUND" });
    return null;
  }
  return itin;
}

// Resolve the staff who should be notified about a decision on a given
// sub-brand's itinerary: ALL admins (full visibility) + the MANAGERs who can
// act on that sub-brand (subBrandAccess includes it, or is unset = full).
async function resolveItineraryStaffUserIds(tenantId, subBrand) {
  const staff = await prisma.user.findMany({
    where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true, role: true, subBrandAccess: true },
  });
  const ids = [];
  for (const u of staff) {
    if (u.role === "ADMIN") { ids.push(u.id); continue; }
    let access = null;
    if (u.subBrandAccess) {
      try {
        const arr = JSON.parse(u.subBrandAccess);
        if (Array.isArray(arr)) access = arr;
      } catch { /* malformed → treat as full access */ }
    }
    // null/empty = no restriction declared → full access; else must include it.
    if (access === null || access.length === 0 || access.includes(subBrand)) {
      ids.push(u.id);
    }
  }
  return ids;
}

// Best-effort: notify the brand's manager(s) + admins that the customer
// accepted/declined their itinerary. Never throws — a notification failure
// must not fail the customer's action.
async function notifyStaffOfItineraryDecision({ tenantId, subBrand, itineraryId, destination, contactId, action, reason, amountPaid, currency }) {
  try {
    const userIds = await resolveItineraryStaffUserIds(tenantId, subBrand);
    if (!userIds.length) return;
    let who = "A customer";
    try {
      const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { name: true, email: true } });
      who = (c && (c.name || c.email)) || who;
    } catch { /* fall back to "A customer" */ }
    const brand = (subBrand || "").toUpperCase();
    const trip = destination || `#${itineraryId}`;

    // 2026-06-19 — customer-initiated cancellation of a committed booking. This
    // is the "flag the advisor to refund per policy" path: surface WHO, the
    // reason, and how much they've already paid so the advisor can settle the
    // refund against the cancellation policy.
    if (action === "cancellation_requested") {
      let message = `${who} requested to CANCEL the ${brand} booking "${trip}".`;
      if (Number(amountPaid) > 0) {
        const paidLabel = (currency || "INR") === "INR" ? `₹${Math.round(amountPaid).toLocaleString("en-IN")}` : `${currency} ${Math.round(amountPaid)}`;
        message += ` They have paid ${paidLabel} so far — review the cancellation policy and process the refund.`;
      } else {
        message += " No payment recorded yet.";
      }
      if (reason) message += ` Reason: "${reason}"`;
      await notifyMany({
        userIds,
        tenantId,
        title: "Booking cancellation requested",
        message,
        type: "warning",
        link: `/travel/itineraries/${itineraryId}`,
      });
      return;
    }

    const verb = action === "accepted" ? "accepted" : "declined";
    let message = `${who} ${verb} the ${brand} itinerary "${trip}".`;
    if (action === "declined" && reason) {
      message += ` Reason: "${reason}"`;
    }
    await notifyMany({
      userIds,
      tenantId,
      title: `Itinerary ${verb} by customer`,
      message,
      type: action === "accepted" ? "success" : "warning",
      link: `/travel/itineraries/${itineraryId}`,
    });
  } catch (e) {
    console.warn("[Portal] staff itinerary-decision notification failed:", e.message);
  }
}

// POST /api/portal/travel/itineraries/:id/accept
router.post("/travel/itineraries/:id/accept", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itin = await loadPortalOwnedItinerary(req, res);
    if (!itin) return;
    if (["accepted", "advance_paid", "fully_paid"].includes(itin.status)) {
      return res.status(409).json({ error: "You've already accepted this trip", code: "ALREADY_ACCEPTED" });
    }
    if (itin.status === "rejected") {
      return res.status(409).json({ error: "This trip was declined — ask your advisor for a fresh offer", code: "ALREADY_REJECTED" });
    }
    if (!DECIDABLE_ITIN_STATUSES.includes(itin.status)) {
      return res.status(409).json({ error: `Cannot accept a trip in '${itin.status}' status`, code: "INVALID_STATE" });
    }
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { status: "accepted" },
      select: { id: true, status: true },
    });
    await notifyStaffOfItineraryDecision({
      tenantId: req.portal.tenantId,
      subBrand: itin.subBrand,
      itineraryId: itin.id,
      destination: itin.destination,
      contactId: req.portal.contactId,
      action: "accepted",
    });
    res.json(updated);
  } catch (err) {
    console.error("[Portal][travel/itin accept]", err);
    res.status(500).json({ error: "Failed to accept this trip" });
  }
});

// POST /api/portal/travel/itineraries/:id/decline
router.post("/travel/itineraries/:id/decline", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itin = await loadPortalOwnedItinerary(req, res);
    if (!itin) return;
    if (itin.status === "rejected") {
      return res.status(409).json({ error: "You've already declined this trip", code: "ALREADY_REJECTED" });
    }
    if (["advance_paid", "fully_paid"].includes(itin.status)) {
      return res.status(409).json({ error: "You can't decline a trip you've already paid for — contact your advisor", code: "INVALID_STATE" });
    }
    // Optional feedback: why they declined / what they'd want improved.
    const rawReason = req.body && typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    const reason = rawReason ? rawReason.slice(0, 2000) : null;
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { status: "rejected", declineReason: reason },
      select: { id: true, status: true, declineReason: true },
    });
    await notifyStaffOfItineraryDecision({
      tenantId: req.portal.tenantId,
      subBrand: itin.subBrand,
      itineraryId: itin.id,
      destination: itin.destination,
      contactId: req.portal.contactId,
      action: "declined",
      reason,
    });
    res.json(updated);
  } catch (err) {
    console.error("[Portal][travel/itin decline]", err);
    res.status(500).json({ error: "Failed to decline this trip" });
  }
});

// POST /api/portal/travel/itineraries/:id/request-cancellation
//
// Customer-initiated cancellation of a COMMITTED booking (accepted / paid),
// 2026-06-19. The customer must give a reason; we record it + flip
// cancellationStatus → "requested", flag the advisor (sub-brand scoped) with
// the reason + amount-paid so they can refund per the cancellation policy, and
// drop an acknowledgement into the customer's portal bell. We DON'T auto-cancel
// the status or auto-refund — the advisor settles per policy. Offers that
// haven't been accepted yet use /decline instead.
router.post("/travel/itineraries/:id/request-cancellation", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itin = await loadPortalOwnedItinerary(req, res);
    if (!itin) return;
    if (!["accepted", "advance_paid", "fully_paid"].includes(itin.status)) {
      return res.status(409).json({ error: "Only a confirmed booking can be cancelled here. Decline the offer instead.", code: "INVALID_STATE" });
    }
    if (itin.cancellationStatus === "requested" || itin.cancellationStatus === "cancelled") {
      return res.status(409).json({ error: "A cancellation is already in progress for this booking.", code: "ALREADY_REQUESTED" });
    }
    // A trip that has already departed (or ended) can't be cancelled online —
    // there's nothing left to cancel and the cancellation policy keys off
    // days-before-departure (which is now negative). The customer must contact
    // their advisor for any post-departure exception. We block on the START
    // date (departure); fall back to endDate if only that's set.
    const departure = itin.startDate || itin.endDate;
    if (departure && new Date(departure).getTime() <= Date.now()) {
      return res.status(409).json({
        error: "This trip has already started, so it can no longer be cancelled online. Please contact your advisor.",
        code: "TRIP_ALREADY_STARTED",
      });
    }
    const rawReason = req.body && typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (!rawReason) {
      return res.status(400).json({ error: "Please tell us why you're cancelling.", code: "REASON_REQUIRED" });
    }
    const reason = rawReason.slice(0, 2000);
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { cancellationStatus: "requested", cancellationReason: reason, cancellationRequestedAt: new Date() },
      select: { id: true, status: true, cancellationStatus: true, cancellationReason: true, cancellationRequestedAt: true },
    });
    // Flag the advisor (sub-brand scoped) with the reason + amount paid.
    await notifyStaffOfItineraryDecision({
      tenantId: req.portal.tenantId,
      subBrand: itin.subBrand,
      itineraryId: itin.id,
      destination: itin.destination,
      contactId: req.portal.contactId,
      action: "cancellation_requested",
      reason,
      amountPaid: Number(itin.advancePaidAmount || 0),
      currency: itin.currency,
    });
    // Acknowledge to the customer in their portal bell.
    travelPortalNotifications.safeNotifyTravelCustomer({
      contactId: req.portal.contactId,
      tenantId: req.portal.tenantId,
      type: "info",
      title: "Cancellation request received",
      message: `We've received your request to cancel your ${itin.destination || "trip"}. Your advisor will review it and process any refund due per the cancellation policy.`,
      link: `booking:${itin.id}`,
    });
    res.json(updated);
  } catch (err) {
    console.error("[Portal][travel/itin request-cancellation]", err);
    res.status(500).json({ error: "Failed to submit your cancellation request" });
  }
});

// POST /api/portal/travel/itineraries/:id/preferred-dates
//
// Customer sets / edits their preferred travel dates from the portal (collect-
// at-accept). Allowed while the offer is still live (not rejected / expired /
// cancelled). Persists startDate (+ optional endDate) and flags the advisor
// (sub-brand scoped) to confirm fares/availability for the chosen dates.
router.post("/travel/itineraries/:id/preferred-dates", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itin = await loadPortalOwnedItinerary(req, res);
    if (!itin) return;
    if (["rejected", "expired"].includes(itin.status) || itin.cancellationStatus === "cancelled") {
      return res.status(409).json({ error: "This booking is no longer editable.", code: "INVALID_STATE" });
    }
    const b = req.body || {};
    const start = b.startDate ? new Date(b.startDate) : null;
    if (!start || Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Please pick a valid start date.", code: "INVALID_START_DATE" });
    }
    let end = b.endDate ? new Date(b.endDate) : null;
    if (end && Number.isNaN(end.getTime())) end = null;
    if (end && end < start) {
      return res.status(400).json({ error: "End date can't be before the start date.", code: "INVALID_DATE_RANGE" });
    }
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { startDate: start, ...(end ? { endDate: end } : {}) },
      select: { id: true, startDate: true, endDate: true },
    });
    // Flag the advisor (sub-brand scoped) to confirm fares for the new dates.
    try {
      const userIds = await resolveItineraryStaffUserIds(req.portal.tenantId, itin.subBrand);
      if (userIds.length) {
        const fmtD = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
        const range = updated.endDate ? `${fmtD(updated.startDate)} → ${fmtD(updated.endDate)}` : `from ${fmtD(updated.startDate)}`;
        await notifyMany({
          userIds,
          tenantId: req.portal.tenantId,
          title: "Customer set travel dates",
          message: `The customer set preferred travel dates (${range}) for "${itin.destination || `#${itin.id}`}". Confirm fares/availability for these dates.`,
          type: "info",
          link: `/travel/itineraries/${itin.id}`,
        });
      }
    } catch (e) {
      console.warn("[Portal][travel/itin preferred-dates] notify failed (non-fatal):", e.message);
    }
    res.json(updated);
  } catch (err) {
    console.error("[Portal][travel/itin preferred-dates]", err);
    res.status(500).json({ error: "Failed to save your travel dates" });
  }
});

// POST /api/portal/travel/itineraries/:id/webcheckin-confirm
//
// The customer's "Yes, I've checked in" action for a flight trip (2026-06-16).
// Flips every still-active WebCheckin row for this trip → status "done" — the
// SAME rows the existing webCheckinScheduler + the email engine read, so this
// one confirm stops BOTH (no more reminder emails, no agent-fallback
// escalation). Ownership verified by loadPortalOwnedItinerary. Idempotent: if
// no active rows remain it's a no-op success (updated: 0).
router.post("/travel/itineraries/:id/webcheckin-confirm", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itin = await loadPortalOwnedItinerary(req, res);
    if (!itin) return;
    const result = await prisma.webCheckin.updateMany({
      where: {
        itineraryId: itin.id,
        tenantId: req.portal.tenantId,
        status: { in: ["pending", "reminded"] },
      },
      data: { status: "done" },
    });
    res.json({ id: itin.id, confirmed: true, updated: result.count });
  } catch (err) {
    console.error("[Portal][travel/itin webcheckin-confirm]", err);
    res.status(500).json({ error: "Failed to confirm web check-in" });
  }
});

// GET /api/portal/travel/itineraries/:id/review
// Returns the (destination-interpolated) review form + the customer's current
// review state for their OWN completed trip. (2026-06-16)
router.get("/travel/itineraries/:id/review", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itin = await loadPortalOwnedItinerary(req, res);
    if (!itin) return;
    const existing = await prisma.travelTripReview.findUnique({
      where: { itineraryId: itin.id },
      select: { status: true, overallRating: true },
    });
    const destination = itin.destination || "your trip";
    res.json({
      destination,
      status: existing ? existing.status : "available",
      alreadySubmitted: existing ? existing.status === "submitted" : false,
      overallRating: existing ? existing.overallRating : null,
      form: buildReviewForm(destination),
    });
  } catch (err) {
    console.error("[Portal][travel/itin review get]", err);
    res.status(500).json({ error: "Failed to load review" });
  }
});

// POST /api/portal/travel/itineraries/:id/review
// The logged-in customer submits a review for their OWN trip. Upserts the
// TravelTripReview row (the cron may have already created one in "requested"
// state; if not, we create it). Idempotent: a re-submit on an already-submitted
// trip returns 409. (2026-06-16)
router.post("/travel/itineraries/:id/review", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itin = await loadPortalOwnedItinerary(req, res);
    if (!itin) return;
    const { ok, errors, overallRating, clean } = validateReviewSubmission(req.body && req.body.answers);
    if (!ok) return res.status(400).json({ error: "Some answers need attention", code: "INVALID_ANSWERS", errors });

    const existing = await prisma.travelTripReview.findUnique({ where: { itineraryId: itin.id }, select: { id: true, status: true } });
    if (existing && existing.status === "submitted") {
      return res.status(409).json({ error: "You've already reviewed this trip — thank you!", code: "ALREADY_SUBMITTED" });
    }
    const data = { status: "submitted", overallRating, answersJson: JSON.stringify(clean), submittedAt: new Date() };
    if (existing) {
      await prisma.travelTripReview.update({ where: { id: existing.id }, data });
    } else {
      await prisma.travelTripReview.create({
        data: {
          tenantId: req.portal.tenantId,
          itineraryId: itin.id,
          contactId: req.portal.contactId,
          token: crypto.randomBytes(24).toString("base64url"),
          ...data,
        },
      });
    }
    res.status(201).json({ ok: true, overallRating });
  } catch (err) {
    console.error("[Portal][travel/itin review submit]", err);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

// ─── Travel customer-portal notification inbox (2026-06-17) ──────────
// Contact-scoped, separate from the staff Notification table. Emitted when an
// advisor sends/revises an itinerary or a payment is recorded (see
// routes/travel_itineraries.js notifyCustomerTrip).

// GET /api/portal/travel/notifications — newest-first inbox + unread count.
//   ?limit=N (default 50, capped 200)   ?unreadOnly=true
router.get("/travel/notifications", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const unreadOnly = req.query.unreadOnly === "true" || req.query.unreadOnly === "1";
    const { items, unreadCount } = await travelPortalNotifications.listTravelPortalNotifications(req.portal.contactId, {
      limit: req.query.limit,
      unreadOnly,
    });
    res.json({
      notifications: items.map(travelPortalNotifications.toPublic),
      unreadCount,
      count: items.length,
    });
  } catch (e) {
    console.error("[Portal][travel/notifications]", e.message);
    res.status(500).json({ error: "Failed to load notifications" });
  }
});

// PUT /api/portal/travel/notifications/:id/read — mark ONE read (own rows only).
router.put("/travel/notifications/:id/read", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid notification id", code: "INVALID_ID" });
    const updated = await travelPortalNotifications.markTravelPortalNotificationRead(req.portal.contactId, id);
    if (!updated) return res.status(404).json({ error: "Notification not found", code: "NOT_FOUND" });
    res.json(travelPortalNotifications.toPublic(updated));
  } catch (e) {
    console.error("[Portal][travel/notifications read]", e.message);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// POST /api/portal/travel/notifications/mark-all-read — mark all unread read.
router.post("/travel/notifications/mark-all-read", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const marked = await travelPortalNotifications.markAllTravelPortalNotificationsRead(req.portal.contactId);
    res.json({ success: true, marked });
  } catch (e) {
    console.error("[Portal][travel/notifications mark-all-read]", e.message);
    res.status(500).json({ error: "Failed to update notifications" });
  }
});

// GET /api/portal/travel/profile — the logged-in customer's profile, incl.
// avatar URL. Distinct from the generic /portal/me (which is not travel-gated
// and omits avatarUrl).
router.get("/travel/profile", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: req.portal.contactId },
      select: {
        id: true, name: true, email: true, phone: true, company: true,
        title: true, subBrand: true, avatarUrl: true, createdAt: true,
        // The portal JWT is tenant-bound. Return the same scoped ID so the
        // public brand resolver can select this organization's kit rather
        // than an ambiguous first travel tenant.
        tenantId: true,
      },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json(contact);
  } catch (err) {
    console.error("[Portal][travel/profile]", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// POST /api/portal/travel/avatar — upload (or replace) the customer's profile
// photo. multipart/form-data, single `file` field. Stored in S3 under
// avatars/contact/<id>; the old object is best-effort deleted on replace.
router.post(
  "/travel/avatar",
  verifyPortalToken,
  requireTravelPortalTenant,
  avatarUploadHandler,
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No file uploaded", code: "NO_FILE" });
      }
      const existing = await prisma.contact.findUnique({
        where: { id: req.portal.contactId },
        select: { id: true, avatarUrl: true },
      });
      if (!existing) return res.status(404).json({ error: "Contact not found" });

      let newUrl;
      try {
        newUrl = await s3Service.uploadImage(
          req.file.buffer,
          req.file.originalname || "avatar.jpg",
          req.file.mimetype,
          `avatars/contact/${req.portal.contactId}`,
        );
      } catch (uploadErr) {
        if (/Invalid image MIME type/.test(uploadErr.message || "")) {
          return res.status(415).json({
            error: "Profile picture must be an image (jpeg/png/gif/webp/svg)",
            code: "UNSUPPORTED_MEDIA",
          });
        }
        if (/S3 bucket not configured/.test(uploadErr.message || "")) {
          return res.status(503).json({
            error: "Profile picture storage is not configured",
            code: "STORAGE_UNCONFIGURED",
          });
        }
        throw uploadErr;
      }

      await prisma.contact.update({
        where: { id: req.portal.contactId },
        data: { avatarUrl: newUrl },
      });

      // Best-effort delete of the previous object so the bucket doesn't leak.
      if (existing.avatarUrl) {
        try {
          const oldKey = s3Service.extractKeyFromUrl(existing.avatarUrl);
          if (oldKey) await s3Service.deleteFile(oldKey);
        } catch (delErr) {
          console.warn("[Portal][travel/avatar] old-avatar delete failed:", delErr.message);
        }
      }

      res.json({ avatarUrl: newUrl });
    } catch (err) {
      console.error("[Portal][travel/avatar]", err);
      res.status(500).json({ error: "Failed to upload avatar" });
    }
  },
);

// ─── Travel customer-portal — travellers + passport upload ───────────
//
// Customer-side half of the passport OCR flow (PRD_PASSPORT_OCR AC-1):
// the customer registers their own travellers (children / family /
// themselves) on a trip and uploads each traveller's passport from the
// portal. Linkage: TripParticipant has no contactId column — ownership is
// TripParticipant.parentEmail === the portal contact's email. Rows the
// customer creates here always stamp that email; staff-created rows that
// share the email surface for the customer too, by design.
//
// Uploads write the SAME TripParticipant extraction columns as the staff
// route (routes/travel_passport.js), so they feed the same operator
// verification queue at /travel/passport-verification.
//
// PII boundary (PRD FR-8/FR-9): the portal NEVER gets extraction VALUES
// back — only status timestamps. The verified extraction is reviewed by
// ADMIN/MANAGER in the queue; audit rows log field NAMES, never values.

// Passport scan storage (S3 with disk fallback) lives in the shared helper so
// the customer + staff routes delete from the same backend on re-upload/clear.
const {
  storeScan: storePassportScan,
  removeScan: removePassportScan,
  descriptorFromEnvelope,
  PASSPORT_MIME_EXT,
} = require("../lib/passportFileStore");

// memoryStorage: the file stays in req.file.buffer and is NOT written anywhere
// until the handler explicitly stores it — so ownership/verified checks run
// BEFORE any persistence (no orphaned files), and the buffer feeds both OCR
// and the S3/disk upload.
const portalPassportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (PASSPORT_MIME_EXT[(file.mimetype || "").toLowerCase()]) {
      return cb(null, true);
    }
    cb(new Error("UNSUPPORTED_MIME"));
  },
});
const portalPassportUploadHandler = (req, res, next) => {
  portalPassportUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file exceeds 5 MB limit", code: "FILE_TOO_LARGE" });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err && err.message === "UNSUPPORTED_MIME") {
      return res.status(415).json({ error: "unsupported file type — JPG / PNG / PDF only", code: "UNSUPPORTED_MIME" });
    }
    if (err) return next(err);
    next();
  });
};

// Sub-brands that the unified Travel Documents surface serves. Snapshot of
// the customer's Contact.subBrand at traveller-creation; falls back to "rfu"
// when a contact has no sub-brand set (RFU is the default B2C pilgrim brand).
const TRAVEL_SUB_BRANDS = ["tmc", "rfu", "travel_stall", "visa_sure"];
// Bound per-customer travellers so a logged-in customer can't pollute the
// staff verification queue at scale.
const PORTAL_MAX_TRAVELLERS = 20;

// GET /api/portal/travel/travellers — the customer's own travellers with
// passport STATUS timestamps only (never extraction VALUES — those stay
// staff-side until verified, per the PII boundary).
router.get("/travel/travellers", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const travellers = await prisma.customerTraveller.findMany({
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        fullName: true,
        relationship: true,
        subBrand: true,
        passportExtractedAt: true,
        passportVerifiedAt: true,
        passportRejectedAt: true,
      },
    });
    res.json({ travellers });
  } catch (err) {
    console.error("[Portal][travel/travellers]", err);
    res.status(500).json({ error: "Failed to fetch travellers" });
  }
});

// POST /api/portal/travel/travellers — { fullName, relationship? }. Creates a
// traveller owned by this customer (contactId), tagged with the customer's
// sub-brand. Works for all 4 sub-brands — no trip/booking selection needed.
router.post("/travel/travellers", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const { fullName, relationship } = req.body || {};
    if (!fullName || !String(fullName).trim()) {
      return res.status(400).json({ error: "fullName is required", code: "MISSING_FIELDS" });
    }
    const me = await prisma.contact.findUnique({
      where: { id: req.portal.contactId },
      select: { subBrand: true },
    });
    const subBrand = (me && TRAVEL_SUB_BRANDS.includes(me.subBrand)) ? me.subBrand : "rfu";

    const count = await prisma.customerTraveller.count({
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
    });
    if (count >= PORTAL_MAX_TRAVELLERS) {
      return res.status(429).json({
        error: `You can register at most ${PORTAL_MAX_TRAVELLERS} travellers — contact your advisor if you need more.`,
        code: "TRAVELLER_LIMIT_REACHED",
      });
    }

    const rel = typeof relationship === "string" && relationship.trim()
      ? relationship.trim().slice(0, 40)
      : null;
    const traveller = await prisma.customerTraveller.create({
      data: {
        tenantId: req.portal.tenantId,
        contactId: req.portal.contactId,
        subBrand,
        fullName: String(fullName).trim().slice(0, 200),
        relationship: rel,
      },
      select: { id: true, fullName: true, relationship: true, subBrand: true },
    });

    writeAudit(
      "CustomerTraveller",
      "traveller.portal_added",
      traveller.id,
      null,
      req.portal.tenantId,
      { portalContactId: req.portal.contactId, subBrand },
      { actorType: "portal" },
    ).catch(() => {});

    res.status(201).json({ traveller });
  } catch (err) {
    console.error("[Portal][travel/travellers:add]", err);
    res.status(500).json({ error: "Failed to add traveller" });
  }
});

// POST /api/portal/travel/travellers/:id/passport-upload — multipart single
// "file". Ownership-scoped (contactId), 404 on foreign rows (don't leak
// existence). Feeds the same staff verification queue as the TMC flow.
router.post(
  "/travel/travellers/:id/passport-upload",
  verifyPortalToken,
  requireTravelPortalTenant,
  portalPassportUploadHandler,
  async (req, res) => {
    // memoryStorage: nothing is persisted until storePassportScan() below, so
    // all the ownership/state early-returns leave NO file behind (the buffer
    // is just GC'd) — only post-store branches need cleanup.
    try {
      const tid = parseInt(req.params.id, 10);
      if (!Number.isFinite(tid)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_TRAVELLER_ID" });
      }
      const traveller = await prisma.customerTraveller.findFirst({
        where: { id: tid, contactId: req.portal.contactId, tenantId: req.portal.tenantId },
        select: { id: true, fullName: true, passportVerifiedAt: true, passportExtractionJson: true },
      });
      if (!traveller) {
        return res.status(404).json({ error: "Traveller not found", code: "TRAVELLER_NOT_FOUND" });
      }
      if (traveller.passportVerifiedAt) {
        // A verified passport is replaced by staff (queue Clear), not
        // silently overwritten from the portal.
        return res.status(409).json({ error: "Passport already verified — contact your advisor to replace it", code: "ALREADY_VERIFIED" });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "no file uploaded (field name: 'file')", code: "NO_FILE" });
      }

      // OCR runs on the in-memory buffer — nothing is stored yet.
      let result;
      try {
        result = await passportOcrClient.extractPassport({
          tenantId: req.portal.tenantId,
          fileBuffer: req.file.buffer,
          fileName: req.file.originalname || null,
          mimeType: req.file.mimetype,
        });
      } catch (e) {
        if (e.code === "PASSPORT_OCR_NOT_YET_ENABLED") {
          return res.status(503).json({
            error: "Passport upload is temporarily unavailable — please try again later",
            code: "PASSPORT_OCR_NOT_YET_ENABLED",
          });
        }
        throw e;
      }

      // Persist the scan (S3 when configured, disk fallback) AFTER all checks
      // pass, so there's nothing to orphan on a rejected request.
      let stored;
      try {
        stored = await storePassportScan(req.file.buffer, req.file.mimetype);
      } catch (e) {
        console.error("[Portal][travel/travellers:passport-upload] storage error:", e.message);
        return res.status(502).json({ error: "Couldn't store the uploaded file — please try again", code: "STORAGE_FAILED" });
      }

      const persistedEnvelope = {
        ...result,
        imageFilename: stored.imageFilename, // disk-mode filename (null on S3)
        imageKey: stored.key,
        storage: stored.storage,
        imageUrl: stored.url,
        originalName: req.file.originalname || null,
        uploadedVia: "portal",
        portalContactId: req.portal.contactId,
      };

      // Conditional update guarded on passportVerifiedAt: null — closes the
      // TOCTOU window where a staff verify lands between our read and write.
      const writeRes = await prisma.customerTraveller.updateMany({
        where: { id: traveller.id, passportVerifiedAt: null },
        data: {
          passportExtractionJson: JSON.stringify(persistedEnvelope),
          passportExtractedAt: new Date(),
          passportRejectedAt: null,
        },
      });
      if (!writeRes.count) {
        // Lost the race — a staff verify committed first. Remove what we stored.
        await removePassportScan(stored);
        return res.status(409).json({ error: "Passport already verified — contact your advisor to replace it", code: "ALREADY_VERIFIED" });
      }

      // Supersede the previous scan, if any, so re-uploads don't orphan it.
      if (traveller.passportExtractionJson) {
        try {
          const prevDesc = descriptorFromEnvelope(JSON.parse(traveller.passportExtractionJson));
          if (prevDesc && prevDesc.key !== stored.key) await removePassportScan(prevDesc);
        } catch (_e) { /* prior envelope unparseable — nothing to clean */ }
      }

      writeAudit(
        "CustomerTraveller",
        "passport.uploaded",
        traveller.id,
        null,
        req.portal.tenantId,
        {
          extractedFieldNames: Object.keys(result.extraction || {}),
          confidence: result.confidence,
          provider: result.provider,
          storage: stored.storage,
          portalContactId: req.portal.contactId,
        },
        { actorType: "portal" },
      ).catch(() => {});

      // Status only — extraction values stay staff-side until verified.
      res.status(201).json({
        travellerId: traveller.id,
        status: "pending-verification",
      });
    } catch (err) {
      console.error("[Portal][travel/travellers:passport-upload]", err);
      res.status(500).json({ error: "Failed to process passport upload" });
    }
  },
);

// ─── Travel customer-portal — self-service diagnostic ────────────────
//
// The customer takes the readiness diagnostic for THEIR sub-brand (the
// sub-brand on their Contact). The submission is recorded as a normal
// TravelDiagnostic row keyed to their contactId + sub-brand + tenant, so
// it automatically shows up for the brand's manager + admins on the staff
// Diagnostics page (which already scopes by sub-brand access) — no extra
// staff wiring needed. Reuses the same scoring engine as the staff route.
//
// Endpoints (all travel-tenant + portal-token gated):
//   GET  /api/portal/travel/diagnostic-bank  → active bank questions for
//        the customer's sub-brand (option weights stripped).
//   GET  /api/portal/travel/diagnostics      → the customer's own past results.
//   POST /api/portal/travel/diagnostics { answers } → score + record + return.

// Resolve the logged-in portal customer's sub-brand from their Contact row.
async function getPortalContactSubBrand(contactId) {
  const c = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { subBrand: true },
  });
  return c && c.subBrand ? c.subBrand : null;
}

// Load the active (highest-version) diagnostic bank for a sub-brand.
async function loadActiveBank(tenantId, subBrand) {
  return prisma.travelDiagnosticQuestionBank.findFirst({
    where: { tenantId, subBrand, isActive: true },
    orderBy: { version: "desc" },
  });
}

// GET /api/portal/travel/diagnostic-brands
//
// A customer can be served by more than one sub-brand (e.g. RFU Umrah AND a
// TMC school trip), so the portal lets them choose which brand's diagnostic
// to take. Returns the sub-brands that have an ACTIVE diagnostic bank in the
// tenant, plus the customer's own primary sub-brand as the default selection.
router.get("/travel/diagnostic-brands", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const banks = await prisma.travelDiagnosticQuestionBank.findMany({
      where: { tenantId: req.portal.tenantId, isActive: true },
      select: { subBrand: true },
      orderBy: [{ subBrand: "asc" }],
    });
    const brands = [...new Set(banks.map((b) => b.subBrand))].map((subBrand) => ({ subBrand }));
    const defaultSubBrand = await getPortalContactSubBrand(req.portal.contactId);
    res.json({ brands, defaultSubBrand });
  } catch (err) {
    console.error("[Portal][travel/diagnostic-brands]", err);
    res.status(500).json({ error: "Failed to load diagnostic brands" });
  }
});

// GET /api/portal/travel/diagnostic-bank?subBrand=rfu
//
// Questions for ONE sub-brand. `subBrand` comes from the customer's selector;
// when omitted we fall back to their primary Contact.subBrand (back-compat).
router.get("/travel/diagnostic-bank", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const requested = req.query.subBrand ? String(req.query.subBrand) : null;
    const subBrand = requested || (await getPortalContactSubBrand(req.portal.contactId));
    if (!subBrand) {
      return res.json({ available: false, reason: "NO_SUB_BRAND" });
    }
    const bank = await loadActiveBank(req.portal.tenantId, subBrand);
    if (!bank) {
      return res.json({ available: false, reason: "NO_BANK", subBrand });
    }
    const { bank: parsed } = parseBank(bank.questionsJson, bank.scoringRulesJson);
    // Project only what the customer needs to answer — NEVER expose the
    // per-option scoring weights or the band thresholds.
    const questions = ((parsed && parsed.questions) || []).map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      options: (q.options || []).map((o) => ({ value: o.value, label: o.label })),
    }));
    res.json({ available: true, bankId: bank.id, subBrand, version: bank.version, questions });
  } catch (err) {
    console.error("[Portal][travel/diagnostic-bank]", err);
    res.status(500).json({ error: "Failed to load diagnostic" });
  }
});

// GET /api/portal/travel/diagnostics — the customer's own submissions.
router.get("/travel/diagnostics", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const rows = await prisma.travelDiagnostic.findMany({
      where: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        subBrand: true,
        score: true,
        classification: true,
        classificationLabel: true,
        recommendedTier: true,
        createdAt: true,
      },
    });
    res.json(rows);
  } catch (err) {
    console.error("[Portal][travel/diagnostics]", err);
    res.status(500).json({ error: "Failed to load diagnostics" });
  }
});

// POST /api/portal/travel/diagnostics — submit answers; score + record.
router.post("/travel/diagnostics", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const { answers, subBrand: bodySubBrand } = req.body || {};
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return res.status(400).json({ error: "answers object required", code: "MISSING_FIELDS" });
    }
    // The customer picks which brand they're taking the diagnostic for
    // (they may be served by several); fall back to their primary sub-brand.
    const subBrand = bodySubBrand ? String(bodySubBrand) : (await getPortalContactSubBrand(req.portal.contactId));
    if (!subBrand) {
      return res.status(409).json({ error: "No sub-brand on your profile — please contact your advisor", code: "NO_SUB_BRAND" });
    }
    const bank = await loadActiveBank(req.portal.tenantId, subBrand);
    if (!bank) {
      return res.status(404).json({ error: "No diagnostic is available right now", code: "NO_BANK" });
    }
    const { bank: parsed } = parseBank(bank.questionsJson, bank.scoringRulesJson);
    if (!parsed) {
      return res.status(500).json({ error: "Diagnostic is temporarily unavailable", code: "BANK_CORRUPTED" });
    }
    const result = scoreDiagnostic(parsed, answers);
    const snapshot = JSON.stringify({
      bankId: bank.id,
      bankVersion: bank.version,
      questionsJson: bank.questionsJson,
      scoringRulesJson: bank.scoringRulesJson,
      scoringWarnings: result.warnings,
      source: "customer-portal",
    });
    const diag = await prisma.travelDiagnostic.create({
      data: {
        tenantId: req.portal.tenantId,
        subBrand: bank.subBrand,
        contactId: req.portal.contactId,
        questionBankId: bank.id,
        questionsJson: snapshot,
        answersJson: JSON.stringify(answers),
        score: result.score,
        classification: result.classification,
        classificationLabel: result.classificationLabel,
        recommendedTier: result.recommendedTier,
      },
    });
    res.status(201).json({
      id: diag.id,
      subBrand: diag.subBrand,
      score: result.score,
      classification: result.classification,
      classificationLabel: result.classificationLabel,
      recommendedTier: result.recommendedTier,
      createdAt: diag.createdAt,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error("[Portal][travel/diagnostics POST]", err);
    res.status(500).json({ error: "Failed to submit diagnostic" });
  }
});

// ─── Visa Sure self-serve: start application + upload documents (FR-6.2) ──
//
// After the Visa Sure diagnostic the customer sees their recommended document
// list (checklist-preview), clicks "Start my application" (creates the
// VisaApplication + seeds the checklist from the template), then uploads each
// required document. The advisor (AdvisorDashboard) then verifies/rejects each
// upload; verifying the last required doc auto-advances the application to
// Filed. Everything here is scoped to the logged-in Contact (req.portal).
const VISA_SUB_BRAND_PORTAL = "visasure";
const VISA_APP_TYPES = ["tourist", "business", "student", "work", "umrah", "hajj"];

// multipart handler — JPG / PNG / PDF only (passport scans, photos, supporting
// docs), 10 MB cap. memoryStorage: nothing persists until storeDoc() runs after
// the ownership checks, so a rejected request leaves no orphaned file.
const portalVisaDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (visaDocStore.VISA_DOC_MIME_EXT[(file.mimetype || "").toLowerCase()]) {
      return cb(null, true);
    }
    cb(new Error("UNSUPPORTED_MIME"));
  },
});
const portalVisaDocUploadHandler = (req, res, next) => {
  portalVisaDocUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large (max 10 MB)", code: "FILE_TOO_LARGE" });
      }
      return res.status(400).json({ error: "Upload error", code: "UPLOAD_ERROR" });
    }
    if (err) {
      return res.status(400).json({ error: "Only JPG, PNG, or PDF files are allowed", code: "UNSUPPORTED_MIME" });
    }
    next();
  });
};

// Project a checklist item for the customer — their own file URL + status +
// any advisor note (e.g. a rejection reason) are surfaced; internal ids aren't.
function projectPortalChecklistItem(i) {
  return {
    id: i.id,
    docType: i.docType,
    required: i.required,
    status: i.status,
    attachmentUrl: i.attachmentUrl || null,
    attachmentName: i.attachmentName || null,
    uploadedAt: i.uploadedAt || null,
    notes: i.notes || null,
  };
}
function projectPortalVisaApp(app) {
  return {
    id: app.id,
    applicationType: app.applicationType,
    destinationCountry: app.destinationCountry,
    status: app.status,
    createdAt: app.createdAt,
    documentChecklist: (app.documentChecklist || []).map(projectPortalChecklistItem),
  };
}

// GET /api/portal/travel/visa/checklist-preview?applicationType=&destinationCountry=
// Read-only — the canonical document list for a combo, shown BEFORE the
// customer starts (so they know what they'll need). No application required.
router.get("/travel/visa/checklist-preview", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const applicationType = String(req.query.applicationType || "").trim();
    const destinationCountry = String(req.query.destinationCountry || "").trim();
    if (!applicationType || !destinationCountry) {
      return res.status(400).json({ error: "applicationType and destinationCountry are required", code: "MISSING_FIELDS" });
    }
    const items = await prisma.visaChecklistTemplate.findMany({
      where: { tenantId: req.portal.tenantId, applicationType, destinationCountry },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { docType: true, required: true, notes: true },
    });
    res.json({ applicationType, destinationCountry, items });
  } catch (err) {
    console.error("[Portal][travel/visa/checklist-preview]", err);
    res.status(500).json({ error: "Failed to load checklist preview" });
  }
});

// GET /api/portal/travel/visa/applications — all of the customer's visa
// applications (one per visa — e.g. a transit visa + a destination visa for
// the same trip), each with its own checklist. Empty array if none started.
router.get("/travel/visa/applications", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const rows = await prisma.visaApplication.findMany({
      where: { tenantId: req.portal.tenantId, contactId: req.portal.contactId },
      orderBy: { createdAt: "desc" },
      include: { documentChecklist: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ applications: rows.map(projectPortalVisaApp) });
  } catch (err) {
    console.error("[Portal][travel/visa/applications GET]", err);
    res.status(500).json({ error: "Failed to load your visa applications" });
  }
});

// POST /api/portal/travel/visa/applications { applicationType, destinationCountry }
// "Start my application" — creates a NEW application (status docs-pending) and
// seeds its checklist from the template. A customer may hold several (one per
// visa); each call creates a fresh application.
router.post("/travel/visa/applications", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const tenantId = req.portal.tenantId;
    const contactId = req.portal.contactId;
    const body = req.body || {};
    const applicationType = typeof body.applicationType === "string" ? body.applicationType.trim() : "";
    const destinationCountry = typeof body.destinationCountry === "string" ? body.destinationCountry.trim() : "";
    if (!VISA_APP_TYPES.includes(applicationType)) {
      return res.status(400).json({ error: `applicationType must be one of: ${VISA_APP_TYPES.join(", ")}`, code: "INVALID_APPLICATION_TYPE" });
    }
    if (!destinationCountry || destinationCountry.length > 200) {
      return res.status(400).json({ error: "destinationCountry is required (1..200 chars)", code: "INVALID_DESTINATION" });
    }

    // The Visa Sure pipeline is sub-brand-scoped: the advisor surface only
    // shows applications whose Contact.subBrand === "visasure". A customer who
    // starts a visa application IS a visa customer, so we promote the contact
    // to visasure here (capturing any prior brand in the audit row) — else
    // their application would be invisible to visa advisors + unactionable.
    // Runs BEFORE the idempotency check so a repeat "start" also repairs an
    // application created before the contact was promoted.
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true, subBrand: true },
    });
    const priorSubBrand = contact ? contact.subBrand : null;
    if (contact && contact.subBrand !== VISA_SUB_BRAND_PORTAL) {
      await prisma.contact.update({ where: { id: contactId }, data: { subBrand: VISA_SUB_BRAND_PORTAL } });
    }

    // Always create a fresh application — the customer can hold one per visa.
    const created = await prisma.visaApplication.create({
      data: { tenantId, contactId, applicationType, destinationCountry, status: "docs-pending" },
    });

    // Seed the checklist from the (applicationType × destinationCountry)
    // template — mirrors seedChecklistFromTemplates in routes/travel_visa.js.
    const templates = await prisma.visaChecklistTemplate.findMany({
      where: { tenantId, applicationType, destinationCountry },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { docType: true, required: true, notes: true },
    });
    if (templates.length) {
      await prisma.visaDocumentChecklistItem.createMany({
        data: templates.map((t) => ({
          applicationId: created.id,
          docType: t.docType,
          required: t.required,
          status: "pending",
          notes: t.notes || null,
        })),
      });
    }

    writeAudit(
      "VisaApplication",
      "CREATE",
      created.id,
      null,
      tenantId,
      { subBrand: VISA_SUB_BRAND_PORTAL, contactId, applicationType, destinationCountry, via: "portal", seeded: templates.length, priorSubBrand: priorSubBrand || null },
      { actorType: "portal" },
    ).catch(() => {});

    const withChecklist = await prisma.visaApplication.findFirst({
      where: { id: created.id },
      include: { documentChecklist: { orderBy: { createdAt: "asc" } } },
    });
    res.status(201).json({ application: projectPortalVisaApp(withChecklist), created: true });
  } catch (err) {
    console.error("[Portal][travel/visa/application POST]", err);
    res.status(500).json({ error: "Failed to start your visa application" });
  }
});

// POST /api/portal/travel/visa/documents/:itemId/upload — multipart "file".
// Uploads (or replaces) the document for one checklist item the customer owns;
// sets status → uploaded for advisor review. A verified item is locked (the
// advisor must reset it before re-upload).
router.post(
  "/travel/visa/documents/:itemId/upload",
  verifyPortalToken,
  requireTravelPortalTenant,
  portalVisaDocUploadHandler,
  async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId, 10);
      if (!Number.isFinite(itemId)) {
        return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ID" });
      }
      // Ownership: the item's application must belong to this customer.
      const item = await prisma.visaDocumentChecklistItem.findFirst({
        where: {
          id: itemId,
          application: { contactId: req.portal.contactId, tenantId: req.portal.tenantId },
        },
        select: { id: true, status: true, attachmentStorage: true, attachmentKey: true },
      });
      if (!item) {
        return res.status(404).json({ error: "Document not found", code: "NOT_FOUND" });
      }
      if (item.status === "verified") {
        return res.status(409).json({ error: "This document is already verified — contact your advisor to replace it", code: "ALREADY_VERIFIED" });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "no file uploaded (field name: 'file')", code: "NO_FILE" });
      }

      let stored;
      try {
        stored = await visaDocStore.storeDoc(req.file.buffer, req.file.mimetype);
      } catch (e) {
        console.error("[Portal][travel/visa/documents:upload] storage error:", e.message);
        return res.status(502).json({ error: "Couldn't store the uploaded file — please try again", code: "STORAGE_FAILED" });
      }

      const updated = await prisma.visaDocumentChecklistItem.update({
        where: { id: item.id },
        data: {
          attachmentUrl: stored.url,
          attachmentName: (req.file.originalname || "").slice(0, 255) || null,
          attachmentStorage: stored.storage,
          attachmentKey: stored.key,
          uploadedAt: new Date(),
          status: "uploaded",
          // Clear any prior rejection reason so the advisor reviews afresh.
          notes: null,
        },
      });

      // Supersede the previous file (re-upload) so we don't orphan it.
      if (item.attachmentKey && item.attachmentKey !== stored.key) {
        await visaDocStore.removeDoc({ storage: item.attachmentStorage, key: item.attachmentKey });
      }

      writeAudit(
        "VisaDocumentChecklistItem",
        "document.uploaded",
        item.id,
        null,
        req.portal.tenantId,
        { storage: stored.storage, portalContactId: req.portal.contactId },
        { actorType: "portal" },
      ).catch(() => {});

      res.status(201).json({ item: projectPortalChecklistItem(updated) });
    } catch (err) {
      console.error("[Portal][travel/visa/documents:upload]", err);
      res.status(500).json({ error: "Failed to upload document" });
    }
  },
);

// GET /api/portal/travel/visa/documents/:itemId/view-url — a short-lived link
// to open ONE document the customer owns. Replaces handing out the raw file URL:
// disk docs now require a signed token, S3 docs a signed URL, and both are
// owner-scoped (the item's application must belong to this customer).
router.get("/travel/visa/documents/:itemId/view-url", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ID" });
    }
    const item = await prisma.visaDocumentChecklistItem.findFirst({
      where: { id: itemId, application: { contactId: req.portal.contactId, tenantId: req.portal.tenantId } },
      select: { id: true, attachmentUrl: true, attachmentStorage: true, attachmentKey: true },
    });
    if (!item || !item.attachmentUrl) {
      return res.status(404).json({ error: "Document not found", code: "NOT_FOUND" });
    }
    const url = await visaDocStore.resolveViewUrl(item);
    if (!url) {
      return res.status(404).json({ error: "Document not found", code: "NOT_FOUND" });
    }
    res.json({ url, expiresIn: visaDocStore.DEFAULT_VIEW_TTL_SEC });
  } catch (e) {
    console.error("[Portal][travel/visa/documents view-url]", e.message);
    res.status(500).json({ error: "Failed to open document" });
  }
});

// DELETE /api/portal/travel/visa/applications/:id — let the customer cancel
// one of their own applications while it's still early. Allowed only in
// intake / docs-pending; once the advisor files or decides it, it's out of
// the customer's hands (409). Cascade removes the checklist items; we best-
// effort delete any uploaded files first so none orphan.
router.delete("/travel/visa/applications/:id", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const app = await prisma.visaApplication.findFirst({
      where: { id, tenantId: req.portal.tenantId, contactId: req.portal.contactId },
      select: { id: true, status: true },
    });
    if (!app) {
      return res.status(404).json({ error: "Application not found", code: "NOT_FOUND" });
    }
    if (!["intake", "docs-pending"].includes(app.status)) {
      return res.status(409).json({
        error: "This application is already being processed — contact your advisor to make changes",
        code: "NOT_CANCELLABLE",
      });
    }
    const filed = await prisma.visaDocumentChecklistItem.findMany({
      // Tenant-safe: `app` was just resolved with { id, tenantId, contactId }
      // above; VisaDocumentChecklistItem has no tenantId of its own (scoped
      // through its application).
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic
      where: { applicationId: id, attachmentKey: { not: null } },
      select: { attachmentStorage: true, attachmentKey: true },
    });
    for (const it of filed) {
      await visaDocStore.removeDoc({ storage: it.attachmentStorage, key: it.attachmentKey });
    }
    await prisma.visaApplication.delete({ where: { id } }); // cascade → checklist items
    writeAudit(
      "VisaApplication",
      "DELETE",
      id,
      null,
      req.portal.tenantId,
      { via: "portal", portalContactId: req.portal.contactId, status: app.status },
      { actorType: "portal" },
    ).catch(() => {});
    return res.json({ success: true, id });
  } catch (err) {
    console.error("[Portal][travel/visa/application DELETE]", err);
    return res.status(500).json({ error: "Failed to cancel your application" });
  }
});

// ─── DigiLocker / Aadhaar verification for the logged-in customer ────
//
// PRD §4.5 extended for end-user self-service KYC. Three endpoints:
//   POST /api/portal/kyc/initiate { redirectUri } → { state, oauthUrl, sessionId }
//   POST /api/portal/kyc/callback { state, code } → { verified, aadhaarLast4 }
//   GET  /api/portal/kyc/status                    → { kycStatus, aadhaarLast4, ... }
//
// Travel-tenant guard applied — non-travel tenants 403. Stub-mode when
// APISETU_PARTNER_API_KEY unset (deterministic synthetic values).
// Real-mode (set in .env) hits APISetu's DigiLocker partner endpoint;
// see services/digilockerClient.js for the exact contract.
//
// Aadhaar Act §29: only aadhaarLast4 + opaque kycTokenId are persisted /
// surfaced. Full 12-digit Aadhaar never crosses the network or hits
// our DB.

// POST /api/portal/kyc/initiate
router.post("/kyc/initiate", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const { redirectUri } = req.body || {};
    if (!redirectUri || typeof redirectUri !== "string") {
      return res.status(400).json({ error: "redirectUri required", code: "MISSING_FIELDS" });
    }
    const contact = await prisma.contact.findUnique({
      where: { id: req.portal.contactId },
      select: { id: true, tenantId: true, kycStatus: true },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    if (contact.kycStatus === "verified") {
      return res.status(409).json({
        error: "Already verified",
        code: "ALREADY_VERIFIED",
      });
    }
    const { state, oauthUrl } = await digilockerClient.initiateSession({
      subjectId: contact.id,
      subjectType: "contact",
      redirectUri,
    });
    const session = await prisma.digilockerSession.create({
      data: {
        tenantId: contact.tenantId,
        subjectType: "contact",
        contactId: contact.id,
        state,
        status: "initiated",
        redirectUri,
      },
      select: { id: true, state: true },
    });
    await prisma.contact.update({
      where: { id: contact.id },
      data: { kycStatus: "initiated", kycInitiatedAt: new Date() },
    });
    res.json({ state: session.state, oauthUrl, sessionId: session.id });
  } catch (err) {
    console.error("[Portal][kyc/initiate]", err);
    res.status(500).json({ error: "Failed to initiate DigiLocker session" });
  }
});

// POST /api/portal/kyc/callback
router.post("/kyc/callback", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const { state, code } = req.body || {};
    if (!state || typeof state !== "string") {
      return res.status(400).json({ error: "state required", code: "MISSING_FIELDS" });
    }
    const session = await prisma.digilockerSession.findFirst({
      where: {
        state,
        tenantId: req.portal.tenantId,
        contactId: req.portal.contactId,
        subjectType: "contact",
      },
    });
    if (!session) {
      return res.status(404).json({
        error: "DigiLocker session not found",
        code: "SESSION_NOT_FOUND",
      });
    }
    if (session.status === "verified") {
      return res.status(409).json({
        error: "DigiLocker session already verified",
        code: "INVALID_STATE",
      });
    }
    if (session.status === "expired" || session.status === "failed") {
      return res.status(410).json({
        error: `DigiLocker session ${session.status}`,
        code: "SESSION_GONE",
      });
    }
    let aadhaarLast4, aadhaarTokenId;
    try {
      ({ aadhaarLast4, aadhaarTokenId } = await digilockerClient.exchangeCallback({ state, code }));
    } catch (e) {
      await prisma.$transaction([
        prisma.digilockerSession.update({
          where: { id: session.id },
          data: { status: "failed", failedReason: String(e.message).slice(0, 200) },
        }),
        prisma.contact.update({
          where: { id: req.portal.contactId },
          data: { kycStatus: "failed" },
        }),
      ]);
      return res.status(502).json({
        error: "DigiLocker exchange failed",
        code: "EXCHANGE_FAILED",
      });
    }
    await prisma.$transaction([
      prisma.digilockerSession.update({
        where: { id: session.id },
        data: {
          status: "verified",
          verifiedAt: new Date(),
          resultLast4: aadhaarLast4,
          resultTokenId: aadhaarTokenId,
        },
      }),
      prisma.contact.update({
        where: { id: req.portal.contactId },
        data: {
          kycStatus: "verified",
          kycVerifiedAt: new Date(),
          aadhaarLast4,
          kycTokenId: aadhaarTokenId,
        },
      }),
    ]);
    // NEVER return aadhaarTokenId — server-side only (Aadhaar Act §29).
    res.json({ verified: true, aadhaarLast4 });
  } catch (err) {
    console.error("[Portal][kyc/callback]", err);
    res.status(500).json({ error: "Failed to complete DigiLocker verification" });
  }
});

// GET /api/portal/kyc/status
router.get("/kyc/status", verifyPortalToken, requireTravelPortalTenant, async (req, res) => {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: req.portal.contactId },
      select: {
        kycStatus: true,
        kycInitiatedAt: true,
        kycVerifiedAt: true,
        aadhaarLast4: true,
      },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json({
      kycStatus: contact.kycStatus || "unverified",
      kycInitiatedAt: contact.kycInitiatedAt,
      kycVerifiedAt: contact.kycVerifiedAt,
      aadhaarLast4: contact.aadhaarLast4,
      mode: digilockerClient.authMode(),
    });
  } catch (err) {
    console.error("[Portal][kyc/status]", err);
    res.status(500).json({ error: "Failed to fetch KYC status" });
  }
});

module.exports = router;
