/**
 * Callified.ai integration client.
 *
 * Supports both the legacy outbound-call stub envelope and the real
 * campaign-first flow used by the generic CRM Leads page:
 *   list campaigns → create lead → enroll → dial → poll transcripts + review.
 *
 * Authentication:
 *   - Per-tenant config lives in `Integration` row provider="callified".
 *   - `Integration.token` holds the API key (ck_...).
 *   - `Integration.settings` is a JSON string with email/password fallback,
 *     baseUrl override, and webhook secret.
 *   - The API key is exchanged for a JWT via GET /api/auth/token?api_key=...
 *     or, if no API key, via POST /api/auth/login with email/password.
 *   - The JWT is cached in memory with a short TTL and refreshed on 401.
 *
 * Cap + feature-flag scaffold (DC-1/2/3/5/7) stays unchanged.
 */

const prisma = require('../lib/prisma');
const { getBudgetCap, getSetting, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'ai_calling';
const FEATURE_FLAG_KEY = 'featureFlag_ai_calling_enabled';
const MAX_CALL_DURATION_SECONDS = 90; // DC-1 per-call ceiling

// JWT cache: { tenantId: { token, expiresAt } }
const tokenCache = new Map();
const JWT_CACHE_TTL_MS = 25 * 60 * 1000; // 25 minutes, safe under typical 30-min expiry

// Touch KEYS so the imported binding isn't flagged unused.
void KEYS;

async function isEnabledForTenant(tenantId) {
  return await getSetting(tenantId, FEATURE_FLAG_KEY, {
    coerce: (v) => v === 'true' || v === '1',
    fallback: true,
  });
}

async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly AI calling spend cap reached for this tenant.');
    err.code = 'AI_CALLING_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(`[callifiedClient] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly AI calling cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`);
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: real implementation will sum CallSession.costEstimate (Decimal USD)
  // filtered by tenantId + createdAt >= startOfMonth. For now returns 0.
  return 0;
}

/**
 * Resolve per-tenant Callified configuration.
 *
 * Reads from `Integration` row provider="callified" first, then falls back to
 * environment variables. Returns a normalized config object.
 *
 * @param {number} tenantId
 * @returns {Promise<{apiKey?: string, email?: string, password?: string, baseUrl: string, webhookSecret?: string, isActive: boolean}>}
 */
async function getCallifiedConfig(tenantId) {
  const envBaseUrl = process.env.CALLIFIED_API_BASE_URL || process.env.CALLIFIED_API_URL || 'https://app.callified.ai';
  const envApiKey = process.env.CALLIFIED_API_KEY || null;
  const envWebhookSecret = process.env.CALLIFIED_WEBHOOK_SECRET || null;

  let row = null;
  try {
    row = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'callified' } },
    });
  } catch (e) {
    console.error(`[callifiedClient] getCallifiedConfig prisma error: ${e.message}`);
  }

  let settings = {};
  if (row && row.settings) {
    try {
      settings = JSON.parse(row.settings);
    } catch (e) {
      console.warn(`[callifiedClient] invalid Integration.settings JSON for tenant ${tenantId}: ${e.message}`);
    }
  }

  const apiKey = settings.apiKey || row?.token || (tenantId ? await module.exports.getCallifiedKey(tenantId) : envApiKey) || null;
  const email = settings.email || null;
  const password = settings.password || null;
  const baseUrl = settings.baseUrl || envBaseUrl;
  const webhookSecret = settings.webhookSecret || envWebhookSecret || null;

  return {
    apiKey,
    email,
    password,
    baseUrl: baseUrl.replace(/\/$/, ''),
    webhookSecret,
    isActive: !!row?.isActive || !!(apiKey || (email && password)),
  };
}

/**
 * Obtain a Callified JWT for the tenant.
 *
 * Tries API key exchange first, then email/password login. Caches the result.
 *
 * @param {number} tenantId
 * @returns {Promise<string>}
 */
async function getCallifiedToken(tenantId) {
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() && cached.token) {
    return cached.token;
  }

  const config = await module.exports.getCallifiedConfig(tenantId);
  if (!config.isActive) {
    const err = new Error('Callified integration not configured for this tenant.');
    err.code = 'CALLIFIED_NOT_CONFIGURED';
    throw err;
  }

  let token = null;
  let authMethod = null;

  if (config.apiKey) {
    try {
      const res = await fetch(`${config.baseUrl}/api/auth/token?api_key=${encodeURIComponent(config.apiKey)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        token = data.access_token || data.token || data.jwt || null;
        authMethod = 'api_key';
      } else {
        const text = await res.text().catch(() => '');
        console.warn(`[callifiedClient] API key token exchange failed for tenant ${tenantId}: ${res.status} ${text}`);
      }
    } catch (e) {
      console.warn(`[callifiedClient] API key token exchange error for tenant ${tenantId}: ${e.message}`);
    }
  }

  if (!token && config.email && config.password) {
    try {
      const res = await fetch(`${config.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: config.email, password: config.password }),
      });
      if (res.ok) {
        const data = await res.json();
        token = data.access_token || data.token || data.jwt || null;
        authMethod = 'password';
      } else {
        const text = await res.text().catch(() => '');
        console.warn(`[callifiedClient] password login failed for tenant ${tenantId}: ${res.status} ${text}`);
      }
    } catch (e) {
      console.warn(`[callifiedClient] password login error for tenant ${tenantId}: ${e.message}`);
    }
  }

  if (!token) {
    const err = new Error('Unable to authenticate with Callified. Check API key or email/password in Settings.');
    err.code = 'CALLIFIED_AUTH_FAILED';
    throw err;
  }

  tokenCache.set(tenantId, { token, expiresAt: Date.now() + JWT_CACHE_TTL_MS, authMethod });
  return token;
}

function clearTokenCache(tenantId) {
  if (tenantId) tokenCache.delete(tenantId);
  else tokenCache.clear();
}

/**
 * Authenticated fetch to Callified. Refreshes JWT once on 401.
 *
 * @param {number} tenantId
 * @param {string} path
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function callifiedFetch(tenantId, path, options = {}) {
  const token = await module.exports.getCallifiedToken(tenantId);
  const config = await module.exports.getCallifiedConfig(tenantId);
  const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearTokenCache(tenantId);
    const newToken = await module.exports.getCallifiedToken(tenantId);
    const retry = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${newToken}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    return retry;
  }

  return res;
}

async function callifiedJson(tenantId, path, options = {}) {
  const res = await callifiedFetch(tenantId, path, options);
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Callified API error ${res.status}: ${text || 'Unknown error'}`);
    err.status = res.status;
    err.code = `CALLIFIED_API_${res.status}`;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch (_e) {
    const err = new Error(`Invalid JSON from Callified: ${text}`);
    err.code = 'CALLIFIED_INVALID_JSON';
    throw err;
  }
}

/**
 * List active Callified campaigns for the tenant.
 */
