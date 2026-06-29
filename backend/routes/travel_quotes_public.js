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
 * targetCurrency, rate, lockedAt }.
 *
 * S47 — fxLock promoted to dedicated columns on TravelQuote
 * (fxRateSnapshot Decimal(15,6) + fxRateSourceCurrency + fxRateTargetCurrency
 * + fxRateLockedAt + fxRateExpiresAt). The accept path now writes to BOTH
 * the columns AND snapshotJson — billing reports can query the locked rate
 * via the columns without parsing JSON, and the snapshotJson form remains
 * for forensic per-transition history + pre-S47 quote backward-compat. The
 * helper readFxLockFromAcceptSnapshot() stays as the fallback reader for
 * pre-S47 quotes whose columns are null.
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
// G124 (Master PRD A3 residual) — per-document view audit for the
// customer-facing share-token landing. The existing customer-action audits
// (accept / reject / counter) only fire on transitions; a customer who just
// reads the quote without acting leaves no trail today. recordDocumentAccess
// closes that gap with a uniform DOCUMENT_VIEW row.
const { recordDocumentAccess } = require('../lib/documentAccessAudit');
// Staff in-app notifications on every customer decision (accept/reject/counter).
const { notifyMany } = require('../lib/notificationService');
// Customer-money payment link — uses the TENANT's OWN Razorpay keys from the
// Payment Gateway config (BYOK), NEVER the platform env keys. Returns null when
// the tenant hasn't configured + activated its keys (link is then skipped).
const { getTenantRazorpayClient } = require('../lib/tenantPaymentGateway');
// Best-effort customer delivery of the advance-payment link (email + WhatsApp).
const { sendEmail } = require('../lib/emailSender');
const waWebClient = require('../services/whatsappWebClient');

// Advance share we ask the customer to pay on accept to confirm the booking.
const ADVANCE_PCT = 0.5; // 50%

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the staff to notify about a customer decision on a sub-brand's quote:
 * ALL admins (full visibility) + the MANAGERs who can act on that sub-brand
 * (subBrandAccess includes it, or is unset/empty = full access). Mirrors the
 * itinerary-decision resolver in routes/portal.js. Best-effort; returns [].
 */
async function resolveQuoteStaffUserIds(tenantId, subBrand) {
  try {
    const staff = await prisma.user.findMany({
      where: { tenantId, role: { in: ['ADMIN', 'MANAGER'] } },
      select: { id: true, role: true, subBrandAccess: true },
    });
    const ids = [];
    for (const u of staff) {
      if (u.role === 'ADMIN') { ids.push(u.id); continue; }
      let access = null;
      if (u.subBrandAccess) {
        try { const arr = JSON.parse(u.subBrandAccess); if (Array.isArray(arr)) access = arr; } catch { /* malformed → full */ }
      }
      if (access === null || access.length === 0 || access.includes(subBrand)) ids.push(u.id);
    }
    return ids;
  } catch (e) {
    console.warn('[travel-quotes-public] staff resolve failed (non-fatal):', e.message);
    return [];
  }
}

/** Friendly contact display name from the various name columns. */
function contactDisplayName(contact) {
  if (!contact) return null;
  return contact.name
    || contact.email
    || null;
}

/**
 * Notify the brand's admins + manager(s) that the customer accepted / rejected /
 * countered the quote. Never throws — a notification failure must not fail the
 * customer's action. `advance` (accept only) annotates whether a pay link went.
 */
async function notifyStaffOfQuoteDecision({ tenantId, subBrand, quoteId, action, displayName, reason, proposedTotal, currency, advance }) {
  try {
    const userIds = await resolveQuoteStaffUserIds(tenantId, subBrand);
    if (!userIds.length) return;
    const who = displayName || 'A customer';
    const brand = (subBrand || '').toUpperCase();
    const cur = currency || 'INR';
    let title; let message; let type;
    if (action === 'accepted') {
      title = 'Quote accepted by customer';
      type = 'success';
      message = `${who} ACCEPTED the ${brand} quote #${quoteId}.`;
      if (advance && advance.ok) {
        message += ` A ${Math.round(ADVANCE_PCT * 100)}% advance link (${advance.currency} ${Number(advance.amountMajor).toLocaleString('en-IN')}) was sent to the customer to confirm the booking.`;
      } else {
        message += ' Set up this organisation\'s Razorpay keys (Settings → Payment Gateway) to collect the advance automatically.';
      }
    } else if (action === 'rejected') {
      title = 'Quote rejected by customer';
      type = 'warning';
      message = `${who} REJECTED the ${brand} quote #${quoteId}.`;
      if (reason) message += ` Reason: "${reason}"`;
    } else { // countered
      title = 'Counter-offer received';
      type = 'warning';
      message = `${who} sent a COUNTER-OFFER on the ${brand} quote #${quoteId}`;
      if (proposedTotal != null) message += ` — proposed ${cur} ${Number(proposedTotal).toLocaleString('en-IN')}`;
      message += '.';
      if (reason) message += ` Comments: "${reason}"`;
    }
    // Deep-link to a REAL route: a counter-offer opens the counter-review screen;
    // accept/reject open the quote in the builder. (The old `/travel/quotes/:id`
    // had no route → the notification 404'd.)
    const link = action === 'countered'
      ? `/travel/quotes/${quoteId}/counter-review`
      : `/travel/quotes/builder/${quoteId}`;
    await notifyMany({ userIds, tenantId, title, message, type, link });
  } catch (e) {
    console.warn('[travel-quotes-public] staff decision notification failed (non-fatal):', e.message);
  }
}

