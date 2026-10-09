'use strict';

if (process.env.NODE_ENV !== 'test') {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: false });
}

const llmRouter = require('../lib/llmRouter');
const aiGateway = require('../lib/aiGateway');
const destinationImageProvider = require('./destinationImageProvider');
const {
  IMAGE_QUERY_VERSION,
  buildWellnessImagePlan,
  queryForWellnessImageSlot,
} = require('./wellnessImageQueries');
const { formatGeminiLimitMessage } = require('../lib/geminiErrors');
const { getBudgetCap, evaluateCap } = require('../lib/tenantSettings');
const {
  BASIC_BLOCK_TYPES,
  buildGenericLandingSitePrompt,
  buildWellnessLandingSitePrompt,
  buildGenericFallback,
  buildWellnessRegistrationBlocks,
  isWellnessSector,
  normalizeSectorKey,
} = require('./landingSitePrompts');

const INTEGRATION = 'llm';
const MODEL_PRIMARY = 'gemini-2.5-flash';
const TASK_NAME = 'landing-site-generate';

async function computeMonthlySpendCents(tenantId) {
  return llmRouter.computeMonthlySpendCents(tenantId);
}

async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  const spentCents = await computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly LLM spend cap reached for this tenant.');
    err.code = 'LANDING_SITE_GENERATE_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  return evaluation;
}

function parseJson(raw) {
  if (!raw || typeof raw !== 'string') throw new Error(`LLM returned empty / non-string response (type=${typeof raw})`);
  let cleaned = raw.trim();
  if (cleaned.charCodeAt(0) === 0xfeff) cleaned = cleaned.slice(1);
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  }
  return JSON.parse(cleaned);
}

function ensureBlockArray(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block && typeof block === 'object')
    .map((block, index) => {
      const type = String(block.type || '').trim();
      if (!BASIC_BLOCK_TYPES.has(type)) return null;
      const props = block.props && typeof block.props === 'object' && !Array.isArray(block.props) ? block.props : {};
      return { id: block.id || `block-${index + 1}`, type, props };
    })
    .filter(Boolean);
}

function collectBlocksByType(blocks, type) {
  const found = [];
  const visit = (items) => {
    if (!Array.isArray(items)) return;
    items.forEach((block) => {
      if (!block || typeof block !== 'object') return;
      if (block.type === type) found.push(block);
      const columns = block.props && Array.isArray(block.props.columns) ? block.props.columns : [];
      columns.forEach((column) => visit(column.components));
    });
  };
  visit(blocks);
  return found;
}

async function enrichWithImages(payload, input, options = {}) {
  const blocks = ensureBlockArray(payload.blocks);
  if (!blocks.length) return payload;

  if (String(input.imageMode || 'auto').toLowerCase() === 'manual') {
    return { ...payload, blocks, imagesFetched: 0 };
  }

  const imageBlocks = collectBlocksByType(blocks, 'image');
  if (!imageBlocks.length) return { ...payload, blocks };

  const wellnessMode = isWellnessSector(input.sectorKey);
  const wellnessImagePlan = wellnessMode
    ? buildWellnessImagePlan(input)
    : null;
  const wellnessPhotoQuery = [input.imageQuery, input.campaignName, input.campaignGoal, input.audience, input.location, input.sectorLabel || input.sectorKey].filter(Boolean).join(' ');
  const queries = wellnessMode
    ? [
        `${wellnessPhotoQuery} wellness event hero`,
        `${wellnessPhotoQuery} professional consultation care team`,
        `${wellnessPhotoQuery} community wellness event participants`,
        `${wellnessPhotoQuery} healthy lifestyle self care`,
        `${wellnessPhotoQuery} registration follow up clinic`,
      ]
    : [
        `${input.sectorLabel || input.sectorKey || 'business'} landing page`,
        `${input.campaignName || input.businessName || input.sectorLabel || 'campaign'} marketing`,
      ];

  const fetched = [];
  const usedUrls = new Set();
  const prefilledUrls = new Set();
  imageBlocks.forEach((block) => {
    const src = String(block?.props?.src || '').trim();
    if (!src) return;
    // Wellness pages must use the campaign-aware Pexels pass below. Do not
    // trust an arbitrary external URL emitted by the model, because it may
    // be a generic clinic image or an unrelated stock photo.
    if (wellnessMode && /^https?:\/\//i.test(src)) {
      block.props.src = '';
      return;
    }
    if (prefilledUrls.has(src)) {
      // LLMs occasionally copy one image URL into several slots. Clear the
      // later occurrence so the slot can be filled by the distinct-image
      // provider pass below instead of rendering the same photo repeatedly.
      block.props.src = '';
      return;
    }
    prefilledUrls.add(src);
    usedUrls.add(src);
  });
  for (let index = 0; index < imageBlocks.length; index += 1) {
    if (imageBlocks[index]?.props?.src) {
      fetched[index] = null;
      continue;
    }
    const query = wellnessMode
      ? queryForWellnessImageSlot(wellnessImagePlan, imageBlocks[index]?.id || imageBlocks[index]?.props?.variant, index)
      : queries[index % queries.length];
    try {
      const image = await destinationImageProvider.fetchOne(query, {
        tenantId: options.tenantId,
        aspectRatio: '16:9',
        stockOnly: true,
        excludeUrls: usedUrls,
        ...(wellnessMode ? { excludeProviders: ['unsplash', 'pixabay', 'ai-fallback'] } : {}),
        ...(wellnessMode ? {
          relevanceTerms: wellnessImagePlan.relevanceTerms,
          requireRelevance: true,
        } : {}),
      });
      if (image && image.url && !usedUrls.has(image.url)) {
        fetched[index] = image;
        usedUrls.add(image.url);
      } else {
        fetched[index] = null;
      }
    } catch (_err) {
      fetched[index] = null;
    }
  }

  imageBlocks.forEach((block, index) => {
    const image = fetched[index] || null;
    if (!block.props.src && image && image.url) {
      block.props.src = image.url;
      if (!block.props.alt && image.attribution) {
        block.props.alt = `Photo by ${image.attribution.photographer || image.attribution.providerId}`;
      }
      if (wellnessMode && image.attribution?.providerId === 'pexels') {
        block.props.imageProvider = 'pexels';
        block.props.imageQueryVersion = IMAGE_QUERY_VERSION;
      }
    }
  });

  return { ...payload, blocks, imagesFetched: fetched.filter(Boolean).length };
}

