/**
 * /api/travel/quotes/public — TravelQuote customer-share landing endpoints (C9).
 *
 * PRD_TRAVEL_QUOTE_BUILDER §3.7 — customer-accept landing.
 *
 * No-auth surface — share-link JWT (lib/quoteShareToken.js) authorizes the
 * caller. Token carries { quoteId, tenantId, purpose: 'travel-quote-share' }
 * and is minted by the operator-side "Send to customer" action (future slice).
 *
 * Endpoints (all keyed by :shareToken in URL):
 *   GET    /quote/:shareToken         — read-only customer-facing envelope
 *   POST   /quote/:shareToken/accept  — customer accepts the quote
 *   POST   /quote/:shareToken/reject  — customer rejects (reason required)
 *   POST   /quote/:shareToken/counter — customer counter-offers
 *
 * Sub-brand isolation: the token's tenantId is the authoritative scope guard.
 * No cross-tenant lookup is possible — verifyShareToken returns the embedded
 * tenantId and every Prisma where-clause is keyed off it.
 *
 * Customer-visible envelope (GET): strips operator-only fields. The line
 * shape the operator builder sees includes supplier-internal fields
 * (supplierId, internal notes) that we DO NOT want surfacing to the customer.
 * For now, the schema's line model is shared between the two surfaces, so
 * the route layer redacts at projection time — only customer-relevant fields
 * are sent (description, quantity, unitPrice, amount, currency, sortOrder).
 *
 * Status-transition guards mirror the operator-side accept/decline:
 *   - Customer actions only allowed on quotes in Draft or Sent status.
 *   - Already-actioned (Accepted / Rejected / Expired) → 409 ALREADY_ACTIONED.
 *   - validUntil < now → 404 EXPIRED at GET, also 404 at action attempts
 *     (the cron will sweep status → Expired shortly; until then we hide it).
 *
 * Snapshot writes: every successful customer action creates an immutable
 * TravelQuoteSnapshot row with statusBefore / statusAfter / changedBy='customer'
 * + optional changeReason. The snapshotJson captures the full quote + lines
 * shape AT THE TRANSITION INSTANT so version history is reconstructable.
 *
 * S32 — FX-rate locking at accept-time (PRD §3.4.2 + §3.4.3 + FR-3.7.4 +
 * AC-6.6). On customer accept, the route looks up the current FX rate for
 * (quote.currency → tenant.defaultCurrency) and persists it into the
 * Accepted-transition snapshotJson under fxLock = { sourceCurrency,
 * targetCurrency, rate, lockedAt }. Why-store-in-snapshotJson: TravelQuote
 * has no fxRateSnapshot column yet (schema add is a follow-up slice — see
 * S47), and the snapshotJson field on TravelQuoteSnapshot is freeform JSON
 * already written on every transition. This delivers the FX-lock contract
 * (margin-shift prevention) without a schema migration. When schema columns
 * land, the helper readFxLockFromAcceptSnapshot() becomes the migration
 * path: the accept route also writes to the column going forward; old
 * pre-migration rows keep their snapshotJson form.
 *
 * Idempotency: if the customer re-hits /accept on a quote already in
 * Accepted status, the route returns 409 ALREADY_ACTIONED with the
 * originally-locked FX rate (NOT a fresh re-lookup) so downstream
 * frontends can still surface the locked rate to the customer. Fresh
 * accepts on Draft/Sent get a fresh lookup. The lookup itself is
 * fail-soft: if the source/target currency pair can't be resolved
 * (no Currency row, no isBase tenant currency), fxLock is recorded with
 * rate=null + reason — the accept transition itself still succeeds.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { verifyShareToken } = require('../lib/quoteShareToken');
const { writeAudit } = require('../lib/audit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify share token and load the quote (with lines).
 * Returns { quote, lines, error } where error is null on success.
 *
 * On verify-failure: error.status / error.code / error.message let the
 * route map to the right HTTP envelope without leaking which side failed.
 *   - TokenExpiredError → 410 GONE LINK_EXPIRED
 *   - JsonWebTokenError → 401 INVALID_TOKEN
 *   - INVALID_PURPOSE / INVALID_PAYLOAD → 401 INVALID_TOKEN
 */