/**
 * Create a Razorpay payment link for the advance (ADVANCE_PCT of the quote
 * total), billed to the TENANT's OWN Razorpay account (BYOK). Returns
 * { ok:true, url, id, amountMajor, currency } on success, else { ok:false,
 * reason }. Never throws — when the tenant has no active gateway the accept
 * still succeeds; the link is simply skipped.
 */
async function createAdvancePaymentLink({ quote, contact, displayName }) {
  try {
    const total = Number(quote.totalAmount) || 0;
    if (total <= 0) return { ok: false, reason: 'no_total' };
    const gw = await getTenantRazorpayClient(quote.tenantId);
    if (!gw) return { ok: false, reason: 'no_gateway' };
    const currency = (quote.currency || 'INR').toUpperCase();
    const minAmountMajor = Math.round(total * ADVANCE_PCT); // 50% — minimum the customer must pay
    if (minAmountMajor <= 0) return { ok: false, reason: 'no_total' };

    // Expiry: use the quote's validUntil if set and in the future, otherwise 1 year from now.
    // The link stays live so the customer can pay the remaining balance any time before the trip.
    const defaultExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    let expireBy = defaultExpiry;
    if (quote.validUntil) {
      const validTs = Math.floor(new Date(quote.validUntil).getTime() / 1000);
      if (validTs > Math.floor(Date.now() / 1000)) expireBy = validTs;
    }

    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:5173';
    const link = await gw.client.paymentLink.create({
      amount: Math.round(total * 100),          // full trip cost in smallest unit (paise)
      currency,
      accept_partial: true,                      // customer can pay 50%, 70%, 80%, or 100%
      first_min_partial_amount: Math.round(minAmountMajor * 100), // minimum = 50%
      expire_by: expireBy,
      description: `Booking confirmation — quote #${quote.id} (min. ${Math.round(ADVANCE_PCT * 100)}% advance)`,
      customer: {
        name: displayName || undefined,
        email: (contact && contact.email) || undefined,
        contact: (contact && contact.phone) || undefined,
      },
      // We deliver the link ourselves (email + WhatsApp) — don't double-send.
      notify: { sms: false, email: false },
      reminder_enable: true,
      notes: { quoteId: String(quote.id), tenantId: String(quote.tenantId), kind: 'travel-quote-advance' },
      // Redirect back to the CRM success page so the payment is reconciled even
      // when the Razorpay webhook cannot reach the server (localhost / dev boxes).
      callback_url: `${frontendBase}/p/payment/success`,
      callback_method: 'get',
    });
    // Persist the Razorpay payment-link id (plink_XXXX) on the quote for refund
    // tracking. Best-effort — a DB write failure must not fail the accept flow.
    try {
      await prisma.travelQuote.update({
        where: { id: quote.id },
        data: { advancePlinkId: link.id },
      });
    } catch (e) {
      console.error('[travel-quotes-public] advancePlinkId persist failed (non-fatal):', e.message);
    }
    // Create a pending Payment row so the public confirm-payment callback can
    // find it, mark it SUCCESS, and reconcile the quote/invoice. Without this,
    // the callback returns 404 and the payment never appears in the CRM.
    try {
      await prisma.payment.create({
        data: {
          tenantId: quote.tenantId,
          invoiceId: null,
          contactId: quote.contactId || null,
          description: `Quote #${quote.id} advance (min. ${Math.round(ADVANCE_PCT * 100)}%)`,
          amount: minAmountMajor,
          currency,
          gateway: 'razorpay',
          gatewayId: link.id,
          status: 'PENDING',
          metadata: JSON.stringify({
            type: 'travel-quote-advance',
            quoteId: quote.id,
            subBrand: quote.subBrand || null,
            plinkId: link.id,
          }),
        },
      });
    } catch (e) {
      console.error('[travel-quotes-public] advance payment row create failed (non-fatal):', e.message);
    }
    return { ok: true, url: link.short_url, id: link.id, amountMajor: minAmountMajor, totalAmount: total, currency };
  } catch (e) {
    console.error('[travel-quotes-public] advance payment-link create failed (non-fatal):', e && (e.message || JSON.stringify(e)));
    return { ok: false, reason: 'error', error: e && (e.message || JSON.stringify(e)) };
  }
}

