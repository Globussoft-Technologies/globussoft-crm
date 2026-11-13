const resetTokens = new Map();

function issuePortalResetToken(token, contactId, expiresAt) {
  resetTokens.set(token, {
    contactId,
    expiresAt: expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt),
  });
}

function getPortalResetToken(token) {
  const entry = resetTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    resetTokens.delete(token);
    return null;
  }
  return entry;
}

function revokePortalResetToken(token) {
  resetTokens.delete(token);
}

module.exports = {
  issuePortalResetToken,
  getPortalResetToken,
  revokePortalResetToken,
  resetTokens,
};
