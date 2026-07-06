const express = require('express');
const { verifyToken, verifyRole } = require('../middleware/auth');
const router = express.Router();
const prisma = require("../lib/prisma");
const audienceController = require("../controllers/audienceController");
const { ensureEmail, ensureNumberInRange, ensureEnum, ensureStringLength, ensureGst, ensureDateInRange, httpFromPrismaError } = require("../lib/validators");
const { writeAudit, diffFields } = require("../lib/audit");
const { markFirstResponseIfNeeded } = require("../lib/leadSla");
const { normalizePhone, computeDuplicateGroupKey, findDuplicateContactFull } = require("../utils/deduplication");
// #464: field-level permission enforcement. The fieldFilter middleware
// existed but was never called from any route; rules saved via the
// FieldPermissions UI had zero effect on read/write payloads. Default
// (no rule in DB) is full access.
const { filterReadFields, filterWriteFields } = require("../middleware/fieldFilter");

// #167: soft-delete helper. Aggregations / reports / merge / internal joins
// (e.g. activities, deals, sequenceEnrollments) are NOT yet filtered by
// deletedAt — that is a follow-up audit (see #167 follow-up note in TODOS).
function applyDeletedAtFilter(where, includeDeleted) {
  if (includeDeleted) return where;
  where.deletedAt = null;
  return where;
}

// #160 #166 #168: shared validator for create + update payloads on Contact.
function validateContactInput(body, { isUpdate = false } = {}) {
  // Email — required on create, optional on update; if present, must parse.
  const emailErr = ensureEmail(body.email, { required: !isUpdate });
  if (emailErr) return emailErr;
  // Name — string length cap, prevents Prisma column-overflow 500s (#165).
  // #337: name is a required field on create AND must contain non-whitespace
  // content. The `ensureStringLength` helper trims before the empty-check by
  // default, so "   " is rejected with NAME_REQUIRED. Stays optional on
  // update so a PATCH that doesn't touch name still validates.
  const nameErr = ensureStringLength(body.name, { max: 200, field: "name", required: !isUpdate });
  if (nameErr) return nameErr;
  // aiScore — bounded 0–100; UI renders "X/100" so anything else is broken (#166).
  if (body.aiScore !== undefined && body.aiScore !== null) {
    const scoreErr = ensureNumberInRange(body.aiScore, { min: 0, max: 100, field: "aiScore", code: "INVALID_AISCORE" });
    if (scoreErr) return scoreErr;
  }
  // status — keep open enum but reject obvious junk like "C" (importer #154 already does this).
  if (body.status !== undefined && body.status !== null && body.status !== "") {
    const stErr = ensureEnum(body.status, ["Lead", "Prospect", "Customer", "Churned", "Junk"], { field: "status" });
    if (stErr) return stErr;
  }
  // #600 — wellness extras. Optional in both verticals (the Lead form gates
  // them by tenant.vertical; this validator stays vertical-agnostic so a
  // generic CRM contact can still receive a treatmentOfInterest from a
  // future tooling integration without surprising 400s). Length-cap mirrors
  // the existing 191-char Contact column convention.
  if (body.treatmentOfInterest !== undefined && body.treatmentOfInterest !== null && body.treatmentOfInterest !== "") {
    const tErr = ensureStringLength(body.treatmentOfInterest, { max: 191, field: "treatmentOfInterest" });
    if (tErr) return tErr;
  }
  for (const idField of ["preferredLocationId", "preferredPractitionerId"]) {
    if (body[idField] !== undefined && body[idField] !== null && body[idField] !== "") {
      const v = Number(body[idField]);
      if (!Number.isInteger(v) || v <= 0) {
        return { status: 400, error: `${idField} must be a positive integer`, code: "INVALID_ID" };
      }
    }
  }
  // PRD Gap §1.1c — GST validation. Optional + 15-char India GSTIN format
  // gate. Invalid input returns 400 INVALID_GST instead of falling through
  // to a Prisma column-overflow 500 (gst column has no max-length cap, so
  // the validator IS the only gate against bogus input).
  if (body.gst !== undefined && body.gst !== null && body.gst !== "") {
    const gstErr = ensureGst(body.gst);
    if (gstErr) return gstErr;
  }
  // PRD_TRAVEL_GST_COMPLIANCE FR-3.5.2 (G034) + slice-3 stateCode shape —
  // ISO-3166-2-style state codes, max 10 chars. Both columns share the
  // same format pattern (e.g. "IN-MH"). We don't enforce the IN- prefix
  // here (format-agnostic per gstStateCodeResolver.js docs) — the
  // resolver returns whatever the DB stores. Length-cap is the only
  // gate against Prisma column-overflow.
  for (const sc of ["stateCode", "billingStateCode"]) {
    if (body[sc] !== undefined && body[sc] !== null && body[sc] !== "") {
      const scErr = ensureStringLength(body[sc], { max: 10, field: sc });
      if (scErr) return scErr;
    }
  }
  // PRD Gap §1.1a / §1.1d — anniversary + birthDate. Both optional, both
  // validated as bounded dates (≥1900, ≤+1y from now). The +1y upper
  // bound on anniversary catches "anniversary in 2099" data-entry typos
  // while still allowing a near-future "next anniversary" scheduling
  // pattern. birthDate uses the same bounds as Patient.dob (no future
  // dates allowed) via ensureDob.
  if (body.birthDate !== undefined && body.birthDate !== null && body.birthDate !== "") {
    const bdErr = ensureDateInRange(body.birthDate, {
      minYear: 1900,
      maxYear: new Date().getUTCFullYear(),
      field: "birthDate",
      code: "INVALID_BIRTHDATE",
    });
    if (bdErr) return bdErr;
    const d = new Date(body.birthDate);
    if (d.getTime() > Date.now()) {
      return { status: 400, error: "birthDate cannot be in the future", code: "INVALID_BIRTHDATE" };
    }
  }
  if (body.anniversary !== undefined && body.anniversary !== null && body.anniversary !== "") {
    const annErr = ensureDateInRange(body.anniversary, {
      minYear: 1900,
      maxYear: new Date().getUTCFullYear() + 1,
      field: "anniversary",
      code: "INVALID_ANNIVERSARY",
    });
    if (annErr) return annErr;
  }
  return null;
}

