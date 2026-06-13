// documentAccessAudit.js — per-document view/download/share audit helper.
//
// Master PRD A3 (TRAVEL_CRM_PRD.md §4.7 + docs/TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md
// G124) — every sensitive operator/customer-facing document fetch should land
// a discrete audit row so we can answer "who pulled this PDF / who opened the
// share link / who minted the link" in DPDP + HIPAA + audit contexts. The
// existing per-route `writeAudit` calls already cover ad-hoc events for some
// document types, but the pattern wasn't uniform and several routes had no
// audit at all (notably the public share-token quote GET handler and the
// itinerary share-mint endpoint).
//
// This helper consolidates the contract. It is a thin wrapper around the
// `writeAudit` chain helper in lib/audit.js — NO new schema is introduced.
// The action verb (DOCUMENT_VIEW / DOCUMENT_DOWNLOAD / DOCUMENT_SHARE) lets
// the audit-viewer page surface a "Document Access" sub-tab without having
// to parse a dozen route-specific verbs. The `documentType` rides inside
// the `details` JSON blob so existing AuditLog filtering by entity stays
// uncluttered.
//
// Contract:
//   recordDocumentAccess({
//     tenantId,         // REQUIRED — tenant scope for the chain
//     userId,           // optional — null for anonymous share-token viewers
//     documentType,     // 'Itinerary' | 'TravelInvoice' | 'TravelQuote' |
//                       // 'VisaApplication' | 'Prescription' | 'ConsentForm'
//                       // | 'TmcReadinessReport' | string
//     documentId,       // required — primary key of the document row
//     event,            // 'view' | 'download' | 'share'
//     viewerEmail,      // optional — share-token visitor email or operator email
//     ipAddress,        // optional — request.ip if available
//     userAgent,        // optional — request.headers['user-agent']
//     shareTokenId,     // optional — the share token (truncated) used to access
//     extra,            // optional — any additional context (sub-brand, version, etc.)
//   })
//
// Returns: a Promise<void>. NEVER throws — audit emission is fail-soft so it
// can't take down the document fetch. Lifts the responsibility from each
// call site for handling writeAudit errors.
//
// Wire-up sites (initial sweep — extend as more routes ship):
//   - backend/routes/travel_itineraries.js:
//       /itineraries/:id/pdf            → event='download', documentType='Itinerary'
//       /itineraries/:id/share          → event='share',    documentType='Itinerary'
//       /itineraries/public/:shareToken → event='view',     documentType='Itinerary'
//   - backend/routes/travel_invoices.js:
//       /invoices/:id/pdf               → event='download', documentType='TravelInvoice'
//   - backend/routes/travel_quotes_public.js:
//       GET /quote/:shareToken          → event='view',     documentType='TravelQuote'
//   - backend/lib/shareLinkPolicy.js — caller-driven; not invoked here directly
//     because the policy module is pure (no Prisma); the wire-up lives in the
//     route that mints the link.
//
// Privacy note: viewerEmail + ipAddress are PII. They're stored only in the
// `details` JSON blob (already permitted under PRD §11 — audit metadata is
// retained for compliance). The audit-viewer page redacts them by default
// and only surfaces them to ADMIN actors with `audit:view-pii` permission
// (implemented in the audit-viewer middleware).

const { writeAudit } = require("./audit");

const EVENT_TO_ACTION = {
  view: "DOCUMENT_VIEW",
  download: "DOCUMENT_DOWNLOAD",
  share: "DOCUMENT_SHARE",
};

const ALLOWED_EVENTS = Object.keys(EVENT_TO_ACTION);

// recordDocumentAccess(params) → Promise<void>
//
// Drops a per-document audit row. Never throws — wraps every call in try/catch
// and logs via console.warn so the calling route handler can safely run this
// without an explicit `.catch()` chain.
async function recordDocumentAccess(params) {
  try {
    const p = params || {};
    if (!p.tenantId) {
      // Tenant scope is required for the per-tenant hash chain. Best-effort:
      // log + no-op so the caller doesn't fall over.
      console.warn(
        "[documentAccessAudit] missing tenantId — skipping audit row",
      );
      return;
    }
    if (!p.event || !ALLOWED_EVENTS.includes(p.event)) {
      console.warn(
        `[documentAccessAudit] invalid event=${p.event} — must be one of ${ALLOWED_EVENTS.join("|")}`,
      );
      return;
    }
    if (!p.documentType || typeof p.documentType !== "string") {
      console.warn(
        "[documentAccessAudit] documentType must be a non-empty string",
      );
      return;
    }
    if (p.documentId == null) {
      console.warn(
        "[documentAccessAudit] documentId is required (use the row primary key)",
      );
      return;
    }

    const action = EVENT_TO_ACTION[p.event];

    // The `details` blob carries the document-type discriminator + viewer
    // context. Stays small (<1KB) so the audit table doesn't bloat.
    const details = {
      documentType: p.documentType,
      event: p.event,
    };
    if (p.viewerEmail) details.viewerEmail = String(p.viewerEmail).slice(0, 200);
    if (p.ipAddress) details.ipAddress = String(p.ipAddress).slice(0, 64);
    if (p.userAgent) details.userAgent = String(p.userAgent).slice(0, 200);
    if (p.shareTokenId) {
      // Truncate share-token IDs to first 8 chars + last 4 so the audit row
      // is correlatable with the active share link without leaking the full
      // bearer secret to anyone with audit:view permission.
      const t = String(p.shareTokenId);
      details.shareTokenId =
        t.length > 16 ? `${t.slice(0, 8)}...${t.slice(-4)}` : t;
    }
    if (p.extra && typeof p.extra === "object") {
      Object.assign(details, p.extra);
    }

    // Anonymous viewers (no JWT) → userId=null + actorType=customer so the
    // audit-viewer can distinguish customer share-link visits from operator
    // accesses. Falls back to 'user' when userId is provided.
    const opts =
      p.userId == null ? { actorType: "customer" } : undefined;

    await writeAudit(
      p.documentType,
      action,
      p.documentId,
      p.userId == null ? null : Number(p.userId),
      Number(p.tenantId),
      details,
      opts,
    );
  } catch (e) {
    // Fail-soft — audit row was unwritable for some reason. Log + move on so
    // the document fetch still completes.
    console.warn(
      `[documentAccessAudit] failed to record ${params && params.event} for ${params && params.documentType}#${params && params.documentId}: ${e && e.message}`,
    );
  }
}

module.exports = {
  recordDocumentAccess,
  EVENT_TO_ACTION,
  ALLOWED_EVENTS,
};
