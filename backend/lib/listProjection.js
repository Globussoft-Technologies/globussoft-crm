// #920 slice S3 — PII list-endpoint summary projections
// (FR-3.5 PII payload reduction — per docs/PRD_TRAVEL_SECURITY_ARCHITECTURE.md
// §3 FR-3.5 + tracker row S3 in docs/TRAVEL_BIG_SCOPE_BACKLOG.md).
//
// Why this helper exists
// ----------------------
// List endpoints today return the FULL Prisma row shape, including PII columns
// (`phone`, `email`, `passportNumber`, `aadhaarLast4`, `medicalNotes`,
// `rawPayload`, etc.). An insider with operator credentials can call
// `GET /api/contacts?limit=10000` once and walk away with 10,000 rows of full
// PII. The audit trail records "one GET call." Issue: #920 — list endpoints
// should ship a slim summary (id + display name + a small handful of non-PII
// keys) by default; the full row follows a click-through to the detail
// endpoint (`GET /:id`), which is per-row-auditable and rate-limit-able.
//
// PRD direction (FR-3.5.a) is to make summary the DEFAULT. The cron has
// already shipped 51 hand-rolled `?fields=summary` opt-in slices going the
// other direction (summary on opt-in, full as default) — see commits
// f7790241 (contacts slice 1) through 4c1743ae (deal-insights slice 51).
// This helper consolidates the pattern those slices share into ONE
// reusable lookup so future routes adopt the same shape with a single
// require() instead of cargo-culting the literal `select` object across
// every new route. The opt-in direction is preserved (`?fields=summary`
// triggers slim) to keep the 51 prior slices + their 50+ vitest cases
// shape-compatible; this slice does NOT flip the default (that's a true
// cross-cutting break that needs its own coordinated wave). The
// `?fields=full` opt-out lands here as a no-op (full is already the
// default) so callers that want to be explicit can be — and the helper
// is forward-compatible for the day the default flips.
//
// Contract
// --------
// listProjection(modelName, fullShape)
//   modelName — Prisma model name (case-sensitive — must match a key in
//               PROJECTIONS). Unknown names return `undefined`.
//   fullShape — boolean (or any truthy value). When truthy, returns
//               `undefined` so the caller's `findMany` call defaults to
//               full row shape. When falsy, returns the slim
//               `{ id: true, ...summaryFields }` object suitable for
//               drop-in use as `findManyArgs.select`.
//
// Returns: a Prisma `select` object, OR `undefined`.
//
// Usage in a route
// ----------------
//   const listProjection = require('../lib/listProjection');
//
//   const isSummary = req.query.fields === 'summary';
//   const select = listProjection('TmcTrip', !isSummary);
//   const findManyArgs = { where, orderBy: { departDate: 'asc' }, take, skip };
//   if (select) findManyArgs.select = select;
//   const rows = await prisma.tmcTrip.findMany(findManyArgs);
//
// Why caller-builds-args rather than helper-builds-args
// -----------------------------------------------------
// Each route's findMany call carries its own `where` / `orderBy` / `take` /
// `skip` / `include` shape — couplings the helper doesn't (and shouldn't)
// know about. The helper's job is JUST the projection lookup; the call-site
// composes it into the rest of the args. This keeps the helper a pure
// function (testable without mocking Prisma) and lets each route opt
// individual fields into the slim shape without forking the helper.
//
// Pure-function contract
// ----------------------
// - Identity-stable: same input always returns the same output object
//   (helps callers that cache the projection across requests).
// - Side-effect-free: no I/O, no env-var reads, no clock.
// - Defensive: unknown model names return `undefined` rather than throwing,
//   so a misspelled model name in a route degrades to "full shape" (the
//   pre-helper baseline) rather than 500-ing the request.
// - PRD anchor: every model's summary field set tracks the PRD's FR-3.5.a
//   shape (id + displayName + sub-brand-ish key + createdAt) plus the
//   minimum extra columns the route's existing filter/sort UI needs to
//   keep working without the full row. New models added here MUST justify
//   each included field with a one-line comment.
//
// What this helper DOES NOT do
// ----------------------------
// - It does NOT enforce that callers pass `select`. A route that ignores
//   the helper's output silently ships full PII; the per-route adoption
//   is the load-bearing step.
// - It does NOT filter response bodies post-Prisma. Slim shape is enforced
//   at the Prisma layer (the SQL `SELECT` clause); if a route inserts
//   PII into the response after the findMany call (e.g. via a decoration
//   `.map((row) => ({ ...row, contact }))`), the helper has no visibility
//   into that. Adopting routes must skip the decoration on the slim path.
// - It does NOT replace `middleware/fieldFilter.js` (the role-based
//   field-level permission filter — issue #464). That layer is still
//   applied per-route post-helper; the helper drops fields at the SQL
//   layer regardless of role, the fieldFilter layer drops fields per role.
//   Both layers compose cleanly: an absent field is a no-op for fieldFilter.