/**
 * Deliver the advance-payment link to the customer over email + WhatsApp
 * (best-effort, both channels). Returns the list of channels that accepted the
 * message (for the response + staff note). Never throws.
 */
async function sendAdvanceLinkToCustomer({ quote, contact, displayName, payUrl, amountMajor, totalAmount, currency, tenantName }) {
  const channels = [];
  if (!contact) return channels;
  const cur = currency || quote.currency || 'INR';
  const minAmt = Number(amountMajor || 0).toLocaleString('en-IN');
  const fullAmt = Number(totalAmount || amountMajor || 0).toLocaleString('en-IN');
  const name = displayName || 'there';
  const brand = tenantName || 'our team';
  const text =
    `Hi ${name},\n\n` +
    `Thank you for accepting your quote! To confirm your booking, please use this secure payment link:\n` +
    `${payUrl}\n\n` +
    `You can pay a minimum of ${cur} ${minAmt} (${Math.round(ADVANCE_PCT * 100)}% advance) to lock in your booking, ` +
    `or pay the full amount of ${cur} ${fullAmt} — any amount in between works too.\n\n` +
    `This link stays active until your trip, so you can pay the remaining balance any time.\n\n— ${brand}`;
  if (contact.email) {
    try {
      const html =
        `<p>Hi ${name},</p>` +
        `<p>Thank you for accepting your quote! To confirm your booking, please use this secure payment link:</p>` +
        `<p><a href="${payUrl}" target="_blank" rel="noopener noreferrer">Pay and confirm booking</a></p>` +
        `<p>You can pay a minimum of ${cur} ${minAmt} (${Math.round(ADVANCE_PCT * 100)}% advance) to lock in your booking, ` +
        `or pay the full amount of ${cur} ${fullAmt} &mdash; any amount in between works too.</p>` +
        `<p>This link stays active until your trip, so you can pay the remaining balance any time.</p>` +
        `<p>&mdash; ${brand}</p>`;
      await sendEmail({ to: contact.email, subject: `Confirm your booking — pay from ${cur} ${minAmt}`, text, html });
      channels.push('email');
    } catch (e) { console.error('[travel-quotes-public] advance email failed (non-fatal):', e.message); }
  }
  if (contact.phone) {
    try {
      const r = await waWebClient.sendBestEffort({
        tenantId: quote.tenantId,
        subBrand: quote.subBrand,
        toPhone: contact.phone,
        contactId: quote.contactId,
        fallbackText: `Hi ${name}! 🎉 Thanks for accepting your quote. Pay min. ${cur} ${minAmt} (${Math.round(ADVANCE_PCT * 100)}% advance) to confirm your booking — or pay more, up to the full ${cur} ${fullAmt}. Link stays active until your trip: ${payUrl}`,
      });
      if (r && r.sent) channels.push('whatsapp');
    } catch (e) { console.error('[travel-quotes-public] advance WhatsApp failed (non-fatal):', e.message); }
  }
  return channels;
}

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
      ? { name: contact.name || contact.email || '' }
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
 *
 * S47 — `quoteUpdateExtras` lets the accept-path also write the dedicated
 * fxRate* columns on TravelQuote alongside the status flip. Merged into the
 * prisma.travelQuote.update.data so the columns are queryable for billing
 * reports without parsing snapshotJson. Backward-compat: snapshotJson under
 * `extraSnapshot.fxLock` keeps being populated for pre-S47 consumers + per-
 * transition forensic history.
 */