// PRD Gap §1.1e — walletBalance is a read-only computed surface. We strip
// it from any incoming body BEFORE Prisma write so a caller can't poison
// the denorm column out of band. Wave 11 FF Wallet remains the source of
// truth; the column on Contact stays null at rest until a future
// Wallet-on-Contact relation lands and a denorm hook is added.
function stripWalletBalanceWrite(body) {
  if (body && typeof body === "object" && "walletBalance" in body) {
    const { walletBalance: _drop, ...rest } = body;
    return rest;
  }
  return body;
}

// PRD Gap §1.1e — surface a computed walletBalance for a single Contact
// when the contact has a linked Patient with a wallet. Best-effort: any
// Prisma error here MUST NOT break the GET (the wallet is a wellness-only
// surface; generic-tenant rows simply return null).
async function attachComputedWalletBalance(contact, tenantId) {
  if (!contact || typeof contact !== "object") return contact;
  try {
    // Find a Patient row linked to this contact (Patient.contactId == Contact.id).
    const patient = await prisma.patient.findFirst({
      where: { tenantId, contactId: contact.id, deletedAt: null },
      select: { id: true },
    });
    if (!patient) {
      return { ...contact, walletBalance: null };
    }
    const wallet = await prisma.wallet.findFirst({
      where: { tenantId, patientId: patient.id },
      select: { balance: true },
    });
    return { ...contact, walletBalance: wallet ? wallet.balance : 0 };
  } catch (_e) {
    // Defensive: a stale Prisma client (no Wallet model yet) or tenant
    // without the wellness vertical schema simply yields null. Do NOT
    // surface a 500 — Wallet is optional for generic-CRM contacts.
    return { ...contact, walletBalance: null };
  }
}

// TRAVEL-ONLY contact-timeline enrichment.
//
// Per PRD_TRAVEL_QUOTE_BUILDER FR-3.7.1 the contact timeline is a UNIFIED
// customer feed (it even attaches sent-quote PDFs), and FR-3.1.1 makes the
// pipeline `Deal` FK OPTIONAL — so a travel customer whose relationship is
// bookings + invoices but no Deal gets an EMPTY timeline when it's fed by Deal
// activities alone (the reported bug). We merge synthetic timeline entries for
// the contact's Itineraries (bookings) + TravelInvoices into `activities` at
// READ time, so existing records surface immediately with no data backfill.
// Deals stay (the PRD keeps them — FR-3.7.4 quote-accept → Deal "Booked"/"Won");
// this only ADDS the travel entities. No-op for generic/wellness tenants.
// Best-effort: any failure returns the contact unchanged — never breaks the GET.
async function attachTravelRelationshipTimeline(contact, tenantId) {
  if (!contact || typeof contact !== "object" || !contact.id) return contact;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    });
    if (!tenant || tenant.vertical !== "travel") return contact;

    const [itineraries, invoices] = await Promise.all([
      prisma.itinerary
        .findMany({
          where: { tenantId, contactId: contact.id },
          select: { id: true, destination: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 100,
        })
        .catch(() => []),
      prisma.travelInvoice
        .findMany({
          where: { tenantId, contactId: contact.id },
          select: { id: true, invoiceNum: true, totalAmount: true, currency: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 100,
        })
        .catch(() => []),
    ]);

    const synthetic = [];
    for (const it of itineraries) {
      synthetic.push({
        id: `itin-${it.id}`,
        type: "Booking",
        description: `Booking: ${it.destination || "trip"}${it.status ? ` — ${it.status}` : ""}`,
        createdAt: it.createdAt,
      });
    }
    for (const inv of invoices) {
      const amt = inv.totalAmount != null
        ? `${inv.currency || "INR"} ${Number(inv.totalAmount).toLocaleString("en-IN")}`
        : null;
      synthetic.push({
        id: `inv-${inv.id}`,
        type: "Invoice",
        description: `Invoice ${inv.invoiceNum}${amt ? ` — ${amt}` : ""}${inv.status ? ` (${inv.status})` : ""}`,
        createdAt: inv.createdAt,
      });
    }
    if (synthetic.length === 0) return contact;

    const existing = Array.isArray(contact.activities) ? contact.activities : [];
    const merged = [...existing, ...synthetic].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return { ...contact, activities: merged };
  } catch (_e) {
    return contact; // best-effort — the timeline merge must never break the GET
  }
}


// Protect all contact routes
router.use(verifyToken);
router.get("/by-status", audienceController.getContactsByStatus)


router.get('/', async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.assignedToId) where.assignedToId = parseInt(req.query.assignedToId);
    if (req.query.unassigned === 'true') where.assignedToId = null;
    // Arc 2 #904 slice 8 — ?source=<prefix> server-side filter. Replaces the
    // STUB client-side `source.startsWith('inbound:')` filter in
    // InboundLeads.jsx (slice 7, 56f549f7) which was bounded by the
    // ?limit=100 page-size + scanned the entire result. Server-side prefix
    // match pushes the predicate into Prisma so the 500-row hard cap (#172)
    // is no longer a coverage hole. Absent param = unfiltered (existing
    // behaviour preserved).
    if (req.query.source !== undefined) {
      const prefix = typeof req.query.source === 'string' ? req.query.source : '';
      if (prefix.length < 1 || prefix.length > 128) {
        return res.status(400).json({
          error: 'source must be a non-empty string ≤128 chars',
          code: 'INVALID_SOURCE',
          field: 'source',
        });
      }
      where.source = { startsWith: prefix };
    }
    // #167: hide soft-deleted rows by default; admin views can opt in.
    applyDeletedAtFilter(where, req.query.includeDeleted === 'true');
    // #588: USER role sees only contacts assigned to them; ADMIN/MANAGER see
    // full tenant. Mirrors the deals-list scoping. An explicit ?assignedToId
    // from a USER is overridden by their own userId — a sales rep cannot
    // probe a colleague's book of business by URL. Total Contacts KPI on
    // /dashboard now reflects own-book size for sales reps.
    if (req.user.role === 'USER') where.assignedToId = req.user.userId;
    // ?count=1 — sidebar badge polls: return { total } only, skip full fetch.
    if (req.query.count === '1') {
      const total = await prisma.contact.count({ where });
      return res.json({ total });
    }
    // #172: honor limit / offset query params with sensible defaults + a hard cap.
    // Pre-fix the API silently returned the entire dataset, breaking pagination
    // and exposing a perf/DoS surface.
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    // #920 slice 1 — PII reduction via opt-in slim shape. When the caller
    // passes ?fields=summary, the response drops the heavy nested includes
    // (activities/tasks/assignedTo) AND the sensitive flat fields
    // (phone/walletBalance/gst/birthDate/anniversary/address) by switching
    // to an explicit Prisma `select`. ADDITIVE — when ?fields is absent
    // or any other value, the existing full-shape `include` is preserved
    // so no existing consumer (Contacts page, Billing.jsx, CommandPalette,
    // etc.) needs to change. filterReadFields() still applies on the slim
    // shape (no-op for fields not present, full-effect for fields it
    // recognises) so the #464 field-permission layer keeps composing.
    const isSummary = req.query.fields === 'summary';
    const findManyArgs = {
      where, take: limit, skip: offset,
      orderBy: { id: 'desc' },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        name: true,
        email: true,
        status: true,
        assignedToId: true,
        tenantId: true,
        createdAt: true,
      };
    } else {
      findManyArgs.include = { activities: true, tasks: true, assignedTo: { select: { id: true, name: true, email: true } } };
    }
    const contacts = await prisma.contact.findMany(findManyArgs);
    // #464: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields(contacts, req.user.role, "Contact", req.user.tenantId);
    res.json(filtered);
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact ID' });
    const includeDeleted = req.query.includeDeleted === 'true';
    const contact = await prisma.contact.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { activities: { orderBy: { createdAt: 'desc' } }, tasks: true, deals: true, assignedTo: { select: { id: true, name: true, email: true } } }
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    // #167: 404 soft-deleted rows unless caller opts in.
    if (contact.deletedAt && !includeDeleted) return res.status(404).json({ error: 'Contact not found' });
    // #464: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields(contact, req.user.role, "Contact", req.user.tenantId);
    // PRD Gap §1.1e — surface computed walletBalance from the linked Patient's
    // Wallet (if any). Best-effort; falls back to null on any error.
    const withWallet = await attachComputedWalletBalance(filtered, req.user.tenantId);
    // Travel-only: merge the contact's bookings (Itineraries) + invoices into
    // the activity timeline so booking-only customers aren't shown empty.
    const withTimeline = await attachTravelRelationshipTimeline(withWallet, req.user.tenantId);
    res.json(withTimeline);
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

