'use strict';

const SECTORS = {
  general: { label: 'General', voice: 'Clear, flexible, and lead-focused.' },
  travel: { label: 'Travel', voice: 'Destination-led and aspirational.' },
  wellness: { label: 'Wellness', voice: 'Calm, reassuring, and registration-friendly.' },
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

const WELLNESS_SECTOR_KEYS = new Set(['wellness', 'health', 'hospital', 'fitness']);
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
      ? 'For health, hospital, and fitness campaigns, create a polished consultation/event registration page with an editable structure: brand header, hero, trust strip, support cards, registration form, and footer. Keep event date, time, and location near the top, and make the copy specific, professional, and easy for an admin to edit.'
      : 'The page must feel complete: hero, supporting copy, one visual, a benefits section, and a lead form.',
    'Do not write vague filler, stock marketing fluff, or placeholder text.',
    'Do not copy any example campaign already seen elsewhere; create fresh copy from the provided inputs.',
    'If a detail is not provided, infer a sensible professional default instead of leaving the copy empty.',
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
      ? 'The form must capture first name, last name, email, phone, service of interest, and a message. Use select for service of interest and textarea for the message. Make the labels, section titles, and microcopy sound like a polished live landing page, not a template.'
      : 'The form should capture name, email, phone, and a short message.',
  ].filter(Boolean).join('\n');

  return { system, user, sectorKey, sectorLabel, campaignName, businessName, campaignGoal, audience, location, tone, ctaText, imageMode, eventDate, eventTime, eventLocation, wellnessMode };
}