async function generateLandingSiteContent(input = {}, options = {}) {
  const tenantId = input.tenantId;
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const wellnessMode = isWellnessSector(sectorKey);
  const prompt = wellnessMode
    ? buildWellnessLandingSitePrompt({ ...input, sectorKey })
    : buildGenericLandingSitePrompt({ ...input, sectorKey });
  await checkBudgetCap(tenantId);

  const userId = input.userId || options.userId || null;

  let rawJson = null;
  let modelUsed = null;
  let source = 'stub';
  let stub = true;
  let realModeError = null;
  // Machine-readable AI-access block (AI_NOT_CONFIGURED /
  // AI_CREDITS_EXHAUSTED). aiGateway throws these as `friendly` errors when
  // the tenant has no BYOK key and no funded subscription — previously they
  // were swallowed here and the caller only saw a silent stub draft, so the
  // UI could never tell "AI isn't set up" apart from a real draft.
  let aiBlockedCode = null;
  let aiBlockedMessage = null;

  // ONE call through aiGateway — it resolves BYOK (the tenant's single
  // fixed provider, if configured — a per-attempt "try Gemini then OpenAI
  // then Groq" loop doesn't apply to BYOK since resolveProviderConfig
  // returns the same BYOK config regardless of the requested-model hint)
  // or a funded CRM-managed subscription, whose own model-family cascade
  // (Gemini → OpenAI-compatible → Anthropic, see
  // lib/aiProviderManagement.resolveProviderConfig's `fallbacks`) is
  // walked automatically inside generateChatCompletion on failure. A
  // "friendly" blocked-access error (no BYOK, no funded subscription)
  // falls through to the deterministic stub, same as before.
  try {
    const resp = await aiGateway.runAiRequest({
      tenantId,
      userId,
      task: TASK_NAME,
      surface: 'landingSiteGeneratorLLM',
      requestedModelLabel: 'gemini-flash',
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
    });
    rawJson = resp.text;
    modelUsed = resp.model;
    source = resp.provider || 'gemini';
    stub = false;
  } catch (err) {
    if (err && err.friendly) {
      aiBlockedCode = err.code || 'AI_NOT_CONFIGURED';
      aiBlockedMessage = err.message || null;
    } else {
      realModeError = formatGeminiLimitMessage(err) || err.message || String(err);
    }
  }

  let payload = null;
  let imageInput = { ...input, sectorKey };
  if (rawJson) {
    try {
      payload = parseJson(rawJson);
    } catch (err) {
      realModeError = err.message || String(err);
    }
  }

  if (!payload || typeof payload !== 'object') {
    payload = buildGenericFallback(input);
    source = 'stub';
    stub = true;
  }

  const fallback = buildGenericFallback(input);
  if (wellnessMode) {
    const wellnessContent = payload && typeof payload.content === 'object' && !Array.isArray(payload.content) ? payload.content : {};
    const wellnessInput = {
      ...input,
      ...wellnessContent,
      wellnessLayout: input.wellnessLayout || wellnessContent.layoutId || input.layoutId,
      sectorKey,
      sectorLabel: input.sectorLabel || fallback.seoMeta.metaTitle?.split(' | ')[1] || input.sectorLabel,
    };
    imageInput = wellnessInput;
    if (!payload.suggestedTitle) payload.suggestedTitle = wellnessContent.suggestedTitle || fallback.suggestedTitle;
    if (!payload.suggestedSlug) payload.suggestedSlug = wellnessContent.suggestedSlug || fallback.suggestedSlug;
    if (!payload.description) payload.description = wellnessContent.description || fallback.description;
    if (!payload.seoMeta || typeof payload.seoMeta !== 'object') payload.seoMeta = fallback.seoMeta;
    payload.blocks = buildWellnessRegistrationBlocks(wellnessInput, { ...payload, description: payload.description });
  } else {
    if (!payload.suggestedTitle) payload.suggestedTitle = fallback.suggestedTitle;
    if (!payload.suggestedSlug) payload.suggestedSlug = fallback.suggestedSlug;
    if (!payload.description) payload.description = fallback.description;
    if (!payload.seoMeta || typeof payload.seoMeta !== 'object') payload.seoMeta = fallback.seoMeta;
    payload.blocks = ensureBlockArray(payload.blocks);
    if (!payload.blocks.length) {
      payload.blocks = fallback.blocks;
    }
  }

  payload = await enrichWithImages({ ...payload, blocks: ensureBlockArray(payload.blocks) }, imageInput, options);
  payload.blocks = ensureBlockArray(payload.blocks);

  return {
    ...payload,
    source,
    model: modelUsed || (source === 'stub' ? 'stub' : process.env.LLM_MODEL_GEMINI || MODEL_PRIMARY),
    stub,
    verdict: stub ? 'fallback' : 'passed',
    guardrailIssues: [],
    realModeError,
    aiBlockedCode,
    aiBlockedMessage,
    sectorKey,
  };
}

module.exports = {
  generateLandingSiteContent,
  computeMonthlySpendCents,
  checkBudgetCap,
  parseJson,
  ensureBlockArray,
};
