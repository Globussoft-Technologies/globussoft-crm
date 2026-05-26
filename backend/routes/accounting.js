/**
 * Accounting Integrations — QuickBooks / Xero / Tally
 * ----------------------------------------------------
 * Multi-tenant scaffolding for syncing CRM Invoices and Expenses to external
 * accounting systems. All sync endpoints currently STUB the external calls
 * and only persist an AccountingSync audit record. Real integrations would
 * require the following SDKs / endpoints:
 *
 *   QuickBooks Online:
 *     - intuit-oauth          (OAuth2 token exchange + refresh)
 *     - node-quickbooks       (Invoice / Bill / Vendor APIs)
 *     - Realm ID + Bearer access token per tenant
 *
 *   Xero:
 *     - xero-node             (OAuth2 + Accounting API)
 *     - xeroTenantId header on every request
 *
 *   Tally (TallyPrime / Tally.ERP 9):
 *     - HTTP POST XML envelopes to the Tally ODBC port (default 9000)
 *     - Local network reachability required (no cloud OAuth)
 *
 * Credentials are stored in the existing `Integration` model
 * (provider + token + JSON settings) keyed by tenantId. Sync state is tracked
 * in `AccountingSync` (provider, entityType, entityId, externalId, tenantId).
 *
 * Webhook receiver is intentionally a no-op log (idempotency, signature
 * verification and event dispatch are deferred until real APIs are wired).
 */

const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

const SUPPORTED_PROVIDERS = ["quickbooks", "xero", "tally"];

const providerKey = (p) => String(p || "").toLowerCase();

const parseSettings = (raw) => {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const requireProvider = (req, res) => {
  const provider = providerKey(req.params.provider);
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `Unsupported provider '${req.params.provider}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}` });
    return null;
  }
  return provider;
};