/**
 * Per-model slim projection.
 *
 * Each entry maps a Prisma model name to the keys that are SAFE to ship in
 * the slim list-endpoint shape. Keys NOT listed here will be dropped by the
 * Prisma `select` clause. The conventions:
 *
 *   - `id` is always included (every model has it; the picker / count-badge
 *     callers need it to wire row-click → detail navigation).
 *   - A single "display name" column — what the operator sees as the row
 *     headline (name, fullName, invoiceNum, tripCode, etc.).
 *   - sub-brand-ish key where the model has one (`subBrand`, `provider`,
 *     `productTier`, etc.). The PRD calls this out as a SAFE classifier
 *     that doesn't leak PII but lets pickers/dropdowns segment correctly.
 *   - `createdAt` (or the model's analogous timestamp) — for default-sort
 *     stability on the picker UI.
 *   - Plus the minimum extra columns the route's existing filter/sort UI
 *     needs to keep working without a full row (e.g. `status` for status
 *     filters, `departDate` for trip-list sort, `tripId` for participant
 *     pickers).
 *
 * NEVER include in a slim projection: phone, email, address, dob,
 * passportNumber (raw), aadhaar fields, medical notes, raw payload blobs,
 * GST numbers, parent contact PII, payment references. These are the
 * "follow click-through to detail endpoint" set.
 */
