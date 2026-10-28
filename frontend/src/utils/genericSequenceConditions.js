export const STANDARD_GENERIC_CONDITION_FIELDS = Object.freeze([
  { value: 'contact.lifecycleStageKey', label: 'Lead stage' },
  { value: 'contact.status', label: 'Lead status' },
  { value: 'contact.source', label: 'Lead source' },
  { value: 'contact.company', label: 'Company' },
  { value: 'contact.title', label: 'Job title' },
  { value: 'contact.industry', label: 'Industry' },
  { value: 'contact.aiScore', label: 'AI score', number: true },
  { value: 'contact.tag', label: 'Tag' },
]);

export function genericConditionFields(customFields = [], leadStatusOptions = []) {
  return [
    ...STANDARD_GENERIC_CONDITION_FIELDS.map(field => field.value === 'contact.status'
      ? { ...field, options: leadStatusOptions }
      : field),
    ...customFields.map(field => ({
      value: `custom_${field.id}`,
      label: field.label,
      custom: true,
      number: field.fieldType === 'number',
      options: Array.isArray(field.options) ? field.options : [],
    })),
  ];
}

export function emptyGenericFieldCondition() {
  return { field: '', op: 'eq', value: '', key: '' };
}

export function storedGenericFieldCondition(condition = {}) {
  if (condition.field === 'contact.field' && condition.key) {
    return { ...condition, field: condition.key };
  }
  return { ...emptyGenericFieldCondition(), ...condition };
}

export function serializedGenericFieldConditions(conditions = []) {
  return conditions.map(condition => {
    if (String(condition.field || '').startsWith('custom_')) {
      return { field: 'contact.field', key: condition.field, op: condition.op, value: condition.value };
    }
    return { field: condition.field, op: condition.op, value: condition.value };
  });
}
