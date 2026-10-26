const express = require('express');
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');
const { snapshotSafe, VERSION_SOURCES } = require('../lib/landingPageVersions');
const { generateLandingSiteContent } = require('../services/landingSiteGeneratorLLM');
const { hydrateWellnessLandingImages } = require('../services/wellnessLandingImages');
const { hydrateGenericLandingImages } = require('../services/genericLandingImages');
const { normalizeSectorKey, SECTORS } = require('../services/landingSitePrompts');
const { getTenantAiState } = require('../lib/aiProviderManagement');
const { isValidPhoneOrEmpty } = require('../lib/validators');
const {
  isPageAllowedForVertical,
  isWellnessSector,
  normalizeVertical,
  verticalWhere,
} = require('../lib/landingPageVertical');

const router = express.Router();
const GENERIC_PREFIX = 'generic-site-';


function landingSiteVerticalWhere(vertical) {
  return verticalWhere(vertical);
}
function sectorKeyFromTemplateType(templateType) {
  if (typeof templateType !== 'string') return 'general';
  const value = templateType.replace(/^generic-(?:site|campaign)-/, '').replace(/^wellness-site-/, '');
  return value.replace(/-v[12]$/, '') || 'general';
}

function sectorLabelFromTemplateType(templateType) {
  const key = sectorKeyFromTemplateType(templateType);
  return (SECTORS[key] && SECTORS[key].label) || key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) || 'General';
}

function slugify(value, fallback = 'landing-site') {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50) || fallback;
}

function mapLandingSiteRow(page) {
  if (!page) return null;
  return {
    ...page,
    sectorKey: sectorKeyFromTemplateType(page.templateType),
    sectorLabel: sectorLabelFromTemplateType(page.templateType),
  };
}

router.get('/', verifyToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { vertical: true } });
    const tenantVertical = normalizeVertical(tenant?.vertical);
    const pageParam = Number.parseInt(req.query.page, 10);
    const limitParam = Number.parseInt(req.query.limit, 10);
    const paginated = Number.isFinite(pageParam) || Number.isFinite(limitParam);
    const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
    const limit = Math.min(Math.max(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 12, 1), 50);
    const createdAfter = req.query.createdAfter ? new Date(String(req.query.createdAfter)) : null;
    const createdBefore = req.query.createdBefore ? new Date(String(req.query.createdBefore)) : null;
    const createdAt = {};
    if (createdAfter && !Number.isNaN(createdAfter.getTime())) createdAt.gte = createdAfter;
    if (createdBefore && !Number.isNaN(createdBefore.getTime())) createdAt.lte = createdBefore;

    const baseWhere = {
      tenantId: req.user.tenantId,
      ...landingSiteVerticalWhere(tenantVertical),
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
    };
    const select = {
      id: true,
      title: true,
      slug: true,
      status: true,
      visits: true,
      submissions: true,
      templateType: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
      isFeatured: true,
    };

    const pinnedRow = await prisma.landingPage.findFirst({
      where: { ...baseWhere, status: 'PUBLISHED' },
      orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
      select,
    });

    if (!paginated) {
      const pages = await prisma.landingPage.findMany({
        where: baseWhere,
        orderBy: { createdAt: 'desc' },
        select,
      });
      const list = pinnedRow ? pages.filter((pageRow) => pageRow.id !== pinnedRow.id) : pages;
      const ordered = pinnedRow ? [pinnedRow, ...list] : list;
      return res.json(ordered.map(mapLandingSiteRow));
    }

    const listWhere = pinnedRow
      ? { ...baseWhere, id: { not: pinnedRow.id } }
      : baseWhere;
    const skip = (page - 1) * limit;
    const [total, pages] = await Promise.all([
      prisma.landingPage.count({ where: listWhere }),
      prisma.landingPage.findMany({
        where: listWhere,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select,
      }),
    ]);

    return res.json({
      pages: pages.map(mapLandingSiteRow),
      pinnedPage: mapLandingSiteRow(pinnedRow),
      page,
      limit,
      total,
      hasMore: skip + pages.length < total,
    });
  } catch (err) {
    console.error('[landing-sites] list failed:', err);
    res.status(500).json({ error: 'Failed to fetch landing sites' });
  }
});

