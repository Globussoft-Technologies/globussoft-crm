// Admin trigger endpoint — template
//
// Append this handler to the existing area router (e.g. backend/routes/billing.js
// for recurring-invoice). Replace <area>, <engine>, <Engine>, <RUN_FAILED-CODE>,
// and the counters in the response shape.
//
// Two variants below: standard ADMIN-only, and the GDPR-style with the
// confirmDestructive body guard. Pick one based on whether the operation
// is destructive.

const { verifyToken, verifyRole } = require('../middleware/auth');
const { runForTenant } = require('../cron/<engine>');

// ── Variant 1: Standard ADMIN-only ────────────────────────────────────

// POST /api/<area>/run — admin-gated manual trigger for cron/<engine>.js
//
// Mirror of /api/forecasting/snapshot/run + /api/billing/recurring/run +
// /api/email/scheduled/run (admin-gated, per-tenant scope, predictable
// envelope). Calls the engine's per-tenant function with the requesting
// admin's tenantId so cron + manual paths can never drift on dedup
// semantics.
router.post('/run', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const result = await runForTenant({ id: req.user.tenantId });
    res.json({
      success: true,
      tenantId: req.user.tenantId,
      // ...engine-specific counters: processed, sent, skipped, generated, etc.
      ...result,
      errors: result.errors || [],
    });
  } catch (err) {
    console.error('[<area>] manual trigger failed:', err);
    res.status(500).json({
      success: false,
      tenantId: req.user.tenantId,
      error: err.message,
      code: '<AREA>_RUN_FAILED',
    });
  }
});

// ── Variant 2: Destructive + confirmDestructive guard + AuditLog ──────

// POST /api/gdpr/retention/run — admin-gated, confirmation-required GDPR sweep
//
// Triple-layer guard: verifyToken + verifyRole(['ADMIN']) + body
// confirmDestructive:true. Without confirmDestructive=true, returns 400
// CONFIRMATION_REQUIRED with no rows deleted and no audit row written.
//
// Each deleted row gets an AuditLog entry (action='DELETE', via='manual')
// for GDPR Art. 30 compliance.
router.post('/retention/run', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  if (req.body?.confirmDestructive !== true) {
    return res.status(400).json({
      success: false,
      error: 'This endpoint deletes data per the retention policy. ' +
             'Set body.confirmDestructive=true to actually delete.',
      code: 'CONFIRMATION_REQUIRED',
    });
  }

  try {
    const result = await runForTenant({
      id: req.user.tenantId,
      auditUserId: req.user.userId, // engine writes audit rows attributed here
      via: 'manual', // engine puts this in details.via so cron/manual are distinguishable
    });
    res.json({
      success: true,
      tenantId: req.user.tenantId,
      deleted: result.deleted || 0,
      preserved: result.preserved || 0,
      errors: result.errors || [],
    });
  } catch (err) {
    console.error('[gdpr] retention manual trigger failed:', err);
    res.status(500).json({
      success: false,
      tenantId: req.user.tenantId,
      error: err.message,
      code: 'RETENTION_RUN_FAILED',
    });
  }
});

// ── Wellness-vertical variant: verifyWellnessRole instead of verifyRole ──

// POST /api/wellness/<engine>/run — wellness admin/manager only
//
// Wellness has its own role hierarchy (admin / manager / doctor /
// professional / telecaller / helper). Use verifyWellnessRole helper
// so the endpoint matches sibling /api/wellness/* routes.

const { verifyWellnessRole } = require('../middleware/auth'); // or wherever it lives
router.post('/ops/run', verifyToken, verifyWellnessRole(['admin', 'manager']), async (req, res) => {
  try {
    const result = await runForTenant({ id: req.user.tenantId });
    res.json({
      success: true,
      tenantId: req.user.tenantId,
      ...result,
      errors: result.errors || [],
    });
  } catch (err) {
    console.error('[wellness/ops] manual trigger failed:', err);
    res.status(500).json({
      success: false,
      tenantId: req.user.tenantId,
      error: err.message,
      code: 'WELLNESS_OPS_RUN_FAILED',
    });
  }
});
