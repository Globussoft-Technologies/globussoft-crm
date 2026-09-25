const dns = require('node:dns').promises;

const DEFAULT_PERSONAL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'icloud.com', 'protonmail.com'];
const MX_LOOKUP_TIMEOUT_MS = 3000;
const MX_CACHE_TTL_MS = 5 * 60 * 1000;
const MX_CACHE_MAX_ENTRIES = 500;
const mxCache = new Map();

function cleanDomains(value) {
  const items = Array.isArray(value) ? value : [];
  return [...new Set(items.map((item) => String(item || '').trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '')).filter((item) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(item)))];
}

function emailDomain(email) {
  const value = String(email || '').trim().toLowerCase();
  return value.slice(value.lastIndexOf('@') + 1);
}

function validSyntax(email) {
  const value = String(email || '').trim();
  return value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !value.includes('..');
}

function cachedMxResult(domain) {
  const cached = mxCache.get(domain);
  if (!cached || cached.expiresAt <= Date.now()) {
    mxCache.delete(domain);
    return null;
  }
  return cached.valid;
}

function rememberMxResult(domain, valid) {
  if (mxCache.size >= MX_CACHE_MAX_ENTRIES && !mxCache.has(domain)) {
    mxCache.delete(mxCache.keys().next().value);
  }
  mxCache.set(domain, { valid, expiresAt: Date.now() + MX_CACHE_TTL_MS });
}

async function resolveMxWithTimeout(domain, resolveMx, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      resolveMx(domain),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('MX lookup timed out')), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function validateEmail(email, settings, options = {}) {
  if (!validSyntax(email)) return { valid: false, code: 'INVALID_EMAIL', message: 'Please enter a valid email address.' };
  const domain = emailDomain(email);
  const blocked = cleanDomains(settings.blockedEmailDomains).filter((domain) => !cleanDomains(settings.disabledBlockedEmailDomains).includes(domain));
  const allowed = cleanDomains(settings.allowedEmailDomains).filter((domain) => !cleanDomains(settings.disabledAllowedEmailDomains).includes(domain));
  if (allowed.length && !allowed.includes(domain)) return { valid: false, code: 'EMAIL_DOMAIN_NOT_ALLOWED', message: 'Please use an approved company email address.' };
  if (settings.emailValidationType === 'company' && blocked.includes(domain)) return { valid: false, code: 'PERSONAL_EMAIL_BLOCKED', message: 'Please use your company email address.' };
  if (settings.emailMxValidation) {
    let hasMx = cachedMxResult(domain);
    if (hasMx == null) {
      try {
        const records = await resolveMxWithTimeout(
          domain,
          options.resolveMx || dns.resolveMx,
          options.timeoutMs || MX_LOOKUP_TIMEOUT_MS,
        );
        hasMx = Array.isArray(records) && records.length > 0;
      } catch (_error) {
        hasMx = false;
      }
      rememberMxResult(domain, hasMx);
    }
    if (!hasMx) {
      return { valid: false, code: 'EMAIL_MX_INVALID', message: 'Please enter a valid business email address.' };
    }
  }
  return { valid: true, domain };
}

function clearMxCache() {
  mxCache.clear();
}

module.exports = { DEFAULT_PERSONAL_DOMAINS, cleanDomains, validSyntax, validateEmail, clearMxCache };