async function listCampaigns(tenantId) {
  const data = await callifiedJson(tenantId, '/api/campaigns');
  return Array.isArray(data) ? data : [];
}

/**
 * Persist a phone → Callified lead id mapping in the tenant's Integration.settings.
 * This is the canonical source of truth for reusing leads across calls.
 */
async function storeCallifiedLeadMapping(tenantId, phone, callifiedLeadId) {
  if (!tenantId || !phone || !callifiedLeadId) return;
  const normalizedPhone = normalizeCallifiedPhone(phone);
  try {
    const row = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'callified' } },
      select: { id: true, settings: true },
    });
    if (!row) return;
    let settings = {};
    if (row.settings) {
      try {
        settings = JSON.parse(row.settings);
      } catch (_e) {
        settings = {};
      }
    }
    settings.callifiedLeadMappings = settings.callifiedLeadMappings || {};
    settings.callifiedLeadMappings[normalizedPhone] = Number(callifiedLeadId);
    await prisma.integration.update({
      where: { id: row.id },
      data: { settings: JSON.stringify(settings) },
    });
  } catch (e) {
    console.error(`[callifiedClient] storeCallifiedLeadMapping failed: ${e.message}`);
  }
}

async function clearCallifiedLeadMapping(tenantId, phone) {
  if (!tenantId || !phone) return;
  const normalizedPhone = normalizeCallifiedPhone(phone);
  try {
    const row = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'callified' } },
      select: { id: true, settings: true },
    });
    if (!row || !row.settings) return;
    let settings = {};
    try {
      settings = JSON.parse(row.settings);
    } catch (_e) {
      settings = {};
    }
    settings.callifiedLeadMappings = settings.callifiedLeadMappings || {};
    const mappedKey = Object.keys(settings.callifiedLeadMappings).find((k) =>
      isPhoneMatch(k, normalizedPhone),
    );
    if (mappedKey) {
      delete settings.callifiedLeadMappings[mappedKey];
      await prisma.integration.update({
        where: { id: row.id },
        data: { settings: JSON.stringify(settings) },
      });
      console.log(`[callifiedClient] cleared stale mapping for ${normalizedPhone} (was ${mappedKey})`);
    }
  } catch (e) {
    console.error(`[callifiedClient] clearCallifiedLeadMapping failed: ${e.message}`);
  }
}

/**
 * Look up a previously stored Callified lead id for a phone number.
 * Order of lookup:
 *   1. Tenant Integration.settings.callifiedLeadMappings
 *   2. Most recent CRM CallLog for this phone + provider
 *   3. Callified API search heuristics (undocumented; best-effort)
 */
async function findCallifiedLeadByPhone(tenantId, phone, campaignId) {
  if (!tenantId || !phone) return null;
  const normalizedPhone = normalizeCallifiedPhone(phone);

  try {
    const row = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'callified' } },
      select: { settings: true },
    });
    if (row && row.settings) {
      const settings = JSON.parse(row.settings);
      const mappings = settings?.callifiedLeadMappings || {};
      // Compare by last 10 digits so +91 9176955432 matches 9176955432.
      const mappedKey = Object.keys(mappings).find((k) => isPhoneMatch(k, normalizedPhone));
      if (mappedKey) {
        const mappedId = Number(mappings[mappedKey]);
        const exists = await _verifyLeadExists(tenantId, mappedId, campaignId, normalizedPhone);
        if (exists) {
          return { id: mappedId, source: 'integration_settings' };
        }
        console.log(`[callifiedClient] findCallifiedLeadByPhone: mapped lead ${mappedId} is stale, clearing mapping for ${normalizedPhone}`);
        await clearCallifiedLeadMapping(tenantId, normalizedPhone);
      }
    }
  } catch (_e) {
    // ignore
  }

  const previousLog = await prisma.callLog.findFirst({
    where: { tenantId, provider: 'callified' },
    orderBy: { createdAt: 'desc' },
    select: { calleeNumber: true, notes: true },
  });
  if (previousLog && previousLog.notes) {
    try {
      const notes = JSON.parse(previousLog.notes);
      if (notes && notes.callifiedLeadId) {
        // Only reuse the CallLog mapping if the phone digits match.
        if (isPhoneMatch(previousLog.calleeNumber || '', normalizedPhone)) {
          const callLogLeadId = Number(notes.callifiedLeadId);
          const exists = await _verifyLeadExists(tenantId, callLogLeadId, campaignId, normalizedPhone);
          if (exists) {
            return { id: callLogLeadId, source: 'crm_calllog' };
          }
          console.log(`[callifiedClient] findCallifiedLeadByPhone: callLog lead ${callLogLeadId} is stale, skipping for ${normalizedPhone}`);
        }
      }
    } catch (_e) {
      // ignore parse errors
    }
  }

  return null;
}

/**
 * Verify that a Callified lead id is still reachable in the current org.
 *
 * The documented surface has no GET /api/leads/{id}. Do NOT use the
 * transcripts endpoint: Callified keeps transcripts even after the lead is
 * deleted, so a ghost lead appears alive. Instead we verify the id appears
 * in live lead lists (campaign-scoped first, then global phone search).
 */
async function _verifyLeadExists(tenantId, leadId, campaignId, phone) {
  if (!tenantId || !leadId) return false;

  const phoneMatches = (candidate) => {
    if (!phone) return true;
    return candidate && isPhoneMatch(candidate.phone, phone);
  };

  // 1. Selected campaign's live lead list.
  if (campaignId) {
    try {
      let campaignLeads = await callifiedJson(tenantId, `/api/campaigns/${campaignId}/leads?limit=1000`).catch(() => null);
      if (!Array.isArray(campaignLeads) && campaignLeads && Array.isArray(campaignLeads.data)) {
        campaignLeads = campaignLeads.data;
      }
      if (!Array.isArray(campaignLeads) && campaignLeads && Array.isArray(campaignLeads.leads)) {
        campaignLeads = campaignLeads.leads;
      }
      if (Array.isArray(campaignLeads)) {
        const match = campaignLeads.find((l) => Number(l.id) === Number(leadId));
        if (match && phoneMatches(match)) {
          return true;
        }
        if (match) {
          console.log(`[callifiedClient] verifyLeadExists: lead ${leadId} found in campaign ${campaignId} but phone mismatch (${match.phone} != ${phone}); treating as stale`);
        }
      }
    } catch (e) {
      console.log(`[callifiedClient] verifyLeadExists: campaign-leads check failed for ${leadId}: ${e.message}`);
    }
  }

  // 2. Global phone search across variants.
  if (phone) {
    const normalizedPhone = normalizeCallifiedPhone(phone);
    try {
      for (const variant of phoneSearchVariants(normalizedPhone)) {
        let data = await callifiedJson(tenantId, `/api/leads?phone=${encodeURIComponent(variant)}&limit=1000`).catch(() => null);
        if (!Array.isArray(data) && data && Array.isArray(data.data)) data = data.data;
        if (!Array.isArray(data) && data && Array.isArray(data.leads)) data = data.leads;
        const candidates = Array.isArray(data) ? data : data && data.id ? [data] : [];
        const match = candidates.find((l) => Number(l.id) === Number(leadId));
        if (match && phoneMatches(match)) {
          return true;
        }
        if (match) {
          console.log(`[callifiedClient] verifyLeadExists: lead ${leadId} found via phone search but phone mismatch (${match.phone} != ${phone}); treating as stale`);
        }
      }
    } catch (e) {
      console.log(`[callifiedClient] verifyLeadExists: phone-search check failed for ${leadId}: ${e.message}`);
    }
  }

  return false;
}