router.post('/', async (req, res) => {
  try {
    // #464: strip write-restricted fields BEFORE validation so a USER who has
    // canWrite=false on Contact.email can't push a value through. Validation
    // then runs on the filtered body — if email was stripped, the !isUpdate
    // path will surface EMAIL_REQUIRED instead of silently storing the
    // forbidden value.
    req.body = await filterWriteFields(req.body, req.user.role, "Contact", req.user.tenantId);
    // PRD Gap §1.1e — strip walletBalance from writes (read-only computed surface).
    req.body = stripWalletBalanceWrite(req.body);
    // #160 #166: validate before hitting Prisma so bad inputs return 400 with a
    // clear code instead of a 500 from the DB layer.
    const inputErr = validateContactInput(req.body, { isUpdate: false });
    if (inputErr) return res.status(inputErr.status).json(inputErr);
    // #337: persist the trimmed name so we don't leak the user's accidental
    // leading/trailing whitespace into search indexes, exports, etc. The
    // validator already verified there's at least one non-whitespace char.
    const normalised = { ...req.body, name: typeof req.body.name === "string" ? req.body.name.trim() : req.body.name };
    // PRD Gap §1.1a/§1.1d — date fields come in as ISO strings; Prisma
    // rejects strings on DateTime columns with PrismaClientValidationError.
    // Coerce to Date objects after validation.
    if (typeof normalised.anniversary === "string" && normalised.anniversary !== "") {
      normalised.anniversary = new Date(normalised.anniversary);
    }
    if (typeof normalised.birthDate === "string" && normalised.birthDate !== "") {
      normalised.birthDate = new Date(normalised.birthDate);
    }
    // #588: default assignedToId to the creator so USER-role list scoping
    // (which filters by assignedToId = req.user.userId) actually surfaces
    // the contact they just created. Mirrors POST /api/deals which sets
    // ownerId = req.user.userId. Explicit body.assignedToId still wins.
    if (normalised.assignedToId == null) normalised.assignedToId = req.user.userId;

    // PRD §4.5 — Phase 2 dedup preflight. Before letting Prisma's
    // @@unique([email, tenantId]) throw a P2002, run the richer
    // findDuplicateContactFull helper so the route can surface a
    // friendly 409 DUPLICATE_CONTACT with `{ existingContactId,
    // matchedBy, contact: {...projection} }` — frontend renders this
    // as the "merge or keep both" pop-up (same shape as the RFU
    // passport-collision modal). Phone match is fuzzy (normalised),
    // so this catches "+91 98765 43210" vs "919876543210" duplicates
    // that the bare email-only unique constraint misses entirely.
    //
    // Bypass with ?force=true for the rare legitimate "yes, I know
    // there's a similar contact, create anyway" case (CSV bulk import
    // already has its own merge flow). The P2002 catch in the outer
    // try block stays as defense-in-depth against the race window
    // between preflight and create.
    const force = req.query.force === "true" || req.query.force === "1";
    if (!force) {
      try {
        const dup = await findDuplicateContactFull({
          email: normalised.email || null,
          phone: normalised.phone || null,
          tenantId: req.user.tenantId,
        });
        if (dup) {
          const c = dup.contact;
          return res.status(409).json({
            error: "A contact with this email or phone already exists in your CRM",
            code: "DUPLICATE_CONTACT",
            matchedBy: dup.matchedBy,
            existingContactId: c.id,
            contact: {
              id: c.id,
              name: c.name,
              email: c.email,
              phone: c.phone,
              company: c.company,
              status: c.status,
              subBrand: c.subBrand,
            },
          });
        }
      } catch (e) {
        // Helper failure is non-fatal — log + fall through to the
        // normal create path so a transient dedup outage doesn't block
        // contact creation. P2002 still catches genuine email collisions.
        console.error("[contacts] dedup preflight error:", e.message);
      }
    }

    const contact = await prisma.contact.create({ data: { ...normalised, tenantId: req.user.tenantId } });
    try { const { emitEvent } = require('../lib/eventBus'); await emitEvent('contact.created', { contactId: contact.id, name: contact.name, email: contact.email, userId: req.user.userId }, req.user.tenantId, req.io); } catch (_e) { /* event bus optional */ }
    // [GP-CRM integration] Fire lead.new to registered webhooks (e.g. GlobusPhone)
    // when a Lead contact is created. Carries the id/name/phone/email shape the
    // partner expects (the emitEvent above uses a workflow-rule payload keyed on
    // contactId). Fire-and-forget — a webhook failure must never block the 201.
    if (contact.status === "Lead") {
      try {
        const { deliverWebhooks } = require('../lib/webhookDelivery');
        await deliverWebhooks("lead.new", {
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          status: contact.status,
          assignedToId: contact.assignedToId,
          tenantId: req.user.tenantId,
        }, req.user.tenantId);
      } catch (_e) { /* webhook delivery is fire-and-forget */ }
    }
    // #179: audit row for new contact.
    await writeAudit('Contact', 'CREATE', contact.id, req.user.userId, req.user.tenantId, { name: contact.name, email: contact.email });
    res.status(201).json(contact);
  } catch (err) {
    // #178: duplicate email should be 409 Conflict, not 500.
    // #165: validation-class Prisma errors (string-too-long, FK miss, …) are
    //       4xx, not 5xx. Only genuine surprises fall through to 500.
    const mapped = httpFromPrismaError(err);
    if (mapped) return res.status(mapped.status).json(mapped);
    console.error('[contacts] create error:', err && err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// Bulk assign agent to multiple contacts (must be before /:id routes)
router.put('/bulk-assign', async (req, res) => {
  try {
    const { contactIds, assignedToId } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'No contact IDs provided' });
    }
    const ids = contactIds.map(id => parseInt(id));
    let assignableIds = ids;
    let skipped = 0;
    // Travel security guard — when assigning to a person, drop any brand-tagged
    // lead the assignee can't access (rather than failing the whole batch).
    // Generic/wellness leads have subBrand null → always assignable → unchanged.
    if (assignedToId) {
      const rows = await prisma.contact.findMany({
        where: { id: { in: ids }, tenantId: req.user.tenantId },
        select: { id: true, subBrand: true },
      });
      const { getSubBrandAccessSet, canAccessSubBrand } = require('../middleware/travelGuards');
      const allowed = await getSubBrandAccessSet(parseInt(assignedToId));
      const ok = rows.filter(r => !r.subBrand || canAccessSubBrand(allowed, r.subBrand)).map(r => r.id);
      skipped = ids.length - ok.length;
      assignableIds = ok;
    }
    await prisma.contact.updateMany({
      where: { id: { in: assignableIds }, tenantId: req.user.tenantId },
      data: { assignedToId: assignedToId ? parseInt(assignedToId) : null }
    });
    res.json({ updated: assignableIds.length, skipped, assignedToId: assignedToId || null });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to bulk assign agent' });
  }
});

router.post('/:id/activities', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const { type, description } = req.body;
    const activity = await prisma.activity.create({
      data: { type, description, contactId: contact.id, userId: req.user ? req.user.userId : null, tenantId: req.user.tenantId }
    });
    // PRD §6.4: lead-side SLA — first activity logged against a Lead stamps
    // firstResponseAt, stopping the SLA clock. Best-effort: any failure
    // here MUST NOT break the activity write.
    try { await markFirstResponseIfNeeded({ contactId: contact.id }); } catch (_e) { /* ignore */ }
    res.status(201).json(activity);
  } catch (_err) {
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    // #464: strip write-restricted fields per the caller's role BEFORE
    // validation so blocked-field updates can't slip through.
    req.body = await filterWriteFields(req.body, req.user.role, "Contact", req.user.tenantId);
    // PRD Gap §1.1e — strip walletBalance from writes (read-only computed surface).
    req.body = stripWalletBalanceWrite(req.body);
    // #168: same input checks as create so PUT can't bypass POST validation.
    const inputErr = validateContactInput(req.body, { isUpdate: true });
    if (inputErr) return res.status(inputErr.status).json(inputErr);
    // PRD Gap §1.1a/§1.1d — coerce date strings to Date objects (mirrors POST handler).
    const updateData = { ...req.body };
    if (typeof updateData.anniversary === "string" && updateData.anniversary !== "") {
      updateData.anniversary = new Date(updateData.anniversary);
    }
    if (typeof updateData.birthDate === "string" && updateData.birthDate !== "") {
      updateData.birthDate = new Date(updateData.birthDate);
    }
    const contact = await prisma.contact.update({ where: { id: existing.id }, data: updateData });

    // #179: audit only the keys that actually changed (skip unchanged + DB internals).
    const changes = diffFields(existing, contact, Object.keys(req.body || {}));
    if (Object.keys(changes).length > 0) {
      await writeAudit('Contact', 'UPDATE', contact.id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }

    // gap #17: emit contact.updated for workflow rules. Always-safe fields exposed
    // for rule conditions. Failure here must NEVER fail the update.
    try {
      require("../lib/eventBus").emitEvent(
        "contact.updated",
        {
          contactId: contact.id,
          changedFields: Object.keys(req.body || {}),
          status: contact.status,
          assignedToId: contact.assignedToId,
          tenantId: req.user.tenantId,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) {}

    // [GP-CRM integration] Push a partner-shaped contact.updated (and, when the
    // status changed, lead.stage_changed) to registered webhooks. The emitEvent
    // above carries a workflow-rule payload keyed on contactId; GlobusPhone needs
    // id/name/phone/email, so we deliver a second, partner-shaped event here.
    // Both are fire-and-forget — a delivery failure must never block the update.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("contact.updated", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        status: contact.status,
        assignedToId: contact.assignedToId,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
      if (existing.status !== contact.status) {
        await deliverWebhooks("lead.stage_changed", {
          id: contact.id,
          status: contact.status,
          previousStatus: existing.status,
          assignedToId: contact.assignedToId,
          tenantId: req.user.tenantId,
        }, req.user.tenantId);
      }
    } catch (_e) { /* webhook delivery is fire-and-forget */ }

    // gap #17: lead.converted — fires when a Contact's status flips from "Lead"
    // to "Customer" or "Prospect". Separate trigger from contact.updated so a
    // rule author can subscribe specifically to conversion events.
    try {
      if (
        existing.status === "Lead" &&
        (contact.status === "Customer" || contact.status === "Prospect") &&
        existing.status !== contact.status
      ) {
        require("../lib/eventBus").emitEvent(
          "lead.converted",
          {
            contactId: contact.id,
            fromStatus: existing.status,
            toStatus: contact.status,
            assignedToId: contact.assignedToId,
          },
          req.user.tenantId,
          req.io
        );
      }
    } catch (_e) {}

    // Bug #283 [wellness]: when a contact transitions into Customer on a
    // wellness tenant, the downstream wellness app needs a Patient row to
    // hang visits / Rx / consents off. Without this row the customer is a
    // dead-end in the wellness UI. Idempotent: dedupe on contactId, then on
    // phone (normalized last-10-digit match) so we never double-create.
    // Best-effort: any failure here MUST NOT fail the contact update itself.
    try {
      if (
        existing.status !== "Customer" &&
        contact.status === "Customer"
      ) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { vertical: true },
        });
        if (tenant && tenant.vertical === "wellness") {
          let patient = await prisma.patient.findFirst({
            where: { tenantId: req.user.tenantId, contactId: contact.id },
          });
          if (!patient && contact.phone) {
            const last10 = String(contact.phone).replace(/\D/g, "").slice(-10);
            if (last10.length === 10) {
              patient = await prisma.patient.findFirst({
                where: { tenantId: req.user.tenantId, phone: { contains: last10 } },
              });
              // Backfill the contactId link if we matched by phone but the
              // Patient was never linked to this CRM Contact.
              if (patient && !patient.contactId) {
                await prisma.patient.update({
                  where: { id: patient.id },
                  data: { contactId: contact.id },
                });
              }
            }
          }
          if (!patient) {
            const normalizedPhone = contact.phone
              ? (normalizePhone(contact.phone) || contact.phone)
              : null;
            const created = await prisma.patient.create({
              data: {
                name: contact.name || contact.email || "Unnamed patient",
                email: contact.email || null,
                phone: normalizedPhone,
                source: contact.source || "lead-conversion",
                contactId: contact.id,
                tenantId: req.user.tenantId,
              },
            });
            await writeAudit(
              "Patient",
              "CREATE",
              created.id,
              req.user.userId,
              req.user.tenantId,
              { from: "lead-conversion", contactId: contact.id }
            );
          }
        }
      }
    } catch (e) {
      // Patient backfill is non-blocking; log and continue.
      console.error("[contacts PUT] wellness Patient backfill failed:", e && e.message);
    }

    res.json(contact);
  } catch (err) {
    // #168 #165: PUT used to leak 500s on bad email / out-of-range values
    // because the Prisma validation error fell through unhandled. Map the
    // full validation-class set to 400 + INVALID_INPUT so the UI shows the
    // real reason instead of "Failed to update contact".
    const mapped = httpFromPrismaError(err);
    if (mapped) return res.status(mapped.status).json(mapped);
    console.error('[contacts] update error:', err && err.message);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// CSV Import — accepts pre-parsed rows
// #154: validation hardening
//   - reject rows with missing/invalid email
//   - reject rows whose status is not in the allowed set
//   - sanitize CSV-injection prefixes (=, +, -, @) on name/company so the row
//     can't execute as a formula if the data is later re-exported and opened in Excel
//   - cap max rows at 5000 to prevent DoS via huge uploads
const ALLOWED_STATUSES = new Set(["Lead", "Prospect", "Customer", "Churned", "Junk"]);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;
const MAX_IMPORT_ROWS = 5000;

function sanitizeCellForExport(v) {
  if (typeof v !== "string" || v.length === 0) return v;
  // Prefix with single quote so spreadsheet apps treat it as text. Doing this
  // on import (rather than only on export) means stored data is also safe if
  // exported via any other path.
  return FORMULA_INJECTION_RE.test(v) ? `'${v}` : v;
}

router.post('/import-csv', async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' });
    }
    if (contacts.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS} per import.`, code: "TOO_MANY_ROWS" });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < contacts.length; i++) {
      const row = contacts[i];
      const rowNum = i + 1; // human-friendly (1-based, matches CSV preview)
      try {
        const email = String(row.email || "").trim();
        if (!email) {
          errors.push(`Row ${rowNum}: missing email`);
          continue;
        }
        if (!EMAIL_RE.test(email)) {
          errors.push(`Row ${rowNum}: invalid email (${email})`);
          continue;
        }
        const status = String(row.status || "Lead").trim();
        if (!ALLOWED_STATUSES.has(status)) {
          errors.push(`Row ${rowNum}: invalid status "${status}" (allowed: ${[...ALLOWED_STATUSES].join(", ")})`);
          continue;
        }

        // email is globally unique, so any tenant collision skips
        const existing = await prisma.contact.findFirst({ where: { email } });
        if (existing) {
          skipped++;
          continue;
        }
        await prisma.contact.create({
          data: {
            name: sanitizeCellForExport(String(row.name || "").trim()),
            email,
            company: sanitizeCellForExport(String(row.company || "").trim()),
            title: String(row.title || "").trim(),
            status,
            tenantId: req.user.tenantId,
          }
        });
        imported++;
      } catch (rowErr) {
        errors.push(`Row ${rowNum} (${row.email || "no email"}): ${rowErr.message}`);
      }
    }

    // #179: audit the bulk import. entityId is null because this affects many rows.
    await writeAudit('Contact', 'CSV_IMPORT', null, req.user.userId, req.user.tenantId, {
      rowCount: contacts.length,
      imported,
      skipped,
      errorCount: errors.length,
      source: 'csv',
    });
    res.json({ imported, skipped, errors });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

// Assign agent to a contact
router.put('/:id/assign', async (req, res) => {
  try {
    const { assignedToId } = req.body;
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    // Travel security guard — a brand-tagged lead can only be assigned to staff
    // who have access to that sub-brand. Contacts with no subBrand (generic /
    // wellness) skip this entirely, so their behaviour is unchanged.
    if (existing.subBrand && assignedToId) {
      const { getSubBrandAccessSet, canAccessSubBrand } = require('../middleware/travelGuards');
      const allowed = await getSubBrandAccessSet(parseInt(assignedToId));
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "That staff member doesn't have access to this lead's sub-brand", code: 'SUB_BRAND_ASSIGN_DENIED' });
      }
    }
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { assignedToId: assignedToId ? parseInt(assignedToId) : null },
      include: { assignedTo: { select: { id: true, name: true, email: true } } }
    });
    // [GP-CRM integration] Notify registered webhooks (e.g. GlobusPhone) that
    // this contact/lead was re-assigned to a different agent. Fire-and-forget.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("lead.assigned", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        status: contact.status,
        assignedToId: contact.assignedToId,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
    } catch (_e) { /* webhook delivery is fire-and-forget */ }
    res.json(contact);
  } catch (_err) {
    res.status(500).json({ error: 'Failed to assign agent' });
  }
});

// ── Find duplicate contacts ───────────────────────────────────────
// #592 — Detector now (a) skips soft-deleted contacts (deletedAt!=null) so a
// merged-secondary doesn't keep showing up, and (b) filters out groups whose
// stable group-key matches a row in DismissedDuplicateGroup so dismissed
// pairs stop resurfacing on every refresh. Group key derivation is sorted
// id-list → SHA-256 (see backend/utils/deduplication.js#computeDuplicateGroupKey).
router.get('/duplicates/find', async (req, res) => {
  try {
    const contacts = await prisma.contact.findMany({
      where: { tenantId: req.user.tenantId, deletedAt: null },
      select: { id: true, name: true, email: true, phone: true, company: true, status: true, aiScore: true, createdAt: true }
    });
    const dupes = [];
    const seen = new Map();

    for (const c of contacts) {
      // Match by email domain + name similarity, or exact phone
      const key = c.email.toLowerCase();
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (!dupes.find(d => d.primary.id === existing.id)) {
          dupes.push({ primary: existing, duplicates: [c], reason: 'Same email' });
        } else {
          dupes.find(d => d.primary.id === existing.id).duplicates.push(c);
        }
      } else {
        seen.set(key, c);
      }

      // Phone match
      if (c.phone) {
        const phoneKey = c.phone.replace(/[^0-9]/g, '').slice(-10);
        if (phoneKey.length >= 10) {
          for (const [, other] of seen) {
            if (other.id !== c.id && other.phone) {
              const otherPhone = other.phone.replace(/[^0-9]/g, '').slice(-10);
              if (phoneKey === otherPhone && !dupes.find(d => (d.primary.id === other.id && d.duplicates.some(dd => dd.id === c.id)))) {
                const existing = dupes.find(d => d.primary.id === other.id);
                if (existing) { existing.duplicates.push(c); }
                else { dupes.push({ primary: other, duplicates: [c], reason: 'Same phone' }); }
              }
            }
          }
        }
      }

      // Name + Company match
      if (c.name && c.company) {
        const nameCompanyKey = `${c.name.toLowerCase().trim()}|${c.company.toLowerCase().trim()}`;
        for (const [, other] of seen) {
          if (other.id !== c.id && other.name && other.company) {
            const otherKey = `${other.name.toLowerCase().trim()}|${other.company.toLowerCase().trim()}`;
            if (nameCompanyKey === otherKey && !dupes.find(d => (d.primary.id === other.id && d.duplicates.some(dd => dd.id === c.id)))) {
              const existing = dupes.find(d => d.primary.id === other.id);
              if (existing) { existing.duplicates.push(c); }
              else { dupes.push({ primary: other, duplicates: [c], reason: 'Same name + company' }); }
            }
          }
        }
      }
    }

    // Stamp every group with its stable groupKey so the UI can reference it
    // when dismissing. Filter out any group the operator has already
    // dismissed for this tenant.
    let dismissedKeys = new Set();
    try {
      const rows = await prisma.dismissedDuplicateGroup.findMany({
        where: { tenantId: req.user.tenantId },
        select: { groupKey: true }
      });
      dismissedKeys = new Set(rows.map(r => r.groupKey));
    } catch (_e) {
      // Table may not exist yet on a stale Prisma client; degrade to "no
      // groups dismissed" so the detector still works.
    }

    const annotated = dupes
      .map(g => ({ ...g, groupKey: computeDuplicateGroupKey(g.primary.id, g.duplicates.map(d => d.id)) }))
      .filter(g => g.groupKey && !dismissedKeys.has(g.groupKey));

    res.json(annotated);
  } catch (err) {
    console.error('[Contacts] Duplicate find error:', err);
    res.status(500).json({ error: 'Failed to find duplicates' });
  }
});

// #592 — Merge contacts (transactional, soft-delete, full FK fold).
//
//   Body: { primaryId: number, secondaryIds: number[] }
//
// Reassigns every contactId-bearing FK from each secondary onto the primary,
// then soft-deletes the secondary (deletedAt = now()). Soft-delete preserves
// audit trail + restore path; the existing GET /:id 404s soft-deleted rows
// unless ?includeDeleted=true is passed.
//
// FK relations folded onto the primary (every model with a contactId column
// in schema.prisma — sweep verified 2026-05-08):
//   Activity, Deal, EmailMessage, CallLog, Task, Invoice, Expense, Contract,
//   Estimate, SmsMessage, WhatsAppMessage, Touchpoint, Project,
//   ContactAttachment, MarketplaceLead, ChatbotConversation, Booking,
//   SurveyResponse, ScheduledEmail, SocialMention, CalendarEvent,
//   VoiceSession, WebVisitor, EmailTracking, PushSubscription, Patient
//   (wellness link), DataExportRequest.
//
// SequenceEnrollment + ConsentRecord are intentionally NOT reassigned:
//   - SequenceEnrollment is per-contact step state; folding two enrollments
//     onto one contact violates the @@unique([sequenceId, contactId])
//     constraint and "you sent the welcome sequence to this person twice"
//     is the wrong fold semantics anyway. We delete the secondary's
//     enrollments instead.
//   - ConsentRecord is a legal artefact attesting that a *specific row* gave
//     consent. Reassigning would falsify the record.
//
// Audit: writeAudit('Contact', 'MERGE', primaryId, ...) + a Note activity on
// the primary documenting each fold.
//
// Wrapped in prisma.$transaction so a partial failure rolls back cleanly.
router.post('/merge', async (req, res) => {
  try {
    const { primaryId, secondaryIds } = req.body;
    if (!primaryId || !Array.isArray(secondaryIds) || secondaryIds.length === 0) {
      return res.status(400).json({ error: 'primaryId and secondaryIds required' });
    }
    const tenantId = req.user.tenantId;
    const userId = req.user?.userId || null;
    const pid = parseInt(primaryId);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: 'Invalid primaryId' });

    const primary = await prisma.contact.findFirst({ where: { id: pid, tenantId, deletedAt: null } });
    if (!primary) return res.status(404).json({ error: 'Primary contact not found' });

    // Resolve every secondary up-front + tenant-scope guard. A secondary that
    // belongs to another tenant or that is already soft-deleted is skipped
    // (not error) — keeps the operation idempotent on retry.
    const sids = secondaryIds.map(Number).filter((n) => Number.isFinite(n) && n !== pid);
    const secondaries = await prisma.contact.findMany({
      where: { id: { in: sids }, tenantId, deletedAt: null },
      select: { id: true, name: true, email: true, phone: true, company: true, title: true, aiScore: true }
    });
    if (secondaries.length === 0) return res.status(404).json({ error: 'No mergeable secondaries' });

    const folded = {};
    const validSecIds = secondaries.map(s => s.id);

    await prisma.$transaction(async (tx) => {
      // Reassign FKs in bulk across all secondaries at once. updateMany returns
      // {count} per call which we accumulate per relation for the audit row.
      const reassign = async (model, label) => {
        try {
          const r = await tx[model].updateMany({
            where: { contactId: { in: validSecIds } },
            data: { contactId: primary.id }
          });
          folded[label] = (folded[label] || 0) + r.count;
        } catch (_e) {
          // Some relations (e.g. wellness Patient on a generic-vertical
          // tenant) may not have any rows; an updateMany on a non-existent
          // contactId column would throw at the Prisma level, but every
          // model in this list does declare contactId in schema.prisma.
        }
      };
      await reassign('activity', 'activities');
      await reassign('deal', 'deals');
      await reassign('emailMessage', 'emails');
      await reassign('callLog', 'callLogs');
      await reassign('task', 'tasks');
      await reassign('invoice', 'invoices');
      await reassign('expense', 'expenses');
      await reassign('contract', 'contracts');
      await reassign('estimate', 'estimates');
      await reassign('smsMessage', 'smsMessages');
      await reassign('whatsAppMessage', 'whatsappMessages');
      await reassign('touchpoint', 'touchpoints');
      await reassign('project', 'projects');
      await reassign('contactAttachment', 'attachments');
      await reassign('marketplaceLead', 'marketplaceLeads');
      await reassign('chatbotConversation', 'chatbotConversations');
      await reassign('booking', 'bookings');
      await reassign('surveyResponse', 'surveyResponses');
      await reassign('scheduledEmail', 'scheduledEmails');
      await reassign('socialMention', 'socialMentions');
      await reassign('calendarEvent', 'calendarEvents');
      await reassign('voiceSession', 'voiceSessions');
      await reassign('webVisitor', 'webVisitors');
      await reassign('emailTracking', 'emailTrackings');
      await reassign('pushSubscription', 'pushSubscriptions');
      await reassign('patient', 'patients');
      await reassign('dataExportRequest', 'dataExportRequests');

      // Drop the secondaries' SequenceEnrollment rows (folding would violate
      // the per-contact-per-sequence unique constraint). ConsentRecord is
      // left alone — re-pointing it would falsify the legal artefact.
      await tx.sequenceEnrollment.deleteMany({ where: { contactId: { in: validSecIds } } });

      // Backfill missing fields on primary from the most-complete secondary.
      // Take the first non-null per field (deterministic by id order).
      const updates = {};
      for (const sec of secondaries) {
        if (!primary.phone && !updates.phone && sec.phone) updates.phone = sec.phone;
        if (!primary.company && !updates.company && sec.company) updates.company = sec.company;
        if (!primary.title && !updates.title && sec.title) updates.title = sec.title;
        if ((sec.aiScore || 0) > (primary.aiScore || 0)) updates.aiScore = sec.aiScore;
      }
      if (Object.keys(updates).length > 0) {
        await tx.contact.update({ where: { id: primary.id }, data: updates });
      }

      // Document each fold as a Note activity on the primary (operator-visible
      // in the contact-detail timeline).
      for (const sec of secondaries) {
        await tx.activity.create({
          data: {
            type: 'Note',
            description: `Merged contact "${sec.name}" (${sec.email}) into this record`,
            contactId: primary.id,
            userId,
            tenantId,
          }
        });
      }

      // Soft-delete the secondaries. Contact.deletedAt exists (#167); this
      // preserves the audit trail and lets ADMIN restore via the existing
      // POST /:id/restore endpoint.
      await tx.contact.updateMany({
        where: { id: { in: validSecIds }, tenantId },
        data: { deletedAt: new Date() }
      });
    });

    // Audit row outside the transaction — writeAudit is best-effort and
    // already wrapped in its own try/catch (lib/audit.js).
    await writeAudit('Contact', 'MERGE', primary.id, userId, tenantId, {
      mergedIds: validSecIds,
      count: validSecIds.length,
      folded,
      strategy: 'soft-delete',
    });

    res.json({
      success: true,
      merged: validSecIds.length,
      primaryId: primary.id,
      mergedIds: validSecIds,
      folded,
      strategy: 'soft-delete',
    });
  } catch (err) {
    console.error('[Contacts] Merge error:', err);
    res.status(500).json({ error: 'Failed to merge contacts' });
  }
});

// #592 — Dismiss a duplicate group ("not actually duplicates").
//
//   Body: one of —
//     { groupKey: "<sha256-hex>" }                                 OR
//     { primaryId: number, secondaryIds: number[] }   (server derives the key)
//     { contactIds: number[] }                        (server derives the key)
//
// Idempotent: a re-dismiss of an already-dismissed group returns 200 with
// {idempotent: true}. Per-tenant scoped — every contact id is verified to
// belong to req.user.tenantId before we hash and persist the key (otherwise
// a caller could lock down another tenant's groups via guessed ids).
router.post('/duplicates/dismiss', async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user?.userId || null;
    let { groupKey, primaryId, secondaryIds, contactIds, reason } = req.body || {};

    let ids = [];
    if (Array.isArray(contactIds) && contactIds.length > 0) {
      ids = contactIds.map(Number).filter(Number.isFinite);
    } else if (primaryId && Array.isArray(secondaryIds)) {
      ids = [Number(primaryId), ...secondaryIds.map(Number)].filter(Number.isFinite);
    }

    // If the caller passed ids, derive + verify-tenant. If only groupKey was
    // passed we trust the caller (the key was minted by /duplicates/find,
    // which itself filters by tenant).
    if (ids.length > 0) {
      const found = await prisma.contact.findMany({
        where: { id: { in: ids }, tenantId },
        select: { id: true }
      });
      if (found.length !== ids.length) {
        return res.status(404).json({ error: 'One or more contacts not found in tenant' });
      }
      groupKey = computeDuplicateGroupKey(ids[0], ids.slice(1));
    }
    if (!groupKey || typeof groupKey !== 'string' || groupKey.length < 8) {
      return res.status(400).json({ error: 'groupKey or contactIds required' });
    }

    // Upsert keeps the first-dismissed-by/createdAt audit-true and makes the
    // operation idempotent on retry.
    const existing = await prisma.dismissedDuplicateGroup.findUnique({
      where: { tenantId_groupKey: { tenantId, groupKey } }
    });
    if (existing) {
      return res.json({ success: true, idempotent: true, groupKey, dismissedAt: existing.createdAt });
    }
    const row = await prisma.dismissedDuplicateGroup.create({
      data: {
        groupKey,
        contactIds: ids.length > 0 ? ids.slice().sort((a, b) => a - b).join(',') : '',
        reason: reason && typeof reason === 'string' ? reason.slice(0, 500) : null,
        dismissedBy: userId,
        tenantId,
      }
    });

    await writeAudit('Contact', 'DUPLICATE_DISMISS', null, userId, tenantId, { groupKey, contactIds: ids });

    res.json({ success: true, groupKey, dismissedAt: row.createdAt });
  } catch (err) {
    console.error('[Contacts] Duplicate dismiss error:', err);
    res.status(500).json({ error: 'Failed to dismiss duplicate group' });
  }
});

// ── Contact Attachments ───────────────────────────────────────────
router.get('/:id/attachments', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(await prisma.contactAttachment.findMany({ where: { contactId: contact.id, tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' } }));
  } catch (_err) { res.status(500).json({ error: 'Failed to fetch attachments' }); }
});

// #176: JSON-only contract — UI sends {filename, fileUrl}. Multipart isn't wired
// (no multer in this router) and is not supported here; document the contract
// rather than crash with a generic 500.
router.post('/:id/attachments', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    if (!Number.isFinite(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id', code: 'INVALID_ID', field: 'id' });
    }
    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Reject multipart up front — no multer wired here, so req.body would be empty.
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.startsWith('multipart/form-data')) {
      return res.status(400).json({
        error: 'Multipart upload not supported on this endpoint. POST application/json with {filename, fileUrl}.',
        code: 'UNSUPPORTED_CONTENT_TYPE',
        field: 'Content-Type'
      });
    }

    const body = req.body || {};
    const { filename, fileUrl, fileSize, mimeType } = body;

    if (!filename || typeof filename !== 'string' || !filename.trim()) {
      return res.status(400).json({ error: 'filename is required', code: 'MISSING_FILENAME', field: 'filename' });
    }
    if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.trim()) {
      return res.status(400).json({ error: 'fileUrl is required', code: 'MISSING_FILEURL', field: 'fileUrl' });
    }
    if (!/^https?:\/\//i.test(fileUrl.trim())) {
      return res.status(400).json({ error: 'fileUrl must be an http(s) URL', code: 'INVALID_FILEURL', field: 'fileUrl' });
    }

    const sizeNum = (fileSize === undefined || fileSize === null || fileSize === '')
      ? null
      : Number.parseInt(fileSize, 10);
    if (sizeNum !== null && !Number.isFinite(sizeNum)) {
      return res.status(400).json({ error: 'fileSize must be an integer', code: 'INVALID_FILESIZE', field: 'fileSize' });
    }

    const attachment = await prisma.contactAttachment.create({
      data: {
        filename: filename.trim().slice(0, 255),
        fileUrl: fileUrl.trim(),
        fileSize: sizeNum,
        mimeType: (mimeType && typeof mimeType === 'string') ? mimeType.trim().slice(0, 120) : null,
        contactId: contact.id,
        tenantId: req.user.tenantId,
      }
    });
    // #179: audit the attachment add — useful for tracking what files have been
    // uploaded against a contact (and by whom).
    await writeAudit('ContactAttachment', 'CREATE', attachment.id, req.user.userId, req.user.tenantId, {
      contactId: contact.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
    });
    res.status(201).json(attachment);
  } catch (err) {
    console.error('POST /contacts/:id/attachments failed:', err);
    res.status(500).json({ error: 'Failed to add attachment' });
  }
});

router.delete('/attachments/:attachId', async (req, res) => {
  try {
    const existing = await prisma.contactAttachment.findFirst({ where: { id: parseInt(req.params.attachId), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Attachment not found' });
    await prisma.contactAttachment.delete({ where: { id: existing.id } });
    // #179: audit the destructive delete (attachments are hard-deleted).
    await writeAudit('ContactAttachment', 'DELETE', existing.id, req.user.userId, req.user.tenantId, {
      contactId: existing.contactId,
      filename: existing.filename,
    });
    res.json({ success: true });
  } catch (_err) { res.status(500).json({ error: 'Failed to delete attachment' }); }
});

// #167: soft-delete — flips deletedAt instead of hard-removing the row.
// Audit row is written first. Idempotent: a second DELETE returns 200 with
// {idempotent: true, softDeleted: true}. Cascade behavior on relations is
// unchanged because we no longer call prisma.contact.delete here.
router.delete('/:id', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, softDeleted: true });
    }
    try {
      await prisma.auditLog.create({
        data: { action: 'SOFT_DELETE', entity: 'Contact', entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ name: existing.name, email: existing.email }) }
      });
    } catch (_) { /* audit failures must not block the soft-delete */ }
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
    // [GP-CRM integration] CRM has no contact.deleted event (soft-delete only).
    // Signal the deletion via contact.updated with a non-null deletedAt so a
    // partner (e.g. GlobusPhone) evicts its caller-ID cache for this number.
    // Fire-and-forget — never block the soft-delete response.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("contact.updated", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        status: contact.status,
        assignedToId: contact.assignedToId,
        deletedAt: contact.deletedAt,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
    } catch (_e) { /* webhook delivery is fire-and-forget */ }
    res.json({ ...contact, softDeleted: true });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// #167: restore a soft-deleted contact. ADMIN only. Idempotent on already-live rows.
router.post('/:id/restore', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (!existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, restored: false });
    }
    try {
      await prisma.auditLog.create({
        data: { action: 'RESTORE', entity: 'Contact', entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ name: existing.name }) }
      });
    } catch (_) { /* non-critical */ }
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { deletedAt: null }
    });
    // [GP-CRM integration] Signal restoration via contact.updated with
    // deletedAt: null so a partner (e.g. GlobusPhone) re-populates caller ID
    // for this number. Fire-and-forget.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("contact.updated", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        status: contact.status,
        assignedToId: contact.assignedToId,
        deletedAt: contact.deletedAt,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
    } catch (_e) { /* webhook delivery is fire-and-forget */ }
    res.json({ ...contact, restored: true });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to restore contact' });
  }
});


module.exports = router;
