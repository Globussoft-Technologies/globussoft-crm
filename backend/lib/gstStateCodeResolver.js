// Travel CRM — Indian GST place-of-supply state-code resolver.
//
// Slice 3 of the #902 GST & Compliance module (PRD:
// docs/PRD_TRAVEL_GST_COMPLIANCE.md). Resolves the operator-state +
// customer-state pair that feeds backend/lib/gstCalculation.js's
// place-of-supply branch (CGST/SGST split vs single-line IGST).
//
// === Source-of-truth chain ===
//
// Per FR-3.x in the PRD, the resolution order for EACH state code is:
//
//   1. Explicit override (caller-supplied — e.g. tax-preview query
//      param, manual invoice override during issue-time correction).
//      Truthy overrides win — empty-string is treated as no override
//      (the route may pass `req.query.operatorStateCode || null`
//      without coercing empties; keep the helper forgiving).
//   2. DB column lookup — Tenant.gstStateCode for operator,
//      Contact.billingStateCode (G034 — PRD_TRAVEL_GST_COMPLIANCE FR-3.5.2)
//      then Contact.stateCode for customer. billingStateCode wins
//      when present — a traveller may live in Karnataka but bill to
//      a corporate AP desk in Maharashtra; GST is taxed by billing
//      address. stateCode is the fallback when billingStateCode is
//      NULL so pre-G034 rows keep working. All columns are nullable.
//   3. Hard-coded "IN-MH" — preserves the slice-2 query-param default
//      so behaviour stays back-compat for callers that don't pass
//      tenantId/contactId AND don't pass overrides.
//
// Customer-specific fallback: if Contact.stateCode is null AND no
// customerOverride was supplied, the customer code MIRRORS the
// operator code (intra-state default). This keeps unpopulated
// customer records on the CGST/SGST branch rather than spuriously
// dropping into IGST when the data simply hasn't been collected
// yet — operators tend to start with intra-state customers and
// the default should reflect that.
//
// === Purity / testability ===
//
// The function takes a `prisma` argument (any object with
// `.tenant.findUnique` + `.contact.findUnique`) rather than importing
// the shared client so vitest stubs work without monkey-patching
// the singleton. The route consumer (slice 4) will pass the real
// require('./prisma') client.
//
// === Format-agnosticism ===
//
// The helper does NO validation of the resolved values. Whatever
// the DB stores comes back. ISO-3166-2 normalisation (e.g. "MH" →
// "IN-MH", lowercase coercion, two-letter Indian-state lookup) is
// a future-slice concern (FR-3.x admin UI for tenant onboarding +
// Contact import). Keeping this helper pure lets the validation
// layer be swapped in without touching every consumer.

const DEFAULT_OPERATOR_STATE = 'IN-MH';

/**
 * Resolves operator + customer state codes for GST place-of-supply rules.
 *
 * @param {object} params
 * @param {object} params.prisma — Prisma-shaped client with .tenant.findUnique
 *                                + .contact.findUnique. The shared
 *                                require('./prisma') instance in production;
 *                                a vi.fn() stub in tests.
 * @param {number|null|undefined} params.tenantId — when null/undefined OR
 *                                Tenant has no gstStateCode column populated,
 *                                falls back to DEFAULT_OPERATOR_STATE.
 * @param {number|null|undefined} params.contactId — when null/undefined OR
 *                                Contact has no stateCode column populated,
 *                                customer mirrors operator (intra-state).
 * @param {string|null|undefined} params.operatorOverride — truthy wins
 *                                over the DB lookup. Empty-string treated
 *                                as no override.
 * @param {string|null|undefined} params.customerOverride — same semantics
 *                                as operatorOverride but for customer side.
 * @returns {Promise<{operatorStateCode: string, customerStateCode: string}>}
 *          Both fields ALWAYS present (never null). Strings.
 */
async function resolveStateCodes({
  prisma,
  tenantId,
  contactId,
  operatorOverride = null,
  customerOverride = null,
} = {}) {
  // 1. Operator side
  let operatorCode = operatorOverride || null;
  if (!operatorCode && tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { gstStateCode: true },
    });
    operatorCode = (tenant && tenant.gstStateCode) || null;
  }
  operatorCode = operatorCode || DEFAULT_OPERATOR_STATE;

  // 2. Customer side — billingStateCode (G034) wins over stateCode
  //    when present. Pre-G034 rows have billingStateCode=NULL and the
  //    fallback to stateCode keeps them on the same branch they were
  //    on before. The select pulls BOTH columns in one round-trip so
  //    the resolver doesn't fire two queries for a Contact lookup.
  let customerCode = customerOverride || null;
  if (!customerCode && contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { stateCode: true, billingStateCode: true },
    });
    customerCode =
      (contact && contact.billingStateCode) ||
      (contact && contact.stateCode) ||
      null;
  }
  // Mirror operator when customer is unknown — intra-state default keeps
  // the customer on the CGST/SGST branch until data lands.
  customerCode = customerCode || operatorCode;

  return { operatorStateCode: operatorCode, customerStateCode: customerCode };
}

module.exports = { resolveStateCodes, DEFAULT_OPERATOR_STATE };