async function loadQuoteByShareToken(shareToken) {
  let payload;
  try {
    payload = verifyShareToken(shareToken);
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return { error: { status: 410, code: 'LINK_EXPIRED', message: 'Share link has expired' } };
    }
    return { error: { status: 401, code: 'INVALID_TOKEN', message: 'Invalid share token' } };
  }
  const { quoteId, tenantId } = payload;

  const quote = await prisma.travelQuote.findFirst({
    where: { id: quoteId, tenantId },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!quote) {
    return { error: { status: 404, code: 'QUOTE_NOT_FOUND', message: 'Quote not available' } };
  }

  return { quote, lines: quote.lines || [], payload };
}

/**
 * Project a quote + lines into the customer-visible envelope. Strips
 * operator-only fields (supplierId, internal notes, margin %, tenantId).
 */
function customerEnvelope(quote, contact) {
  const lines = (quote.lines || []).map((l) => ({
    id: l.id,
    lineType: l.lineType,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: l.amount,
    currency: l.currency,
    sortOrder: l.sortOrder,
  }));
  return {
    quote: {
      id: quote.id,
      subBrand: quote.subBrand,
      status: quote.status,
      totalAmount: quote.totalAmount,
      currency: quote.currency,
      validUntil: quote.validUntil,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt,
    },
    lines,
    customer: contact
      ? { name: contact.firstName ? `${contact.firstName} ${contact.lastName || ''}`.trim() : (contact.email || '') }
      : null,
  };
}

// ---------------------------------------------------------------------------
// S32 — FX-rate lock helpers
// ---------------------------------------------------------------------------

/**
 * Look up the FX rate for source-currency → tenant-base-currency at this
 * instant. Returns { sourceCurrency, targetCurrency, rate, lockedAt, reason }.
 *
 * Rate semantics: multiply a source-currency amount by `rate` to get the
 * target-currency amount. So if quote.currency = 'USD' and tenant base = 'INR',
 * the returned rate is "1 USD = N INR" (e.g. 83.4).
 *
 * Fail-soft: missing Currency row / missing tenant default / lookup error
 * returns rate=null + a non-empty reason so callers can persist the attempt.
 * The accept transition itself never fails because the FX lookup failed —
 * the customer accept must always proceed; FX-lock is a margin-protection
 * accessory, not a gate.
 *
 * Pair semantics:
 *   - sourceCurrency === targetCurrency → rate=1.0, reason='same_currency'.
 *   - Tenant defaultCurrency missing → rate=null, reason='no_tenant_currency'.
 *   - Currency row for sourceCurrency missing in this tenant → rate=null,
 *     reason='no_source_rate'.
 *   - Lookup throws → rate=null, reason='lookup_error'.
 */
async function lookupFxRate(prismaClient, sourceCurrency, tenantId) {
  const lockedAt = new Date().toISOString();
  try {
    const tenant = await prismaClient.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultCurrency: true },
    });
    const targetCurrency = tenant && tenant.defaultCurrency ? tenant.defaultCurrency : null;
    if (!targetCurrency) {
      return {
        sourceCurrency: sourceCurrency || null,
        targetCurrency: null,
        rate: null,
        lockedAt,
        reason: 'no_tenant_currency',
      };
    }
    if (sourceCurrency && sourceCurrency === targetCurrency) {
      return {
        sourceCurrency,
        targetCurrency,
        rate: 1.0,
        lockedAt,
        reason: 'same_currency',
      };
    }
    if (!sourceCurrency) {
      return {
        sourceCurrency: null,
        targetCurrency,
        rate: null,
        lockedAt,
        reason: 'no_source_currency',
      };
    }
    const currencyRow = await prismaClient.currency.findFirst({
      where: { code: sourceCurrency, tenantId },
      select: { exchangeRate: true },
    });
    if (!currencyRow || currencyRow.exchangeRate == null) {
      return {
        sourceCurrency,
        targetCurrency,
        rate: null,
        lockedAt,
        reason: 'no_source_rate',
      };
    }
    return {
      sourceCurrency,
      targetCurrency,
      rate: Number(currencyRow.exchangeRate),
      lockedAt,
      reason: null,
    };
  } catch (_e) {
    return {
      sourceCurrency: sourceCurrency || null,
      targetCurrency: null,
      rate: null,
      lockedAt,
      reason: 'lookup_error',
    };
  }
}

