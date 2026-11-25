const router = require('express').Router();
const { verifyToken, verifyRole } = require('../middleware/auth');
const { formatInTenantTZ } = require('../lib/datetime');
// #665: shared inverted-date-range guard. Pre-this, ?from=2026-05-01&to=2026-04-01
// silently returned an empty audit list because the where-clause built `gte
// later-than lte` which matches nothing — operators saw an empty trail and
// believed the audit log itself was empty.
const { validateDateRange } = require('../lib/validateDateRange');
const {
  resolveAuditTenantScope,
  auditTenantWhere,
  loadTenantAuditActors,
  attachTenantAuditActors,
} = require('../lib/auditTenantScope');

const prisma = require("../lib/prisma");

// Deletion actions are intentionally more specific than the generic DELETE
// verb on some resources. Keep the viewer's deletion KPI/category inclusive
// so hard-deleted Contacts (leads) and soft-deleted records are not hidden
// from operators simply because their audit action carries a qualifier.
function isDeleteAction(action) {
  return action === "DELETE" || /(?:^|_)DELETE$/.test(String(action || ""));
}

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
// replacing it — API consumers and CSV exports retain the raw timestamp,
// while the Audit Log UI uses the resolved viewerTimezone for display.
async function resolveViewerTZ(req, scope) {
  // Cache on req so /export.csv + /list don't double-fetch when both run.
  if (req._viewerTZ) return req._viewerTZ;
  let tz = "UTC";
  try {
    const user = await prisma.user.findFirst({
      where: {
        id: req.user.userId,
        tenantId: scope.tenantId,
        tenant: { is: { vertical: scope.vertical } },
      },
      select: { timezone: true, tenantId: true, tenant: { select: { vertical: true } } },
    });
    if (
      Number(user?.tenantId) === scope.tenantId &&
      user?.tenant?.vertical === scope.vertical &&
      user?.timezone && user.timezone !== "UTC"
    ) {
      tz = user.timezone;
    } else if (scope.vertical === "wellness") {
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
    ...(Object.prototype.hasOwnProperty.call(row, 'details')
      ? { details: visibleAuditDetails(row.details) }
      : {}),
    // '—' for null/Invalid; formatted 'YYYY-MM-DD HH:mm <TZ>' otherwise.
    createdAtFormatted: formatInTenantTZ(row.createdAt, tz),
    viewerTimezone: tz,
  };
}

function stripInternalAuditFields(value) {
  if (Array.isArray(value)) return value.map(stripInternalAuditFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/^jti$/i.test(key))
      .map(([key, child]) => [key, stripInternalAuditFields(child)]),
  );
}

function hasInternalAuditField(value) {
  if (Array.isArray(value)) return value.some(hasInternalAuditField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /^jti$/i.test(key) || hasInternalAuditField(child),
  );
}

function visibleAuditDetails(details) {
  if (typeof details !== 'string') return stripInternalAuditFields(details);
  try {
    const parsed = JSON.parse(details);
    return hasInternalAuditField(parsed) ? JSON.stringify(stripInternalAuditFields(parsed)) : details;
  } catch (_err) {
    return details;
  }
}

