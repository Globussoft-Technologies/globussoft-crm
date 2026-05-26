const router = require('express').Router();
const { verifyToken, verifyRole } = require('../middleware/auth');
const { formatInTenantTZ } = require('../lib/datetime');
// #665: shared inverted-date-range guard. Pre-this, ?from=2026-05-01&to=2026-04-01
// silently returned an empty audit list because the where-clause built `gte
// later-than lte` which matches nothing — operators saw an empty trail and
// believed the audit log itself was empty.
const { validateDateRange } = require('../lib/validateDateRange');

const prisma = require("../lib/prisma");

// #621: ADMIN-only — audit log viewer.
// Pre-fix MANAGER was in the allow-list but the wellness sidebar's
// `adminOnly` flag hid the link, RoleGuard redirected MANAGER on /audit-log,
// and the toast wording said "System Admin Required". Backend now matches
// the rest of the surfaces — single consistent role contract across verticals.
router.use(verifyToken, verifyRole(["ADMIN"]));

// #387 callsite-sweep (2026-05-07): audit rows ship with a UTC `createdAt`
// timestamp. Reviewers reading the trail need the local-time-of-action
// without doing offset math. We render each row's createdAt in the viewing
// user's timezone and add an explicit TZ label.
//
// Resolution order for the viewer's TZ:
//   1. User.timezone column (the personalisation setting, default 'UTC')
//   2. 'Asia/Kolkata' for wellness tenants (clinics are India-anchored)
//   3. 'UTC' as a final fallback
//
// We add `createdAtFormatted` ALONGSIDE the raw `createdAt` rather than
// replacing it — the existing field stays for clients that do their own
// formatting (the AuditLog.jsx frontend currently re-formats client-side
// with hardcoded 'Asia/Kolkata'; this server-side field gives parity for
// API consumers + CSV export and unblocks #387's TZ-label acceptance).
async function resolveViewerTZ(req) {
  // Cache on req so /export.csv + /list don't double-fetch when both run.
  if (req._viewerTZ) return req._viewerTZ;
  let tz = "UTC";
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { timezone: true, tenant: { select: { vertical: true } } },
    });
    if (user?.timezone && user.timezone !== "UTC") {
      tz = user.timezone;
    } else if (user?.tenant?.vertical === "wellness") {
      tz = "Asia/Kolkata";
    }
  } catch (_e) {
    // tolerate lookup failures — fall through to UTC.
  }
  req._viewerTZ = tz;
  return tz;
}

function decorateRow(row, tz) {
  if (!row) return row;
  return {
    ...row,
    // '—' for null/Invalid; formatted 'YYYY-MM-DD HH:mm <TZ>' otherwise.
    createdAtFormatted: formatInTenantTZ(row.createdAt, tz),
    viewerTimezone: tz,
  };
}

// Build a Prisma `where` clause from query params, scoped to the caller's tenant.
function buildWhere(req) {
  const { entity, action, userId, from, to } = req.query;
  const where = { tenantId: req.user.tenantId };

  if (entity) where.entity = entity;
  if (action) where.action = action;
  if (userId) {
    const uid = parseInt(userId, 10);
    if (!Number.isNaN(uid)) where.userId = uid;
  }
  if (from || to) {
    where.createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) where.createdAt.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) where.createdAt.lte = d;
    }
  }
  return where;
}