/**
 * Look up a lead in Callified by phone number via the remote API.
 * Used when the local CRM mapping is missing but Callified rejects create
 * with a 409 duplicate-phone error. We ask the remote system for the id
 * rather than guessing, then persist the mapping for next time.
 *
 * Priority order:
 *   1. Active leads in the selected campaign.
 *   2. Active leads in other campaigns.
 *   3. Generic /api/leads?phone search.
 *   4. Historical call-log entries (verified; call-log can reference deleted leads).
 *
 * Every candidate is verified with verifyLeadExists before it is returned so
 * we never recycle a stale/deleted lead id that would fail on dial.
 */
function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function phoneMatchScore(a, b) {
  // Indian mobile numbers are often stored with or without the +91 prefix.
  // We match by the last 10 digits first, and fall back to full digits.
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length >= 10 && db.length >= 10 && da.slice(-10) === db.slice(-10)) return 2;
  if (da === db && da.length > 0) return 1;
  return 0;
}

function isPhoneMatch(a, b) {
  return phoneMatchScore(a, b) > 0;
}

/**
 * Normalize a phone number to the format Callified's dialer expects.
 *
 * Callified accepts leads with spaces (e.g. "+91 9176955432") for storage,
 * but the dialer silently fails on space-containing E.164 numbers. The
 * dashboard strips spaces, so leads created there ring while CRM-created
 * leads with raw user input may not. We force a consistent format:
 *   - Indian mobile 10 digits starting 6-9  -> +91XXXXXXXXXX
 *   - Indian mobile with 91 country code    -> +91XXXXXXXXXX
 *   - Longer international                  -> +<digits>
 *   - Everything else                       -> <digits>
 */
