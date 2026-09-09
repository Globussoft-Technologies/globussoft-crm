class TenantReferenceError extends Error {
  constructor(message, { status = 404, code = "REFERENCE_NOT_FOUND" } = {}) {
    super(message);
    this.name = "TenantReferenceError";
    this.status = status;
    this.code = code;
  }
}

function parseReferenceId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new TenantReferenceError(`${label} must be a positive integer`, {
      status: 400,
      code: "INVALID_REFERENCE",
    });
  }
  return id;
}

async function requireTenantReferences(prisma, tenantId, references) {
  const resolved = {};
  for (const reference of references) {
    const { key, model, value, label = key } = reference;
    const id = parseReferenceId(value, label);
    resolved[key] = id;
    if (id === null) continue;
    const delegate = prisma[model];
    if (!delegate || typeof delegate.findFirst !== "function") {
      throw new TypeError(`Unknown Prisma delegate: ${model}`);
    }
    const row = await delegate.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new TenantReferenceError(`${label} not found`);
  }
  return resolved;
}

function sendTenantReferenceError(res, error) {
  if (!(error instanceof TenantReferenceError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

module.exports = {
  TenantReferenceError,
  parseReferenceId,
  requireTenantReferences,
  sendTenantReferenceError,
};
