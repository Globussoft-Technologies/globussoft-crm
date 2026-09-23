const { computeHash } = require('./audit');

function payloadFor(row, details) {
  return {
    tenantId: Number(row.tenantId),
    entity: row.entity,
    action: row.action,
    entityId: row.entityId,
    userId: row.userId,
    details,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Prove whether reversing a known storage-URL rewrite restores an audit row's
 * original, already-stored hash. This never guesses or generates a new hash:
 * the candidate is repairable only when the pre-existing SHA-256 digest is an
 * exact match for the reconstructed historical content.
 */
function assessStorageUrlRepair(row, { oldBase, newBase }) {
  if (!row || !row.hash || !row.prevHash || !(row.createdAt instanceof Date)) {
    return { status: 'invalid-row' };
  }

  const currentDetails = row.details == null ? null : String(row.details);
  const currentHash = computeHash(row.prevHash, payloadFor(row, currentDetails));
  if (currentHash === row.hash) {
    return { status: 'already-valid' };
  }

  if (!currentDetails || !currentDetails.includes(newBase)) {
    return { status: 'unverified-conflict' };
  }

  const restoredDetails = currentDetails.replaceAll(newBase, oldBase);
  const restoredHash = computeHash(row.prevHash, payloadFor(row, restoredDetails));
  if (restoredHash !== row.hash) {
    return { status: 'unverified-conflict' };
  }

  return {
    status: 'repairable',
    currentDetails,
    restoredDetails,
    storedHash: row.hash,
  };
}

module.exports = { assessStorageUrlRepair };