async function applyCustomerTransition({ quote, statusAfter, changedBy, changeReason, customerName, extraSnapshot, quoteUpdateExtras }) {
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

  // S47 — merge transition-specific column writes (e.g. fxRate* on Accepted).
  // Falls back to the bare status flip when no extras are passed (reject /
  // counter paths don't have lock state to persist).
  const updateData = { status: statusAfter };
  if (quoteUpdateExtras && typeof quoteUpdateExtras === 'object') {
    Object.assign(updateData, quoteUpdateExtras);
  }
  const updated = await prisma.travelQuote.update({
    where: { id: quote.id },
    data: updateData,
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
        select: { name: true, email: true },
      });
    } catch (_e) {
      // Non-fatal — render without customer name
    }

    // G124 — DOCUMENT_VIEW audit row for the customer-facing share-token
    // landing. Anonymous viewer (no JWT) → userId=null + actorType=customer.
    // Captures the contact email (if resolvable) + IP + UA + truncated share
    // token so a leaked link can be traced. Fail-soft.
    recordDocumentAccess({
      tenantId: quote.tenantId,
      userId: null,
      documentType: 'TravelQuote',
      documentId: quote.id,
      event: 'view',
      viewerEmail: contact && contact.email,
      shareTokenId: shareToken,
      ipAddress: req.ip,
      userAgent: req.headers && req.headers['user-agent'],
      extra: { subBrand: quote.subBrand, status: quote.status },
    });

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

    // S47 — promote fxLock fields to dedicated TravelQuote columns so
    // billing reports can query them without parsing snapshotJson. Keep
    // populating snapshotJson too for forensic history + pre-S47 reader
    // backward-compat. Null-safe: if fxLock is somehow null, columns stay
    // null (additive-nullable schema permits this).
    const quoteUpdateExtras = fxLock
      ? {
          fxRateSnapshot: fxLock.rate != null ? fxLock.rate : null,
          fxRateSourceCurrency: fxLock.sourceCurrency || null,
          fxRateTargetCurrency: fxLock.targetCurrency || null,
          fxRateLockedAt: fxLock.lockedAt ? new Date(fxLock.lockedAt) : null,
          fxRateExpiresAt: fxLock.expiresAt ? new Date(fxLock.expiresAt) : null,
        }
      : undefined;

    const { updated, statusBefore } = await applyCustomerTransition({
      quote,
      statusAfter: 'Accepted',
      changedBy: 'customer',
      changeReason: customerNote,
      customerName,
      extraSnapshot: { fxLock },
      quoteUpdateExtras,
    });

    // Notify staff + send the customer a 50% advance payment link (billed to the
    // TENANT's own Razorpay account — BYOK). All best-effort — these never block
    // or fail the accept acknowledgement.
    let advancePayment = null;
    try {
      let contact = null;
      try {
        contact = await prisma.contact.findFirst({
          where: { id: quote.contactId, tenantId: quote.tenantId },
          select: { name: true, email: true, phone: true },
        });
      } catch { /* proceed without contact */ }
      const displayName = contactDisplayName(contact) || customerName || null;
      let tenantName = null;
      try {
        const t = await prisma.tenant.findUnique({ where: { id: quote.tenantId }, select: { name: true } });
        tenantName = t && t.name;
      } catch { /* fall back to generic */ }
      const advance = await createAdvancePaymentLink({ quote, contact, displayName });
      if (advance.ok) {
        const channelsSent = await sendAdvanceLinkToCustomer({
          quote, contact, displayName, payUrl: advance.url, amountMajor: advance.amountMajor, totalAmount: advance.totalAmount, currency: advance.currency, tenantName,
        });
        advancePayment = { link: advance.url, amount: advance.amountMajor, currency: advance.currency, percent: Math.round(ADVANCE_PCT * 100), channelsSent };
      }
      await notifyStaffOfQuoteDecision({ tenantId: quote.tenantId, subBrand: quote.subBrand, quoteId: quote.id, action: 'accepted', displayName, advance });
    } catch (e) {
      console.error('[travel-quotes-public] post-accept side effects failed (non-fatal):', e.message);
    }

    return res.status(200).json({
      status: 'accepted',
      quoteId: updated.id,
      previousStatus: statusBefore,
      acceptedAt: updated.updatedAt,
      fxLock,
      advancePayment,
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

    // Notify staff (best-effort).
    try {
      let displayName = null;
      try {
        const c = await prisma.contact.findFirst({
          where: { id: quote.contactId, tenantId: quote.tenantId },
          select: { name: true, email: true },
        });
        displayName = contactDisplayName(c);
      } catch { /* ignore */ }
      await notifyStaffOfQuoteDecision({ tenantId: quote.tenantId, subBrand: quote.subBrand, quoteId: quote.id, action: 'rejected', displayName, reason: rejectionReason });
    } catch (e) {
      console.error('[travel-quotes-public] reject notify failed (non-fatal):', e.message);
    }

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

    // Notify staff (best-effort).
    try {
      let displayName = null;
      try {
        const c = await prisma.contact.findFirst({
          where: { id: quote.contactId, tenantId: quote.tenantId },
          select: { name: true, email: true },
        });
        displayName = contactDisplayName(c);
      } catch { /* ignore */ }
      await notifyStaffOfQuoteDecision({ tenantId: quote.tenantId, subBrand: quote.subBrand, quoteId: quote.id, action: 'countered', displayName, reason: comments, proposedTotal: Number(proposedTotal), currency: quote.currency });
    } catch (e) {
      console.error('[travel-quotes-public] counter notify failed (non-fatal):', e.message);
    }

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