function normalizeCallifiedPhone(phone) {
  const digits = digitsOnly(phone);
  // Indian mobile: 10 digits starting with 6-9 -> +91...
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91${digits}`;
  }
  // Indian mobile with country code: 12 digits starting with 91
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }
  // Indian landline with STD code (e.g., 01112345678) - keep as digits
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits;
  }
  // International / other long numbers
  if (digits.length > 10) {
    return `+${digits}`;
  }
  return digits;
}

function isNormalizedPhoneFormat(phone) {
  return normalizeCallifiedPhone(phone) === String(phone).trim();
}

/**
 * Return a list of likely phone string variants for search endpoints that
 * may normalize differently. Helps recovery find an existing lead when the
 * exact stored format does not match.
 */
function phoneSearchVariants(phone) {
  const normalized = normalizeCallifiedPhone(phone);
  const digits = digitsOnly(normalized);
  const variants = new Set([normalized]);
  if (digits.length >= 10) {
    variants.add(digits);
    variants.add(`+${digits}`);
    variants.add(digits.slice(-10));
    variants.add(`0${digits.slice(-10)}`);
    variants.add(`+${digits.slice(0, 2)} ${digits.slice(2)}`);
  }
  return Array.from(variants);
}

async function findCallifiedLeadByPhoneApi(tenantId, phone, campaignId) {
  if (!tenantId || !phone) return null;
  const normalizedPhone = normalizeCallifiedPhone(phone);
  const targetDigits = digitsOnly(normalizedPhone);

  function pickMatch(list) {
    if (!Array.isArray(list)) return null;
    // Prefer a lead whose stored phone is already normalized/dialable. A lead
    // with spaces or trailing junk may ring silently, so we only fall back to
    // a malformed match when no clean lead exists.
    const normalizedMatch = list.find(
      (l) => l && l.id && isPhoneMatch(l.phone, normalizedPhone) && isNormalizedPhoneFormat(l.phone),
    );
    if (normalizedMatch) return normalizedMatch;
    return list.find((l) => l && l.id && isPhoneMatch(l.phone, normalizedPhone));
  }

  try {
    // 1. Selected campaign's active lead list (documented, preferred).
    if (campaignId) {
      console.log(
        `[callifiedClient] 409 recovery: searching active leads in campaign ${campaignId} for ${normalizedPhone} (digits ${targetDigits})`,
      );
      let campaignLeads = await callifiedJson(
        tenantId,
        `/api/campaigns/${campaignId}/leads?limit=1000`,
      ).catch((_e) => {
        console.log(`[callifiedClient] 409 recovery: campaign-leads endpoint failed: ${_e.message}`);
        return null;
      });
      if (!Array.isArray(campaignLeads) && campaignLeads && Array.isArray(campaignLeads.data)) {
        campaignLeads = campaignLeads.data;
      }
      if (!Array.isArray(campaignLeads) && campaignLeads && Array.isArray(campaignLeads.leads)) {
        campaignLeads = campaignLeads.leads;
      }
      const match = pickMatch(campaignLeads);
      if (match) {
        console.log(`[callifiedClient] 409 recovery: matched selected-campaign lead id ${match.id} (phone: ${match.phone})`);
        return { id: Number(match.id), phone: match.phone };
      }
    }

    // 2. Active leads in all other campaigns.
    console.log(`[callifiedClient] 409 recovery: scanning all campaigns for active lead ${normalizedPhone}`);
    const campaigns = await module.exports.listCampaigns(tenantId).catch((_e) => {
      console.log(`[callifiedClient] 409 recovery: listCampaigns failed: ${_e.message}`);
      return [];
    });
    const allCampaigns = (campaigns || []).filter((c) => c && c.id && c.id !== Number(campaignId));
    for (const c of allCampaigns) {
      let otherLeads = await callifiedJson(
        tenantId,
        `/api/campaigns/${c.id}/leads?limit=1000`,
      ).catch((_e) => null);
      if (!Array.isArray(otherLeads) && otherLeads && Array.isArray(otherLeads.data)) {
        otherLeads = otherLeads.data;
      }
      if (!Array.isArray(otherLeads) && otherLeads && Array.isArray(otherLeads.leads)) {
        otherLeads = otherLeads.leads;
      }
      const match = pickMatch(otherLeads);
      if (match) {
        console.log(`[callifiedClient] 409 recovery: matched campaign-${c.id} lead id ${match.id} (phone: ${match.phone})`);
        return { id: Number(match.id), phone: match.phone };
      }
    }

    // 3. Generic phone search with multiple formats (best-effort, undocumented).
    for (const variant of phoneSearchVariants(normalizedPhone)) {
      console.log(`[callifiedClient] 409 recovery: trying generic /api/leads?phone=${encodeURIComponent(variant)}`);
      let data = await callifiedJson(
        tenantId,
        `/api/leads?phone=${encodeURIComponent(variant)}&limit=1000`,
      ).catch((_e) => {
        console.log(`[callifiedClient] 409 recovery: generic phone search failed for ${variant}: ${_e.message}`);
        return null;
      });
      if (!Array.isArray(data) && data && Array.isArray(data.data)) data = data.data;
      if (!Array.isArray(data) && data && Array.isArray(data.leads)) data = data.leads;
      const candidates = Array.isArray(data) ? data : data && data.id ? [data] : [];
      const match = pickMatch(candidates);
      if (match) {
        console.log(`[callifiedClient] 409 recovery: matched generic-search lead id ${match.id} (phone: ${match.phone})`);
        return { id: Number(match.id), phone: match.phone };
      }
    }

    // 4. Historical call-logs only as a last resort; entries may reference deleted leads.
    //    Only use `lead_id` from a call-log entry — `id` in call-log is the call/transcript id.
    if (campaignId) {
      console.log(
        `[callifiedClient] 409 recovery: searching call-logs for campaign ${campaignId} for ${normalizedPhone}`,
      );
      const callLog = await callifiedJson(
        tenantId,
        `/api/campaigns/${campaignId}/call-log`,
      ).catch((_e) => {
        console.log(`[callifiedClient] 409 recovery: call-log endpoint failed: ${_e.message}`);
        return null;
      });
      if (Array.isArray(callLog)) {
        console.log(`[callifiedClient] 409 recovery: call-log returned ${callLog.length} entries`);
        const match = callLog.find((l) => isPhoneMatch(l.phone, normalizedPhone));
        if (match && match.lead_id) {
          const verified = await _verifyLeadExists(tenantId, match.lead_id, campaignId, normalizedPhone);
          if (verified) {
            console.log(`[callifiedClient] 409 recovery: verified call-log lead id ${match.lead_id}`);
            return { id: Number(match.lead_id), phone: match.phone };
          }
          console.log(`[callifiedClient] 409 recovery: call-log lead id ${match.lead_id} is stale; skipping`);
        }
      }

      for (const c of allCampaigns) {
        const otherLog = await callifiedJson(
          tenantId,
          `/api/campaigns/${c.id}/call-log`,
        ).catch((_e) => null);
        if (Array.isArray(otherLog)) {
          const match = otherLog.find((l) => isPhoneMatch(l.phone, normalizedPhone));
          if (match && match.lead_id) {
            const verified = await _verifyLeadExists(tenantId, match.lead_id, c.id, normalizedPhone);
            if (verified) {
              console.log(`[callifiedClient] 409 recovery: verified call-log-campaign-${c.id} lead id ${match.lead_id}`);
              return { id: Number(match.lead_id), phone: match.phone };
            }
            console.log(`[callifiedClient] 409 recovery: call-log-campaign-${c.id} lead id ${match.lead_id} is stale; skipping`);
          }
        }
      }
    }
    // 5. Global lead list fallback. Some Callified accounts keep the lead
    //    orphaned (not enrolled in any campaign) so campaign lists and call-logs
    //    are empty. Try listing all leads and matching by digits.
    for (const page of [1, 2, 3]) {
      console.log(`[callifiedClient] 409 recovery: trying global lead list page ${page} for ${normalizedPhone}`);
      let allLeads = await callifiedJson(tenantId, `/api/leads?page=${page}&limit=1000`).catch((_e) => {
        console.log(`[callifiedClient] 409 recovery: global lead list page ${page} failed: ${_e.message}`);
        return null;
      });
      if (!Array.isArray(allLeads) && allLeads && Array.isArray(allLeads.data)) {
        allLeads = allLeads.data;
      }
      if (!Array.isArray(allLeads) && allLeads && Array.isArray(allLeads.leads)) {
        allLeads = allLeads.leads;
      }
      const match = pickMatch(allLeads);
      if (match) {
        console.log(`[callifiedClient] 409 recovery: matched global lead list id ${match.id} (phone: ${match.phone})`);
        return { id: Number(match.id), phone: match.phone };
      }
    }
  } catch (_e) {
    console.error(
      `[callifiedClient] findCallifiedLeadByPhoneApi failed for ${normalizedPhone}: ${_e.message}`,
    );
  }
  console.log(`[callifiedClient] 409 recovery: no remote match found for ${normalizedPhone}`);
  return null;
}

async function deleteCallifiedLead(tenantId, leadId) {
  if (!tenantId || !leadId) return false;
  try {
    const res = await callifiedJson(tenantId, `/api/leads/${leadId}`, { method: 'DELETE' });
    console.log(`[callifiedClient] deleteCallifiedLead: deleted lead ${leadId}: ${JSON.stringify(res)}`);
    return true;
  } catch (e) {
    console.log(`[callifiedClient] deleteCallifiedLead: failed to delete lead ${leadId}: ${e.message}`);
    return false;
  }
}

/**
 * Collect every lead id matching the phone across all search surfaces,
 * WITHOUT verifying existence. Used to find stale/deleted phantom leads
 * that block re-creation because Callified still enforces unique phones.
 */
async function collectCandidateLeadIds(tenantId, phone, campaignId) {
  if (!tenantId || !phone) return [];
  const normalizedPhone = String(phone).trim();
  const ids = new Set();

  function ingest(label, list) {
    let data = list;
    if (!Array.isArray(data) && data && Array.isArray(data.data)) data = data.data;
    if (!Array.isArray(data) && data && Array.isArray(data.leads)) data = data.leads;
    if (Array.isArray(data)) {
      data
        .filter((l) => l && l.id && isPhoneMatch(l.phone, normalizedPhone))
        .forEach((l) => ids.add(Number(l.id)));
    } else if (label) {
      console.log(`[callifiedClient] collectCandidateLeadIds: ${label} was not a list`, data);
    }
  }

  try {
    if (campaignId) {
      ingest('selected-campaign', await callifiedJson(tenantId, `/api/campaigns/${campaignId}/leads?limit=1000`).catch(() => null));
    }

    const campaigns = await module.exports.listCampaigns(tenantId).catch(() => []);
    for (const c of (campaigns || []).filter((c) => c && c.id)) {
      ingest(`campaign-${c.id}`, await callifiedJson(tenantId, `/api/campaigns/${c.id}/leads?limit=1000`).catch(() => null));
      const callLog = await callifiedJson(tenantId, `/api/campaigns/${c.id}/call-log`).catch(() => null);
      if (Array.isArray(callLog)) {
        callLog
          .filter((l) => isPhoneMatch(l.phone, normalizedPhone) && l.lead_id)
          .forEach((l) => ids.add(Number(l.lead_id)));
      }
    }

    for (const variant of phoneSearchVariants(normalizedPhone)) {
      ingest(`generic-${variant}`, await callifiedJson(tenantId, `/api/leads?phone=${encodeURIComponent(variant)}&limit=1000`).catch(() => null));
    }

    for (const page of [1, 2, 3]) {
      ingest(`global-page-${page}`, await callifiedJson(tenantId, `/api/leads?page=${page}&limit=1000`).catch(() => null));
    }
  } catch (_e) {
    console.error(`[callifiedClient] collectCandidateLeadIds failed for ${normalizedPhone}: ${_e.message}`);
  }
  return Array.from(ids);
}

/**
 * Create a lead in Callified from a CRM contact, or reuse an existing lead
 * that the CRM has already mapped for this phone number.
 */
async function createLead(tenantId, { firstName, lastName, phone, email, company, interest, source, campaignId, contactId }, { retryAfterDelete = true, _recursionDepth = 0 } = {}) {
  // Prevent infinite recursion if Callified keeps returning non-normalized
  // leads that we cannot delete.
  if (_recursionDepth > 3) {
    console.log(`[callifiedClient] createLead: recursion depth exceeded for ${phone}; giving up`);
    throw new Error(`Unable to create a dialable Callified lead for ${phone}`);
  }

  const normalizedPhone = normalizeCallifiedPhone(phone);
  const existing = await findCallifiedLeadByPhone(tenantId, normalizedPhone, campaignId);
  if (existing && existing.id) {
    console.log(`[callifiedClient] createLead: reusing local mapping ${existing.id} for ${normalizedPhone}`);
    return { id: existing.id, reused: true, source: existing.source };
  }

  const body = {
    first_name: firstName || '',
    last_name: lastName || '',
    phone: normalizedPhone,
    company: company || '',
    email: email || '',
    source: source || 'Globussoft CRM',
    interest: interest || '',
  };

  try {
    const data = await callifiedJson(tenantId, '/api/leads', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (data && data.id) {
      await storeCallifiedLeadMapping(tenantId, phone, data.id);
    }
    return data;
  } catch (e) {
    // Callified rejects duplicate phones with 409. Reuse the remote lead id
    // so the user can call the same contact again without manual cleanup.
    if (e.status === 409 || String(e.message).toLowerCase().includes('already exists')) {
      console.log(`[callifiedClient] createLead: got 409 for ${normalizedPhone}, attempting campaign-scoped create with campaign ${campaignId}`);

      // 1. Try creating the lead directly scoped to the chosen campaign.
      //    Some Callified deployments allow a campaign_id on create even though
      //    it is not in the public docs, and this bypasses the global conflict.
      if (campaignId) {
        const campaignShapes = [
          { url: '/api/leads', body: { ...body, campaign_id: Number(campaignId) } },
          { url: `/api/campaigns/${campaignId}/leads`, body: { leads: [{ ...body }] } },
          { url: `/api/campaigns/${campaignId}/leads`, body: { lead: { ...body } } },
          { url: `/api/campaigns/${campaignId}/leads`, body: { ...body } },
          { url: `/api/campaigns/${campaignId}/leads/quick-add`, body: { ...body } },
        ];
        for (const shape of campaignShapes) {
          try {
            const scopedData = await callifiedJson(tenantId, shape.url, {
              method: 'POST',
              body: JSON.stringify(shape.body),
            });
            const leadId = scopedData?.id || scopedData?.lead?.id || scopedData?.leads?.[0]?.id;
            if (leadId) {
              await storeCallifiedLeadMapping(tenantId, phone, leadId);
              console.log(`[callifiedClient] createLead: campaign-scoped create succeeded via ${shape.url} for ${normalizedPhone}, lead ${leadId}`);
              return { id: leadId, ...scopedData };
            }
          } catch (scopedErr) {
            console.log(`[callifiedClient] createLead: campaign-scoped create ${shape.url} failed: ${scopedErr.message}`);
          }
        }
      }

      // 2. Reuse a remote lead id if we can find one.
      //    Prefer a lead whose stored phone is already normalized. If the only
      //    matching lead has spaces or other dialer-hostile formatting, delete
      //    it and create a fresh normalized lead so the call actually rings.
      console.log(`[callifiedClient] createLead: attempting remote recovery with campaign ${campaignId}`);
      const remote = await findCallifiedLeadByPhoneApi(tenantId, normalizedPhone, campaignId);
      if (remote && remote.id) {
        if (remote.phone && !isNormalizedPhoneFormat(remote.phone)) {
          console.log(`[callifiedClient] createLead: recovered lead ${remote.id} has non-dialable phone "${remote.phone}", deleting and recreating with normalized ${normalizedPhone}`);
          const deleted = await deleteCallifiedLead(tenantId, remote.id);
          if (deleted) {
            const retry = await createLead(tenantId, {
              firstName, lastName, phone: normalizedPhone, email, company, interest, source, campaignId, contactId,
            }, { retryAfterDelete: false, _recursionDepth: _recursionDepth + 1 });
            return retry;
          }
          // Could not delete; fall through to reuse (call may still fail, but
          // we have no better option without losing the mapping).
        }
        console.log(`[callifiedClient] createLead: recovered remote lead id ${remote.id} for ${normalizedPhone}`);
        await storeCallifiedLeadMapping(tenantId, phone, remote.id);
        return { id: remote.id, reused: true, source: 'callified_api' };
      }

      // 3. No usable lead was found, but the phone is still blocked. Callified
      // sometimes keeps a deleted/stale lead id in call-log while still
      // enforcing unique phones. Try to delete every candidate id we can see
      // and then recreate once.
      if (retryAfterDelete) {
        const candidates = await collectCandidateLeadIds(tenantId, normalizedPhone, campaignId);
        console.log(`[callifiedClient] createLead: found ${candidates.length} candidate id(s) to purge for ${normalizedPhone}: ${candidates.join(', ')}`);
        for (const candidateId of candidates) {
          const deleted = await deleteCallifiedLead(tenantId, candidateId);
          if (deleted) {
            console.log(`[callifiedClient] createLead: purged stale lead ${candidateId}, retrying create for ${normalizedPhone}`);
            const retry = await createLead(tenantId, {
              firstName, lastName, phone: normalizedPhone, email, company, interest, source, campaignId, contactId,
            }, { retryAfterDelete: false, _recursionDepth: _recursionDepth + 1 });
            return retry;
          }
        }
      }

      // 4. Last resort: Callified's phone uniqueness is still blocking creation
      // and we cannot find/delete the phantom lead. Try creating with different
      // raw phone formats in case Callified stores/display the raw string but
      // the dialer still reaches the same human.
      const formatVariants = [
        digitsOnly(normalizedPhone),
        `+${digitsOnly(normalizedPhone)}`,
        `0${digitsOnly(normalizedPhone).slice(-10)}`,
      ].filter((v) => v !== normalizedPhone);
      for (const variantPhone of formatVariants) {
        console.log(`[callifiedClient] createLead: 409 fallback, trying format variant ${variantPhone}`);
        try {
          const variantBody = { ...body, phone: variantPhone };
          const data = await callifiedJson(tenantId, '/api/leads', {
            method: 'POST',
            body: JSON.stringify(variantBody),
          });
          if (data && data.id) {
            await storeCallifiedLeadMapping(tenantId, phone, data.id);
            console.log(`[callifiedClient] createLead: format variant created lead ${data.id} with phone ${variantPhone}`);
            return { ...data, fallbackPhone: variantPhone };
          }
        } catch (variantErr) {
          console.log(`[callifiedClient] createLead: format variant ${variantPhone} failed: ${variantErr.message}`);
        }
      }

      // 5. Ultra-last resort: unique suffix. Common dialers ignore ;ext= / #.
      const uniqueSuffix = contactId || campaignId || Date.now();
      const suffixVariants = [
        `${normalizedPhone};ext=crm-${uniqueSuffix}`,
        `${normalizedPhone}#crm-${uniqueSuffix}`,
        `${digitsOnly(normalizedPhone)};ext=${uniqueSuffix}`,
      ];
      for (const variantPhone of suffixVariants) {
        console.log(`[callifiedClient] createLead: 409 fallback, trying unique phone ${variantPhone}`);
        try {
          const fallbackBody = {
            ...body,
            phone: variantPhone,
            source: `${source || 'Globussoft CRM'} (fallback)`,
          };
          const data = await callifiedJson(tenantId, '/api/leads', {
            method: 'POST',
            body: JSON.stringify(fallbackBody),
          });
          if (data && data.id) {
            await storeCallifiedLeadMapping(tenantId, phone, data.id);
            console.log(`[callifiedClient] createLead: suffix fallback created lead ${data.id} with phone ${variantPhone}`);
            return { ...data, fallbackPhone: variantPhone };
          }
        } catch (fallbackErr) {
          console.log(`[callifiedClient] createLead: suffix fallback ${variantPhone} failed: ${fallbackErr.message}`);
        }
      }

      console.log(`[callifiedClient] createLead: remote recovery failed for ${phone}, re-throwing 409`);
    }
    throw e;
  }
}

