const { KEYS, getSetting } = require('./tenantSettings');

/**
 * Normalise a comparison value so that case, whitespace, and punctuation
 * differences are ignored. "Web-form", "web-form", and "web form" all
 * collapse to "webform".
 *
 * @param {any} value
 * @returns {string}
 */
function normaliseMatchValue(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Evaluate a single rule against a lead.
 *
 * @param {Object} rule
 * @param {Object} leadData     Built-in Contact fields (e.g. source, status, company).
 * @param {Object} customFields Map of fieldKey -> value for lead custom fields.
 * @returns {boolean}
 */
function ruleMatches(rule, leadData, customFields) {
  if (!rule || !rule.enabled || !rule.column || rule.campaignId == null) return false;

  const column = String(rule.column);
  let actualValue;
  if (column.startsWith('cf_')) {
    const fieldKey = column.slice(3);
    actualValue = customFields && customFields[fieldKey];
  } else {
    actualValue = leadData && leadData[column];
  }

  const normalisedActual = normaliseMatchValue(actualValue);
  const normalisedExpected = normaliseMatchValue(rule.value);
  if (!normalisedExpected) return false;

  return normalisedActual === normalisedExpected;
}

/**
 * Evaluate the tenant's auto-campaign assignment rules against a lead.
 * Returns the first matching campaign id, or null if none match.
 *
 * @param {number} tenantId
 * @param {Object} leadData     Built-in Contact fields.
 * @param {Object} customFields Lead custom fields map.
 * @returns {Promise<number|null>}
 */
async function evaluateAutoCampaignRules(tenantId, leadData, customFields) {
  if (!tenantId) return null;
  try {
    const config = await getSetting(tenantId, KEYS.CALLIFIED_AUTO_CAMPAIGN_RULES, {
      coerce: (v) => {
        if (!v || v === '' || v === 'null') return { enabled: false, rules: [] };
        try {
          const parsed = JSON.parse(v);
          if (parsed && Array.isArray(parsed.rules)) return parsed;
          return { enabled: false, rules: [] };
        } catch (_e) {
          return { enabled: false, rules: [] };
        }
      },
      fallback: { enabled: false, rules: [] },
    });

    if (!config || !config.enabled || !Array.isArray(config.rules) || config.rules.length === 0) {
      return null;
    }

    for (const rule of config.rules) {
      if (ruleMatches(rule, leadData, customFields)) {
        const campaignId = Number(rule.campaignId);
        return Number.isFinite(campaignId) && campaignId > 0 ? campaignId : null;
      }
    }
    return null;
  } catch (e) {
    console.error('[callifiedAutoCampaignRules] evaluation failed:', e.message);
    return null;
  }
}

module.exports = {
  normaliseMatchValue,
  ruleMatches,
  evaluateAutoCampaignRules,
};
