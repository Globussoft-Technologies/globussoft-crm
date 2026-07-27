'use strict';

const SECTORS = {
  general: { label: 'General', voice: 'Clear, flexible, and lead-focused.' },
  travel: { label: 'Travel', voice: 'Destination-led and aspirational.' },
  health: { label: 'Health', voice: 'Calm, trustworthy, and reassuring.' },
  hospital: { label: 'Hospital', voice: 'Clinical, welcoming, patient-first.' },
  real_estate: { label: 'Real Estate', voice: 'Property-focused and trust-building.' },
  education: { label: 'Education', voice: 'Parent-friendly and informative.' },
  law_firm: { label: 'Law Firm', voice: 'Professional and discreet.' },
  nonprofit: { label: 'Nonprofit', voice: 'Warm, mission-led, and community-oriented.' },
  hospitality: { label: 'Hospitality', voice: 'Welcoming and booking-oriented.' },
  retail: { label: 'Retail', voice: 'Concise and action-oriented.' },
  technology: { label: 'Technology', voice: 'Modern and solution-focused.' },
  fitness: { label: 'Fitness', voice: 'Energetic and sign-up friendly.' },
  finance: { label: 'Finance', voice: 'Trustworthy and compliant.' },
};

const BASIC_BLOCK_TYPES = new Set(['heading', 'text', 'image', 'button', 'form', 'divider', 'spacer', 'columns']);

function normalizeSectorKey(value) {
  const key = String(value || 'general').trim().toLowerCase();
  return SECTORS[key] ? key : 'general';
}

function buildGenericLandingSitePrompt(input = {}) {
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const sector = SECTORS[sectorKey];
  const sectorLabel = String(input.sectorLabel || sector.label).trim().slice(0, 60);
  const campaignName = String(input.campaignName || '').trim().slice(0, 120) || `${sectorLabel} Landing Site`;
  const businessName = String(input.businessName || '').trim().slice(0, 120);
  const campaignGoal = String(input.campaignGoal || '').trim().slice(0, 200) || 'capture leads';
  const audience = String(input.audience || '').trim().slice(0, 200) || 'qualified visitors';
  const location = String(input.location || '').trim().slice(0, 120);
  const tone = String(input.tone || '').trim().slice(0, 120) || sector.voice;
  const ctaText = String(input.ctaText || '').trim().slice(0, 40) || 'Get Started';
  const imageMode = String(input.imageMode || 'auto').trim().toLowerCase();

  const system = [
    'You generate generic CRM landing-site content.',
    'Return exactly one JSON object with no markdown, no fences, and no extra prose.',
    'Use only these block types: heading, text, image, button, form, divider, spacer, columns.',
    'The page must feel complete: hero, supporting copy, one visual, a benefits section, and a lead form.',
    'Image URLs are optional. If you cannot produce a useful image, use an empty string for src.',
    '',
    'Return this shape:',
    '{',
    '  "suggestedTitle": "string",',
    '  "suggestedSlug": "string",',
    '  "description": "string",',
    '  "seoMeta": { "metaTitle": "string", "metaDescription": "string" },',
    '  "blocks": [ ... ]',
    '}',
  ].join('\n');

  const user = [
    `Sector: ${sectorLabel}`,
    `Campaign name: ${campaignName}`,
    `Business name: ${businessName || '(not provided)'}`,
    `Goal: ${campaignGoal}`,
    `Audience: ${audience}`,
    `Location/context: ${location || '(not provided)'}`,
    `Tone: ${tone}`,
    `CTA label: ${ctaText}`,
    `Image mode: ${imageMode}`,
    '',
    'Write for a mobile-first landing site with a clear lead capture focus.',
    'Include at least one image block, one columns block, one button block, and one form block.',
    'The form should capture name, email, phone, and a short message.',
    'Keep the page concise and practical.',
  ].join('\n');

  return { system, user, sectorKey, sectorLabel, campaignName, businessName, campaignGoal, audience, location, tone, ctaText, imageMode };
}