// Build a Prisma `where` clause from query params, scoped to the caller's tenant.
function buildWhere(req, scope) {
  const { entity, action, userId, from, to } = req.query;
  const where = auditTenantWhere(scope);

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

    const scope = await resolveAuditTenantScope(req.user.tenantId);
    if (!scope) {
      return res.status(403).json({ error: 'Invalid audit tenant scope', code: 'AUDIT_SCOPE_INVALID' });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const where = buildWhere(req, scope);

    // #920 slice 24 — slim-shape opt-in. Audit rows carry heavy `details`
    // JSON (often PII diffs) that callers paginating a list view don't need.
    // Opt-in additive — no existing caller passes ?fields=summary. Slim shape
    // drops details and actor identifiers; the default response separately
    // hydrates actors with tenant + vertical constraints.
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
        tenantId: true,
        createdAt: true,
      };
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany(findManyArgs),
      prisma.auditLog.count({ where }),
    ]);

    const tz = await resolveViewerTZ(req, scope);
    const visibleLogs = isSummary
      ? logs.map((log) => {
          const summary = { ...log };
          delete summary.userId;
          return summary;
        })
      : attachTenantAuditActors(
          logs,
          await loadTenantAuditActors(logs.map((log) => log.userId), scope),
        );
    res.json({
      // #387: each row carries createdAt (raw UTC) + createdAtFormatted
      // (rendered in the viewer's TZ with a label). viewerTimezone surfaces
      // the resolved zone so the frontend / CSV consumer doesn't have to
      // re-derive it.
      logs: visibleLogs.map((log) => decorateRow(log, tz)),
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
    const scope = await resolveAuditTenantScope(req.user.tenantId);
    if (!scope) {
      return res.status(403).json({ error: 'Invalid audit tenant scope', code: 'AUDIT_SCOPE_INVALID' });
    }
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const baseWhere = auditTenantWhere(scope, { createdAt: { gte: since } });

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
    const userMap = await loadTenantAuditActors(userIds, scope);

    const counts = { CREATE: 0, UPDATE: 0, DELETE: 0 };
    for (const row of byAction) {
      const count = row._count._all;
      // Preserve the exact action counts as additive fields for consumers
      // that need to distinguish HARD_DELETE/SOFT_DELETE, while also making
      // the top-level DELETE bucket mean "all deletion actions".
      if (row.action !== "DELETE") counts[row.action] = count;
      if (isDeleteAction(row.action)) counts.DELETE += count;
    }

    res.json({
      total,
      since,
      byAction: counts,
      byEntity: byEntity.map(e => ({ entity: e.entity, count: e._count._all })),
      topUsers: byUser.flatMap(u => {
        const user = userMap.get(Number(u.userId));
        return user ? [{ userId: u.userId, count: u._count._all, user }] : [];
      }),
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

    const scope = await resolveAuditTenantScope(req.user.tenantId);
    if (!scope) {
      return res.status(403).json({ error: 'Invalid audit tenant scope', code: 'AUDIT_SCOPE_INVALID' });
    }

    const logs = await prisma.auditLog.findMany({
      where: auditTenantWhere(scope, {
        entity: req.params.entity,
        entityId,
      }),
      orderBy: { createdAt: 'desc' },
    });

    const tz = await resolveViewerTZ(req, scope);
    const visibleLogs = attachTenantAuditActors(
      logs,
      await loadTenantAuditActors(logs.map((log) => log.userId), scope),
    );
    res.json({
      logs: visibleLogs.map((log) => decorateRow(log, tz)),
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

    const scope = await resolveAuditTenantScope(req.user.tenantId);
    if (!scope) {
      return res.status(403).json({ error: 'Invalid audit tenant scope', code: 'AUDIT_SCOPE_INVALID' });
    }

    const where = buildWhere(req, scope);
    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });
    const visibleLogs = attachTenantAuditActors(
      logs,
      await loadTenantAuditActors(logs.map((log) => log.userId), scope),
    );

    // #387: CSV gets BOTH the raw UTC timestamp (machine-friendly, sortable
    // in Excel) AND the viewer-TZ-rendered form with a label (human-friendly,
    // forensic-clear). Existing column order preserved so downstream parsers
    // that hard-coded a 0-indexed offset stay green; the new column appends
    // at the end alongside the existing trailing Details column shift would
    // break those, so we slot Timestamp(local) AFTER Timestamp.
    const tz = await resolveViewerTZ(req, scope);
    const header = ['ID', 'Timestamp', 'TimestampLocal', 'Action', 'Entity', 'EntityId', 'UserName', 'UserEmail', 'Details'];
    const rows = visibleLogs.map(l => [
      l.id,
      l.createdAt ? new Date(l.createdAt).toISOString() : '',
      l.createdAt ? formatInTenantTZ(l.createdAt, tz) : '',
      l.action,
      l.entity,
      l.entityId ?? '',
      l.user ? l.user.name : '',
      l.user ? l.user.email : '',
      visibleAuditDetails(l.details) || '',
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
