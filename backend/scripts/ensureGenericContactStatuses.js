const prisma = require('../lib/prisma');

const STATUS_REPLACEMENTS = Object.freeze([
  { from: 'New', to: 'Lead' },
]);

/**
 * Idempotently restores Generic CRM's automation-compatible new-lead value.
 * This intentionally changes only `New` to `Lead`; every other status remains
 * untouched. The frontend presents the stored `Lead` value as `New`.
 *
 * Production deploys use `prisma db push`, so SQL data migrations are not
 * executed there. Running this before HTTP traffic makes the data correction
 * deploy-safe without deleting contacts or touching Wellness/Travel tenants.
 */
async function ensureGenericContactStatuses() {
  const updates = await prisma.$transaction(
    STATUS_REPLACEMENTS.map(({ from, to }) => prisma.contact.updateMany({
      where: { status: from, tenant: { vertical: 'generic' } },
      data: { status: to },
    })),
  );

  return {
    updated: updates.reduce((total, result) => total + Number(result?.count || 0), 0),
    replacements: Object.fromEntries(
      STATUS_REPLACEMENTS.map(({ from, to }, index) => [
        `${from}->${to}`,
        Number(updates[index]?.count || 0),
      ]),
    ),
  };
}

module.exports = { ensureGenericContactStatuses, STATUS_REPLACEMENTS };