// ─────────────────────────────────────────────────────────────────────────
// GET /api/accounting/stats — tenant-wide AccountingSync rollup.
//
// CRM polish — first /stats endpoint on this route. Read-only KPI surface
// for the finance integrations dashboard. Mirrors billing/stats and
// travel-suppliers/stats posture (same JWT auth, same ?from/?to bounds,
// same INVALID_DATE 400 shape, no audit row).
//
// Powers the integrations dashboard header strip ("87 sync attempts ·
// 100% success · 42 tally · 35 quickbooks · 10 xero · 56 Invoice · 31
// Expense · last sync 12m ago") — without this the frontend has to fire
// N+1 round-trips (list + count by provider × 3 + count by entityType
// × 3 + a separate max(syncedAt) probe).
//
// SCHEMA DRIFT NOTE — AccountingSync's actual columns (verified against
// prisma/schema.prisma line 2442): id, provider, entityType, entityId,
// externalId, syncedAt, tenantId. No `status`, `recordsSynced`,
// `errorMessage`, or `createdAt` field. The original gap-card response
// shape assumed those columns; this implementation pins to the schema:
//   - `byEntityType` substitutes for `byStatus` (Invoice/Expense/Customer
//     are the live entityType values per recordSync() callers in this
//     file). Every row recorded in AccountingSync represents a
//     SUCCESSFUL upsert (the route only writes the row AFTER the
//     external-system stub returns), so:
//   - `successRate` = 1.0 when total > 0, null when total = 0 (kept in
//     the envelope for forward-compat when a `status` column lands).
//   - `totalRecordsSynced` = total (1 row = 1 successfully synced
//     record in the current schema; will diverge once batch-sync
//     bookkeeping arrives).
//   - `lastSuccessfulSyncAt` = max(syncedAt) — all rows are successful
//     by construction.
//
// Query params:
//   ?from / ?to — optional ISO date bounds on syncedAt (the only
//                 timestamp column available — there's no createdAt on
//                 AccountingSync). Invalid → 400 INVALID_DATE.
//
// Response envelope:
//   { total, byEntityType, byProvider, successRate, totalRecordsSynced,
//     lastSuccessfulSyncAt }
//
// Express route ordering: literal-path /stats is declared BEFORE the
// /:provider family so the /providers + /stats literal handlers win
// before the parameterized routes have a chance to match.
// ─────────────────────────────────────────────────────────────────────────
router.get("/stats", verifyToken, async (req, res) => {
  try {
    // Validate optional date bounds independently so a bad ?from doesn't
    // get masked by a missing ?to (mirrors billing-stats / travel-supplier
    // -stats validation order).
    const syncedAtClause = {};
    if (req.query.from !== undefined) {
      const fromDate = new Date(req.query.from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "invalid from date", code: "INVALID_DATE" });
      }
      syncedAtClause.gte = fromDate;
    }
    if (req.query.to !== undefined) {
      const toDate = new Date(req.query.to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "invalid to date", code: "INVALID_DATE" });
      }
      syncedAtClause.lte = toDate;
    }

    const where = { tenantId: req.user.tenantId };
    if (Object.keys(syncedAtClause).length > 0) {
      where.syncedAt = syncedAtClause;
    }

    // Pull only the columns we need to aggregate — avoids dragging the
    // full row (externalId payloads etc.) into memory just to count.
    const rows = await prisma.accountingSync.findMany({
      where,
      select: { provider: true, entityType: true, syncedAt: true },
    });

    const total = rows.length;
    const byProvider = {};
    const byEntityType = {};
    let lastSyncedAt = null;

    for (const r of rows) {
      const provider = r.provider || "_unknown";
      byProvider[provider] = (byProvider[provider] || 0) + 1;

      const entityType = r.entityType || "_unknown";
      byEntityType[entityType] = (byEntityType[entityType] || 0) + 1;

      if (r.syncedAt) {
        const ts = r.syncedAt instanceof Date ? r.syncedAt : new Date(r.syncedAt);
        if (lastSyncedAt === null || ts > lastSyncedAt) {
          lastSyncedAt = ts;
        }
      }
    }

    // Half-up 2dp rounding helper — mirrors billing-stats. EPSILON tweak
    // collapses JS float noise (0.1+0.2 type artefacts).
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

    // successRate: every row in AccountingSync is a successful sync by
    // construction (the route only persists AFTER the external upsert
    // returns). Future: when a `status` column lands, this becomes
    // successCount / total.
    const successRate = total === 0 ? null : round2(1.0);

    res.json({
      total,
      byEntityType,
      byProvider,
      successRate,
      totalRecordsSynced: total,
      lastSuccessfulSyncAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[accounting/stats]", err);
    res.status(500).json({ error: "Failed to compute accounting stats" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/accounting/providers
// Return supported providers and per-tenant connection status.
// ─────────────────────────────────────────────────────────────────────────
router.get("/providers", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const integrations = await prisma.integration.findMany({
      where: { tenantId, provider: { in: SUPPORTED_PROVIDERS } },
    });

    const status = {
      quickbooks: { connected: false },
      xero: { connected: false },
      tally: { connected: false },
    };

    for (const intg of integrations) {
      const settings = parseSettings(intg.settings);
      const connected = !!intg.isActive;
      if (intg.provider === "quickbooks") {
        status.quickbooks = { connected, accountId: settings.realmId || null };
      } else if (intg.provider === "xero") {
        status.xero = { connected, tenantId: settings.xeroTenantId || null };
      } else if (intg.provider === "tally") {
        status.tally = { connected };
      }
    }

    res.json(status);
  } catch (err) {
    console.error("[accounting] providers error:", err);
    res.status(500).json({ error: "Failed to load providers" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/accounting/:provider/connect
// Persist provider credentials in the Integration model. The expected body
// shape varies per provider (see JSDoc at top of file).
// ─────────────────────────────────────────────────────────────────────────
router.post("/:provider/connect", verifyToken, async (req, res) => {
  const provider = requireProvider(req, res);
  if (!provider) return;

  try {
    const tenantId = req.user.tenantId;
    let token = null;
    const settings = {};

    if (provider === "quickbooks") {
      const { accessToken, refreshToken, realmId } = req.body || {};
      if (!accessToken || !refreshToken || !realmId) {
        return res.status(400).json({ error: "quickbooks requires accessToken, refreshToken, realmId" });
      }
      token = accessToken;
      settings.refreshToken = refreshToken;
      settings.realmId = realmId;
    } else if (provider === "xero") {
      const { accessToken, refreshToken, xeroTenantId } = req.body || {};
      if (!accessToken || !refreshToken || !xeroTenantId) {
        return res.status(400).json({ error: "xero requires accessToken, refreshToken, xeroTenantId" });
      }
      token = accessToken;
      settings.refreshToken = refreshToken;
      settings.xeroTenantId = xeroTenantId;
    } else if (provider === "tally") {
      const { url, port, companyName } = req.body || {};
      if (!url || !port || !companyName) {
        return res.status(400).json({ error: "tally requires url, port, companyName" });
      }
      // Tally is LAN-based; "token" left null, all config in settings.
      settings.url = url;
      settings.port = port;
      settings.companyName = companyName;
    }

    const integration = await prisma.integration.upsert({
      where: { tenantId_provider: { tenantId, provider } },
      update: { token, isActive: true, settings: JSON.stringify(settings) },
      create: { provider, token, isActive: true, settings: JSON.stringify(settings), tenantId },
    });

    res.json({ success: true, provider, id: integration.id });
  } catch (err) {
    console.error("[accounting] connect error:", err);
    res.status(500).json({ error: "Failed to connect provider" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/accounting/:provider/disconnect
// Mark provider integration inactive and clear stored token.
// ─────────────────────────────────────────────────────────────────────────
router.post("/:provider/disconnect", verifyToken, async (req, res) => {
  const provider = requireProvider(req, res);
  if (!provider) return;

  try {
    const tenantId = req.user.tenantId;
    const existing = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider } },
    });
    if (!existing) return res.status(404).json({ error: "Integration not found" });

    await prisma.integration.update({
      where: { id: existing.id },
      data: { isActive: false, token: null },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[accounting] disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect provider" });
  }
});

// Internal helper — record an AccountingSync row (STUB, no external call).
async function recordSync({ provider, entityType, entityId, tenantId, payload }) {
  const externalId = `STUB_${entityId}_${Date.now()}`;
  console.log(`[accounting] STUB ${provider} sync ${entityType}#${entityId} (tenant ${tenantId}) ->`, externalId, JSON.stringify(payload));

  const sync = await prisma.accountingSync.upsert({
    where: {
      provider_entityType_entityId_tenantId: { provider, entityType, entityId, tenantId },
    },
    update: { externalId, syncedAt: new Date() },
    create: { provider, entityType, entityId, externalId, tenantId },
  });

  return sync;
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/accounting/:provider/sync/invoice/:id
// ─────────────────────────────────────────────────────────────────────────
router.post("/:provider/sync/invoice/:id", verifyToken, async (req, res) => {
  const provider = requireProvider(req, res);
  if (!provider) return;

  try {
    const tenantId = req.user.tenantId;
    const invoiceId = parseInt(req.params.id, 10);
    if (Number.isNaN(invoiceId)) return res.status(400).json({ error: "Invalid invoice id" });

    const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const sync = await recordSync({
      provider,
      entityType: "Invoice",
      entityId: invoice.id,
      tenantId,
      payload: { invoiceNum: invoice.invoiceNum, amount: invoice.amount, status: invoice.status, dueDate: invoice.dueDate },
    });

    res.json({ success: true, externalId: sync.externalId });
  } catch (err) {
    console.error("[accounting] sync invoice error:", err);
    res.status(500).json({ error: "Failed to sync invoice" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/accounting/:provider/sync/expense/:id
// ─────────────────────────────────────────────────────────────────────────
router.post("/:provider/sync/expense/:id", verifyToken, async (req, res) => {
  const provider = requireProvider(req, res);
  if (!provider) return;

  try {
    const tenantId = req.user.tenantId;
    const expenseId = parseInt(req.params.id, 10);
    if (Number.isNaN(expenseId)) return res.status(400).json({ error: "Invalid expense id" });

    const expense = await prisma.expense.findFirst({ where: { id: expenseId, tenantId } });
    if (!expense) return res.status(404).json({ error: "Expense not found" });

    const sync = await recordSync({
      provider,
      entityType: "Expense",
      entityId: expense.id,
      tenantId,
      payload: { title: expense.title, amount: expense.amount, category: expense.category, status: expense.status, expenseDate: expense.expenseDate },
    });

    res.json({ success: true, externalId: sync.externalId });
  } catch (err) {
    console.error("[accounting] sync expense error:", err);
    res.status(500).json({ error: "Failed to sync expense" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/accounting/:provider/sync/all
// Bulk sync all unsynced invoices for the current tenant.
// ─────────────────────────────────────────────────────────────────────────
router.post("/:provider/sync/all", verifyToken, async (req, res) => {
  const provider = requireProvider(req, res);
  if (!provider) return;

  try {
    const tenantId = req.user.tenantId;

    const [invoices, alreadySynced] = await Promise.all([
      prisma.invoice.findMany({ where: { tenantId } }),
      prisma.accountingSync.findMany({
        where: { provider, entityType: "Invoice", tenantId },
        select: { entityId: true },
      }),
    ]);

    const syncedIds = new Set(alreadySynced.map((s) => s.entityId));
    const toSync = invoices.filter((inv) => !syncedIds.has(inv.id));

    const results = [];
    for (const invoice of toSync) {
      const sync = await recordSync({
        provider,
        entityType: "Invoice",
        entityId: invoice.id,
        tenantId,
        payload: { invoiceNum: invoice.invoiceNum, amount: invoice.amount, status: invoice.status },
      });
      results.push({ invoiceId: invoice.id, externalId: sync.externalId });
    }

    res.json({ success: true, syncedCount: results.length, skippedCount: invoices.length - results.length, results });
  } catch (err) {
    console.error("[accounting] sync all error:", err);
    res.status(500).json({ error: "Failed to bulk sync invoices" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/accounting/:provider/synced  (paginated)
// ─────────────────────────────────────────────────────────────────────────
router.get("/:provider/synced", verifyToken, async (req, res) => {
  const provider = requireProvider(req, res);
  if (!provider) return;

  try {
    const tenantId = req.user.tenantId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const where = { provider, tenantId };

    const [total, items] = await Promise.all([
      prisma.accountingSync.count({ where }),
      prisma.accountingSync.findMany({
        where,
        orderBy: { syncedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ page, pageSize, total, items });
  } catch (err) {
    console.error("[accounting] synced list error:", err);
    res.status(500).json({ error: "Failed to load sync history" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/accounting/webhook/:provider  (PUBLIC — listed in openPaths)
// Stub receiver. Real impl would verify HMAC signature, parse provider event
// envelope, then update AccountingSync / mirror invoice status changes.
// ─────────────────────────────────────────────────────────────────────────
router.post("/webhook/:provider", async (req, res) => {
  const provider = providerKey(req.params.provider);
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: "Unsupported provider" });
  }
  try {
    console.log(`[accounting] webhook received from ${provider}:`, JSON.stringify(req.body || {}).slice(0, 2000));
    res.json({ success: true, received: true });
  } catch (err) {
    console.error("[accounting] webhook error:", err);
    res.status(500).json({ error: "Webhook handler failed" });
  }
});

module.exports = router;
