'use strict';

const crypto = require('crypto');
const destinationImageProvider = require('./destinationImageProvider');
const { buildGenericCampaignPage } = require('./landingPageRenderer');
const { isGenericLandingPage } = require('../lib/landingPageVertical');
const { normalizeSectorKey, SECTORS } = require('./landingSitePrompts');

const PEXELS_ONLY = ['unsplash', 'pixabay', 'ai-fallback'];
const IMAGE_IDS = new Set(['hero-image', 'gallery-image-1', 'gallery-image-2', 'gallery-image-3', 'cta-image']);
const IMAGE_QUERY_VERSION = 'generic-landing-v1';
const inFlight = new Map();

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_err) { return null; }
}

function collectBlocks(blocks, output = []) {
  (Array.isArray(blocks) ? blocks : []).forEach((block) => {
    if (!block || typeof block !== 'object') return;
    output.push(block);
    (Array.isArray(block.props?.columns) ? block.props.columns : [])
      .forEach((column) => collectBlocks(column?.components, output));
  });
  return output;
}

function findRoot(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .find((block) => block?.type === 'columns' && block.props?.variant === 'generic-campaign-page');
}

function imageAspectRatio(block) {
  const slot = String(block?.id || block?.props?.variant || '').toLowerCase();
  return slot.includes('hero') || slot.includes('cta') ? '16:9' : '4:3';
}

function sectorLabelForPage(page) {
  if (page.sectorLabel) return page.sectorLabel;
  const rawKey = String(page.sectorKey || page.templateType || '')
    .replace(/^generic-(?:site|campaign)-/, '')
    .replace(/-v\d+$/, '');
  const key = normalizeSectorKey(rawKey);
  return SECTORS[key]?.label || key.replace(/_/g, ' ') || 'business';
}

function queryForSlot(page, block, index, contextualCopy = '') {
  const sector = sectorLabelForPage(page);
  const context = [page.businessName, page.title, page.description, page.audience, page.location, sector, contextualCopy]
    .filter(Boolean).join(' ');
  const slot = String(block?.id || '').toLowerCase();
  const intent = slot.includes('hero') ? 'hero' : slot.includes('gallery') ? 'customer experience' : 'business team and results';
  return `${context} ${intent} professional campaign photo ${index + 1}`;
}

async function hydrateGenericLandingImages(page, { db, persist = true } = {}) {
  if (!page || !persist || !process.env.PEXELS_API_KEY || !isGenericLandingPage(page)) return page;
  const pageKey = crypto.createHash('sha256').update(JSON.stringify(page)).digest('hex');
  if (inFlight.has(pageKey)) return inFlight.get(pageKey);

  const task = (async () => {
    const parsed = typeof page.content === 'string'
      ? (() => { try { return JSON.parse(page.content); } catch (_err) { return []; } })()
      : page.content;
    const currentRoot = findRoot(parsed);
    const next = clone(currentRoot ? parsed : buildGenericCampaignPage(page, Array.isArray(parsed) ? parsed : []));
    if (!Array.isArray(next)) return page;
    const root = findRoot(next);
    if (!root) return page;
    const imageBlocks = collectBlocks([root]).filter((block) => block.type === 'image' && (IMAGE_IDS.has(block.id) || String(block.props?.variant || '').startsWith('wellness-')));
    if (!imageBlocks.length) return page;
    const contextualCopy = collectBlocks(next)
      .filter((block) => ['heading', 'text'].includes(block.type) && typeof block.props?.text === 'string')
      .map((block) => block.props.text.trim())
      .filter(Boolean)
      .slice(0, 18)
      .join(' ');

    const usedUrls = new Set();
    let changed = false;
    for (let index = 0; index < imageBlocks.length; index += 1) {
      const block = imageBlocks[index];
      const src = String(block.props?.src || '').trim();
      if (src) {
        if (usedUrls.has(src)) { block.props.src = ''; changed = true; } else usedUrls.add(src);
      }
      if (block.props?.src) continue;
      try {
        const image = await destinationImageProvider.fetchOne(queryForSlot(page, block, index, contextualCopy), {
          tenantId: page.tenantId,
          aspectRatio: imageAspectRatio(block),
          stockOnly: true,
          perPage: 8,
          excludeUrls: usedUrls,
          excludeProviders: PEXELS_ONLY,
        });
        if (!image?.url || image.attribution?.providerId !== 'pexels' || usedUrls.has(image.url)) continue;
        block.props.src = image.url;
        block.props.imageProvider = 'pexels';
        block.props.imageQueryVersion = IMAGE_QUERY_VERSION;
        if (!block.props.alt && image.attribution?.photographer) block.props.alt = `Photo by ${image.attribution.photographer} on Pexels`;
        usedUrls.add(image.url);
        changed = true;
      } catch (err) {
        console.warn(`[generic-images] Pexels lookup skipped for ${page.slug || page.id}:`, err.message || err);
      }
    }
    if (!changed) return page;
    const serialized = JSON.stringify(next);
    if (db?.landingPage?.updateMany && page.id && page.tenantId && typeof page.content === 'string') {
      const saved = await db.landingPage.updateMany({
        where: { id: page.id, tenantId: page.tenantId, content: page.content, ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}) },
        data: { content: serialized },
      });
      if (saved.count !== 1) return await db.landingPage.findFirst({ where: { id: page.id, tenantId: page.tenantId } }) || page;
    }
    return { ...page, content: serialized };
  })();
  inFlight.set(pageKey, task);
  try { return await task; } finally { inFlight.delete(pageKey); }
}

module.exports = { hydrateGenericLandingImages, _resetForTests() { inFlight.clear(); } };
