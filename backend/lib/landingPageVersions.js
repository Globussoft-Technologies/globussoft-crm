// Lightweight version-history snapshot helper for LandingPage rows.
//
// Why: operators need a safety net when they run AI generation, publish,
// or manually edit landing pages during UAT / client demos. The PRD
// explicitly excludes diff views / branching / merge — this module ships
// the smallest surface that satisfies "snapshot, list, restore".
//
// Usage:
//   const { snapshot, VERSION_SOURCES } = require('../lib/landingPageVersions');
//   await snapshot(prisma, page, VERSION_SOURCES.MANUAL_SAVE, req.user);
//
// Snapshot is best-effort by design — version capture must NEVER block
// the underlying save / publish / generate flow. The caller awaits but
// any throw is logged and swallowed in the route handler.
//
// Restore writes a NEW snapshot with source=RESTORE rather than mutating
// the existing chain; "previous versions remain available" is the user-
// facing contract.

const VERSION_SOURCES = Object.freeze({
  CREATE: 'CREATE',
  MANUAL_SAVE: 'MANUAL_SAVE',
  PUBLISH: 'PUBLISH',
  AI_GENERATION: 'AI_GENERATION',
  RESTORE: 'RESTORE',
});

const VALID_SOURCES = new Set(Object.values(VERSION_SOURCES));

/**
 * Capture a new snapshot of the page's current title / slug / content.
 *
 * @param {object} prisma   The shared Prisma client instance.
 * @param {object} page     A LandingPage row with id/title/slug/content/tenantId.
 * @param {string} source   One of VERSION_SOURCES.
 * @param {object} actor    { userId? } — auth user object; userId may be null.
 * @param {object} [opts]   { restoredFromVersionId? } — only set on RESTORE.
 * @returns {Promise<object>} The created LandingPageVersion row.
 */
async function snapshot(prisma, page, source, actor, opts = {}) {
  if (!page || typeof page.id !== 'number') {
    throw new Error('snapshot requires a LandingPage row with numeric id');
  }
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`snapshot source must be one of: ${[...VALID_SOURCES].join(', ')}`);
  }

  const last = await prisma.landingPageVersion.findFirst({
    where: { landingPageId: page.id },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });
  const versionNumber = (last?.versionNumber || 0) + 1;

  return prisma.landingPageVersion.create({
    data: {
      landingPageId: page.id,
      versionNumber,
      title: page.title || '',
      slug: page.slug || '',
      content: typeof page.content === 'string' ? page.content : JSON.stringify(page.content || []),
      source,
      restoredFromVersionId: opts.restoredFromVersionId ?? null,
      createdById: actor?.userId ?? null,
      tenantId: page.tenantId,
    },
  });
}

/**
 * Best-effort wrapper. Calls snapshot() and swallows errors so the
 * underlying save / publish / generate route never fails because the
 * version-history write hiccupped. Logs to console for ops visibility.
 */
async function snapshotSafe(prisma, page, source, actor, opts = {}) {
  try {
    return await snapshot(prisma, page, source, actor, opts);
  } catch (err) {
    console.warn('[LandingPageVersions] snapshot failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = {
  VERSION_SOURCES,
  snapshot,
  snapshotSafe,
};
