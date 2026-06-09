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
async function applyCustomerTransition({ quote, statusAfter, changedBy, changeReason, customerName }) {
  const statusBefore = quote.status;
  const versionNumber = await nextVersionNumber(quote.id);

  // Capture the full quote + lines shape at the transition instant.
  const snapshotJson = JSON.stringify({
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
  });

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
      return res.status(409).json({
        error: `This quote was already actioned (status: ${quote.status})`,
        code: 'ALREADY_ACTIONED',
        status: quote.status,
      });
    }

    // Optional body fields.
    const customerName = typeof req.body?.customerName === 'string'
      ? req.body.customerName.trim().slice(0, 200)
      : null;
    const customerNote = typeof req.body?.customerNote === 'string'
      ? req.body.customerNote.trim().slice(0, 2000)
      : null;

    const { updated, statusBefore } = await applyCustomerTransition({
      quote,
      statusAfter: 'Accepted',
      changedBy: 'customer',
      changeReason: customerNote,
      customerName,
    });

    return res.status(200).json({
      status: 'accepted',
      quoteId: updated.id,
      previousStatus: statusBefore,
      acceptedAt: updated.updatedAt,
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