/**
 * Enroll a Callified lead into a campaign.
 */
async function enrollLead(tenantId, campaignId, leadId) {
  return await callifiedJson(tenantId, `/api/campaigns/${campaignId}/leads`, {
    method: 'POST',
    body: JSON.stringify({ lead_ids: [Number(leadId)] }),
  });
}

/**
 * Trigger an AI dial for a lead using the single-lead dial endpoint.
 *
 * This is preferred over the campaign-internal dial path because it does NOT
 * require the lead to be enrolled in the chosen campaign. The campaign_id is
 * passed in the body so the call still uses the selected campaign's voice
 * settings. This lets the CRM call a lead from any campaign even if Callified
 * already has the lead under a different org/campaign.
 */
async function dialLead(tenantId, leadId, campaignId) {
  const body = campaignId ? JSON.stringify({ campaign_id: Number(campaignId) }) : undefined;
  return await callifiedJson(tenantId, `/api/dial/${leadId}`, {
    method: 'POST',
    body,
  });
}

/**
 * Trigger an AI dial for a lead inside a campaign.
 */
async function dialCampaign(tenantId, campaignId, leadId) {
  return await callifiedJson(tenantId, `/api/campaigns/${campaignId}/dial/${leadId}`, {
    method: 'POST',
  });
}

