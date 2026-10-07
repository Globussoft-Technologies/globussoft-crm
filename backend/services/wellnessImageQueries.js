'use strict';

const IMAGE_QUERY_VERSION = 'wellness-relevance-v2';

const GENERIC_TERMS = new Set([
  'a', 'an', 'and', 'care', 'campaign', 'center', 'centre', 'clinic', 'community',
  'consult', 'consultation', 'day', 'event', 'experience', 'for', 'health',
  'landing', 'local', 'options', 'people', 'professional', 'registration',
  'site', 'the', 'treatment', 'wellness', 'with', 'your', 'book', 'booking',
  'capture', 'lead', 'leads', 'enquiry', 'enquiries', 'follow', 'up', 'get',
  'untitled', 'page', 'new', 'dr', 'doctor', 'studio', 'brand', 'enhanced',
]);

const SUBJECT_RULES = [
  {
    match: /\b(hair\s*(?:loss|fall|growth|care|treatment)?|scalp|alopecia|bald(?:ness)?|thinning)\b/i,
    phrase: (source) => /\b(hair\s*loss|hair\s*fall|alopecia|bald(?:ness)?|thinning)\b/i.test(source)
      ? 'hair loss scalp treatment'
      : 'hair treatment scalp care',
    terms: ['hair', 'scalp'],
  },
  {
    match: /\b(eye|eyes|vision|optometry|ophthalmology|glaucoma|cataract)\b/i,
    phrase: 'eye examination vision screening',
    terms: ['eye', 'vision'],
  },
  {
    match: /\b(skin|acne|dermatology|eczema|pigmentation|facial|cosmetic)\b/i,
    phrase: 'skin care dermatology consultation',
    terms: ['skin', 'dermatology', 'acne'],
  },
  {
    match: /\b(dental|dentist|teeth|tooth|oral|braces|orthodont)\b/i,
    phrase: 'dental examination oral health',
    terms: ['dental', 'teeth', 'oral'],
  },
  {
    match: /\b(physio|physical\s*therapy|rehabilitation|mobility|orthopedic|joint|back\s*pain)\b/i,
    phrase: 'physical therapy rehabilitation assessment',
    terms: ['therapy', 'rehabilitation', 'mobility'],
  },
  {
    match: /\b(nutrition|dietitian|diet|weight\s*loss|metabolic)\b/i,
    phrase: 'nutrition consultation healthy meal planning',
    terms: ['nutrition', 'dietitian', 'diet'],
  },
  {
    match: /\b(mental\s*health|therapy|counseling|counselling|anxiety|stress|mindfulness)\b/i,
    phrase: 'mental health counseling wellbeing support',
    terms: ['mental', 'therapy', 'counseling', 'mindfulness'],
  },
];

function clean(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s&'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sourceText(input = {}) {
  return [
    input.imageQuery,
    input.campaignName,
    input.title,
    input.description,
    input.campaignGoal,
    input.audience,
    input.businessName,
    input.sectorLabel,
    input.text,
  ].map(clean).filter(Boolean).join(' ');
}

function fallbackSubject(source) {
  const terms = source
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}-]/gu, ''))
    .filter((term) => term.length > 2 && !GENERIC_TERMS.has(term));
  const unique = [...new Set(terms)].slice(0, 4);
  return unique.length ? unique.join(' ') : 'wellness consultation';
}

function buildWellnessImagePlan(input = {}) {
  const source = sourceText(input);
  const matched = SUBJECT_RULES.find((rule) => rule.match.test(source));
  const subject = matched
    ? (typeof matched.phrase === 'function' ? matched.phrase(source) : matched.phrase)
    : fallbackSubject(source);
  const relevanceTerms = matched
    ? matched.terms
    : subject.split(/\s+/).filter((term) => !GENERIC_TERMS.has(term)).slice(0, 3);
  if (!relevanceTerms.length && subject === 'wellness consultation') relevanceTerms.push('wellness');

  return {
    subject,
    relevanceTerms,
    queries: {
      hero: `${subject} client consultation specialist assessment`,
      'gallery-image-1': `${subject} symptoms concerns consultation`,
      'gallery-image-2': `${subject} professional consultation care team`,
      'gallery-image-3': `${subject} patient education support`,
      cta: `${subject} personalized care consultation`,
    },
  };
}

function queryForWellnessImageSlot(plan, slotId, index = 0) {
  const slot = String(slotId || '').toLowerCase();
  if (slot.includes('hero')) return plan.queries.hero;
  if (slot.includes('gallery-image-1')) return plan.queries['gallery-image-1'];
  if (slot.includes('gallery-image-2')) return plan.queries['gallery-image-2'];
  if (slot.includes('gallery-image-3')) return plan.queries['gallery-image-3'];
  if (slot.includes('cta')) return plan.queries.cta;
  return Object.values(plan.queries)[index % Object.keys(plan.queries).length];
}

module.exports = {
  IMAGE_QUERY_VERSION,
  buildWellnessImagePlan,
  queryForWellnessImageSlot,
  _sourceText: sourceText,
};
