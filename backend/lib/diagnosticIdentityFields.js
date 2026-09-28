const { sanitizeText } = require('./sanitizeJson');

const FIELD_TYPES = new Set(['text', 'email', 'tel', 'number', 'date', 'time', 'url', 'textarea']);
const FIELD_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

function integerInRange(value, min, max) {
  if (value === '' || value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeIdentityField(field) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
  const id = String(field.id || '').trim().toLowerCase();
  if (!FIELD_ID_RE.test(id)) return null;
  const type = FIELD_TYPES.has(String(field.type || '').toLowerCase())
    ? String(field.type).toLowerCase()
    : 'text';
  const normalized = {
    id,
    label: sanitizeText(String(field.label || id).trim()).slice(0, 120) || id,
    type,
    enabled: field.enabled !== false,
    required: field.required === true,
  };
  const copy = (key, max) => {
    const value = sanitizeText(String(field[key] || '').trim()).slice(0, max);
    if (value) normalized[key] = value;
  };
  copy('placeholder', 200);
  copy('helper', 300);
  copy('autocomplete', 80);
  copy('validationMessage', 240);
  const pattern = String(field.pattern || '').trim().slice(0, 300);
  if (pattern) normalized.pattern = pattern;
  const minLength = integerInRange(field.minLength, 0, 5000);
  const maxLength = integerInRange(field.maxLength, 1, 5000);
  if (minLength !== undefined) normalized.minLength = minLength;
  if (maxLength !== undefined) normalized.maxLength = Math.max(minLength || 0, maxLength);
  if (field.min !== '' && field.min != null) {
    if (type === 'number' && Number.isFinite(Number(field.min))) normalized.min = Number(field.min);
    else if (['date', 'time'].includes(type)) normalized.min = String(field.min).slice(0, 20);
  }
  if (field.max !== '' && field.max != null) {
    if (type === 'number' && Number.isFinite(Number(field.max))) normalized.max = Number(field.max);
    else if (['date', 'time'].includes(type)) normalized.max = String(field.max).slice(0, 20);
  }
  return normalized;
}

function normalizeIdentityFields(fields, legacyForm = {}) {
  const defaults = [
    { id: 'name', label: 'Name', type: 'text', enabled: legacyForm.includeName !== false, required: legacyForm.nameRequired !== false, maxLength: 120, autocomplete: 'name' },
    { id: 'email', label: 'Email', type: 'email', enabled: legacyForm.includeEmail !== false, required: legacyForm.emailRequired !== false, maxLength: 254, autocomplete: 'email' },
    { id: 'phone', label: 'Phone', type: 'tel', enabled: legacyForm.includePhone !== false, required: legacyForm.phoneRequired === true, autocomplete: 'tel' },
  ];
  const source = Array.isArray(fields) ? fields : defaults;
  const seen = new Set();
  return source.reduce((result, field) => {
    const normalized = normalizeIdentityField(field);
    if (!normalized || seen.has(normalized.id)) return result;
    seen.add(normalized.id);
    result.push(normalized);
    return result;
  }, []);
}

function validateIdentityFieldConfiguration(fields) {
  if (fields === undefined) return null;
  if (!Array.isArray(fields)) return 'identityFields must be an array';
  if (fields.length > 30) return 'identityFields supports at most 30 fields';
  const seen = new Set();
  for (const [index, field] of fields.entries()) {
    const id = String(field?.id || '').trim().toLowerCase();
    if (!FIELD_ID_RE.test(id)) return `identityFields[${index}].id must start with a letter and contain only lowercase letters, numbers, or underscores`;
    if (seen.has(id)) return `identityFields contains duplicate field key "${id}"`;
    seen.add(id);
    if (!String(field?.label || '').trim()) return `identityFields[${index}].label is required`;
    if (field?.type && !FIELD_TYPES.has(String(field.type).toLowerCase())) return `identityFields[${index}].type is not supported`;
    if (field?.pattern) {
      try { new RegExp(String(field.pattern)); } catch { return `identityFields[${index}].pattern is not a valid regular expression`; }
    }
    if (field?.minLength != null && field?.maxLength != null && Number(field.minLength) > Number(field.maxLength)) {
      return `identityFields[${index}] minimum length cannot exceed maximum length`;
    }
    if (field?.min != null && field?.max != null) {
      const minExceedsMax = String(field.type || 'text').toLowerCase() === 'number'
        ? Number(field.min) > Number(field.max)
        : String(field.min) > String(field.max);
      if (minExceedsMax) return `identityFields[${index}] minimum value cannot exceed maximum value`;
    }
  }
  return null;
}

function invalid(field, message, reason = 'invalid') {
  return {
    error: {
      error: field.validationMessage || message,
      code: 'IDENTITY_FIELD_INVALID',
      fieldId: field.id,
      reason,
    },
  };
}

function validateIdentitySubmission({ fields, identity, legacyValues = {} }) {
  const source = identity && typeof identity === 'object' && !Array.isArray(identity) ? identity : {};
  const values = {};
  for (const field of fields.filter((item) => item.enabled !== false)) {
    const raw = source[field.id] ?? legacyValues[field.id] ?? '';
    if (raw !== null && typeof raw === 'object') {
      return invalid(field, `${field.label} must be a single value`, 'type');
    }
    const value = sanitizeText(String(raw).trim()).slice(0, 5000);
    if (field.required && !value) return invalid(field, `${field.label} is required`, 'required');
    if (!value) {
      continue;
    }
    if (field.minLength !== undefined && value.length < field.minLength) {
      return invalid(field, `${field.label} must be at least ${field.minLength} characters`, 'minLength');
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return invalid(field, `${field.label} must be ${field.maxLength} characters or fewer`, 'maxLength');
    }
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return invalid(field, `${field.label} must be a valid email address`, 'type');
    }
    if (field.type === 'tel') {
      const digits = value.replace(/\D/g, '');
      if (!/^\+?[0-9][0-9\s().-]+$/.test(value) || digits.length < 10 || digits.length > 15) {
        return invalid(field, `${field.label} must be a valid phone number`, 'type');
      }
    }
    if (field.type === 'url') {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
      } catch {
        return invalid(field, `${field.label} must be a valid web address`, 'type');
      }
    }
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return invalid(field, `${field.label} must be a number`, 'type');
      if (field.min !== undefined && number < field.min) return invalid(field, `${field.label} must be at least ${field.min}`, 'min');
      if (field.max !== undefined && number > field.max) return invalid(field, `${field.label} must be at most ${field.max}`, 'max');
    }
    if (field.type === 'date') {
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
      if (!match || date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
        return invalid(field, `${field.label} must be a valid date`, 'type');
      }
      if (field.min && value < field.min) return invalid(field, `${field.label} must be on or after ${field.min}`, 'min');
      if (field.max && value > field.max) return invalid(field, `${field.label} must be on or before ${field.max}`, 'max');
    }
    if (field.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
      return invalid(field, `${field.label} must be a valid time`, 'type');
    }
    if (field.type === 'time' && field.min && value < field.min) return invalid(field, `${field.label} must be at or after ${field.min}`, 'min');
    if (field.type === 'time' && field.max && value > field.max) return invalid(field, `${field.label} must be at or before ${field.max}`, 'max');
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) return invalid(field, `${field.label} has an invalid format`, 'pattern');
      } catch {
        return invalid(field, `${field.label} has an invalid validation pattern`, 'patternConfig');
      }
    }
    values[field.id] = value;
  }
  return { values, error: null };
}

module.exports = {
  FIELD_ID_RE,
  FIELD_TYPES,
  normalizeIdentityField,
  normalizeIdentityFields,
  validateIdentityFieldConfiguration,
  validateIdentitySubmission,
};