/**
 * Fetch all transcripts for a Callified lead.
 */
async function getLeadTranscripts(tenantId, callifiedLeadId) {
  return await callifiedJson(tenantId, `/api/leads/${callifiedLeadId}/transcripts`);
}

/**
 * Fetch AI review for a transcript.
 */
async function getTranscriptReview(tenantId, transcriptId) {
  return await callifiedJson(tenantId, `/api/transcripts/${transcriptId}/review`);
}

/**
 * Combine transcripts + reviews for a Callified lead into a single details object.
 */
async function getCallDetails(tenantId, callifiedLeadId) {
  let transcripts = [];
  try {
    transcripts = await module.exports.getLeadTranscripts(tenantId, callifiedLeadId);
  } catch (e) {
    console.log(`[callifiedClient] getCallDetails: transcript fetch failed for lead ${callifiedLeadId}: ${e.message}`);
    return { transcripts: [], reviews: [], fetchError: e.message };
  }
  if (!Array.isArray(transcripts) || transcripts.length === 0) {
    return { transcripts: [], reviews: [] };
  }

  const reviews = await Promise.all(
    transcripts.map((t) =>
      module.exports
        .getTranscriptReview(tenantId, t.id)
        .catch((e) => ({ transcriptId: t.id, error: e.message })),
    ),
  );

  return { transcripts, reviews };
}

/**
 * Compute a CRM lead score from Callified review data.
 */
function computeAiScoreFromReview(review) {
  if (!review) return null;
  const quality = Number(review.quality_score) || 0;
  let score = Math.round(quality * 10);
  if (review.appointment_booked) score += 10;
  if (review.sentiment === 'positive') score += 5;
  if (review.sentiment === 'negative') score -= 5;
  return Math.max(0, Math.min(100, score));
}

/**
 * Full outbound call flow for a CRM contact.
 *
 * 1. Creates or reuses a Callified lead.
 * 2. Triggers an AI dial via the single-lead dial endpoint (no campaign
 *    enrollment required, so leads mapped under a different org/campaign can
 *    still be called from the CRM).
 * 3. Persists a CallLog row in the CRM.
 *
 * Returns the Callified leadId and the CRM CallLog id.
 */
