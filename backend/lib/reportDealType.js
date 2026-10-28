const { KEYS, DEFAULTS } = require('./tenantSettings');

// Match the Deals page: legacy untyped deals belong to the original
// New Business type, even if that type has been renamed.
async function reportDealTypeWhere(db, tenantId, dealType) {
  if (!dealType) return {};
  const selected = String(dealType);
  const setting = await db.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: KEYS.GENERIC_DEAL_TYPES } },
    select: { value: true },
  });
  let types;
  try { types = JSON.parse(setting?.value || DEFAULTS[KEYS.GENERIC_DEAL_TYPES]); }
  catch (_error) { types = JSON.parse(DEFAULTS[KEYS.GENERIC_DEAL_TYPES]); }
  const list = Array.isArray(types) ? types : [];
  const legacyType = list.find((type) => type.id === 'new-business') || list.find((type) => type.isDefault) || list[0];
  return selected === (legacyType?.name || 'New Business')
    ? { OR: [{ dealType: selected }, { dealType: null }] }
    : { dealType: selected };
}

module.exports = { reportDealTypeWhere };
