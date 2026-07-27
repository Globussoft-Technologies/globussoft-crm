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

const WELLNESS_SECTOR_KEYS = new Set(['health', 'hospital', 'fitness']);
const BASIC_BLOCK_TYPES = new Set(['heading', 'text', 'image', 'button', 'form', 'divider', 'spacer', 'columns']);

function isWellnessSector(sectorKey) {
  return WELLNESS_SECTOR_KEYS.has(String(sectorKey || '').trim().toLowerCase());
}

function normalizeSectorKey(value) {
  const key = String(value || 'general').trim().toLowerCase();
  return SECTORS[key] ? key : 'general';
}

function clean(value, fallback = '', max = 120) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, max);
}

function slugFor(sectorKey, campaignName) {
  return `${sectorKey}-${campaignName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 50) || `landing-${sectorKey}`;
}

function buildGenericLandingSitePrompt(input = {}) {
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const sector = SECTORS[sectorKey];
  const sectorLabel = clean(input.sectorLabel, sector.label, 60);
  const campaignName = clean(input.campaignName, `${sectorLabel} Landing Site`, 120);
  const businessName = clean(input.businessName, '', 120);
  const campaignGoal = clean(input.campaignGoal, 'capture leads', 200);
  const audience = clean(input.audience, 'qualified visitors', 200);
  const location = clean(input.location, '', 120);
  const eventDate = clean(input.eventDate, '', 80);
  const eventTime = clean(input.eventTime, '', 80);
  const eventLocation = clean(input.eventLocation || input.location, '', 120);
  const tone = clean(input.tone, sector.voice, 120);
  const ctaText = clean(input.ctaText, 'Get Started', 40);
  const imageMode = clean(input.imageMode, 'auto', 20).toLowerCase();
  const wellnessMode = isWellnessSector(sectorKey);

  const system = [
    'You generate CRM landing-site content.',
    'Return exactly one JSON object with no markdown, no fences, and no extra prose.',
    'Use only these block types: heading, text, image, button, form, divider, spacer, columns.',
    wellnessMode
      ? 'For health, hospital, and fitness campaigns, create a polished consultation/event registration page similar to a wellness clinic contact page: left column with event details and contact copy, right column with a lead form. Keep event date, time, and location near the top.'
      : 'The page must feel complete: hero, supporting copy, one visual, a benefits section, and a lead form.',
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
    wellnessMode ? `Event date: ${eventDate || '(not provided)'}` : '',
    wellnessMode ? `Event time: ${eventTime || '(not provided)'}` : '',
    wellnessMode ? `Event location: ${eventLocation || '(not provided)'}` : '',
    '',
    wellnessMode
      ? 'The form must capture first name, last name, email, phone, service of interest, and a message. Use select for service of interest and textarea for the message.'
      : 'The form should capture name, email, phone, and a short message.',
  ].filter(Boolean).join('\n');

  return { system, user, sectorKey, sectorLabel, campaignName, businessName, campaignGoal, audience, location, tone, ctaText, imageMode, eventDate, eventTime, eventLocation, wellnessMode };
}

function buildWellnessRegistrationBlocks(input = {}, sourcePayload = {}) {
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const sector = SECTORS[sectorKey];
  const sectorLabel = clean(input.sectorLabel, sector.label, 60);
  const campaignName = clean(input.campaignName || sourcePayload.suggestedTitle, `${sectorLabel} Wellness Event`, 120);
  const businessName = clean(input.businessName, 'Enhance Wellness', 120);
  const campaignGoal = clean(input.campaignGoal || sourcePayload.description, 'invite the community to register and help the team collect qualified leads', 220);
  const audience = clean(input.audience, 'interested visitors', 180);
  const eventDate = clean(input.eventDate, 'Add the event date', 80);
  const eventTime = clean(input.eventTime, 'Add the event time', 80);
  const eventLocation = clean(input.eventLocation || input.location, 'Add the event venue', 160);
  const ctaText = clean(input.ctaText, 'Get Started', 40);
  const serviceLabel = clean(input.serviceLabel || sourcePayload.serviceLabel, sectorKey === 'fitness' ? 'Wellness Assessment' : sectorKey === 'hospital' ? 'Health Camp Registration' : 'Event Registration', 80);
  const intro = `${businessName} invites ${audience} to register. ${campaignGoal}`;

  return [
    {
      id: 'wellness-campaign-page',
      type: 'columns',
      props: {
        gap: '0',
        variant: 'wellness-campaign-page',
        columns: [
          {
            fullWidth: true,
            components: [
              {
                id: 'wellness-page-header',
                type: 'columns',
                props: {
                  gap: '10px',
                  variant: 'wellness-header-row',
                  columns: [
                    {
                      fullWidth: true,
                      components: [
                        { id: 'wellness-logo', type: 'heading', props: { text: `${businessName} Initiative`, level: 'h3', align: 'center', color: '#1f2f2c', variant: 'wellness-logo' } },
                        { id: 'wellness-nav', type: 'text', props: { text: 'HOME   EVENTS   ABOUT   DONATE   CONTACT', align: 'center', color: '#1f2f2c', fontSize: '0.78rem', variant: 'wellness-nav' } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          {
            fullWidth: true,
            components: [
              {
                id: 'wellness-hero-row',
                type: 'columns',
                props: {
                  gap: '36px',
                  variant: 'wellness-hero-row',
                  columns: [
                    {
                      components: [
                        { id: 'wellness-eyebrow', type: 'text', props: { text: 'VISIT - CALL - WRITE', align: 'left', color: '#a88345', fontSize: '0.78rem', variant: 'wellness-eyebrow' } },
                        { id: 'wellness-title', type: 'heading', props: { text: campaignName, level: 'h1', align: 'left', color: '#1f2f2c', variant: 'wellness-display' } },
                        { id: 'wellness-intro', type: 'text', props: { text: intro, align: 'left', color: '#5f6c67', fontSize: '1.02rem', variant: 'wellness-body' } },
                        { id: 'event-title', type: 'heading', props: { text: 'Event Details', level: 'h3', align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' } },
                        { id: 'event-date', type: 'text', props: { text: `Date: ${eventDate}`, align: 'left', color: '#4e5a55', fontSize: '0.98rem', variant: 'wellness-detail' } },
                        { id: 'event-time', type: 'text', props: { text: `Time: ${eventTime}`, align: 'left', color: '#4e5a55', fontSize: '0.98rem', variant: 'wellness-detail' } },
                        { id: 'event-location', type: 'text', props: { text: `Location: ${eventLocation}`, align: 'left', color: '#4e5a55', fontSize: '0.98rem', variant: 'wellness-detail' } },
                        { id: 'event-audience', type: 'text', props: { text: `For: ${audience}`, align: 'left', color: '#4e5a55', fontSize: '0.98rem', variant: 'wellness-detail' } },
                      ],
                    },
                    {
                      components: [
                        { id: 'event-photo', type: 'image', props: { src: '', alt: `${campaignName} event photo`, width: '100%', maxWidth: '420px', variant: 'wellness-event-image' } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          {
            fullWidth: true,
            components: [
              {
                id: 'wellness-registration-row',
                type: 'columns',
                props: {
                  gap: '36px',
                  variant: 'wellness-registration-row',
                  columns: [
                    {
                      components: [
                        {
                          id: 'lead-form',
                          type: 'form',
                          props: {
                            title: 'Request a Consultation',
                            fields: [
                              { label: 'First Name', name: 'first_name', type: 'text', required: true, placeholder: 'e.g., John' },
                              { label: 'Last Name', name: 'last_name', type: 'text', required: true, placeholder: 'e.g., Doe' },
                              { label: 'Email Address', name: 'email', type: 'email', required: true, placeholder: 'e.g., name@example.com' },
                              { label: 'Phone Number', name: 'phone', type: 'tel', required: true, placeholder: 'e.g., Phone Number' },
                              { label: 'Service of Interest', name: 'service_interest', type: 'select', required: false, options: [serviceLabel, campaignName, 'General Enquiry'] },
                              { label: 'Tell Us More', name: 'message', type: 'textarea', required: false, placeholder: 'Share any questions or concerns...' },
                            ],
                            submitText: ctaText,
                            thankYouMessage: `Thanks. We have received your registration for ${campaignName}.`,
                            enableCaptcha: false,
                            leadRoutingRuleId: '',
                            successRedirectUrl: '',
                            variant: 'wellness-consultation',
                          },
                        },
                      ],
                    },
                    {
                      components: [
                        {
                          id: 'wellness-benefit-cards',
                          type: 'columns',
                          props: {
                            gap: '18px',
                            variant: 'wellness-benefit-cards',
                            columns: [
                              {
                                components: [
                                  { id: 'contact-title', type: 'heading', props: { text: 'Need Help?', level: 'h3', align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' } },
                                  { id: 'contact-copy', type: 'text', props: { text: 'Share your details in the registration form. The team will follow up with confirmation and next steps.', align: 'center', color: '#4e5a55', fontSize: '0.98rem', variant: 'wellness-body' } },
                                ],
                              },
                              {
                                components: [
                                  { id: 'why-title', type: 'heading', props: { text: 'Why Attend', level: 'h3', align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' } },
                                  { id: 'why-copy', type: 'text', props: { text: 'Get clear guidance, event support, and a simple registration experience from the wellness team.', align: 'center', color: '#4e5a55', fontSize: '0.98rem', variant: 'wellness-body' } },
                                ],
                              },
                              {
                                components: [
                                  { id: 'after-title', type: 'heading', props: { text: 'After Registration', level: 'h3', align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' } },
                                  { id: 'after-copy', type: 'text', props: { text: 'Your enquiry is stored as a lead in the CRM so the team can follow up without missing the request.', align: 'center', color: '#4e5a55', fontSize: '0.98rem', variant: 'wellness-body' } },
                                ],
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          {
            fullWidth: true,
            components: [
              { id: 'wellness-footer', type: 'text', props: { text: `Copyright ${new Date().getFullYear()} ${businessName}`, align: 'center', color: '#ffffff', fontSize: '0.82rem', variant: 'wellness-footer' } },
            ],
          },
        ],
      },
    },
  ];
}

function buildGenericFallback(input = {}) {
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const sector = SECTORS[sectorKey];
  const sectorLabel = clean(input.sectorLabel, sector.label, 60);
  const campaignName = clean(input.campaignName, `${sectorLabel} Landing Site`, 120);
  const businessName = clean(input.businessName, '', 120);
  const campaignGoal = clean(input.campaignGoal, 'capture leads', 200);
  const audience = clean(input.audience, 'qualified visitors', 200);
  const location = clean(input.location, '', 120);
  const ctaText = clean(input.ctaText, 'Get Started', 40);
  const wellnessMode = isWellnessSector(sectorKey);
  const slug = slugFor(sectorKey, campaignName);

  if (wellnessMode) {
    return {
      suggestedTitle: campaignName.slice(0, 80),
      suggestedSlug: slug,
      description: `${sectorLabel} event registration landing site for ${campaignGoal}`.slice(0, 200),
      seoMeta: {
        metaTitle: `${campaignName} | ${sectorLabel}`.slice(0, 60),
        metaDescription: `${campaignGoal} for ${audience}.`.slice(0, 160),
      },
      blocks: buildWellnessRegistrationBlocks(input, { suggestedTitle: campaignName }),
    };
  }

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
            { label: 'Message', name: 'message', type: 'textarea', required: false },
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
  buildWellnessRegistrationBlocks,
  isWellnessSector,
};