function buildWellnessLandingSitePrompt(input = {}) {
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const sector = SECTORS[sectorKey];
  const sectorLabel = clean(input.sectorLabel, sector.label, 60);
  const campaignName = clean(input.campaignName, `${sectorLabel} Landing Page`, 120);
  const businessName = clean(input.businessName, campaignName, 120);
  const campaignGoal = clean(input.campaignGoal, 'capture registrations', 200);
  const audience = clean(input.audience, 'qualified visitors', 200);
  const location = clean(input.location, '', 120);
  const eventDate = clean(input.eventDate, 'Add date', 80);
  const eventTime = clean(input.eventTime, 'Add time', 80);
  const eventLocation = clean(input.eventLocation || input.location, 'Add location', 120);
  const tone = clean(input.tone, sector.voice, 120);
  const ctaText = clean(input.ctaText, 'Get Started', 40);
  const imageMode = clean(input.imageMode, 'auto', 20).toLowerCase();

  const system = [
    'You generate structured content for a wellness landing page builder.',
    'Return exactly one JSON object with no markdown fences and no extra commentary.',
    'The page must feel like a polished, editable landing page for marketing and lead capture.',
    'Use the provided inputs as the source of truth. Do not substitute a different campaign theme.',
    'Do not mention blood donation unless the user explicitly provided that campaign theme.',
    'Keep the copy campaign-neutral and professional so the same layout can be reused for hair treatment, skin care, consultations, wellness events, or clinic campaigns.',
    'You may generate fresh copy, but the content must remain consistent with the inputs.',
    'Use concise, specific language. No vague filler.',
    'If an input is missing, infer a sensible professional default rather than leaving it blank.',
    '',
    'Return this JSON shape:',
    '{',
    '  "suggestedTitle": "string",',
    '  "suggestedSlug": "string",',
    '  "description": "string",',
    '  "seoMeta": { "metaTitle": "string", "metaDescription": "string" },',
    '  "content": {',
    '    "heroKicker": "string",',
    '    "heroTitleLine1": "string",',
    '    "heroTitleLine2": "string",',
    '    "heroCopy": "string",',
    '    "heroNote": "string",',
    '    "heroPrimaryCta": "string",',
    '    "detailDateLabel": "string",',
    '    "detailDateValue": "string",',
    '    "detailTimeLabel": "string",',
    '    "detailTimeValue": "string",',
    '    "detailLocationLabel": "string",',
    '    "detailLocationValue": "string",',
    '    "detailAudienceLabel": "string",',
    '    "detailAudienceValue": "string",',
    '    "benefitsKicker": "string",',
    '    "benefitsTitle": "string",',
    '    "benefitsCopy": "string",',
    '    "benefit1Title": "string",',
    '    "benefit1Body": "string",',
    '    "benefit2Title": "string",',
    '    "benefit2Body": "string",',
    '    "benefit3Title": "string",',
    '    "benefit3Body": "string",',
    '    "benefit4Title": "string",',
    '    "benefit4Body": "string",',
    '    "eligibilityTitle": "string",',
    '    "eligibilityCopy": "string",',
    '    "eligibilityBullets": ["string"],',
    '    "processTitle": "string",',
    '    "processCopy": "string",',
    '    "step1Title": "string",',
    '    "step1Body": "string",',
    '    "step2Title": "string",',
    '    "step2Body": "string",',
    '    "step3Title": "string",',
    '    "step3Body": "string",',
    '    "step4Title": "string",',
    '    "step4Body": "string",',
    '    "impactKicker": "string",',
    '    "impactTitle": "string",',
    '    "impactCopy": "string",',
    '    "metric1Value": "string",',
    '    "metric1Label": "string",',
    '    "metric2Value": "string",',
    '    "metric2Label": "string",',
    '    "metric3Value": "string",',
    '    "metric3Label": "string",',
    '    "metric4Value": "string",',
    '    "metric4Label": "string",',
    '    "ctaTitle": "string",',
    '    "ctaCopy": "string",',
    '    "ctaNote": "string",',
    '    "formTitle": "string",',
    '    "formCopy": "string",',
    '    "formSubmitText": "string",',
    '    "formThankYou": "string",',
    '    "footerLinks": "string",',
    '    "footerContact": "string",',
    '    "footerCopy": "string",',
    '    "imageQuery": "string",',
    '    "imageAlt": "string"',
    '  }',
    '}',
    '',
    'Inputs provided:',
    `- sector: ${sectorLabel}`,
    `- campaignName: ${campaignName}`,
    `- businessName: ${businessName}`,
    `- campaignGoal: ${campaignGoal}`,
    `- audience: ${audience}`,
    `- location: ${location || '(not provided)'}`,
    `- eventDate: ${eventDate}`,
    `- eventTime: ${eventTime}`,
    `- eventLocation: ${eventLocation}`,
    `- tone: ${tone}`,
    `- ctaText: ${ctaText}`,
    `- imageMode: ${imageMode}`,
    '',
    'Writing rules:',
    '- Keep the layout professional and attractive, with concise hero copy and specific supporting sections.',
    '- Make the content editable by an admin: clear labels, useful helper text, and structured copy.',
    '- Use the provided business name, audience, location, date, and time directly in the content.',
    '- Return professional copy related to the actual campaign, not a generic camp placeholder.',
    '- Never invent prices, phone numbers, email addresses, or partner names.',
    '- If you include an image query, make it relevant to the campaign and suitable for Pexels search.',
  ].join('\n');

  const user = [
    `Business name: ${businessName}`,
    `Campaign name: ${campaignName}`,
    `Campaign goal: ${campaignGoal}`,
    `Audience: ${audience}`,
    `Location: ${location || '(not provided)'}`,
    `Event date: ${eventDate}`,
    `Event time: ${eventTime}`,
    `Event location: ${eventLocation}`,
    `Tone: ${tone}`,
    `CTA label: ${ctaText}`,
    `Image mode: ${imageMode}`,
    '',
    'Generate the wellness landing page content now.',
  ].join('\n');

  return { system, user, sectorKey, sectorLabel, campaignName, businessName, campaignGoal, audience, location, tone, ctaText, imageMode, eventDate, eventTime, eventLocation };
}
function buildWellnessRegistrationBlocks(input = {}, sourcePayload = {}) {
  const sectorKey = normalizeSectorKey(input.sectorKey);
  const sector = SECTORS[sectorKey];
  const sectorLabel = clean(input.sectorLabel, sector.label, 60);
  const campaignName = clean(input.campaignName || sourcePayload.suggestedTitle || input.businessName, `${sectorLabel} Landing Page`, 120);
  const businessName = clean(input.businessName, campaignName, 120);
  const audience = clean(input.audience, 'local residents', 180);
  const eventDate = clean(input.eventDate, '15 August 2026', 80);
  const eventTime = clean(input.eventTime, '10:00 AM - 4:00 PM', 80);
  const eventLocation = clean(input.eventLocation || input.location, 'Koramangala, Bengaluru', 160);
  const ctaText = clean(input.ctaText, 'Book Now', 40);
  const heroPrimaryCta = clean(input.heroPrimaryCta, 'Get Started', 40);
  const topCta = clean(input.topCta, 'Book Now', 40);
  const heroKicker = clean(input.heroKicker, 'VISIT - CALL - WRITE', 40);
  const heroTitleLine1 = clean(input.heroTitleLine1, campaignName, 80);
  const heroTitleLine2 = clean(input.heroTitleLine2, '', 40);
  const heroCopy = clean(input.heroCopy || sourcePayload.description, `${businessName} invites ${audience} to explore this ${sectorLabel.toLowerCase()} experience and share their details for a prompt, professional follow-up.`, 260);
  const heroNote = clean(input.heroNote, 'Every submission is editable, trackable, and routed to the right team instantly.', 160);
  const brandMark = clean(input.brandMark, '+', 10);
  const brandLine = clean(input.brandLine, businessName, 120);
  const brandSubline = clean(input.brandSubline, sectorLabel, 80);
  const navText = clean(input.navText, 'HOME   SERVICES   ABOUT US   CONTACT', 100);
  const detailDateLabel = clean(input.detailDateLabel, 'Date', 40);
  const detailTimeLabel = clean(input.detailTimeLabel, 'Time', 40);
  const detailLocationLabel = clean(input.detailLocationLabel, 'Location', 40);
  const detailAudienceLabel = clean(input.detailAudienceLabel, 'For', 40);
  const detailAudience = clean(input.detailAudience, audience, 120);
  const benefitsKicker = clean(input.benefitsKicker, 'WHY CHOOSE US?', 60);
  const benefitsTitle = clean(input.benefitsTitle, campaignName, 120);
  const benefitsCopy = clean(input.benefitsCopy, `A clear landing page helps visitors understand the ${sectorLabel.toLowerCase()} offer, trust the brand, and take the next step without friction.`, 220);
  const eligibilityTitle = clean(input.eligibilityTitle, 'Who is this for?', 60);
  const eligibilityCopy = clean(input.eligibilityCopy, 'Use this section to explain who the offer is for, what should be prepared, and what the visitor can expect next.', 220);
  const eligibilityBullets = Array.isArray(input.eligibilityBullets) && input.eligibilityBullets.length
    ? input.eligibilityBullets
    : ['Clear service details', 'Simple enquiry process', 'Responsive follow-up', 'Editable by the admin'];
  const processTitle = clean(input.processTitle, 'How it works', 60);
  const processCopy = clean(input.processCopy, 'A simple flow helps visitors move from interest to enquiry while keeping the team in control of the next steps.', 220);
  const impactKicker = clean(input.impactKicker, 'WHY IT WORKS', 60);
  const impactTitle = clean(input.impactTitle, `Built to capture leads for ${campaignName}.`, 120);
  const impactCopy = clean(input.impactCopy, 'The landing page highlights the strongest proof points without overwhelming the visitor, and the form stays easy to find.', 220);
  const ctaTitle = clean(input.ctaTitle, 'Ready to get started?', 100);
  const ctaCopy = clean(input.ctaCopy, `Invite your visitors to take the next step with a clear, professional experience tailored to ${sectorLabel.toLowerCase()}.`, 220);
  const ctaNote = clean(input.ctaNote, 'Your details will be captured in the CRM and shared with the right team for follow-up.', 180);
  const formTitle = clean(input.formTitle, 'Request More Information', 100);
  const formCopy = clean(input.formCopy, 'Share your details and the team will follow up with confirmation and next steps.', 220);
  const formSubmitText = clean(input.formSubmitText, 'Submit Enquiry', 40);
  const formThankYou = clean(input.formThankYou, `Thanks. We have received your enquiry for ${campaignName}.`, 220);
  const footerLinks = clean(input.footerLinks, 'Home | Services | About Us | Contact', 180);
  const footerContact = clean(input.footerContact, '+91 98765 43210\ninfo@company.com\nKoramangala, Bengaluru', 220);
  const footerCopy = clean(input.footerCopy, `(c) ${new Date().getFullYear()} ${businessName}. All rights reserved.`, 180);
  const eligibilityCta = clean(input.eligibilityCta, 'Know More', 40);

  const benefitCards = [
    { id: 'benefit-1', icon: '+', title: clean(input.benefit1Title, 'Clear value', 60), body: clean(input.benefit1Body, `Show visitors why the ${sectorLabel.toLowerCase()} offer matters and how it helps them.`, 180) },
    { id: 'benefit-2', icon: 'o', title: clean(input.benefit2Title, 'Professional follow-up', 60), body: clean(input.benefit2Body, 'The team can respond quickly with the right next step once the enquiry is submitted.', 180) },
    { id: 'benefit-3', icon: ':)', title: clean(input.benefit3Title, 'Trust-building copy', 60), body: clean(input.benefit3Body, 'Clear language and a polished layout make the page feel credible and easy to use.', 180) },
    { id: 'benefit-4', icon: '#', title: clean(input.benefit4Title, 'Stronger conversions', 60), body: clean(input.benefit4Body, 'A focused landing page keeps attention on the offer and the enquiry form.', 180) },
  ];

  const steps = [
    { id: 'step-1', number: '1', title: clean(input.step1Title, 'Review', 60), body: clean(input.step1Body, `Visitors quickly understand the ${sectorLabel.toLowerCase()} offer and what to expect next.`, 180) },
    { id: 'step-2', number: '2', title: clean(input.step2Title, 'Enquire', 60), body: clean(input.step2Body, 'They submit a short form with the essential details the team needs.', 180) },
    { id: 'step-3', number: '3', title: clean(input.step3Title, 'Follow up', 60), body: clean(input.step3Body, 'The team reviews the enquiry and responds with confirmation or next steps.', 180) },
    { id: 'step-4', number: '4', title: clean(input.step4Title, 'Convert', 60), body: clean(input.step4Body, 'A clear process improves trust and keeps the visitor moving toward action.', 180) },
  ];

  const impactMetrics = [
    { id: 'metric-1', value: clean(input.metric1Value, '4', 20), label: clean(input.metric1Label, 'Simple sections', 60) },
    { id: 'metric-2', value: clean(input.metric2Value, '0', 20), label: clean(input.metric2Label, 'Manual chasing', 60) },
    { id: 'metric-3', value: clean(input.metric3Value, '100%', 20), label: clean(input.metric3Label, 'Editable content', 60) },
    { id: 'metric-4', value: clean(input.metric4Value, '1', 20), label: clean(input.metric4Label, 'Lead pipeline', 60) },
  ];

  const section = (id, variant, columns, gap = '24px') => ({ id, type: 'columns', props: { gap, variant, columns } });
  const cardGrid = (id, variant, items, cardBuilder, gap = '18px') => section(id, variant, items.map((item) => ({ components: cardBuilder(item) })), gap);
  const details = [
    { id: 'detail-date', label: detailDateLabel, value: eventDate },
    { id: 'detail-time', label: detailTimeLabel, value: eventTime },
    { id: 'detail-location', label: detailLocationLabel, value: eventLocation },
    { id: 'detail-audience', label: detailAudienceLabel, value: detailAudience },
  ];

  return [
    section('wellness-page', 'wellness-campaign-page', [
      { fullWidth: true, components: [
        section('wellness-header-row', 'wellness-header-row', [
          { components: [
            { id: 'brand-mark', type: 'text', props: { text: brandMark, align: 'center', color: '#b31d15', fontSize: '1.7rem', variant: 'wellness-logo-mark' } },
            { id: 'brand-name', type: 'heading', props: { text: brandLine, level: 'h3', align: 'left', color: '#1f2f2c', variant: 'wellness-logo' } },
            { id: 'brand-subline', type: 'text', props: { text: brandSubline, align: 'left', color: '#5f6c67', fontSize: '0.82rem', variant: 'wellness-brand-subline' } },
          ] },
          { components: [
            { id: 'top-nav', type: 'text', props: { text: navText, align: 'center', color: '#1f2f2c', fontSize: '0.78rem', variant: 'wellness-nav' } },
            { id: 'top-cta', type: 'button', props: { text: topCta, url: '#lead-form', bgColor: '#b31d15', color: '#ffffff', align: 'right', size: 'small' } },
          ] },
        ], '24px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-hero-row', 'wellness-hero-row', [
          { components: [
            { id: 'hero-kicker', type: 'text', props: { text: heroKicker, align: 'left', color: '#b31d15', fontSize: '0.8rem', variant: 'wellness-eyebrow' } },
            { id: 'hero-title-1', type: 'heading', props: { text: heroTitleLine1, level: 'h1', align: 'left', color: '#1f2f2c', variant: 'wellness-display' } },
            { id: 'hero-title-2', type: 'heading', props: { text: heroTitleLine2, level: 'h1', align: 'left', color: '#b31d15', variant: 'wellness-hero-accent' } },
            { id: 'hero-copy', type: 'text', props: { text: heroCopy, align: 'left', color: '#5f6c67', fontSize: '1.02rem', variant: 'wellness-body' } },
            { id: 'hero-primary-cta', type: 'button', props: { text: heroPrimaryCta, url: '#lead-form', bgColor: '#b31d15', color: '#ffffff', align: 'left', size: 'medium' } },
            { id: 'hero-note', type: 'text', props: { text: heroNote, align: 'left', color: '#5f6c67', fontSize: '0.88rem', variant: 'wellness-note' } },
          ] },
          { components: [
            { id: 'hero-image', type: 'image', props: { src: '', alt: `${campaignName} hero image`, width: '100%', maxWidth: '100%', variant: 'wellness-hero-image' } },
          ] },
        ], '36px'),
      ] },
      { fullWidth: true, components: [
        cardGrid('wellness-details-strip', 'wellness-details-strip', details, (item) => ([
          { id: `${item.id}-label`, type: 'text', props: { text: item.label, align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label' } },
          { id: `${item.id}-value`, type: 'heading', props: { text: item.value, level: 'h4', align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' } },
        ]), '18px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-benefits-row', 'wellness-benefits-row', [
          { components: [
            { id: 'benefits-kicker', type: 'text', props: { text: benefitsKicker, align: 'left', color: '#b31d15', fontSize: '0.8rem', variant: 'wellness-eyebrow' } },
            { id: 'benefits-title', type: 'heading', props: { text: benefitsTitle, level: 'h2', align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' } },
            { id: 'benefits-copy', type: 'text', props: { text: benefitsCopy, align: 'left', color: '#5f6c67', fontSize: '0.98rem', variant: 'wellness-body' } },
          ] },
          { components: [
            cardGrid('benefit-grid', 'wellness-benefit-grid', benefitCards, (card) => ([
              { id: `${card.id}-icon`, type: 'text', props: { text: card.icon, align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge' } },
              { id: `${card.id}-title`, type: 'heading', props: { text: card.title, level: 'h4', align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' } },
              { id: `${card.id}-body`, type: 'text', props: { text: card.body, align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' } },
            ])),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-process-row', 'wellness-process-row', [
          { components: [
            { id: 'eligibility-title', type: 'heading', props: { text: eligibilityTitle, level: 'h3', align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' } },
            { id: 'eligibility-copy', type: 'text', props: { text: eligibilityCopy, align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' } },
            { id: 'eligibility-list', type: 'text', props: { text: eligibilityBullets.map((bullet) => `- ${bullet}`).join('\n'), align: 'left', color: '#1f2f2c', fontSize: '0.96rem', variant: 'wellness-bullet-list', whiteSpace: 'pre-line' } },
            { id: 'eligibility-cta', type: 'button', props: { text: eligibilityCta, url: '#lead-form', bgColor: '#fff8f7', color: '#b31d15', align: 'left', size: 'small' } },
          ] },
          { components: [
            { id: 'process-title', type: 'heading', props: { text: processTitle, level: 'h3', align: 'left', color: '#b31d15', variant: 'wellness-section-title' } },
            { id: 'process-copy', type: 'text', props: { text: processCopy, align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' } },
            cardGrid('steps-grid', 'wellness-step-grid', steps, (step) => ([
              { id: `${step.id}-number`, type: 'heading', props: { text: step.number, level: 'h3', align: 'center', color: '#b31d15', variant: 'wellness-step-number' } },
              { id: `${step.id}-title`, type: 'heading', props: { text: step.title, level: 'h4', align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' } },
              { id: `${step.id}-body`, type: 'text', props: { text: step.body, align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' } },
            ])),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-impact-band', 'wellness-impact-band', [
          { components: [
            { id: 'impact-kicker', type: 'text', props: { text: impactKicker, align: 'left', color: '#fff4f1', fontSize: '0.8rem', variant: 'wellness-eyebrow' } },
            { id: 'impact-title', type: 'heading', props: { text: impactTitle, level: 'h2', align: 'left', color: '#ffffff', variant: 'wellness-band-title' } },
            { id: 'impact-copy', type: 'text', props: { text: impactCopy, align: 'left', color: '#ffe7e3', fontSize: '0.94rem', variant: 'wellness-band-copy' } },
          ] },
          { components: [
            cardGrid('metrics-grid', 'wellness-metric-grid', impactMetrics, (metric) => ([
              { id: `${metric.id}-value`, type: 'heading', props: { text: metric.value, level: 'h2', align: 'center', color: '#ffffff', variant: 'wellness-metric-value' } },
              { id: `${metric.id}-label`, type: 'text', props: { text: metric.label, align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' } },
            ])),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-cta-row', 'wellness-cta-row', [
          { components: [
            { id: 'cta-title', type: 'heading', props: { text: ctaTitle, level: 'h3', align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' } },
            { id: 'cta-copy', type: 'text', props: { text: ctaCopy, align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' } },
            { id: 'cta-note', type: 'text', props: { text: ctaNote, align: 'left', color: '#5f6c67', fontSize: '0.86rem', variant: 'wellness-note' } },
          ] },
          { components: [
            { id: 'cta-button', type: 'button', props: { text: ctaText, url: '#lead-form', bgColor: '#b31d15', color: '#ffffff', align: 'center', size: 'large' } },
          ] },
        ], '24px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-form-row', 'wellness-form-row', [
          { components: [
            { id: 'form-kicker', type: 'text', props: { text: 'Lead capture', align: 'left', color: '#b31d15', fontSize: '0.76rem', variant: 'wellness-eyebrow' } },
            { id: 'form-title-copy', type: 'heading', props: { text: formTitle, level: 'h3', align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' } },
            { id: 'form-copy', type: 'text', props: { text: formCopy, align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-body' } },
            { id: 'lead-form', type: 'form', props: {
              title: formTitle,
              fields: [
                { label: 'First Name', name: 'first_name', type: 'text', required: true, placeholder: 'e.g., John' },
                { label: 'Last Name', name: 'last_name', type: 'text', required: true, placeholder: 'e.g., Doe' },
                { label: 'Email Address', name: 'email', type: 'email', required: true, placeholder: 'e.g., name@example.com' },
                { label: 'Phone Number', name: 'phone', type: 'tel', required: true, placeholder: 'e.g., +91 98765 43210' },
                { label: 'Service of Interest', name: 'service_interest', type: 'select', required: false, options: [sectorLabel, campaignName, 'General Enquiry'] },
                { label: 'Tell Us More', name: 'message', type: 'textarea', required: false, placeholder: 'Share any questions or concerns...' },
              ],
              submitText: formSubmitText,
              thankYouMessage: formThankYou,
              enableCaptcha: false,
              leadRoutingRuleId: '',
              successRedirectUrl: '',
              variant: 'wellness-consultation',
            } },
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-footer-row', 'wellness-footer-row', [
          { components: [
            { id: 'footer-brand-mark', type: 'text', props: { text: brandMark, align: 'left', color: '#b31d15', fontSize: '1.4rem', variant: 'wellness-logo-mark' } },
            { id: 'footer-brand-name', type: 'heading', props: { text: brandLine, level: 'h4', align: 'left', color: '#1f2f2c', variant: 'wellness-footer-brand' } },
            { id: 'footer-links', type: 'text', props: { text: footerLinks, align: 'left', color: '#5f6c67', fontSize: '0.84rem', variant: 'wellness-footer-links' } },
          ] },
          { components: [
            { id: 'footer-contact', type: 'text', props: { text: footerContact, align: 'left', color: '#5f6c67', fontSize: '0.84rem', variant: 'wellness-footer-contact', whiteSpace: 'pre-line' } },
            { id: 'footer-copy', type: 'text', props: { text: footerCopy, align: 'right', color: '#7b807a', fontSize: '0.78rem', variant: 'wellness-footer-copy' } },
          ] },
        ], '24px'),
      ] },
    ], '24px'),
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
  buildWellnessLandingSitePrompt,
  SECTORS,
  BASIC_BLOCK_TYPES,
  normalizeSectorKey,
  buildGenericLandingSitePrompt,
  buildGenericFallback,
  buildWellnessRegistrationBlocks,
  isWellnessSector,
};





