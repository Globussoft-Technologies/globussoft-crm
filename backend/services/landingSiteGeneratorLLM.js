'use strict';

if (process.env.NODE_ENV !== 'test') {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: false });
}

const llmRouter = require('../lib/llmRouter');
const destinationImageProvider = require('./destinationImageProvider');
const { getBudgetCap, evaluateCap } = require('../lib/tenantSettings');
const {
  BASIC_BLOCK_TYPES,
  buildGenericLandingSitePrompt,
  buildGenericFallback,
  buildWellnessRegistrationBlocks,
  isWellnessSector,
  normalizeSectorKey,
} = require('./landingSitePrompts');

const INTEGRATION = 'llm';
const MODEL_PRIMARY = 'gemini-2.5-flash';
const MODEL_FALLBACK = 'gemini-2.0-flash';

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

async function callGeminiAttempt({ apiKey, modelName, prompt }, usageOut) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
  });
  const fullPrompt = `${prompt.system}\n\n${prompt.user}`;
  const res = await model.generateContent(fullPrompt);
  const text = res?.response?.text?.();
  if (usageOut && typeof usageOut === 'object') {
    const usage = (res && res.response && res.response.usageMetadata) || {};
    usageOut.promptTokens = usage.promptTokenCount || 0;
    usageOut.completionTokens = usage.candidatesTokenCount || 0;
  }
  if (!text) throw new Error('LLM returned an empty response');
  return text;
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

  const imageBlocks = collectBlocksByType(blocks, 'image');
  if (!imageBlocks.length) return { ...payload, blocks };

  const wellnessPhotoQuery = [input.campaignName, input.campaignGoal, input.audience, input.location, input.sectorLabel || input.sectorKey, 'wellness healthcare community event'].filter(Boolean).join(' ');
  const queries = isWellnessSector(input.sectorKey)
    ? [
        wellnessPhotoQuery,
        [input.businessName, input.sectorLabel || input.sectorKey, 'wellness event registration'].filter(Boolean).join(' '),
      ]
    : [
        `${input.sectorLabel || input.sectorKey || 'business'} landing page`,
        `${input.campaignName || input.businessName || input.sectorLabel || 'campaign'} marketing`,
      ];

  const fetched = [];
  for (const query of queries) {
    try {
      const image = await destinationImageProvider.fetchOne(query, {
        tenantId: options.tenantId,
        aspectRatio: '16:9',
        stockOnly: true,
      });
      if (image && image.url) fetched.push(image);
    } catch (_err) {
      fetched.push(null);
    }
  }

  imageBlocks.forEach((block, index) => {
    const image = fetched[index] || fetched[0] || null;
    if (!block.props.src && image && image.url) {
      block.props.src = image.url;
      if (!block.props.alt && image.attribution) {
        block.props.alt = `Photo by ${image.attribution.photographer || image.attribution.providerId}`;
      }
    }
  });

  return { ...payload, blocks, imagesFetched: fetched.filter(Boolean).length };
}

async function generateLandingSiteContent(input = {}, options = {}) {
  const tenantId = input.tenantId;
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const prompt = buildGenericLandingSitePrompt({ ...input, sectorKey });
  await checkBudgetCap(tenantId);

  const llmKey = tenantId ? await llmRouter.getLlmKey(tenantId, 'gemini-flash') : null;
  const usageOut = {};
  let rawJson = null;
  let modelUsed = null;
  let source = 'stub';
  let stub = true;
  let realModeError = null;

  if (llmKey) {
    const cascade = [process.env.LLM_MODEL_GEMINI || MODEL_PRIMARY, process.env.LLM_MODEL_GEMINI_FALLBACK || MODEL_FALLBACK, 'gemini-2.0-flash-lite'];
    for (const modelName of cascade) {
      try {
        rawJson = await callGeminiAttempt({ apiKey: llmKey, modelName, prompt }, usageOut);
        modelUsed = modelName;
        source = 'gemini';
        stub = false;
        realModeError = null;
        break;
      } catch (err) {
        realModeError = err.message || String(err);
      }
    }
  }

  let payload = null;
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
  if (!payload.suggestedTitle) payload.suggestedTitle = fallback.suggestedTitle;
  if (!payload.suggestedSlug) payload.suggestedSlug = fallback.suggestedSlug;
  if (!payload.description) payload.description = fallback.description;
  if (!payload.seoMeta || typeof payload.seoMeta !== 'object') payload.seoMeta = fallback.seoMeta;
  payload.blocks = ensureBlockArray(payload.blocks);
  if (!payload.blocks.length) payload = fallback;

  payload.blocks = ensureBlockArray(payload.blocks);
  if (isWellnessSector(sectorKey)) {
    payload.blocks = buildWellnessRegistrationBlocks({ ...input, sectorKey }, payload);
  }
  payload = await enrichWithImages(payload, { ...input, sectorKey }, options);
  payload.blocks = ensureBlockArray(payload.blocks);

  return {
    ...payload,
    source,
    model: modelUsed || (llmKey ? process.env.LLM_MODEL_GEMINI || MODEL_PRIMARY : 'stub'),
    stub,
    verdict: stub ? 'fallback' : 'passed',
    guardrailIssues: [],
    realModeError,
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