function buildGenericFallback(input = {}) {
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const sector = SECTORS[sectorKey];
  const sectorLabel = String(input.sectorLabel || sector.label).trim().slice(0, 60);
  const campaignName = String(input.campaignName || '').trim().slice(0, 120) || `${sectorLabel} Landing Site`;
  const businessName = String(input.businessName || '').trim().slice(0, 120);
  const campaignGoal = String(input.campaignGoal || '').trim().slice(0, 200) || 'capture leads';
  const audience = String(input.audience || '').trim().slice(0, 200) || 'qualified visitors';
  const location = String(input.location || '').trim().slice(0, 120);
  const ctaText = String(input.ctaText || '').trim().slice(0, 40) || 'Get Started';
  const slug = `${sectorKey}-${campaignName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 50) || `landing-${sectorKey}`;

  const heroTitle = location ? `${campaignName} in ${location}` : campaignName;
  const heroBody = businessName
    ? `${businessName} can turn this into a focused landing page for ${audience}.`
    : `This page is built to convert ${audience} into enquiries for ${campaignGoal}.`;

  return {
    suggestedTitle: campaignName.slice(0, 80),
    suggestedSlug: slug,
    description: `${sectorLabel} landing site for ${campaignGoal}`.slice(0, 200),
    seoMeta: {
      metaTitle: `${campaignName} | ${sectorLabel}`.slice(0, 60),
      metaDescription: `${campaignGoal} for ${audience}.`.slice(0, 160),
    },
    blocks: [
      { id: 'h1', type: 'heading', props: { text: heroTitle, level: 'h1', align: 'center', color: '#111827' } },
      { id: 't1', type: 'text', props: { text: heroBody, align: 'center', color: '#4b5563', fontSize: '1.05rem' } },
      { id: 'img1', type: 'image', props: { src: '', alt: `${sectorLabel} campaign image`, maxWidth: '100%' } },
      {
        id: 'cols',
        type: 'columns',
        props: {
          gap: '24px',
          columns: [
            {
              components: [
                { id: 'h2a', type: 'heading', props: { text: 'Why this works', level: 'h3', align: 'left', color: '#111827' } },
                { id: 't2a', type: 'text', props: { text: 'A clean message, strong CTA, and simple lead form keep the visitor focused.', align: 'left', color: '#4b5563', fontSize: '0.98rem' } },
              ],
            },
            {
              components: [
                { id: 'h2b', type: 'heading', props: { text: 'Built for your sector', level: 'h3', align: 'left', color: '#111827' } },
                { id: 't2b', type: 'text', props: { text: `The copy adapts to the ${sectorLabel.toLowerCase()} use case without travel-specific assumptions.`, align: 'left', color: '#4b5563', fontSize: '0.98rem' } },
              ],
            },
          ],
        },
      },
      { id: 'btn', type: 'button', props: { text: ctaText, url: '#lead-form', bgColor: '#4f46e5', color: '#ffffff', align: 'center', size: 'medium' } },
      {
        id: 'lead-form',
        type: 'form',
        props: {
          fields: [
            { label: 'Name', name: 'name', type: 'text', required: true },
            { label: 'Email', name: 'email', type: 'email', required: true },
            { label: 'Phone', name: 'phone', type: 'tel', required: false },
            { label: 'Message', name: 'message', type: 'text', required: false },
          ],
          submitText: 'Submit',
          thankYouMessage: `Thanks. We will contact you about this ${sectorLabel.toLowerCase()} page soon.`,
          enableCaptcha: false,
          leadRoutingRuleId: '',
          successRedirectUrl: '',
        },
      },
      { id: 'd1', type: 'divider', props: { color: '#e5e7eb', margin: '1.5rem' } },
    ],
  };
}

module.exports = {
  SECTORS,
  BASIC_BLOCK_TYPES,
  normalizeSectorKey,
  buildGenericLandingSitePrompt,
  buildGenericFallback,
};
