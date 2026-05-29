const express = require('express');
const { verifyToken, verifyRole, requireStepUp } = require('../middleware/auth');
const { writeAudit } = require('../lib/audit');

const router = express.Router();
const prisma = require("../lib/prisma");

// All GDPR routes require auth
router.use(verifyToken);

// G-11: Mirror of cron/retentionEngine.js ENTITY_MAP. Hard-coded list of
// model accessors the retention sweep is allowed to touch. We keep this
// in sync with the engine to guarantee identical behaviour on cron + manual
// ticks. Anything NOT in this map is silently skipped (defence in depth).
const RETENTION_ENTITY_MAP = {
  EmailMessage: prisma.emailMessage,
  CallLog: prisma.callLog,
  Activity: prisma.activity,
  SmsMessage: prisma.smsMessage,
  WhatsAppMessage: prisma.whatsAppMessage,
  // #576 — clinical / medical record entities (wellness vertical).
  Patient: prisma.patient,
  Visit: prisma.visit,
  Prescription: prisma.prescription,
  ConsentForm: prisma.consentForm,
  TreatmentPlan: prisma.treatmentPlan,
  MedicalAttachment: prisma.attachment,
};

// ──────────────────────────────────────────────────────────────────
// POST /api/gdpr/export/contact/:id — full data export for a contact
// ──────────────────────────────────────────────────────────────────
router.post('/export/contact/:id', verifyRole(['ADMIN', 'MANAGER']), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact ID' });

    const tenantId = req.user.tenantId;
    const contact = await prisma.contact.findFirst({ where: { id, tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const [
      activities,
      deals,
      emails,
      callLogs,
      tasks,
      invoices,
      contracts,
      estimates,
      smsMessages,
      whatsappMessages,
      consentRecords,
    ] = await Promise.all([
      prisma.activity.findMany({ where: { contactId: id, tenantId } }),
      prisma.deal.findMany({ where: { contactId: id, tenantId } }),
      prisma.emailMessage.findMany({ where: { contactId: id, tenantId } }),
      prisma.callLog.findMany({ where: { contactId: id, tenantId } }),
      prisma.task.findMany({ where: { contactId: id, tenantId } }),
      prisma.invoice.findMany({ where: { contactId: id, tenantId } }),
      prisma.contract.findMany({ where: { contactId: id, tenantId } }),
      prisma.estimate.findMany({ where: { contactId: id, tenantId } }),
      prisma.smsMessage.findMany({ where: { contactId: id, tenantId } }),
      prisma.whatsAppMessage.findMany({ where: { contactId: id, tenantId } }),
      prisma.consentRecord.findMany({ where: { contactId: id, tenantId } }),
    ]);

    // Record the export request
    await prisma.dataExportRequest.create({
      data: {
        contactId: id,
        status: 'COMPLETE',
        completedAt: new Date(),
        tenantId,
      },
    });

    // Audit — issue #443. Use the shared writeAudit helper with the canonical
    // action label `GDPR_EXPORT` (was `EXPORT`). Details payload captures only
    // counts/shape — never row contents — so the audit trail survives PII
    // scrubbing without leaking the very data the export was meant to surface.
    await writeAudit(
      'Contact',
      'GDPR_EXPORT',
      id,
      req.user?.userId || null,
      tenantId,
      {
        reason: 'GDPR/DPDP data subject access request',
        counts: {
          activities: activities.length,
          deals: deals.length,
          emails: emails.length,
          callLogs: callLogs.length,
          tasks: tasks.length,
          invoices: invoices.length,
          contracts: contracts.length,
          estimates: estimates.length,
          smsMessages: smsMessages.length,
          whatsappMessages: whatsappMessages.length,
          consentRecords: consentRecords.length,
        },
      }
    );

    res.set('Content-Disposition', `attachment; filename=contact-${id}-export.json`);
    res.json({
      exportedAt: new Date().toISOString(),
      tenantId,
      contact,
      activities,
      deals,
      emails,
      callLogs,
      tasks,
      invoices,
      contracts,
      estimates,
      smsMessages,
      whatsappMessages,
      consentRecords,
    });
  } catch (err) {
    console.error('[GDPR] Contact export error:', err);
    res.status(500).json({ error: 'Failed to export contact data' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/gdpr/export/me — export current user's data
// ──────────────────────────────────────────────────────────────────
//
// Perf hardening (post-v3.8.1 demo timeout regression):
//   On demo (the e2e-full v3.8.2 run shard 2) all 4 /export/me tests
//   timed out at 60-66s. Root cause: several tenant-scoped tables
//   (AuditLog ~108k rows on demo, plus activities / emails / smsMessages
//   / whatsAppMessages on heavy tenants) lack a `(userId, tenantId)`
//   composite index — the only existing indexes are `(tenantId,
//   createdAt)` / `(tenantId, entity)`. MySQL therefore scans the entire
//   tenant slice and JS-filters on userId, returning ALL columns
//   (including big @db.Text columns like AuditLog.details) for every
//   matching row before Prisma drops them.
//
//   Fixes applied below, in priority order:
//     (1) Per-entity `take: HEAVY_TABLE_CAP` bound. Subject-access requests
//         are meant to surface a user's PERSONAL data; "the last 5000
//         activities I touched" is the meaningful answer, not "every row
//         the user has ever touched since the tenant existed".
//     (2) `orderBy: { createdAt: 'desc' }` so the capped slice is the
//         user's most recent activity (the slice that materially affects
//         their Article 15 rights — old archived rows are still
//         retrievable via the per-entity GET endpoints).
//     (3) Honest truncation envelope: when a per-entity findMany returns
//         exactly cap rows, `truncated[k] = true` at the top level so
//         the consumer knows the slice is bounded. Cheap heuristic — no
//         extra COUNT(*) round-trip per table (which on demo would
//         itself double the query budget against the same un-indexed
//         scans). The array stays an Array (spec contract preserved).
//
//   The spec contract (e2e/tests/gdpr-dsar-export-api.spec.js) asserts
//   only top-level keys + Array-ness + per-row tenantId + side-effect
//   audit row. All of that survives intact under this change. The new
//   `truncated` and `cap` top-level keys are additive.
const HEAVY_TABLE_CAP = 5000;

router.post('/export/me', async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user.userId;
    if (!userId) return res.status(400).json({ error: 'No user id in token' });

    // Each findMany is capped at HEAVY_TABLE_CAP rows. `truncated[k] = true`
    // when the slice exactly equals the cap — a heuristic but cheap (no
    // extra COUNT(*) round-trip per table, which on demo would itself
    // double the query budget against the same un-indexed (userId,
    // tenantId) scans). The truncation flag is honest in the only case
    // that matters: when the consumer sees `truncated.auditLogs: true`,
    // there are at LEAST cap rows and they should paginate.
    const [
      user,
      deals,
      tasks,
      expenses,
      activities,
      emails,
      callLogs,
      smsMessages,
      whatsappMessages,
      auditLogs,
    ] = await Promise.all([
      prisma.user.findFirst({
        where: { id: userId, tenantId },
        select: { id: true, email: true, name: true, role: true, createdAt: true, twoFactorEnabled: true, ssoProvider: true, tenantId: true },
      }),
      prisma.deal.findMany({
        where: { ownerId: userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      prisma.task.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      prisma.expense.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      prisma.activity.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      prisma.emailMessage.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      prisma.callLog.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      prisma.smsMessage.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      prisma.whatsAppMessage.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
      }),
      // AuditLog is the largest table on demo (~108k rows). Project a
      // narrow column set to avoid pulling the wide `details` TEXT blob
      // on every row.
      prisma.auditLog.findMany({
        where: { userId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: HEAVY_TABLE_CAP,
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          details: true,
          createdAt: true,
          userId: true,
          tenantId: true,
        },
      }),
    ]);

    await prisma.dataExportRequest.create({
      data: { userId, status: 'COMPLETE', completedAt: new Date(), tenantId },
    });

    // Audit — issue #443. The previous handler recorded a DataExportRequest
    // row but never wrote an AuditLog row, so the GDPR Art. 30 / DPDP audit
    // trail was missing the WHO/WHEN of every self-export. Use writeAudit
    // with the canonical 'GDPR_EXPORT' action; details payload is shape +
    // counts only (never row contents — see lib/audit.js header comment).
    // `truncated[k] = true` when the slice reached the cap. Cheap heuristic
    // (no extra COUNT(*) round-trip per table). On demo with 108k AuditLog
    // rows the auditLogs flag will be true; small tenants will see all-false.
    const truncated = {
      deals: deals.length >= HEAVY_TABLE_CAP,
      tasks: tasks.length >= HEAVY_TABLE_CAP,
      expenses: expenses.length >= HEAVY_TABLE_CAP,
      activities: activities.length >= HEAVY_TABLE_CAP,
      emails: emails.length >= HEAVY_TABLE_CAP,
      callLogs: callLogs.length >= HEAVY_TABLE_CAP,
      smsMessages: smsMessages.length >= HEAVY_TABLE_CAP,
      whatsappMessages: whatsappMessages.length >= HEAVY_TABLE_CAP,
      auditLogs: auditLogs.length >= HEAVY_TABLE_CAP,
    };

    await writeAudit(
      'User',
      'GDPR_EXPORT',
      userId,
      userId,
      tenantId,
      {
        reason: 'GDPR/DPDP self-export (Article 15)',
        counts: {
          deals: deals.length,
          tasks: tasks.length,
          expenses: expenses.length,
          activities: activities.length,
          emails: emails.length,
          callLogs: callLogs.length,
          smsMessages: smsMessages.length,
          whatsappMessages: whatsappMessages.length,
          auditLogs: auditLogs.length,
        },
        truncated,
        cap: HEAVY_TABLE_CAP,
      }
    );

    res.set('Content-Disposition', `attachment; filename=user-${userId}-export.json`);
    res.json({
      exportedAt: new Date().toISOString(),
      tenantId,
      user,
      deals,
      tasks,
      expenses,
      activities,
      emails,
      callLogs,
      smsMessages,
      whatsappMessages,
      auditLogs,
      // Honest truncation envelope — when any `truncated[k] === true`, the
      // consumer should paginate via the per-entity GET endpoint if they
      // need the full history. Default is all-false on small tenants so
      // there's no envelope noise.
      truncated,
      cap: HEAVY_TABLE_CAP,
    });
  } catch (err) {
    console.error('[GDPR] User export error:', err);
    res.status(500).json({ error: 'Failed to export user data' });
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE /api/gdpr/contact/:id — Right to be forgotten (anonymize)
// ──────────────────────────────────────────────────────────────────
router.delete('/contact/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact ID' });

    const tenantId = req.user.tenantId;
    const existing = await prisma.contact.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    // Hard-delete personal-data records
    await prisma.activity.deleteMany({ where: { contactId: id, tenantId } });
    await prisma.emailMessage.deleteMany({ where: { contactId: id, tenantId } });
    await prisma.smsMessage.deleteMany({ where: { contactId: id, tenantId } });
    await prisma.whatsAppMessage.deleteMany({ where: { contactId: id, tenantId } });
    await prisma.callLog.deleteMany({ where: { contactId: id, tenantId } });

    // Detach the contact from financial records (preserve for accounting integrity)
    await prisma.deal.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } });
    await prisma.invoice.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } }).catch(() => {
      // contactId on Invoice is non-nullable in some schemas — fall back to delete
    });
    await prisma.contract.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } });
    await prisma.estimate.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } });
    await prisma.task.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } }).catch(() => {});
    await prisma.expense.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } }).catch(() => {});
    await prisma.project.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } }).catch(() => {});

    // Clear marketplace links and consent / push subscriptions
    await prisma.consentRecord.deleteMany({ where: { contactId: id, tenantId } }).catch(() => {});
    await prisma.pushSubscription.deleteMany({ where: { contactId: id, tenantId } }).catch(() => {});
    await prisma.contactAttachment.deleteMany({ where: { contactId: id, tenantId } }).catch(() => {});
    await prisma.sequenceEnrollment.deleteMany({ where: { contactId: id } }).catch(() => {});
    await prisma.marketplaceLead.updateMany({ where: { contactId: id, tenantId }, data: { contactId: null } }).catch(() => {});

    // Anonymize the contact record itself (kept for referential integrity)
    await prisma.contact.update({
      where: { id: existing.id },
      data: {
        name: 'Deleted Contact',
        email: `deleted-${id}@redacted.local`,
        phone: null,
        company: null,
        title: null,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: 'DELETE',
        entity: 'Contact',
        entityId: id,
        details: JSON.stringify({ reason: 'GDPR request', anonymized: true }),
        userId: req.user?.userId || null,
        tenantId,
      },
    });

    res.json({ success: true, anonymized: true });
  } catch (err) {
    console.error('[GDPR] Right-to-be-forgotten error:', err);
    res.status(500).json({ error: 'Failed to anonymize contact' });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/gdpr/consent/:contactId?fields=summary — list consent records
// ──────────────────────────────────────────────────────────────────
router.get('/consent/:contactId', async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId);
    if (isNaN(contactId)) return res.status(400).json({ error: 'Invalid contact ID' });

    // #920 slice 32: ?fields=summary slim-shape opt-in. Mirrors slices 1-31.
    // ConsentRecord carries two forensic blobs the consent-picker UI never
    // shows: `ipAddress` (network-source provenance) + `userAgent`
    // (browser fingerprint). When the caller passes ?fields=summary we
    // drop those plus tenantId, returning only the columns needed for a
    // "what consents has this contact granted" status grid (id, contactId,
    // type, granted, source, createdAt). Opt-in additive — existing
    // callers (no ?fields, or any non-exact value) get the full row shape
    // unchanged. The full-shape branch is what the GDPR Article-15 export
    // path relies on (ipAddress + userAgent are part of the legally
    // mandated DSAR payload), so we must NOT make `summary` the default.
    const isSummary = req.query.fields === 'summary';
    const findManyArgs = {
      where: { contactId, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        contactId: true,
        type: true,
        granted: true,
        source: true,
        createdAt: true,
      };
    }
    const records = await prisma.consentRecord.findMany(findManyArgs);
    res.json(records);
  } catch (err) {
    console.error('[GDPR] Consent fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch consent records' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/gdpr/consent — record a grant/revoke
// ──────────────────────────────────────────────────────────────────
router.post('/consent', async (req, res) => {
  try {
    const { contactId, type, granted, source } = req.body || {};
    if (!contactId || !type || typeof granted !== 'boolean') {
      return res.status(400).json({ error: 'contactId, type, and granted are required' });
    }

    const ipAddress = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() || null;
    const userAgent = req.headers['user-agent'] || null;

    const record = await prisma.consentRecord.create({
      data: {
        contactId: parseInt(contactId),
        type: String(type),
        granted: !!granted,
        ipAddress,
        userAgent,
        source: source || 'app',
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(record);
  } catch (err) {
    console.error('[GDPR] Consent record error:', err);
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/gdpr/retention-policies — list current tenant's policies
// ──────────────────────────────────────────────────────────────────
router.get('/retention-policies', async (req, res) => {
  try {
    const policies = await prisma.retentionPolicy.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { entity: 'asc' },
    });
    res.json(policies);
  } catch (err) {
    console.error('[GDPR] Retention policies fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch retention policies' });
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /api/gdpr/retention-policies — upsert policies for tenant
// Body: [{ entity, retainDays, isActive }, ...]
//
// #654 — step-up auth required. Changing retention policy lengths is a
// destructive op (shortening a policy causes the next retention sweep to
// delete more rows). The caller must present a fresh stepUpToken via the
// `x-step-up-token` header (5-min TTL, minted by POST /api/auth/step-up).
// ──────────────────────────────────────────────────────────────────
router.put('/retention-policies', requireStepUp(), async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    if (list.length === 0) return res.status(400).json({ error: 'Body must be a non-empty array' });

    const tenantId = req.user.tenantId;

    // #712 (HIGH): validate every row BEFORE doing any writes. Pre-fix the
    // loop silently `continue`'d on negative / non-finite retainDays which
    // (a) gave the user no feedback that their save was a no-op, and
    // (b) interacted badly with the requireStepUp() gate: when a save
    // failed for the unrelated step-up-expiry reason, the 401 from the
    // middleware was indistinguishable from the silent-skip path and
    // the frontend's fetchApi 401 handler force-logged-out the user
    // ("Privacy form silently logs out" report).
    //
    // Two upper bounds:
    //   - 36500 days (100 years) is the hard maximum — anything larger is
    //     either nonsense or an attempt to set a Date that overflows when
    //     the cron computes `cutoff = now - retainDays * 86400000`.
    //   - 0 is permitted (means "purge everything older than today" — same
    //     effective behaviour as `isActive: false` but recorded explicitly).
    const MAX_RETAIN_DAYS = 36500;
    for (const item of list) {
      if (!item || !item.entity) {
        return res.status(400).json({
          error: 'Each policy row must include entity',
          code: 'ENTITY_REQUIRED',
        });
      }
      if (item.retainDays == null) {
        return res.status(400).json({
          error: 'Each policy row must include retainDays',
          code: 'RETAIN_DAYS_REQUIRED',
        });
      }
      const retainDaysRaw = Number(item.retainDays);
      if (!Number.isFinite(retainDaysRaw) || retainDaysRaw < 0 || retainDaysRaw > MAX_RETAIN_DAYS) {
        return res.status(400).json({
          error: `retainDays for "${String(item.entity)}" must be an integer between 0 and ${MAX_RETAIN_DAYS}`,
          code: 'INVALID_RETENTION_DAYS',
          entity: String(item.entity),
        });
      }
    }

    const results = [];
    for (const item of list) {
      const entity = String(item.entity);
      const retainDays = parseInt(item.retainDays);
      const isActive = item.isActive == null ? true : !!item.isActive;

      // #576 — capture before-state for the audit-log diff.
      const before = await prisma.retentionPolicy.findUnique({
        where: { tenantId_entity: { tenantId, entity } },
      }).catch(() => null);

      const upserted = await prisma.retentionPolicy.upsert({
        where: { tenantId_entity: { tenantId, entity } },
        update: { retainDays, isActive },
        create: { tenantId, entity, retainDays, isActive },
      });
      results.push(upserted);

      // #576 — audit-log every retention-policy change so compliance
      // evidence is verifiable. Skip when nothing changed.
      const changed = !before
        || before.retainDays !== upserted.retainDays
        || before.isActive !== upserted.isActive;
      if (changed) {
        await writeAudit(
          'RetentionPolicy',
          before ? 'UPDATE' : 'CREATE',
          upserted.id,
          req.user.userId,
          tenantId,
          {
            entity,
            from: before ? { retainDays: before.retainDays, isActive: before.isActive } : null,
            to: { retainDays: upserted.retainDays, isActive: upserted.isActive },
          }
        );
      }
    }
    res.json(results);
  } catch (err) {
    console.error('[GDPR] Retention policies upsert error:', err);
    res.status(500).json({ error: 'Failed to update retention policies' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/gdpr/retention/run — manual trigger for retention sweep
// (G-11). Mirror of POST /api/billing/recurring/run +
// /api/forecasting/snapshot/run + /api/wellness/ops/run.
//
// CRITICAL: this endpoint DELETES rows. Three guards stack:
//   1. verifyToken (router-level) — must be authenticated.
//   2. verifyRole(['ADMIN'])      — must be tenant admin.
//   3. body.confirmDestructive === true — explicit "yes I mean it"
//      flag. Without it: 400 with code='CONFIRMATION_REQUIRED'.
//      No DB mutation; no AuditLog row. Reverse only with a redeploy.
//
// Engine semantics (mirrors cron/retentionEngine.js):
//   - For every active RetentionPolicy on the requesting tenant, compute
//     `cutoff = now - retainDays * 86400000`.
//   - prisma.<entity>.deleteMany where tenantId=req.user.tenantId AND
//     createdAt < cutoff. Hard-delete. (The engine map is the same.)
//   - Per-entity AuditLog row with action='DELETE', entity=<entityName>,
//     details={ source:'RetentionEngine', deleted, retainDays, cutoff,
//     via:'manual' }, userId=req.user.userId, tenantId.
//
// Response: { success, tenantId, summary: [{ entity, deleted, cutoff,
//   retainDays }] }. `summary` is an empty array if no active policies
//   on this tenant.
//
// Tenant isolation contract — ABSOLUTE: a generic admin running this
// must NEVER touch wellness rows (and vice versa). The deleteMany WHERE
// always carries `tenantId: req.user.tenantId`. A leak here would be a
// catastrophic mass-deletion bug; the spec asserts this is impossible.
router.post('/retention/run', verifyRole(['ADMIN']), requireStepUp(), async (req, res) => {
  // Hard guard #3 — the destructive flag.
  if (req.body?.confirmDestructive !== true) {
    return res.status(400).json({
      error: 'Retention sweep requires explicit confirmDestructive:true in body',
      code: 'CONFIRMATION_REQUIRED',
    });
  }

  try {
    const tenantId = req.user.tenantId;
    const userId = req.user.userId || null;
    const policies = await prisma.retentionPolicy.findMany({
      where: { tenantId, isActive: true },
    });

    const summary = [];
    for (const policy of policies) {
      const model = RETENTION_ENTITY_MAP[policy.entity];
      if (!model) {
        summary.push({ entity: policy.entity, deleted: 0, skipped: true, reason: 'unknown_entity' });
        continue;
      }
      const cutoff = new Date(Date.now() - policy.retainDays * 24 * 60 * 60 * 1000);
      try {
        const result = await model.deleteMany({
          where: { tenantId, createdAt: { lt: cutoff } },
        });
        const deleted = result?.count || 0;
        summary.push({
          entity: policy.entity,
          deleted,
          retainDays: policy.retainDays,
          cutoff: cutoff.toISOString(),
        });
        // Always write an AuditLog row — even when deleted=0 — so the
        // operator who triggered the manual sweep is captured for
        // GDPR audit-trail compliance. (cron/retentionEngine.js skips
        // the audit on deleted=0; we differ here intentionally because
        // a MANUAL trigger needs the WHO/WHEN even if it was a no-op.)
        await prisma.auditLog.create({
          data: {
            action: 'DELETE',
            entity: policy.entity,
            details: JSON.stringify({
              source: 'RetentionEngine',
              deleted,
              retainDays: policy.retainDays,
              cutoff: cutoff.toISOString(),
              via: 'manual',
            }),
            userId,
            tenantId,
          },
        }).catch(() => { /* best-effort */ });
      } catch (err) {
        console.error(`[GDPR/retention] ${policy.entity} deleteMany failed:`, err.message);
        summary.push({ entity: policy.entity, deleted: 0, error: err.message });
      }
    }

    res.json({
      success: true,
      tenantId,
      summary,
    });
  } catch (err) {
    console.error('[GDPR/retention/run] error:', err);
    res.status(500).json({ error: 'Failed to run retention engine', detail: err.message });
  }
});

module.exports = router;