router.get('/sectors', verifyToken, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { vertical: true } });
  const tenantVertical = normalizeVertical(tenant?.vertical);
  if (tenantVertical === 'travel') return res.json({ sectors: [] });
  if (tenantVertical === 'wellness') return res.json({ sectors: [{ key: 'wellness', label: 'Wellness' }] });
  res.json({
    sectors: [
      { key: 'general', label: 'General' },
      { key: 'real_estate', label: 'Real Estate' },
      { key: 'education', label: 'Education' },
      { key: 'law_firm', label: 'Law Firm' },
      { key: 'nonprofit', label: 'Nonprofit' },
      { key: 'hospitality', label: 'Hospitality' },
      { key: 'retail', label: 'Retail' },
      { key: 'technology', label: 'Technology' },
      { key: 'finance', label: 'Finance' },
    ],
  });
});

router.get('/config', verifyToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { vertical: true } });
    const vertical = normalizeVertical(tenant?.vertical);
    const aiState = await getTenantAiState(req.user.tenantId);
    res.json({
      vertical,
      pexelsConfigured: Boolean(process.env.PEXELS_API_KEY),
      aiConfigured: aiState?.resolverAccess !== 'none',
      aiAccess: aiState?.resolverAccess || 'none',
      imageProvider: 'pexels',
    });
  } catch (err) {
    console.error('[landing-sites] config failed:', err);
    res.status(500).json({ error: 'Failed to load landing-site configuration' });
  }
});