/**
 * Read the previously-locked FX snapshot from the existing Accepted-status
 * snapshot row for a quote. Returns the fxLock block as stored at accept
 * time, or null if no Accepted snapshot exists / snapshotJson is malformed.
 *
 * Used on the 409 ALREADY_ACTIONED branch of /accept so re-hits surface
 * the originally-locked rate without re-running the lookup.
 */
async function readFxLockFromAcceptSnapshot(prismaClient, quoteId) {
  try {
    const accepted = await prismaClient.travelQuoteSnapshot.findFirst({
      where: { quoteId, statusAfter: 'Accepted' },
      orderBy: { createdAt: 'asc' },
      select: { snapshotJson: true },
    });
    if (!accepted || !accepted.snapshotJson) return null;
    const parsed = JSON.parse(accepted.snapshotJson);
    return parsed && parsed.fxLock ? parsed.fxLock : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Determine the next versionNumber for snapshots on this quote.
 */
async function nextVersionNumber(quoteId) {
  const latest = await prisma.travelQuoteSnapshot.findFirst({
    where: { quoteId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });
  return latest ? latest.versionNumber + 1 : 1;
}

/**
 * Common action handler: applies the transition, writes the snapshot, and
 * returns the response envelope. Caller passes the wanted new status +
 * change-reason payload.
 */
async function applyCustomerTransition({ quote, statusAfter, changedBy, changeReason, customerName, extraSnapshot }) {
  const statusBefore = quote.status;
  const versionNumber = await nextVersionNumber(quote.id);

  // Capture the full quote + lines shape at the transition instant.
  const snapshotPayload = {
    quote: {
      id: quote.id,
      tenantId: quote.tenantId,
      subBrand: quote.subBrand,
      contactId: quote.contactId,
      status: quote.status,
      totalAmount: quote.totalAmount,
      currency: quote.currency,
      validUntil: quote.validUntil,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt,
    },
    lines: (quote.lines || []).map((l) => ({
      id: l.id,
      lineType: l.lineType,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount,
      currency: l.currency,
      supplierId: l.supplierId,
      sortOrder: l.sortOrder,
      notes: l.notes,
    })),
    customerName: customerName || null,
  };
  // S32 — merge any transition-specific extras (e.g. fxLock on Accepted).
  if (extraSnapshot && typeof extraSnapshot === 'object') {
    Object.assign(snapshotPayload, extraSnapshot);
  }
  const snapshotJson = JSON.stringify(snapshotPayload);

  const updated = await prisma.travelQuote.update({
    where: { id: quote.id },
    data: { status: statusAfter },
  });

  await prisma.travelQuoteSnapshot.create({
    data: {
      quoteId: quote.id,
      tenantId: quote.tenantId,
      versionNumber,
      snapshotJson,
      statusBefore,
      statusAfter,
      changedById: null, // customer-side — no req.user.userId
      changedBy,
      changeReason: changeReason || null,
    },
  });

  // Audit chain — actor is the customer; writeAudit's userId is null and
  // actorType='system' falls through to 'customer' via the actorType opt.
  try {
    await writeAudit(
      'TravelQuote',
      `TRAVEL_QUOTE_CUSTOMER_${statusAfter.toUpperCase()}`,
      quote.id,
      null,
      quote.tenantId,
      {
        quoteId: quote.id,
        subBrand: quote.subBrand,
        contactId: quote.contactId,
        previousStatus: statusBefore,
        newStatus: statusAfter,
        customerName: customerName || null,
        changeReason: changeReason || null,
      },
      { actorType: 'customer' },
    );
  } catch (e) {
    // Audit failure must not block the customer-side acknowledgement.
    console.error('[travel-quotes-public] audit write failed:', e.message);
  }

  return { updated, statusBefore, statusAfter, versionNumber };
}

// ---------------------------------------------------------------------------
// GET /quote/:shareToken — read-only customer envelope
// ---------------------------------------------------------------------------
router.get('/quote/:shareToken', async (req, res) => {
  try {
    const { shareToken } = req.params;
    const result = await loadQuoteByShareToken(shareToken);
    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        code: result.error.code,
      });
    }
    const { quote } = result;

    // Hide cancelled / rejected quotes from customer view to avoid
    // leaking historical decline details.
    if (quote.status === 'Cancelled' || quote.status === 'Expired') {
      return res.status(404).json({
        error: 'This quote is no longer available',
        code: 'QUOTE_NOT_AVAILABLE',
      });
    }

    // Hide expired-by-validUntil quotes (cron will mark them Expired soon).
    if (quote.validUntil && new Date(quote.validUntil).getTime() < Date.now()) {
      return res.status(404).json({
        error: 'This quote has expired',
        code: 'QUOTE_EXPIRED',
      });
    }

    // Customer name lookup — contact may be deleted; null-safe.
    let contact = null;
    try {
      contact = await prisma.contact.findFirst({
        where: { id: quote.contactId, tenantId: quote.tenantId },
        select: { firstName: true, lastName: true, email: true },
      });
    } catch (e) {
      // Non-fatal — render without customer name
    }

    return res.json(customerEnvelope(quote, contact));
  } catch (e) {
    console.error('[travel-quotes-public] GET error:', e.message);
    return res.status(500).json({ error: 'Failed to load quote', code: 'INTERNAL_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// POST /quote/:shareToken/accept — customer accepts
// ---------------------------------------------------------------------------
router.post('/quote/:shareToken/accept', async (req, res) => {
  try {
    const { shareToken } = req.params;
    const result = await loadQuoteByShareToken(shareToken);
    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        code: result.error.code,
      });
    }
    const { quote } = result;

    if (quote.validUntil && new Date(quote.validUntil).getTime() < Date.now()) {
      return res.status(404).json({
        error: 'This quote has expired',
        code: 'QUOTE_EXPIRED',
      });
    }

    if (quote.status !== 'Draft' && quote.status !== 'Sent') {
      // S32 — surface the originally-locked FX rate on the idempotency-409
      // path so re-hits return the locked rate without a fresh lookup.
      // Only applies when prior status is Accepted (Rejected / Countered
      // don't carry an FX lock).
      let fxLock = null;
      if (quote.status === 'Accepted') {
        fxLock = await readFxLockFromAcceptSnapshot(prisma, quote.id);
      }
      return res.status(409).json({
        error: `This quote was already actioned (status: ${quote.status})`,
        code: 'ALREADY_ACTIONED',
        status: quote.status,
        fxLock,
      });
    }

    // Optional body fields.
    const customerName = typeof req.body?.customerName === 'string'
      ? req.body.customerName.trim().slice(0, 200)
      : null;
    const customerNote = typeof req.body?.customerNote === 'string'
      ? req.body.customerNote.trim().slice(0, 2000)
      : null;

    // S32 — compute the FX-lock for source (quote.currency) → tenant base.
    // Fail-soft: rate=null + reason is recorded if lookup can't resolve.
    const fxLock = await lookupFxRate(prisma, quote.currency, quote.tenantId);

    const { updated, statusBefore } = await applyCustomerTransition({
      quote,
      statusAfter: 'Accepted',
      changedBy: 'customer',
      changeReason: customerNote,
      customerName,
      extraSnapshot: { fxLock },
    });

    return res.status(200).json({
      status: 'accepted',
      quoteId: updated.id,
      previousStatus: statusBefore,
      acceptedAt: updated.updatedAt,
      fxLock,
    });
  } catch (e) {
    console.error('[travel-quotes-public] accept error:', e.message);
    return res.status(500).json({ error: 'Failed to accept quote', code: 'INTERNAL_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// POST /quote/:shareToken/reject — customer rejects (reason required)
// ---------------------------------------------------------------------------
router.post('/quote/:shareToken/reject', async (req, res) => {
  try {
    const { shareToken } = req.params;
    const result = await loadQuoteByShareToken(shareToken);
    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        code: result.error.code,
      });
    }
    const { quote } = result;

    const rawReason = req.body && req.body.rejectionReason;
    if (typeof rawReason !== 'string' || !rawReason.trim()) {
      return res.status(400).json({
        error: 'rejectionReason is required',
        code: 'MISSING_REASON',
      });
    }
    const rejectionReason = rawReason.trim().slice(0, 2000);

    if (quote.validUntil && new Date(quote.validUntil).getTime() < Date.now()) {
      return res.status(404).json({
        error: 'This quote has expired',
        code: 'QUOTE_EXPIRED',
      });
    }

    if (quote.status !== 'Draft' && quote.status !== 'Sent') {
      return res.status(409).json({
        error: `This quote was already actioned (status: ${quote.status})`,
        code: 'ALREADY_ACTIONED',
        status: quote.status,
      });
    }

    const { updated, statusBefore } = await applyCustomerTransition({
      quote,
      statusAfter: 'Rejected',
      changedBy: 'customer',
      changeReason: rejectionReason,
    });

    return res.status(200).json({
      status: 'rejected',
      quoteId: updated.id,
      previousStatus: statusBefore,
      rejectedAt: updated.updatedAt,
    });
  } catch (e) {
    console.error('[travel-quotes-public] reject error:', e.message);
    return res.status(500).json({ error: 'Failed to reject quote', code: 'INTERNAL_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// POST /quote/:shareToken/counter — customer counter-offers
// ---------------------------------------------------------------------------
router.post('/quote/:shareToken/counter', async (req, res) => {
  try {
    const { shareToken } = req.params;
    const result = await loadQuoteByShareToken(shareToken);
    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        code: result.error.code,
      });
    }
    const { quote } = result;

    const proposedTotal = req.body && req.body.proposedTotal;
    if (proposedTotal == null || !Number.isFinite(Number(proposedTotal)) || Number(proposedTotal) <= 0) {
      return res.status(400).json({
        error: 'proposedTotal is required and must be a positive number',
        code: 'MISSING_PROPOSED_TOTAL',
      });
    }
    const comments = typeof req.body?.comments === 'string'
      ? req.body.comments.trim().slice(0, 2000)
      : '';

    if (quote.validUntil && new Date(quote.validUntil).getTime() < Date.now()) {
      return res.status(404).json({
        error: 'This quote has expired',
        code: 'QUOTE_EXPIRED',
      });
    }

    if (quote.status !== 'Draft' && quote.status !== 'Sent') {
      return res.status(409).json({
        error: `This quote was already actioned (status: ${quote.status})`,
        code: 'ALREADY_ACTIONED',
        status: quote.status,
      });
    }

    const counterOfferJson = JSON.stringify({
      proposedTotal: Number(proposedTotal),
      comments,
    });

    // Status name for counter — we use 'Countered' as a custom transitional
    // state (operator UI will translate back to Sent when they respond). The
    // status field is a free string, so no enum migration needed.
    const { updated, statusBefore } = await applyCustomerTransition({
      quote,
      statusAfter: 'Countered',
      changedBy: 'customer',
      changeReason: counterOfferJson,
    });

    return res.status(200).json({
      status: 'countered',
      quoteId: updated.id,
      previousStatus: statusBefore,
      proposedTotal: Number(proposedTotal),
      counteredAt: updated.updatedAt,
    });
  } catch (e) {
    console.error('[travel-quotes-public] counter error:', e.message);
    return res.status(500).json({ error: 'Failed to submit counter-offer', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
