'use strict';

const destinationImageProvider = require('./destinationImageProvider');
const crypto = require('crypto');
const { isWellnessLandingPage } = require('./wellnessLandingThemes');
const { buildWellnessCampaignPage } = require('./landingPageRenderer');
const {
  IMAGE_QUERY_VERSION,
  buildWellnessImagePlan,
  queryForWellnessImageSlot,
} = require('./wellnessImageQueries');

const PEXELS_ONLY = ['unsplash', 'pixabay', 'ai-fallback'];
const IMAGE_IDS = new Set([
  'hero-image',
  'gallery-image-1',
  'gallery-image-2',
  'gallery-image-3',
  'cta-image',
]);
const inFlight = new Map();

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return null;
  }
}

function collectBlocks(blocks, output = []) {
  (Array.isArray(blocks) ? blocks : []).forEach((block) => {
    if (!block || typeof block !== 'object') return;
    output.push(block);
    const columns = block.props && Array.isArray(block.props.columns) ? block.props.columns : [];
    columns.forEach((column) => collectBlocks(column?.components, output));
  });
  return output;
}

function findWellnessRoot(components) {
  return (Array.isArray(components) ? components : [])
    .find((block) => block?.type === 'columns' && block.props?.variant === 'wellness-campaign-page');
}

function isWellnessImage(block) {
  if (!block || block.type !== 'image') return false;
  const variant = String(block.props?.variant || '').toLowerCase();
  return IMAGE_IDS.has(block.id) || variant.startsWith('wellness-');
}

function queryForImage(block, context) {
  const plan = context.plan || buildWellnessImagePlan(context);
  return queryForWellnessImageSlot(plan, block.id || block.props?.variant, context.imageIndex || 0);
}

function imageAspectRatio(block) {
  const slot = String(block?.id || block?.props?.variant || '').toLowerCase();
  return slot.includes('hero') || slot.includes('cta') ? '16:9' : '4:3';
}

function buildContext(page, blocks) {
  const text = blocks
    .map((block) => block?.props?.text)
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
  const plan = buildWellnessImagePlan({ ...page, text });
  return { ...page, text, plan };
}

function isStaleGeneratedPexelsImage(block) {
  const src = String(block?.props?.src || '').trim();
  if (!/^https?:\/\/(?:images\.)?pexels\.com\//i.test(src)) return false;
  return block.props?.imageQueryVersion !== IMAGE_QUERY_VERSION;
}

async function hydrateWellnessLandingImages(page, { db, persist = true } = {}) {
  // Historical snapshots are rendered exactly as saved, without live image
  // fetching or joining a mutable draft's in-flight hydration.
  if (!page || !persist || !process.env.PEXELS_API_KEY) return page;

  const pageKey = crypto.createHash('sha256').update(JSON.stringify(page)).digest('hex');
  if (inFlight.has(pageKey)) return inFlight.get(pageKey);

  const task = (async () => {
    const parsed = typeof page.content === 'string'
      ? (() => {
          try { return JSON.parse(page.content); } catch (_err) { return null; }
        })()
      : page.content;
    const root = findWellnessRoot(parsed);
    if (!isWellnessLandingPage(page, Array.isArray(parsed) ? parsed : [])) return page;
    const canBuildScaffold = !root
      && typeof page.templateType === 'string'
      && page.templateType.startsWith('generic-site-');
    if (!root && !canBuildScaffold) return page;

    const next = clone(canBuildScaffold
      ? buildWellnessCampaignPage(page, Array.isArray(parsed) ? parsed : [])
      : parsed);
    if (!Array.isArray(next)) return page;
    const nextRoot = findWellnessRoot(next);
    const imageBlocks = collectBlocks([nextRoot])
      .filter(isWellnessImage);
    if (!imageBlocks.length) return page;

    const usedUrls = new Set();
    const staleBlocks = new Set();
    let changed = false;
    imageBlocks.forEach((block) => {
      const src = String(block.props?.src || '').trim();
      if (!src) return;
      if (isStaleGeneratedPexelsImage(block)) {
        staleBlocks.add(block);
        return;
      }
      if (usedUrls.has(src)) {
        block.props.src = '';
        changed = true;
        return;
      }
      usedUrls.add(src);
    });

    const context = buildContext(page, collectBlocks(next));
    for (let imageIndex = 0; imageIndex < imageBlocks.length; imageIndex += 1) {
      const block = imageBlocks[imageIndex];
      const currentSrc = String(block.props?.src || '').trim();
      if (currentSrc && !staleBlocks.has(block)) continue;
      const query = queryForImage(block, { ...context, imageIndex });
      try {
        const image = await destinationImageProvider.fetchOne(query, {
          tenantId: page.tenantId,
          aspectRatio: imageAspectRatio(block),
          stockOnly: true,
          perPage: 8,
          excludeUrls: usedUrls,
          excludeProviders: PEXELS_ONLY,
          relevanceTerms: context.plan.relevanceTerms,
          requireRelevance: true,
        });
        if (!image?.url || image?.attribution?.providerId !== 'pexels' || usedUrls.has(image.url)) continue;
        block.props.src = image.url;
        block.props.imageProvider = 'pexels';
        block.props.imageQueryVersion = IMAGE_QUERY_VERSION;
        if (!block.props.alt && image.attribution?.photographer) {
          block.props.alt = `Photo by ${image.attribution.photographer} on Pexels`;
        }
        usedUrls.add(image.url);
        changed = true;
      } catch (err) {
        console.warn(`[wellness-images] Pexels lookup skipped for ${page.slug || page.id}:`, err.message || err);
      }
    }

    if (!changed) return page;
    const serialized = JSON.stringify(next);
    if (db?.landingPage?.updateMany && page.id && page.tenantId && typeof page.content === 'string') {
      try {
        const saved = await db.landingPage.updateMany({
          where: { id: page.id, tenantId: page.tenantId, content: page.content,
            ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}) },
          data: { content: serialized },
        });
        if (saved.count !== 1) {
          // Do not overwrite a newer edit or return stale hydrated content.
          return await db.landingPage.findFirst({ where: { id: page.id, tenantId: page.tenantId } }) || page;
        }
      } catch (err) {
        console.warn(`[wellness-images] Could not persist images for ${page.slug || page.id}:`, err.message || err);
        return page;
      }
    }
    return { ...page, content: serialized };
  })();

  inFlight.set(pageKey, task);
  try {
    return await task;
  } finally {
    inFlight.delete(pageKey);
  }
}

module.exports = {
  hydrateWellnessLandingImages,
  _collectBlocks: collectBlocks,
  _queryForImage: queryForImage,
  _resetForTests() { inFlight.clear(); },
};
