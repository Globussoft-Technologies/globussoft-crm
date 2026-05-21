// Per-tenant settings helper (PRD §4.7) — generic key/value reader
// over the TenantSetting table.
//
// `getTenantSetting(prisma, tenantId, key, fallback?)` returns the
// row's `value` string (caller parses) or the supplied fallback.
//
// `getTravelAdvanceRatio(prisma, tenantId, subBrand)` is the first
// consumer. Lookup chain:
//   1. sub-brand-scoped key  travel.advanceRatio.<subBrand>
//   2. tenant default key    travel.advanceRatio.default
//   3. hard-coded 0.5 fallback (Phase 2 baseline)
// Values outside (0, 1] (negative, > 1, NaN, non-numeric) are rejected
// and skipped — falling through to the next layer rather than
// poisoning the booking flow with a bad ratio. This is intentional:
// an admin who fat-fingers "1.5" sees Travel Stall keep working on
// the 0.5 default instead of demanding 150% upfront on every trip.

async function getTenantSetting(prisma, tenantId, key, fallback = null) {
  if (!tenantId || !key) return fallback;
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key } },
    select: { value: true },
  });
  return row ? row.value : fallback;
}

function parseRatio(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
  return n;
}

async function getTravelAdvanceRatio(prisma, tenantId, subBrand) {
  if (subBrand) {
    const subVal = await getTenantSetting(
      prisma,
      tenantId,
      `travel.advanceRatio.${subBrand}`,
      null,
    );
    const parsed = parseRatio(subVal);
    if (parsed != null) return parsed;
  }
  const defaultVal = await getTenantSetting(
    prisma,
    tenantId,
    "travel.advanceRatio.default",
    null,
  );
  const parsedDefault = parseRatio(defaultVal);
  if (parsedDefault != null) return parsedDefault;
  return 0.5;
}

module.exports = { getTenantSetting, getTravelAdvanceRatio };