router.post('/generate', verifyToken, async (req, res) => {
  try {
    const { sectorKey, sectorLabel, campaignName, campaignGoal, businessName, audience, location, eventDate, eventTime, eventLocation, tone, ctaText, imageMode, wellnessTheme, wellnessCustomColors, wellnessCustomBaseThemeId, wellnessLayout, autoCreate = true } = req.body || {};
    const normalizedSector = normalizeSectorKey(sectorKey);
    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { vertical: true } });
    const tenantVertical = normalizeVertical(tenant?.vertical);
    if (tenantVertical === 'travel') {
      return res.status(409).json({ error: 'Travel tenants must use travel landing pages.', code: 'VERTICAL_ROUTE_MISMATCH' });
    }
    if (tenantVertical === 'wellness' && !isWellnessSector(normalizedSector)) {
      return res.status(409).json({ error: 'Wellness tenants can only create wellness landing sites.', code: 'VERTICAL_ROUTE_MISMATCH' });
    }
    if (tenantVertical === 'generic' && isWellnessSector(normalizedSector)) {
      return res.status(409).json({ error: 'Generic tenants cannot create wellness landing sites.', code: 'VERTICAL_ROUTE_MISMATCH' });
    }
    const result = await generateLandingSiteContent({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      sectorKey: normalizedSector,
      sectorLabel: sectorLabel || (SECTORS[normalizedSector] && SECTORS[normalizedSector].label) || 'General',
      campaignName,
      campaignGoal,
      businessName,
      audience,
      location,
      eventDate,
      eventTime,
      eventLocation,
      tone,
      ctaText,
      imageMode,
      wellnessTheme,
      wellnessCustomColors,
      wellnessCustomBaseThemeId,
      wellnessLayout,
    }, { tenantId: req.user.tenantId });

    // AI access blocked (no BYOK key + no funded subscription, or credits
    // exhausted): fail loudly with a machine-readable code instead of
    // persisting a silent stub draft — the UI shows a proper
    // "AI is not configured" message and no orphan page is created.
    if (result.aiBlockedCode) {
      const statusMessage =
        result.aiBlockedMessage ||
        (result.aiBlockedCode === 'AI_CREDITS_EXHAUSTED'
          ? 'AI credits for this workspace are exhausted.'
          : 'AI is not configured for this workspace.');
      return res.status(503).json({ error: statusMessage, code: result.aiBlockedCode });
    }

    if (!autoCreate) return res.json(result);

    const baseSlug = slugify(result.suggestedSlug || campaignName || `${normalizedSector}-landing-site`);
    const templateType = tenantVertical === 'wellness'
      ? `wellness-site-${normalizedSector}-v1`
      : `${GENERIC_PREFIX}${normalizedSector}-v2`;
    const baseData = {
      title: String(result.suggestedTitle || campaignName || `${normalizedSector} Landing Site`).slice(0, 200),
      templateType,
      content: JSON.stringify(result.blocks || []),
      description: String(result.description || campaignGoal || '').slice(0, 500) || null,
      metaTitle: result.seoMeta?.metaTitle || null,
      metaDescription: result.seoMeta?.metaDescription || null,
      generatedByAi: true,
      generatedAt: new Date(),
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      status: 'DRAFT',
    };

    let created = null;
    let slug = baseSlug;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      try {
        created = await prisma.landingPage.create({ data: { ...baseData, slug } });
      } catch (err) {
        if (err.code !== 'P2002') throw err;
        slug = `${baseSlug.slice(0, 45)}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }

    if (!created) return res.status(500).json({ error: 'Failed to allocate a unique slug after 5 attempts' });
    await snapshotSafe(prisma, created, VERSION_SOURCES.AI_GENERATION, req.user);
    return res.status(201).json({ page: created, generation: { source: result.source, model: result.model, stub: result.stub, verdict: result.verdict, guardrailIssues: result.guardrailIssues, realModeError: result.realModeError, aiBlockedCode: result.aiBlockedCode || null, aiBlockedMessage: result.aiBlockedMessage || null, imagesFetched: result.imagesFetched || 0 } });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI provider is not configured. Configure an AI provider to generate this landing site.', code: 'AI_NOT_CONFIGURED' });
    }
    if (err.code === 'LANDING_SITE_GENERATE_BUDGET_EXCEEDED') {
      return res.status(429).json({ error: 'Monthly LLM spend cap reached for this tenant.', code: 'LLM_BUDGET_EXCEEDED', spentCents: err.spentCents, capCents: err.capCents });
    }
    console.error('[landing-sites] generate failed:', err);
    res.status(500).json({ error: 'Failed to generate landing site' });
  }
});

router.get('/public/:vertical/:tenantId/:slug', async (req, res) => {
  try {
    const vertical = normalizeVertical(req.params.vertical);
    if (!['generic', 'wellness'].includes(vertical) || String(req.params.vertical).toLowerCase() !== vertical) {
      return res.status(404).json({ error: 'Landing site not found', code: 'LANDING_SITE_NOT_FOUND' });
    }
    const tenantId = Number.parseInt(req.params.tenantId, 10);
    if (!Number.isInteger(tenantId) || tenantId <= 0) return res.status(404).json({ error: 'Landing site not found', code: 'LANDING_SITE_NOT_FOUND' });
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Slug is required' });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    if (normalizeVertical(tenant?.vertical) !== vertical) return res.status(404).json({ error: 'Landing site not found', code: 'LANDING_SITE_NOT_FOUND' });
    const page = await prisma.landingPage.findFirst({ where: { tenantId, slug, status: 'PUBLISHED', ...landingSiteVerticalWhere(vertical) } });
    if (!page || !isPageAllowedForVertical(page, vertical)) return res.status(404).json({ error: 'Landing site not found', code: 'LANDING_SITE_NOT_FOUND' });
    const hydrated = vertical === 'wellness'
      ? await hydrateWellnessLandingImages(page, { db: prisma, persist: true })
      : await hydrateGenericLandingImages(page, { db: prisma, persist: true });
    res.json({ ...hydrated, vertical });
  } catch (err) {
    console.error('[landing-sites] public fetch failed:', err);
    res.status(500).json({ error: 'Failed to load landing site' });
  }
});

async function resolveScopedPublicLandingSite(req) {
  const vertical = normalizeVertical(req.params.vertical);
  if (!['generic', 'wellness'].includes(vertical) || String(req.params.vertical).toLowerCase() !== vertical) return null;
  const tenantId = Number.parseInt(req.params.tenantId, 10);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  const slug = String(req.params.slug || '').trim();
  if (!slug) return null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
  if (normalizeVertical(tenant?.vertical) !== vertical) return null;
  const page = await prisma.landingPage.findFirst({
    where: { tenantId, slug, status: 'PUBLISHED', ...landingSiteVerticalWhere(vertical) },
  });
  return page && isPageAllowedForVertical(page, vertical) ? page : null;
}

router.post('/public/:vertical/:tenantId/:slug/submit', express.json(), async (req, res) => {
  try {
    const page = await resolveScopedPublicLandingSite(req);
    if (!page) return res.status(404).json({ error: 'Landing site not found', code: 'LANDING_SITE_NOT_FOUND' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const firstName = String(body.first_name || body.firstName || '').trim();
    const lastName = String(body.last_name || body.lastName || '').trim();
    const contactName = String(body.name || `${firstName} ${lastName}` || 'Website enquiry').trim() || 'Website enquiry';
    const email = String(body.email || body.email_address || '').trim().toLowerCase();
    const phone = String(body.phone || body.phone_number || '').trim();
    if (!email) return res.status(400).json({ error: 'Email is required', code: 'MISSING_FIELDS' });
    if (!isValidPhoneOrEmpty(phone)) return res.status(400).json({ error: 'Please enter a valid phone number', code: 'INVALID_PHONE' });

    const company = String(body.company || body.organization || '').trim() || null;
    const serviceInterest = String(body.service_interest || body.interest || body.subject || '').trim() || null;
    const sourceLabel = `Landing Site: ${page.title}`;
    const existing = await prisma.contact.findFirst({ where: { email, tenantId: page.tenantId, deletedAt: null } });
    const contact = existing
      ? await prisma.contact.update({ where: { id: existing.id }, data: { name: contactName, phone: phone || null, company, source: 'inbound:webform', treatmentOfInterest: serviceInterest } })
      : await prisma.contact.create({ data: { name: contactName, email, phone: phone || null, company, status: 'Lead', source: 'inbound:webform', firstTouchSource: sourceLabel, treatmentOfInterest: serviceInterest, aiScore: 30, tenantId: page.tenantId } });

    await prisma.deal.create({ data: { title: `Landing Site Inbound: ${page.title}`, amount: 0, stage: 'lead', contactId: contact.id, tenantId: page.tenantId } });
    await prisma.landingPage.update({ where: { id: page.id }, data: { submissions: { increment: 1 } } });
    await prisma.landingPageAnalytics.create({ data: { landingPageId: page.id, eventType: 'FORM_SUBMIT', visitorIp: req.ip, metadata: JSON.stringify(body), tenantId: page.tenantId } });
    if (req.io) req.io.emit('deal_updated', {});
    return res.json({ success: true, message: 'Thank you for your submission!' });
  } catch (err) {
    console.error('[landing-sites] public submit failed:', err);
    return res.status(500).json({ error: 'Submission failed', code: 'SUBMISSION_FAILED' });
  }
});

router.get('/public/:vertical/:tenantId/:slug/track', async (req, res) => {
  try {
    const page = await resolveScopedPublicLandingSite(req);
    if (page) {
      await prisma.landingPageAnalytics.create({ data: { landingPageId: page.id, eventType: String(req.query.event || 'VISIT').slice(0, 50), visitorIp: req.ip, userAgent: req.headers['user-agent'], tenantId: page.tenantId } });
    }
  } catch (err) {
    console.warn('[landing-sites] public tracking skipped:', err.message || err);
  }
  return res.status(204).end();
});

// The former /public/:slug endpoint was ambiguous because slugs are unique
// per tenant, not globally. Never resolve it by searching all tenants.
router.get('/public/:slug', (_req, res) => res.status(404).json({ error: 'Landing site route requires a tenant boundary', code: 'LANDING_SITE_ROUTE_REQUIRES_TENANT' }));

module.exports = router;