async function initiateCallForContact({ tenantId, contactId, campaignId, userId, interest }) {
  if (!tenantId) throw new Error('tenantId required');
  if (!contactId) throw new Error('contactId required');
  if (!campaignId) throw new Error('campaignId required');

  if (!(await module.exports.isEnabledForTenant(tenantId))) {
    const err = new Error('AI calling disabled for this tenant.');
    err.code = 'AI_CALLING_DISABLED';
    throw err;
  }

  await module.exports.checkBudgetCap(tenantId);

  const contact = await prisma.contact.findUnique({
    where: { id: Number(contactId), tenantId },
  });
  if (!contact) {
    const err = new Error('Contact not found');
    err.status = 404;
    err.code = 'CONTACT_NOT_FOUND';
    throw err;
  }
  if (!contact.phone) {
    const err = new Error('Contact has no phone number');
    err.status = 400;
    err.code = 'MISSING_PHONE';
    throw err;
  }

  const normalizedPhone = normalizeCallifiedPhone(contact.phone);

  const nameParts = (contact.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || contact.name || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  async function buildLead() {
    return module.exports.createLead(tenantId, {
      firstName,
      lastName,
      phone: normalizedPhone,
      email: contact.email,
      company: contact.company,
      interest: interest || 'CRM outbound call',
      source: 'Globussoft CRM',
      campaignId: Number(campaignId),
      contactId: contact.id,
    });
  }

  async function tryCampaignDial(leadId) {
    console.log(`[callifiedClient] initiateCallForContact: enrolling lead ${leadId} in campaign ${campaignId}`);
    try {
      await module.exports.enrollLead(tenantId, campaignId, leadId);
      console.log(`[callifiedClient] initiateCallForContact: enrolled lead ${leadId}, triggering campaign dial`);
    } catch (e) {
      const msg = String(e.message).toLowerCase();
      // If the lead is already enrolled, treat it as success and dial anyway.
      if (msg.includes('already') || msg.includes('duplicate') || msg.includes('exists')) {
        console.log(`[callifiedClient] initiateCallForContact: enrollment skipped (lead ${leadId} already in campaign ${campaignId}): ${e.message}`);
      } else {
        // Enrollment may fail if the lead belongs to a different org/campaign.
        // Re-throw so caller can fall back to single-lead dial or recreate.
        console.log(`[callifiedClient] initiateCallForContact: enrollment failed for lead ${leadId}: ${e.message}`);
        throw e;
      }
    }
    return await module.exports.dialCampaign(tenantId, campaignId, leadId);
  }

  async function trySingleLeadDial(leadId) {
    console.log(`[callifiedClient] initiateCallForContact: trying single-lead dial for lead ${leadId}`);
    return await module.exports.dialLead(tenantId, leadId, campaignId);
  }

  let lead = await buildLead();
  let callifiedLeadId = lead.id;
  if (!callifiedLeadId) {
    const err = new Error('Callified did not return a lead id');
    err.code = 'CALLIFIED_MISSING_LEAD_ID';
    throw err;
  }

  let dialResult;
  try {
    dialResult = await tryCampaignDial(callifiedLeadId);
  } catch (campaignErr) {
    try {
      dialResult = await trySingleLeadDial(callifiedLeadId);
    } catch (singleErr) {
      // If the lead is missing/stale, clear the mapping and build a fresh one.
      // createLead's 409 recovery + suffix fallback will handle phantom duplicates.
      if (campaignErr.status === 404 || singleErr.status === 404) {
        console.log(
          `[callifiedClient] initiateCallForContact: lead ${callifiedLeadId} unreachable, clearing mapping and rebuilding for ${normalizedPhone}`,
        );
        await clearCallifiedLeadMapping(tenantId, normalizedPhone);
        lead = await buildLead();
        callifiedLeadId = lead.id;
        if (!callifiedLeadId) {
          const err = new Error('Callified did not return a lead id on retry');
          err.code = 'CALLIFIED_MISSING_LEAD_ID';
          throw err;
        }
        dialResult = await tryCampaignDial(callifiedLeadId);
      } else {
        throw singleErr;
      }
    }
  }

  const callLog = await prisma.callLog.create({
    data: {
      tenantId,
      contactId: contact.id,
      userId: userId || null,
      provider: 'callified',
      providerCallId: String(callifiedLeadId),
      calleeNumber: normalizedPhone,
      direction: 'OUTBOUND',
      status: 'INITIATED',
      duration: 0,
      notes: JSON.stringify({
        campaignId: Number(campaignId),
        callifiedLeadId,
        dialResult,
        initiatedAt: new Date().toISOString(),
      }),
    },
  });

  return {
    callifiedLeadId,
    campaignId: Number(campaignId),
    contactId: contact.id,
    callLogId: callLog.id,
    dialResult,
  };
}

/**
 * Fetch full Callified details for a previously initiated call and update CRM.
 *
 * 1. Finds the most recent CallLog by providerCallId (Callified lead id).
 * 2. Polls transcripts + reviews.
 * 3. Merges the stored per-attempt notes (dial result, campaign, initiatedAt)
 *    with the fetched details so older call attempts keep their own metadata.
 * 4. Optionally updates the contact aiScore if a review is present.
 */
async function fetchAndStoreCallDetails({ tenantId, callifiedLeadId, contactId, updateScore = true }) {
  if (!tenantId || !callifiedLeadId) {
    throw new Error('tenantId and callifiedLeadId required');
  }

  const details = await module.exports.getCallDetails(tenantId, callifiedLeadId);
  const latestTranscript = details.transcripts[details.transcripts.length - 1] || null;
  const latestReview = details.reviews.find(
    (r) => r && !r.error && (latestTranscript ? r.transcript_id === latestTranscript.id : true),
  ) || details.reviews.find((r) => r && !r.error) || null;

  // Merge the per-attempt metadata captured at dial time with a compact
  // summary of fetched transcripts/reviews. Full transcript/review payloads
  // can be very large, so we store only a summary in CallLog.notes and
  // return the full details in the API response.
  const latestLog = await prisma.callLog.findFirst({
    where: { tenantId, provider: 'callified', providerCallId: String(callifiedLeadId) },
    orderBy: { createdAt: 'desc' },
  });

  const transcriptSummary = details.transcripts.map((t) => ({
    id: t.id,
    status: t.status,
    call_duration_s: t.call_duration_s,
    recording_url: t.recording_url,
    created_at: t.created_at,
  }));
  const reviewSummary = details.reviews.map((r) =>
    r && !r.error
      ? {
          transcript_id: r.transcript_id,
          sentiment: r.sentiment,
          quality_score: r.quality_score,
          summary: r.summary,
          appointment_booked: r.appointment_booked,
        }
      : { error: r?.error },
  );
  const compactDetails = {
    transcriptCount: details.transcripts.length,
    reviewCount: details.reviews.length,
    fetchError: details.fetchError || undefined,
    transcripts: transcriptSummary,
    reviews: reviewSummary,
  };

  let mergedNotes = { ...compactDetails, fetchedAt: new Date().toISOString() };
  if (latestLog && latestLog.notes) {
    try {
      const existing = JSON.parse(latestLog.notes);
      mergedNotes = { ...existing, ...compactDetails, fetchedAt: new Date().toISOString() };
    } catch (_e) {
      // ignore malformed notes
    }
  }

  // Final safety truncate: even @db.Text has practical limits; cap notes so
  // the update cannot fail on a pathologically large payload.
  let notesJson = JSON.stringify(mergedNotes);
  if (notesJson.length > 500_000) {
    notesJson = JSON.stringify({
      ...mergedNotes,
      transcripts: [],
      reviews: [],
      truncated: true,
      transcriptCount: mergedNotes.transcriptCount,
      reviewCount: mergedNotes.reviewCount,
    });
    if (notesJson.length > 500_000) {
      notesJson = JSON.stringify({
        callifiedLeadId,
        fetchedAt: new Date().toISOString(),
        truncated: true,
        message: 'Transcript payload too large to store',
      });
    }
  }

  const updateData = {
    duration: latestTranscript?.call_duration_s ? Math.round(Number(latestTranscript.call_duration_s)) : 0,
    recordingUrl: latestTranscript?.recording_url || null,
    status: latestTranscript ? 'COMPLETED' : 'INITIATED',
    notes: notesJson,
  };

  if (latestLog) {
    await prisma.callLog.update({
      where: { id: latestLog.id },
      data: updateData,
    });
  }

  let updatedScore = null;
  if (updateScore && contactId && latestReview) {
    const score = computeAiScoreFromReview(latestReview);
    if (score !== null) {
      const contact = await prisma.contact.findUnique({
        where: { id: Number(contactId), tenantId },
        select: { aiScore: true },
      });
      if (contact) {
        const newScore = Math.max(contact.aiScore || 0, score);
        await prisma.contact.update({
          where: { id: Number(contactId), tenantId },
          data: { aiScore: newScore },
        });
        updatedScore = newScore;
      }
    }
  }

  return { ...details, latestTranscript, latestReview, updatedScore };
}

/**
 * Legacy outbound AI call wrapper. Maintained for the existing admin dialer.
 *
 * This surface remains in stub mode (returns a canned pending-cred-drop
 * envelope). The real campaign-first outbound flow lives in
 * `initiateCallForContact` and is exposed via /api/callified/leads/:leadId/call.
 */
async function initiateCall({ tenantId, subBrand, toPhone, leadId, intent, persona }) {
  if (!tenantId) throw new Error('tenantId required');
  if (!toPhone) throw new Error('toPhone required');

  if (!(await module.exports.isEnabledForTenant(tenantId))) {
    const err = new Error('AI calling disabled for this tenant.');
    err.code = 'AI_CALLING_DISABLED';
    throw err;
  }

  await module.exports.checkBudgetCap(tenantId);

  const resolvedPersona =
    persona || (await module.exports.resolveSubBrandPersona(tenantId, subBrand)) || 'default';

  const apiKey = await module.exports.getCallifiedKey(tenantId);
  void apiKey; // unused in stub mode; kept for CJS self-mocking seam tests

  console.log(`[callifiedClient STUB] initiateCall: tenantId=${tenantId} subBrand=${subBrand} toPhone=${toPhone} leadId=${leadId} intent=${intent} persona=${resolvedPersona} maxDurationSeconds=${MAX_CALL_DURATION_SECONDS}`);

  return {
    stub: true,
    callId: null,
    tenantId,
    subBrand: subBrand || null,
    toPhone,
    leadId: leadId || null,
    intent: intent || null,
    persona: resolvedPersona,
    maxDurationSeconds: MAX_CALL_DURATION_SECONDS,
    status: 'pending-cred-drop',
    note: 'Callified.ai integration pending Q1 creds (Yasin handover). Real call invocation will populate once the swap is done.',
  };
}

/**
 * Legacy call-result fetch. Maintained for the existing admin dialer.
 */
async function fetchCallResult({ tenantId, callId }) {
  if (!tenantId) throw new Error('tenantId required');
  if (!callId) throw new Error('callId required');

  const apiKey = await module.exports.getCallifiedKey(tenantId);
  void apiKey; // unused in stub mode; kept for CJS self-mocking seam tests

  console.log(`[callifiedClient STUB] fetchCallResult: tenantId=${tenantId} callId=${callId}`);

  return {
    stub: true,
    callId,
    tenantId,
    durationSeconds: 0,
    recordingUrl: null,
    transcript: null,
    summary: null,
    outcome: 'pending-cred-drop',
    note: 'Callified.ai integration pending Q1 creds (Yasin handover). Real call result will populate once the swap is done.',
  };
}

/**
 * Resolve the Callified.ai API key for a tenant. (Legacy alias — new code
 * should use `getCallifiedConfig`. Kept for backward compatibility with
 * existing callers and unit tests.)
 *
 * Mirrors the pre-S69 contract: env var first, then SupplierCredential,
 * then Integration config.
 */
async function getCallifiedKey(tenantId) {
  const envValue = process.env.CALLIFIED_API_KEY || null;
  if (!tenantId) return envValue;

  // 1. SupplierCredential (legacy S69 resolver).
  try {
    const prismaLib = require('../lib/prisma');
    if (prismaLib.supplierCredential && typeof prismaLib.supplierCredential.findFirst === 'function') {
      const row = await prismaLib.supplierCredential.findFirst({
        where: { tenantId, category: 'ai-calling-key' },
        select: { passwordEncrypted: true },
      });
      if (row && row.passwordEncrypted) {
        const { decrypt } = require('../lib/fieldEncryption');
        const plaintext = decrypt(row.passwordEncrypted);
        if (plaintext) return plaintext;
      }
    }
  } catch (e) {
    console.error(
      `[callifiedClient] getCallifiedKey supplierCredential lookup failed (non-fatal, falling back to ENV): ${e.message}`,
    );
  }

  // 2. Integration token (new per-tenant config store).
  try {
    const row = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'callified' } },
      select: { token: true },
    });
    if (row && row.token) return row.token;
  } catch (e) {
    console.error(
      `[callifiedClient] getCallifiedKey integration lookup failed (non-fatal, falling back to ENV): ${e.message}`,
    );
  }

  return envValue;
}

async function resolveSubBrandPersona(tenantId, subBrand) {
  if (!subBrand) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });
  if (!tenant || !tenant.subBrandConfigJson) return null;
  try {
    const config = JSON.parse(tenant.subBrandConfigJson);
    return config[`callifiedPersona_${subBrand}`] || null;
  } catch {
    return null;
  }
}

module.exports = {
  // Legacy / admin surface
  initiateCall,
  fetchCallResult,
  checkBudgetCap,
  computeMonthlySpendCents,
  isEnabledForTenant,
  resolveSubBrandPersona,
  getCallifiedKey,
  INTEGRATION,
  FEATURE_FLAG_KEY,
  MAX_CALL_DURATION_SECONDS,

  // New campaign-first surface
  getCallifiedConfig,
  getCallifiedToken,
  clearTokenCache,
  listCampaigns,
  createLead,
  enrollLead,
  dialLead,
  dialCampaign,
  getLeadTranscripts,
  getTranscriptReview,
  getCallDetails,
  initiateCallForContact,
  fetchAndStoreCallDetails,
  computeAiScoreFromReview,

  // Phone normalization helpers (exported for tests + external callers)
  normalizeCallifiedPhone,
  isNormalizedPhoneFormat,
};
