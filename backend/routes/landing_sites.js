const express = require('express');
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');
const { snapshotSafe, VERSION_SOURCES } = require('../lib/landingPageVersions');
const { generateLandingSiteContent } = require('../services/landingSiteGeneratorLLM');
const { normalizeSectorKey, SECTORS } = require('../services/landingSitePrompts');

const router = express.Router();
const GENERIC_PREFIX = 'generic-site-';


function landingSiteVerticalWhere(vertical) {
  const key = String(vertical || "").trim().toLowerCase();
  if (key === "generic") {
    return {
      templateType: { startsWith: GENERIC_PREFIX },
      NOT: [
        { templateType: { startsWith: "generic-site-health" } },
        { templateType: { startsWith: "generic-site-hospital" } },
        { templateType: { startsWith: "generic-site-fitness" } },
      ],
    };
  }
  if (key === "wellness") {
    return {
      OR: [
        { templateType: { startsWith: "generic-site-health" } },
        { templateType: { startsWith: "generic-site-hospital" } },
        { templateType: { startsWith: "generic-site-fitness" } },
      ],
    };
  }
  return { templateType: { startsWith: GENERIC_PREFIX } };
}
function isGenericPage(page) {
  return Boolean(page && typeof page.templateType === 'string' && page.templateType.startsWith(GENERIC_PREFIX));
}

function sectorKeyFromTemplateType(templateType) {
  if (typeof templateType !== 'string' || !templateType.startsWith(GENERIC_PREFIX)) return 'general';
  return templateType.slice(GENERIC_PREFIX.length).replace(/-v1$/, '') || 'general';
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
      templateType: { startsWith: GENERIC_PREFIX },
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

router.get('/sectors', verifyToken, async (_req, res) => {
  res.json({
    sectors: [
      { key: 'general', label: 'General' },
      { key: 'travel', label: 'Travel' },
      { key: 'health', label: 'Health' },
      { key: 'hospital', label: 'Hospital' },
      { key: 'real_estate', label: 'Real Estate' },
      { key: 'education', label: 'Education' },
      { key: 'law_firm', label: 'Law Firm' },
      { key: 'nonprofit', label: 'Nonprofit' },
      { key: 'hospitality', label: 'Hospitality' },
      { key: 'retail', label: 'Retail' },
      { key: 'technology', label: 'Technology' },
      { key: 'fitness', label: 'Fitness' },
      { key: 'finance', label: 'Finance' },
    ],
  });
});

router.post('/generate', verifyToken, async (req, res) => {
  try {
    const { sectorKey, sectorLabel, campaignName, campaignGoal, businessName, audience, location, eventDate, eventTime, eventLocation, tone, ctaText, imageMode, autoCreate = true } = req.body || {};
    const normalizedSector = normalizeSectorKey(sectorKey);
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
    }, { tenantId: req.user.tenantId });

    if (result.stub) {
      return res.status(503).json({ error: 'AI provider is not configured. Configure an AI provider to generate this landing site.', code: 'AI_NOT_CONFIGURED' });
    }
    if (!autoCreate) return res.json(result);

    const baseSlug = slugify(result.suggestedSlug || campaignName || `${normalizedSector}-landing-site`);
    const templateType = `${GENERIC_PREFIX}${normalizedSector}-v1`;
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
    return res.status(201).json({ page: created, generation: { source: result.source, model: result.model, stub: result.stub, verdict: result.verdict, guardrailIssues: result.guardrailIssues, realModeError: result.realModeError, imagesFetched: result.imagesFetched || 0 } });
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

router.get('/public/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Slug is required' });
    const page = await prisma.landingPage.findFirst({ where: { slug, status: 'PUBLISHED', ...landingSiteVerticalWhere(req.query.vertical) } });
    if (!page) return res.status(404).json({ error: 'Landing site not found', code: 'LANDING_SITE_NOT_FOUND' });
    res.json(page);
  } catch (err) {
    console.error('[landing-sites] public fetch failed:', err);
    res.status(500).json({ error: 'Failed to load landing site' });
  }
});

module.exports = router;