// GET / — paginated list of audit logs
router.get('/', async (req, res) => {
  try {
    // #665: validate date range BEFORE building the where-clause.
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const where = buildWhere(req);

    // #920 slice 24 — slim-shape opt-in. Audit rows carry heavy `details`
    // JSON (often PII diffs) + hash-chain bookkeeping (`prevHash`/`hash`)
    // that callers paginating a list view don't need. Opt-in additive — no
    // existing caller passes ?fields=summary (grep audit pre-flight clean),
    // so legacy callers keep the full row shape with the nested user
    // include unchanged. Slim shape drops:
    //   - details      (heavy JSON, PII)
    //   - prevHash     (hash-chain bookkeeping, not list-view-relevant)
    //   - hash         (hash-chain bookkeeping, not list-view-relevant)
    //   - user include (slim is list-only; detail fetch hydrates user)
    // The createdAtFormatted + viewerTimezone decoration from #387 still
    // applies on slim rows because decorateRow operates on the projected
    // shape (it only depends on `createdAt`, which slim still selects).
    const isSummary = req.query.fields === 'summary';
    const findManyArgs = {
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        entity: true,
        entityId: true,
        action: true,
        userId: true,
        tenantId: true,
        createdAt: true,
      };
    } else {
      findManyArgs.include = {
        user: { select: { id: true, name: true, email: true } },
      };
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany(findManyArgs),
      prisma.auditLog.count({ where }),
    ]);

    const tz = await resolveViewerTZ(req);
    res.json({
      // #387: each row carries createdAt (raw UTC) + createdAtFormatted
      // (rendered in the viewer's TZ with a label). viewerTimezone surfaces
      // the resolved zone so the frontend / CSV consumer doesn't have to
      // re-derive it.
      logs: logs.map((log) => decorateRow(log, tz)),
      total,
      pages: Math.max(Math.ceil(total / limit), 1),
      page,
      limit,
      viewerTimezone: tz,
    });
  } catch (err) {
    console.error('[AuditViewer] List error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// GET /stats — last 30 days aggregate stats for the current tenant
router.get('/stats', async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const baseWhere = { tenantId: req.user.tenantId, createdAt: { gte: since } };

    const [byAction, byEntity, byUser, total] = await Promise.all([
      prisma.auditLog.groupBy({
        by: ['action'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.auditLog.groupBy({
        by: ['entity'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { entity: 'desc' } },
        take: 10,
      }),
      prisma.auditLog.groupBy({
        by: ['userId'],
        where: { ...baseWhere, userId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 5,
      }),
      prisma.auditLog.count({ where: baseWhere }),
    ]);

    // Hydrate user details for top users
    const userIds = byUser.map(u => u.userId).filter(Boolean);
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const counts = { CREATE: 0, UPDATE: 0, DELETE: 0 };
    for (const row of byAction) {
      counts[row.action] = row._count._all;
    }

    res.json({
      total,
      since,
      byAction: counts,
      byEntity: byEntity.map(e => ({ entity: e.entity, count: e._count._all })),
      topUsers: byUser.map(u => ({
        userId: u.userId,
        count: u._count._all,
        user: userMap[u.userId] || null,
      })),
    });
  } catch (err) {
    console.error('[AuditViewer] Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch audit stats' });
  }
});

// GET /entity/:entity/:id — full audit trail for a single record
router.get('/entity/:entity/:id', async (req, res) => {
  try {
    const entityId = parseInt(req.params.id, 10);
    if (Number.isNaN(entityId)) {
      return res.status(400).json({ error: 'Invalid entity id' });
    }

    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId: req.user.tenantId,
        entity: req.params.entity,
        entityId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    const tz = await resolveViewerTZ(req);
    res.json({
      logs: logs.map((log) => decorateRow(log, tz)),
      entity: req.params.entity,
      entityId,
      viewerTimezone: tz,
    });
  } catch (err) {
    console.error('[AuditViewer] Entity trail error:', err);
    res.status(500).json({ error: 'Failed to fetch entity audit trail' });
  }
});

// CSV escaping — wraps in quotes and doubles internal quotes
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// GET /export.csv — CSV export of filtered audit logs (capped at 10k rows)
router.get('/export.csv', async (req, res) => {
  try {
    // #665: validate date range BEFORE building the where-clause.
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const where = buildWhere(req);
    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10000,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    // #387: CSV gets BOTH the raw UTC timestamp (machine-friendly, sortable
    // in Excel) AND the viewer-TZ-rendered form with a label (human-friendly,
    // forensic-clear). Existing column order preserved so downstream parsers
    // that hard-coded a 0-indexed offset stay green; the new column appends
    // at the end alongside the existing trailing Details column shift would
    // break those, so we slot Timestamp(local) AFTER Timestamp.
    const tz = await resolveViewerTZ(req);
    const header = ['ID', 'Timestamp', 'TimestampLocal', 'Action', 'Entity', 'EntityId', 'UserName', 'UserEmail', 'Details'];
    const rows = logs.map(l => [
      l.id,
      l.createdAt ? new Date(l.createdAt).toISOString() : '',
      l.createdAt ? formatInTenantTZ(l.createdAt, tz) : '',
      l.action,
      l.entity,
      l.entityId ?? '',
      l.user ? l.user.name : '',
      l.user ? l.user.email : '',
      l.details || '',
    ].map(csvCell).join(','));

    const csv = [header.join(','), ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=audit-log.csv');
    res.send(csv);
  } catch (err) {
    console.error('[AuditViewer] CSV export error:', err);
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

module.exports = router;
