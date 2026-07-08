// Effective-brand resolver — the single source of truth for "what logo and
// color should this tenant show for sub-brand X" (2026-07-08).
//
// Fallback chain (documented in schema.prisma:92-98 for Tenant.defaultSubBrand
// but never actually implemented until now — see PRD_TRAVEL_PER_SUBBRAND_BRANDING):
//   1. The active BrandKit for the requested subBrand (if it has a logoUrl).
//   2. The tenant's DEFAULT BRAND — the active BrandKit for
//      Tenant.defaultSubBrand (if set), else the tenant-wide (subBrand=null)
//      active BrandKit.
//   3. Tenant.logoUrl / Tenant.brandColor (the legacy single-brand fields).
//   4. null — caller renders the bundled system-default logo.
//
// Every layer is independently allowed to have a color but no logo (or vice
// versa) — the chain resolves logoUrl and primaryColor SEPARATELY so e.g. a
// sub-brand with a color but no logo still shows its own color while
// borrowing the default brand's logo.

const prisma = require("./prisma");

async function findActiveKit(tenantId, subBrand) {
  return prisma.brandKit.findFirst({
    where: { tenantId, subBrand, isActive: true },
  });
}

// Resolve the tenant's "default brand" BrandKit row: the active kit for
// Tenant.defaultSubBrand when set, else the tenant-wide (subBrand=null) kit.
// Returns null if neither exists.
async function resolveDefaultBrandKit(tenantId, tenant) {
  const t = tenant || (await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { defaultSubBrand: true, logoUrl: true, brandColor: true },
  }));
  if (!t) return null;
  if (t.defaultSubBrand) {
    const kit = await findActiveKit(tenantId, t.defaultSubBrand);
    if (kit) return kit;
  }
  return findActiveKit(tenantId, null);
}

/**
 * Resolve the effective logo + color for a tenant + (optional) sub-brand,
 * walking the full fallback chain. Never throws — a resolution failure
 * degrades to nulls so callers render their own system default.
 *
 * @param {number} tenantId
 * @param {string|null} subBrand — null/undefined means "no sub-brand context"
 *   (skips straight to the default-brand step).
 * @returns {Promise<{
 *   logoUrl: string|null, primaryColor: string|null,
 *   source: "subBrand"|"default"|"tenant"|"system",
 *   subBrandKit: object|null, defaultKit: object|null,
 * }>}
 */
async function resolveEffectiveBrand(tenantId, subBrand) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultSubBrand: true, logoUrl: true, brandColor: true },
    });
    if (!tenant) {
      return { logoUrl: null, primaryColor: null, source: "system", subBrandKit: null, defaultKit: null };
    }

    const subBrandKit = subBrand ? await findActiveKit(tenantId, subBrand) : null;
    const defaultKit = await resolveDefaultBrandKit(tenantId, tenant);

    const logoUrl =
      subBrandKit?.logoUrl || defaultKit?.logoUrl || tenant.logoUrl || null;
    const primaryColor =
      subBrandKit?.primaryColor || defaultKit?.primaryColor || tenant.brandColor || null;

    let source = "system";
    if (subBrandKit?.logoUrl || subBrandKit?.primaryColor) source = "subBrand";
    else if (defaultKit?.logoUrl || defaultKit?.primaryColor) source = "default";
    else if (tenant.logoUrl || tenant.brandColor) source = "tenant";

    return { logoUrl, primaryColor, source, subBrandKit: subBrandKit || null, defaultKit: defaultKit || null };
  } catch (e) {
    console.error(`[brandResolver] resolveEffectiveBrand failed (tenant=${tenantId}, subBrand=${subBrand}): ${e.message}`);
    return { logoUrl: null, primaryColor: null, source: "system", subBrandKit: null, defaultKit: null };
  }
}

module.exports = { resolveEffectiveBrand, resolveDefaultBrandKit, findActiveKit };