const PROJECTIONS = Object.freeze({
  // ── Travel vertical ──────────────────────────────────────────────────
  TmcTrip: Object.freeze({
    id: true,
    tripCode: true,      // display name (tenant-unique slug)
    destination: true,   // location label (non-PII)
    status: true,        // filter on the trip-list UI
    departDate: true,    // sort key
    returnDate: true,    // duration display (date math, non-PII)
    // (TmcTrip has no `subBrand` column on the schema — TMC is its own
    // sub-brand by virtue of model identity; the absence of a subBrand
    // entry here is intentional, not an oversight.)
    createdAt: true,
  }),

  // Trip participants — high-value PII target. fullName is required as the
  // operator headline; everything else (passportNumber, aadhaar*, parent*,
  // medicalNotes) is intentionally DROPPED. The detail endpoint
  // GET /trips/:id/participants/:pid would surface the full row.
  TripParticipant: Object.freeze({
    id: true,
    tripId: true,        // pickers need this to navigate back to the trip
    fullName: true,      // operator headline
    // consentCapturedAt indicates "has parent consented?" — a workflow
    // boolean, not PII. createdAt is the sort key.
    consentCapturedAt: true,
    createdAt: true,
  }),

  Itinerary: Object.freeze({
    id: true,
    subBrand: true,      // sub-brand chip on the list UI
    contactId: true,     // FK only — the contact's PII follows a separate fetch
    destination: true,   // non-PII location label
    status: true,        // filter UI
    startDate: true,
    endDate: true,
    totalAmount: true,   // currency display on the picker
    currency: true,
    createdAt: true,
    // Intentionally DROPPED: pricingJson (heavy @db.Text breakdown),
    // shareToken (auth-bearing), pdfUrl (heavy + may leak), micrositeUrl.
  }),

  TravelQuote: Object.freeze({
    id: true,
    subBrand: true,
    contactId: true,
    status: true,
    totalAmount: true,
    currency: true,
    validUntil: true,    // expiry-sort UI needs this
    createdAt: true,
  }),

  TravelInvoice: Object.freeze({
    id: true,
    subBrand: true,
    contactId: true,
    invoiceNum: true,    // operator headline
    status: true,
    docType: true,       // TaxInvoice vs CreditNote etc. — filter UI
    totalAmount: true,
    currency: true,
    dueDate: true,       // aging-tile sort
    paidAt: true,        // paid-vs-unpaid filter
    createdAt: true,
    // Intentionally DROPPED: tcsAmount / tcsRate / tcsExceedingAmount /
    // tcsAppliedAt (audit-trail data, not picker-relevant); parentInvoiceId
    // (FK only — detail endpoint surfaces it).
  }),

  TravelSupplier: Object.freeze({
    id: true,
    subBrand: true,
    name: true,          // operator headline
    supplierCategory: true,
    isActive: true,
    createdAt: true,
    // Intentionally DROPPED: contactPerson, phone, email (supplier PII —
    // the supplier-master detail endpoint serves these); gstin (regulated
    // identifier); addressLine, notes, paymentTermsDays, creditLimit.
  }),

  RfuLeadProfile: Object.freeze({
    id: true,
    contactId: true,     // FK only — detail endpoint surfaces the PII
    productTier: true,   // entry | primary | premium — sub-brand-ish
    createdAt: true,
    // Intentionally DROPPED: passportNumber, emergencyContact*, medicalNotes,
    // visaHistoryJson, frequentFlyerJson, pastComplaintsJson — all PII /
    // sensitive personal data.
  }),

  // ── Multi-channel inbound lead ingestion ─────────────────────────────
  MarketplaceLead: Object.freeze({
    id: true,
    provider: true,      // indiamart | justdial | tradeindia — sub-brand-ish
    name: true,          // operator headline (non-PII when present as just
                         // a first name; sometimes it's "John D.", sometimes
                         // full — same risk-class as Contact.name which the
                         // shipped contacts slice 1 already classified as
                         // safe-in-summary)
    status: true,        // filter UI (New | Imported | Duplicate | Dismissed)
    contactId: true,     // FK only (resolved Contact's PII follows separately)
    createdAt: true,
    // Intentionally DROPPED: email, phone, company, message (@db.Text),
    // product, city, rawPayload (@db.Text — could embed full webhook payload).
    // These are the highest-PII fields on the model.
  }),
});

/**
 * Look up the Prisma `select` projection for a model's slim list-endpoint shape.
 *
 * @param {string} modelName     - Prisma model name (case-sensitive).
 * @param {boolean} fullShape    - When truthy, returns `undefined` so Prisma
 *                                 ships the full row. When falsy, returns
 *                                 the slim `select` object.
 * @returns {object|undefined}   - Slim select object, or `undefined` for
 *                                 full-shape / unknown-model paths.
 */
function listProjection(modelName, fullShape) {
  if (fullShape) return undefined;
  if (typeof modelName !== 'string' || modelName.length === 0) return undefined;
  const projection = PROJECTIONS[modelName];
  if (!projection) return undefined;
  return projection;
}

/**
 * Expose the projection map for testing + introspection. Read-only at module
 * load (Object.freeze on construction); callers that mutate this in tests
 * are caught by the freeze and crash loudly rather than corrupting state.
 *
 * @returns {Readonly<Record<string, object>>}
 */
function getProjections() {
  return PROJECTIONS;
}

/**
 * Resolve the `req.query.fields` value to a boolean "ship full shape?" flag.
 * Centralizes the strict-equality opt-in convention shared across slices 1-51
 * (`?fields=summary` is the slim opt-in; everything else — absent param,
 * `?fields=full`, `?fields=summary,extra`, casing variants — falls through
 * to full shape).
 *
 * Slim path requires EXACTLY the literal string "summary". Anything else
 * (including `?fields=full`, `?fields=Summary`, `?fields=summary ` with
 * trailing whitespace, `?fields=summary,extra`) returns true (full shape).
 *
 * @param {object} query - req.query
 * @returns {boolean}    - true when the caller wants the full row shape.
 */
function isFullShape(query) {
  if (!query || typeof query !== 'object') return true;
  return query.fields !== 'summary';
}

module.exports = listProjection;
module.exports.listProjection = listProjection;
module.exports.getProjections = getProjections;
module.exports.isFullShape = isFullShape;
