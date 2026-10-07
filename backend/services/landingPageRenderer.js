// #447 ?? ?? ?? ??  URL scheme allowlist before rendering into the public landing-page
// HTML. The previous implementation only HTML-escaped the URL (via
// escapeHtml on the attribute value), which prevents `"` injection but
// does NOT block dangerous schemes:
//   - <img src="javascript:alert(1)">  ?? ?? ?? ??  modern browsers don't execute this
//     on <img>, but accepting it is still defense-in-depth wrong, and the
//     same string can flow into other sinks (a future hyperlink wrapper, an
//     email template inheriting the URL, etc.) where it WOULD execute.
//   - <a href="javascript:alert(1)">   ?? ?? ?? ??  DOES execute in every browser. The
//     button component had this exact bug.
//   - <iframe src="javascript:...">    ?? ?? ?? ??  rejected by most browsers but still
//     sloppy. Restrict iframe to https:/http: (videos).
//
// `safeUrl(input, kind)` returns a string suitable for embedding in the
// matching attribute. Returns the safe fallback (empty / "#" / about:blank)
// when the input fails the allowlist for that kind. Caller should
// further escapeHtml() the result before injecting into the attribute
// value (escapeHtml stays the responsibility of the renderer site so the
// helper can be tested in isolation against the scheme rules).
//
// Allowlists chosen conservatively:
//   image-src  : http:, https:, protocol-relative `//`, relative `/path`,
//                data:image/* (lets users embed inline previews if they
//                paste a base64 image; harmless because data:image/* can't
//                execute JS in modern browsers).
//   link-href  : http:, https:, mailto:, tel:, sms:, fragment `#anchor`,
//                relative paths starting with `/`, protocol-relative `//`.
//   iframe-src : http:, https:, protocol-relative `//`. NO data:.
//
// Rejected schemes (always): javascript:, vbscript:, data:text/html,
// data:application/*, file:, about:, jar:, ms-its:, mhtml:.
//
// Whitespace + URL-encoded variants: trim leading whitespace before scheme
// match (browsers do); reject if the *trimmed* value starts with a denied
// scheme (case-insensitive). The denied list is the gate; everything not
// on the allowed list also falls back, so a future protocol like
// `webcal:` requires an explicit allowlist update.
const { normalizeVideoEmbedUrl, isDirectVideoFile } = require("../lib/videoUrl");
const { getPreset: getRegistrationPreset } = require("../lib/travelRegistrationPresets");
const { resolveWellnessLandingTheme, resolveWellnessLandingLayout } = require("./wellnessLandingThemes");

const SAFE_FALLBACK = {
  'image-src': '',
  'link-href': '#',
  'iframe-src': 'about:blank',
};
function safeUrl(input, kind) {
  if (input == null) return SAFE_FALLBACK[kind] ?? '';
  const raw = String(input);
  // Browsers strip leading C0 whitespace AND TAB before scheme parsing ?? ?? ?? ?? 
  // mirror that so a "  javascript:..." or "\tjavascript:..." attempt is
  // caught the same way. Lowercase the prefix for a case-insensitive
  // scheme test.
  // eslint-disable-next-line no-control-regex
  const trimmed = raw.replace(/^[\s\x00-\x1f]+/, '');
  // Empty / whitespace-only input is indistinguishable from null after
  // trim ?? ?? ?? ??  return the kind's safe fallback rather than passing through
  // an empty attribute (`<a href="">` is clickable and reloads the page).
  if (trimmed.length === 0) return SAFE_FALLBACK[kind] ?? '';
  const lower = trimmed.toLowerCase();
  // Allow same-page anchor, relative path, protocol-relative.
  if (lower.startsWith('#') || lower.startsWith('/')) return trimmed;
  // Scheme-prefixed values: walk the allowlist for the kind.
  const schemeMatch = lower.match(/^([a-z][a-z0-9+.-]*):/);
  if (!schemeMatch) {
    // No scheme + not anchor / not absolute path; treat as relative
    // ("foo.png" or "page.html" or "test"). Allow it.
    return trimmed;
  }
  const scheme = schemeMatch[1];
  if (kind === 'image-src') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    // data:image/...  but NOT data:text/html etc.
    if (scheme === 'data' && /^data:image\//i.test(trimmed)) return trimmed;
    return SAFE_FALLBACK['image-src'];
  }
  if (kind === 'link-href') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    if (scheme === 'mailto' || scheme === 'tel' || scheme === 'sms') return trimmed;
    return SAFE_FALLBACK['link-href'];
  }
  if (kind === 'iframe-src') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    return SAFE_FALLBACK['iframe-src'];
  }
  return SAFE_FALLBACK[kind] ?? '';
}

// ?? ?? ?? ?? ?? ?? ?? ??  Travel-block helpers ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? 
//
// All 8 travel blocks reuse the same `.trips-page .t-*` class names as the
// hardcoded Japan page (frontend/src/pages/public/TripsLanding.css). The
// shared CSS file `backend/services/landingPageRenderer.travel.css` is
// auto-injected for any page whose templateType is "travel_destination" ?? ?? ?? ?? 
// see `renderPage()` below.
//
// `tplStr(template, vars)` is a minimal {{key}} substitution helper so the
// inline countdown / scroll-target JS stays readable while keeping `slug`
// + element IDs HTML-escaped at injection time.
function collectBlocks(blocks, acc = []) {
  (Array.isArray(blocks) ? blocks : []).forEach((block) => {
    if (!block || typeof block !== 'object') return;
    acc.push(block);
    (block.props?.columns || []).forEach((column) => collectBlocks(column?.components, acc));
  });
  return acc;
}

function firstBlockText(content, ids = []) {
  const flat = collectBlocks(content);
  for (const id of ids) {
    const match = flat.find((block) => block?.id === id && typeof block?.props?.text === 'string' && block.props.text.trim());
    if (match) return match.props.text;
  }
  const fallback = flat.find((block) => ['heading', 'text'].includes(block?.type) && typeof block?.props?.text === 'string' && block.props.text.trim());
  return fallback?.props?.text || '';
}

function firstBlockForm(content, ids = []) {
  const flat = collectBlocks(content);
  for (const id of ids) {
    const match = flat.find((block) => block?.id === id && block?.type === 'form');
    if (match) return match;
  }
  return flat.find((block) => block?.type === 'form') || null;
}

function isWellnessServiceInterestField(field) {
  const name = String(field?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = String(field?.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['serviceinterest', 'service', 'treatmentofinterest'].includes(name)
    || label === 'serviceofinterest';
}

function getWellnessFormFields(fields) {
  return (Array.isArray(fields) ? fields : []).filter((field) => !isWellnessServiceInterestField(field));
}

function hasWellnessRoot(components) {
  return Array.isArray(components)
    ? components.some((block) => block && block.type === 'columns' && block.props?.variant === 'wellness-campaign-page')
    : false;
}

function normalizeWellnessCampaignComponents(components) {
  let next;
  try {
    next = JSON.parse(JSON.stringify(components));
  } catch (_err) {
    return components;
  }

  const page = next.find((block) => block?.type === 'columns' && block.props?.variant === 'wellness-campaign-page');
  if (!page) return next;

  const findRow = (variant) => (page.props?.columns || [])
    .flatMap((column) => column?.components || [])
    .find((block) => block?.type === 'columns' && block.props?.variant === variant);

  const header = findRow('wellness-header-row');
  const headerBrandColumn = header?.props?.columns?.[0];
  if (headerBrandColumn) {
    headerBrandColumn.components = (headerBrandColumn.components || [])
      .filter((block) => block?.id !== 'brand-subline' && block?.props?.variant !== 'wellness-brand-subline');
  }
  const headerNavColumn = header?.props?.columns?.[1];
  if (headerNavColumn) {
    headerNavColumn.components = (headerNavColumn.components || [])
      .filter((block) => block?.type !== 'button');
  }

  const hero = findRow('wellness-hero-row');
  if (hero?.props?.columns) {
    hero.props.columns = hero.props.columns.map((column) => {
      const buttons = (column.components || []).filter((block) => block?.type === 'button');
      if (buttons.length <= 1) return column;
      const preferred = buttons.find((block) => block.id === 'hero-primary-cta') || buttons[0];
      return {
        ...column,
        components: (column.components || []).filter((block) => block?.type !== 'button' || block === preferred),
      };
    });
  }

  const allPageBlocks = collectBlocks([page]);
  const usedWellnessImageSources = new Set();
  allPageBlocks
    .filter((block) => block?.type === 'image' && typeof block?.props?.src === 'string' && block.props.src.trim())
    .forEach((block) => {
      const src = block.props.src.trim();
      if (usedWellnessImageSources.has(src)) {
        // Prevent a legacy/generated duplicate photo from being repeated in
        // the hero, gallery, and CTA slots. Empty slots render their neutral
        // campaign placeholder until a distinct image is supplied.
        block.props.src = '';
      } else {
        usedWellnessImageSources.add(src);
      }
  });
  const heroImage = allPageBlocks.find((block) => block?.id === 'hero-image' && block?.type === 'image' && block?.props?.src);
  const cta = findRow('wellness-cta-row');
  if (cta?.props?.columns?.length >= 2 && heroImage) {
    const ctaColumns = cta.props.columns;
    const existingCtaImage = ctaColumns.flatMap((column) => column.components || []).find((block) => block?.id === 'cta-image');
    if (existingCtaImage) {
      if (existingCtaImage.props?.src === heroImage.props.src) existingCtaImage.props.src = '';
    } else {
      const copyComponents = (ctaColumns[0].components || []).filter((block) => block?.type !== 'button');
      const actionComponents = (ctaColumns[1].components || []).filter((block) => block?.type !== 'image');
      cta.props.columns = [
        {
          components: [{
            id: 'cta-image',
            type: 'image',
            props: {
              src: '',
              alt: 'Wellness campaign experience',
              variant: 'wellness-cta-image',
              width: '100%',
              maxWidth: '100%',
            },
          }],
        },
        { components: [...copyComponents, ...actionComponents] },
      ];
    }
  }

  const formRow = ['wellness-form-row', 'wellness-registration-row']
    .map((variant) => findRow(variant))
    .find((row) => row?.props?.columns?.some((column) => (column.components || []).some((block) => block?.id === 'lead-form')));
  const formColumn = formRow?.props?.columns?.find((column) => (column.components || []).some((block) => block?.id === 'lead-form'));
  if (formColumn) {
    formColumn.components = (formColumn.components || []).filter((block) => block?.id !== 'form-title-copy');
    formRow.props.columns = [formColumn];
  }

  return next;
}

function buildWellnessCampaignPage(landingPage = {}, content = []) {
  const flat = collectBlocks(content);
  const campaignName = firstBlockText(flat, ['hero-title-1', 'brand-name', 'cta-title', 'form-title-copy']) || landingPage.title || landingPage.name || landingPage.slug || 'Wellness Landing Page';
  const businessName = landingPage.businessName || firstBlockText(flat, ['brand-name']) || campaignName;
  const audience = landingPage.audience || firstBlockText(flat, ['detail-audience-value']) || 'your audience';
  const sectorLabel = landingPage.sectorLabel || 'Wellness';
  const summary = landingPage.description || `${businessName} invites ${audience} to learn more, submit an enquiry, and receive a prompt follow-up.`;
  const location = landingPage.eventLocation || landingPage.location || firstBlockText(flat, ['detail-location-value']) || 'Add location';
  const eventDate = landingPage.eventDate || firstBlockText(flat, ['detail-date-value']) || 'Add date';
  const eventTime = landingPage.eventTime || firstBlockText(flat, ['detail-time-value']) || 'Add time';
  const imageSources = flat
    .filter((block) => block?.type === 'image' && typeof block?.props?.src === 'string' && block.props.src.trim())
    .map((block) => ({ id: block.id, src: block.props.src.trim() }));
  const usedScaffoldImageSources = new Set();
  const imageSourceFor = (id) => {
    const candidates = [
      ...imageSources.filter((imageBlock) => imageBlock.id === id),
      ...imageSources.filter((imageBlock) => imageBlock.id !== id),
    ];
    const match = candidates.find((imageBlock) => !usedScaffoldImageSources.has(imageBlock.src));
    if (!match) return '';
    usedScaffoldImageSources.add(match.src);
    return match.src;
  };
  const existingForm = firstBlockForm(flat, ['lead-form']);
  const formTitle = landingPage.formTitle || existingForm?.props?.title || `Register for ${campaignName}`;
  const submitText = landingPage.formSubmitText || existingForm?.props?.submitText || 'Submit Enquiry';
  const thankYouMessage = landingPage.formThankYou || existingForm?.props?.thankYouMessage || `Thanks. We have received your enquiry for ${campaignName}.`;
  const existingFormFields = Array.isArray(existingForm?.props?.fields) && existingForm.props.fields.length > 0
    ? getWellnessFormFields(existingForm.props.fields)
    : [];
  const formFields = existingFormFields.length > 0
    ? existingFormFields
    : [
        { label: 'First Name', name: 'first_name', type: 'text', required: true, placeholder: 'e.g., John' },
        { label: 'Last Name', name: 'last_name', type: 'text', required: true, placeholder: 'e.g., Doe' },
        { label: 'Email Address', name: 'email', type: 'email', required: true, placeholder: 'e.g., name@example.com' },
        { label: 'Phone Number', name: 'phone', type: 'tel', required: true, placeholder: 'e.g., +91 98765 43210' },
        { label: 'Tell Us More', name: 'message', type: 'textarea', required: false, placeholder: 'Share any questions or concerns...' },
      ];

  const text = (id, value, extra = {}) => ({ id, type: 'text', props: { text: value, ...extra } });
  const heading = (id, value, level = 'h3', extra = {}) => ({ id, type: 'heading', props: { text: value, level, ...extra } });
  const button = (id, value, url, extra = {}) => ({ id, type: 'button', props: { text: value, url, ...extra } });
  const image = (id, alt, variant = 'wellness-event-image') => ({ id, type: 'image', props: { src: imageSourceFor(id), alt, variant, width: '100%', maxWidth: '100%' } });
  const form = () => ({ id: 'lead-form', type: 'form', props: { title: formTitle, submitText, thankYouMessage, variant: 'wellness-consultation', fields: formFields } });
  const wellnessTheme = String(landingPage.wellnessTheme || landingPage.themeId || 'botanical').trim().toLowerCase();
  const wellnessLayout = String(landingPage.wellnessLayout || landingPage.layoutId || 'editorial').trim().toLowerCase();
  const section = (id, variant, columns, gap = '24px', extraProps = {}) => ({ id, type: 'columns', props: { variant, gap, columns, ...extraProps } });

  return [
    section('wellness-page', 'wellness-campaign-page', [
      { fullWidth: true, components: [
        section('wellness-header-row', 'wellness-header-row', [
          { components: [
            text('brand-mark', landingPage.brandMark || '+', { align: 'center', color: '#b31d15', fontSize: '1.7rem', variant: 'wellness-logo-mark', icon: 'leaf' }),
            heading('brand-name', landingPage.brandLine || businessName, 'h3', { align: 'left', color: '#1f2f2c', variant: 'wellness-logo' }),
          ] },
          { components: [
            text('top-nav', landingPage.navText || 'HOME   SERVICES   ABOUT US   CONTACT', { align: 'center', color: '#1f2f2c', fontSize: '0.78rem', variant: 'wellness-nav' }),
          ] },
        ], '18px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-hero-row', 'wellness-hero-row', [
          { components: [
            text('hero-kicker', landingPage.heroKicker || 'VISIT - CALL - WRITE', { align: 'left', color: '#b31d15', fontSize: '0.8rem', variant: 'wellness-eyebrow' }),
            heading('hero-title-1', landingPage.heroTitleLine1 || campaignName, 'h1', { align: 'left', color: '#1f2f2c', variant: 'wellness-display' }),
            heading('hero-title-2', landingPage.heroTitleLine2 || landingPage.campaignTagline || 'Consultation', 'h1', { align: 'left', color: '#b31d15', variant: 'wellness-hero-accent' }),
            text('hero-copy', landingPage.heroCopy || summary, { align: 'left', color: '#5f6c67', fontSize: '1.02rem', variant: 'wellness-body' }),
            button('hero-primary-cta', landingPage.heroPrimaryCta || 'Get Started', '#lead-form', { bgColor: '#b31d15', color: '#ffffff', align: 'left', size: 'medium' }),
            text('hero-note', landingPage.heroNote || 'Every submission is editable, trackable, and routed to the right team instantly.', { align: 'left', color: '#5f6c67', fontSize: '0.88rem', variant: 'wellness-note' }),
          ] },
          { components: [ image('hero-image', `${campaignName} hero image`) ] },
        ], '36px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-details-strip', 'wellness-details-strip', [
          { components: [text('detail-date-label', 'Date', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label', icon: 'calendar' }), heading('detail-date-value', eventDate, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
          { components: [text('detail-time-label', 'Time', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label', icon: 'clock' }), heading('detail-time-value', eventTime, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
          { components: [text('detail-location-label', 'Location', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label', icon: 'location' }), heading('detail-location-value', location, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
          { components: [text('detail-audience-label', 'For', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label', icon: 'users' }), heading('detail-audience-value', audience, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
        ], '18px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-gallery-row', 'wellness-gallery-row', [
          { components: [image('gallery-image-1', `${campaignName} wellness experience`, 'wellness-gallery-image')] },
          { components: [image('gallery-image-2', `${campaignName} care team`, 'wellness-gallery-image')] },
          { components: [image('gallery-image-3', `${campaignName} community`, 'wellness-gallery-image')] },
        ], '18px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-benefits-row', 'wellness-benefits-row', [
          { components: [
            text('benefits-kicker', landingPage.benefitsKicker || 'WHY CHOOSE US?', { align: 'left', color: '#b31d15', fontSize: '0.8rem', variant: 'wellness-eyebrow' }),
            heading('benefits-title', landingPage.benefitsTitle || campaignName, 'h2', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('benefits-copy', landingPage.benefitsCopy || `A clear landing page helps visitors understand the ${sectorLabel.toLowerCase()} offer, trust the brand, and take the next step without friction.`, { align: 'left', color: '#5f6c67', fontSize: '0.98rem', variant: 'wellness-body' }),
          ] },
          { components: [
            section('benefit-grid', 'wellness-benefit-grid', [
              { components: [text('benefit-1-icon', '', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge', icon: 'eye' }), heading('benefit-1-title', landingPage.benefit1Title || 'Clear value', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-1-body', landingPage.benefit1Body || `Show visitors why the ${sectorLabel.toLowerCase()} offer matters and how it helps them.`, { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
              { components: [text('benefit-2-icon', '', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge', icon: 'person' }), heading('benefit-2-title', landingPage.benefit2Title || 'Professional follow-up', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-2-body', landingPage.benefit2Body || 'The team can respond quickly with the right next step once the enquiry is submitted.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
              { components: [text('benefit-3-icon', '', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge', icon: 'users' }), heading('benefit-3-title', landingPage.benefit3Title || 'Trust-building copy', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-3-body', landingPage.benefit3Body || 'Clear language and a polished layout make the page feel credible and easy to use.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
              { components: [text('benefit-4-icon', '', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge', icon: 'document' }), heading('benefit-4-title', landingPage.benefit4Title || 'Stronger conversions', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-4-body', landingPage.benefit4Body || 'A focused landing page keeps attention on the offer and the enquiry form.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
            ], '18px'),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-process-row', 'wellness-process-row', [
          { components: [
            heading('eligibility-title', landingPage.eligibilityTitle || 'Who is this for?', 'h3', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('eligibility-copy', landingPage.eligibilityCopy || 'Use this section to explain who the offer is for, what should be prepared, and what the visitor can expect next.', { align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' }),
            text('eligibility-list', (Array.isArray(landingPage.eligibilityBullets) && landingPage.eligibilityBullets.length > 0 ? landingPage.eligibilityBullets : ['Clear service details', 'Simple enquiry process', 'Responsive follow-up', 'Editable by the admin']).map((bullet) => `- ${bullet}`).join('\n'), { align: 'left', color: '#1f2f2c', fontSize: '0.96rem', variant: 'wellness-bullet-list', whiteSpace: 'pre-line' }),
            button('eligibility-cta', landingPage.eligibilityCta || 'Know More', '#lead-form', { bgColor: '#fff8f7', color: '#b31d15', align: 'left', size: 'small' }),
          ] },
          { components: [
            heading('process-title', landingPage.processTitle || 'How it works', 'h3', { align: 'left', color: '#b31d15', variant: 'wellness-section-title' }),
            text('process-copy', landingPage.processCopy || 'A simple flow helps visitors move from interest to enquiry while keeping the team in control of the next steps.', { align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' }),
            section('steps-grid', 'wellness-step-grid', [
              { components: [heading('step-1-number', '1', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-1-title', landingPage.step1Title || 'Review', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-1-body', landingPage.step1Body || `Visitors quickly understand the ${sectorLabel.toLowerCase()} offer and what to expect next.`, { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('step-2-number', '2', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-2-title', landingPage.step2Title || 'Enquire', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-2-body', landingPage.step2Body || 'They submit a short form with the essential details the team needs.', { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('step-3-number', '3', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-3-title', landingPage.step3Title || 'Follow up', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-3-body', landingPage.step3Body || 'The team reviews the enquiry and responds with confirmation or next steps.', { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('step-4-number', '4', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-4-title', landingPage.step4Title || 'Convert', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-4-body', landingPage.step4Body || 'A clear process improves trust and keeps the visitor moving toward action.', { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
            ], '18px'),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-impact-band', 'wellness-impact-band', [
          { components: [
            text('impact-kicker', landingPage.impactKicker || 'WHY IT WORKS', { align: 'left', color: '#fff4f1', fontSize: '0.8rem', variant: 'wellness-eyebrow' }),
            heading('impact-title', landingPage.impactTitle || `Built to capture leads for ${campaignName}.`, 'h2', { align: 'left', color: '#ffffff', variant: 'wellness-band-title' }),
            text('impact-copy', landingPage.impactCopy || 'The landing page highlights the strongest proof points without overwhelming the visitor, and the form stays easy to find.', { align: 'left', color: '#ffe7e3', fontSize: '0.94rem', variant: 'wellness-band-copy' }),
          ] },
          { components: [
            section('metrics-grid', 'wellness-metric-grid', [
              { components: [heading('metric-1-value', landingPage.metric1Value || '4', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-1-label', landingPage.metric1Label || 'Simple sections', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
              { components: [heading('metric-2-value', landingPage.metric2Value || '0', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-2-label', landingPage.metric2Label || 'Manual chasing', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
              { components: [heading('metric-3-value', landingPage.metric3Value || '100%', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-3-label', landingPage.metric3Label || 'Editable content', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
              { components: [heading('metric-4-value', landingPage.metric4Value || '1', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-4-label', landingPage.metric4Label || 'Lead pipeline', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
            ], '18px'),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-cta-row', 'wellness-cta-row', [
          { components: [
            image('cta-image', `${campaignName} wellness experience`, 'wellness-cta-image'),
          ] },
          { components: [
            heading('cta-title', landingPage.ctaTitle || 'Ready to get started?', 'h3', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('cta-copy', landingPage.ctaCopy || `Invite your visitors to take the next step with a clear, professional experience tailored to ${sectorLabel.toLowerCase()}.`, { align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' }),
            text('cta-note', landingPage.ctaNote || 'Your details will be captured in the CRM and shared with the right team for follow-up.', { align: 'left', color: '#5f6c67', fontSize: '0.86rem', variant: 'wellness-note' }),
            button('cta-button', landingPage.ctaText || 'Book Now', '#lead-form', { bgColor: '#b31d15', color: '#ffffff', align: 'left', size: 'medium' }),
          ] },
        ], '18px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-form-row', 'wellness-form-row', [
          { components: [
            text('form-kicker', 'Lead capture', { align: 'left', color: '#b31d15', fontSize: '0.76rem', variant: 'wellness-eyebrow' }),
            text('form-copy', landingPage.formCopy || 'Fill out the form below and the team will follow up with confirmation and next steps.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-body' }),
            form(),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-footer-row', 'wellness-footer-row', [
          { components: [
            text('footer-brand-mark', landingPage.brandMark || '+', { align: 'left', color: '#b31d15', fontSize: '1.4rem', variant: 'wellness-logo-mark', icon: 'leaf' }),
            heading('footer-brand-name', landingPage.brandLine || businessName, 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-footer-brand' }),
            text('footer-links', landingPage.footerLinks || 'Home | Services | About Us | Contact', { align: 'left', color: '#5f6c67', fontSize: '0.84rem', variant: 'wellness-footer-links' }),
          ] },
          { components: [
            text('footer-contact', landingPage.footerContact || '+91 98765 43210\ninfo@company.com\nKoramangala, Bengaluru', { align: 'left', color: '#5f6c67', fontSize: '0.84rem', variant: 'wellness-footer-contact', whiteSpace: 'pre-line' }),
            text('footer-copy', landingPage.footerCopy || `(c) ${new Date().getFullYear()} ${businessName}. All rights reserved.`, { align: 'right', color: '#7b807a', fontSize: '0.78rem', variant: 'wellness-footer-copy' }),
          ] },
        ], '18px'),
      ] },
    ], '24px', { themeId: wellnessTheme, layoutId: wellnessLayout, customColors: landingPage.wellnessCustomColors || landingPage.customColors || undefined, customBaseThemeId: landingPage.wellnessCustomBaseThemeId || undefined }),
  ];
}

function tplStr(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ""
  );
}

function travelBlockId(prefix) {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

const WELLNESS_SYMBOL_ICONS = {
  '+': 'eye',
  o: 'person',
  ':)': 'users',
  '#': 'document',
};

const WELLNESS_DETAIL_ICONS = {
  date: 'calendar',
  time: 'clock',
  location: 'location',
  for: 'users',
};

const WELLNESS_NAV_TARGETS = {
  home: 'wellness-home',
  services: 'wellness-services',
  service: 'wellness-services',
  about: 'wellness-about',
  'about us': 'wellness-about',
  contact: 'wellness-contact',
};

const WELLNESS_ICON_PATHS = {
  barChart: '<path d="M4 19V5M4 19h16M8 16v-4m4 4V8m4 8V4"/><path d="M7 12h2m2-4h2m2-4h2"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M8 10h8M8 14h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  document: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  leaf: '<path d="M20.5 3.5C13 3.7 6.4 6.8 5.2 12.2c-.8 3.7 1.9 6.2 5.2 5.7 5.2-.8 8.8-6.2 10.1-14.4Z"/><path d="M4 21c2.4-4.2 6-7.3 11-9.5"/>',
  location: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  person: '<circle cx="12" cy="7" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  sparkles: '<path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3ZM19 16l.6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="3"/><path d="M17 8a3 3 0 0 1 0 6M21 21v-2a4 4 0 0 0-3-3.9"/>',
};

function getWellnessIconName(props = {}) {
  const variant = props.variant || '';
  const text = String(props.text || '').trim();
  if (props.icon && WELLNESS_ICON_PATHS[props.icon]) return props.icon;
  if (variant === 'wellness-badge') return WELLNESS_SYMBOL_ICONS[text] || '';
  if (variant === 'wellness-detail-label') {
    const detailText = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (WELLNESS_DETAIL_ICONS[detailText]) return WELLNESS_DETAIL_ICONS[detailText];
    if (detailText.includes('date')) return 'calendar';
    if (detailText.includes('time')) return 'clock';
    if (detailText.includes('location') || detailText.includes('venue')) return 'location';
    if (detailText === 'for' || detailText.includes('audience') || detailText.includes('attend')) return 'users';
  }
  if (variant === 'wellness-logo-mark' && text === '+') return 'leaf';
  return '';
}

function wellnessIconSvg(name, className = 'wellness-icon') {
  const icon = WELLNESS_ICON_PATHS[name] ? name : 'sparkles';
  return `<svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${WELLNESS_ICON_PATHS[icon]}</svg>`;
}

function getWellnessNavItems(value) {
  const text = String(value || '').trim();
  const tokens = text
    .split(/\s{2,}|\s*\|\s*|\s*[·•]\s*|\s*,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const items = tokens.length > 1 ? tokens : ['Home', 'Services', 'About Us', 'Contact']
    .filter((label) => new RegExp(`\\b${label.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text));
  return (items.length ? items : ['Home', 'Services', 'About Us', 'Contact']).map((label) => ({
    label,
    target: WELLNESS_NAV_TARGETS[label.toLowerCase()] || '',
  }));
}

function renderWellnessNav(props) {
  const align = escapeHtml(props.align || 'right');
  const fontSize = escapeHtml(props.fontSize || '0.82rem');
  const items = getWellnessNavItems(props.text);
  const links = items.map((item) => item.target
    ? `<a href="#${item.target}">${escapeHtml(item.label)}</a>`
    : `<span>${escapeHtml(item.label)}</span>`).join('');
  return `<nav class="landing-text landing-text--wellness-nav wellness-nav" aria-label="Wellness campaign navigation" style="color:var(--wellness-muted, #63766b);text-align:${align};font-size:${fontSize};">${links}</nav>`;
}

// Render a "?? ?? ?? ?? " / null-safe pricing cell. AI never emits monetary values; if
// the operator left the value blank, the rendered cell still has visual
// weight via the dashed placeholder + "Pricing TBD" label.
function renderPricingValue(amount, currency) {
  if (amount == null || amount === "") {
    return `<div class="t-tier-amount t-tier-amount--empty" aria-label="Pricing to be configured">Pricing TBD</div>`;
  }
  const sym = escapeHtml(currency || "INR");
  return `<div class="t-tier-amount">${sym}${escapeHtml(String(amount))}</div>`;
}

function renderComponent(component, slug, options = {}) {
  const { type, props = {} } = component;

  switch (type) {
    case "heading": {
      const level = props.level || "h1";
      const align = props.align || "left";
      const color = props.color || "#1a1a1a";
      const variant = props.variant || "";
      const variantClass = variant.replace(/[^a-z0-9_-]/gi, '-');
      let extra = "";
      let finalColor = color;
      if (variant === "wellness-logo") extra = "font-size:0.90rem;text-transform:uppercase;letter-spacing:0.08em;font-weight:800;margin:0;line-height:1;";
      else if (variant === "wellness-display") extra = "font-size:clamp(2rem,5vw,3.4rem);line-height:1.05;font-weight:800;margin:0 0 16px;";
      else if (variant === "wellness-section-title" || variant === "wellness-card-title") extra = `font-size:${variant === "wellness-card-title" ? "1.25rem" : "1.35rem"};font-weight:800;margin:0 0 10px;`;
      else if (variant === "wellness-metric-value") extra = "font-size:clamp(1.15rem,1.4vw,1.85rem);line-height:1.08;font-weight:900;margin:0 0 8px;max-width:100%;min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:normal;text-shadow:0 2px 16px rgba(0,0,0,0.28);";
      if (variant === "wellness-metric-value" || variant === "wellness-band-title" || variant.startsWith("wellness-footer")) finalColor = "var(--wellness-inverse, #ffffff)";
      else if (variant === "wellness-hero-accent") finalColor = "var(--wellness-primary, #2f6b50)";
      else if (variant.startsWith("wellness-")) finalColor = "var(--wellness-ink, #173b35)";
      return `<${level} class="landing-heading landing-heading--${variantClass}" style="color:${finalColor};text-align:${align};margin:0 0 16px;${extra}">${escapeHtml(props.text || "")}</${level}>`;
    }

    case "text": {
      const align = props.align || "left";
      const color = props.color || "#444";
      const fontSize = props.fontSize || "16px";
      const variant = props.variant || "";
      const variantClass = variant.replace(/[^a-z0-9_-]/gi, '-');
      if (variant === "wellness-nav") return renderWellnessNav(props);
      let extra = "";
      let finalColor = color;
      if (variant === "wellness-nav") extra = "text-transform:uppercase;letter-spacing:0.16em;font-weight:700;margin:0;line-height:1;";
      else if (variant === "wellness-brand-subline") extra = "margin:0;line-height:1;letter-spacing:0.02em;";
      else if (variant === "wellness-eyebrow") extra = "text-transform:uppercase;letter-spacing:0.14em;font-weight:700;margin:0 0 14px;";
      else if (variant === "wellness-detail") extra = "margin:0 0 10px;line-height:1.45;";
      else if (variant === "wellness-metric-label") { extra = "margin:0;max-width:100%;min-width:0;font-weight:700;line-height:1.35;overflow-wrap:anywhere;"; finalColor = "var(--wellness-inverse, #ffffff)"; }
      else if (variant === "wellness-band-copy") { extra = "max-width:580px;line-height:1.55;overflow-wrap:anywhere;"; finalColor = "color-mix(in srgb, var(--wellness-inverse, #ffffff) 90%, transparent)"; }
      else if (variant === "wellness-footer") { extra = "margin:0;padding:22px 24px;background:transparent;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;"; finalColor = "var(--wellness-inverse, #ffffff)"; }
      else if (variant.startsWith("wellness-footer")) finalColor = "var(--wellness-inverse, #ffffff)";
      else if (variant === "wellness-eyebrow" || variant === "wellness-badge") finalColor = "var(--wellness-primary, #2f6b50)";
      else if (variant.startsWith("wellness-")) finalColor = "var(--wellness-muted, #63766b)";
      const iconName = getWellnessIconName(props);
      if (variant === "wellness-logo-mark" && String(props.text || "").trim() === "+" && !iconName) return "";
      const style = `color:${finalColor};text-align:${align};font-size:${fontSize};line-height:1.6;margin:0 0 16px;${extra}`;
      if (iconName && (variant === "wellness-badge" || variant === "wellness-logo-mark")) {
        return `<span class="landing-text landing-text--${variantClass}" aria-label="${variant === "wellness-badge" ? "Wellness benefit" : "Wellness brand"}" style="${style}">${wellnessIconSvg(iconName)}</span>`;
      }
      const textContent = iconName && variant === "wellness-detail-label"
        ? `<span class="wellness-detail-label-content"><span class="wellness-detail-icon">${wellnessIconSvg(iconName)}</span><span>${escapeHtml(props.text || "")}</span></span>`
        : escapeHtml(props.text || "");
      return `<p class="landing-text landing-text--${variantClass}" style="${style}">${textContent}</p>`;
    }

    case "image": {
      const width = props.width || "100%";
      const maxWidth = props.maxWidth || "100%";
      const alt = escapeHtml(props.alt || "");
      const isWellnessEventImage = props.variant === "wellness-event-image";
      const isWellnessHeroImage = props.variant === "wellness-hero-image";
      const isWellnessGalleryImage = props.variant === "wellness-gallery-image";
      const isWellnessCtaImage = props.variant === "wellness-cta-image";
      if (isWellnessHeroImage || isWellnessGalleryImage || isWellnessCtaImage) {
        const src = safeUrl(props.src, 'image-src');
        const imageMarkup = src
          ? `<img src="${escapeHtml(src)}" alt="${alt}" />`
          : `<span class="wellness-media-placeholder" aria-label="Campaign image will appear here">${isWellnessHeroImage ? 'Wellness campaign' : isWellnessGalleryImage ? 'Your campaign story' : 'Wellness experience'}</span>`;
        const mediaClass = isWellnessHeroImage ? 'wellness-media--hero' : isWellnessGalleryImage ? 'wellness-media--gallery' : 'wellness-media--cta';
        return `<figure class="wellness-media ${mediaClass}">${imageMarkup}</figure>`;
      }
      const wrapperMargin = isWellnessEventImage ? "0" : "0 0 16px";
      const height = isWellnessEventImage ? "height:360px;object-fit:cover;" : "height:auto;";
      const radius = isWellnessEventImage ? "18px" : "8px";
      const border = isWellnessEventImage ? "border:1px solid #d8d2c3;background:#f4f1e8;box-shadow:0 18px 45px rgba(31,47,44,0.12);" : "";
      return `<div style="text-align:center;margin:${wrapperMargin};"><img src="${escapeHtml(safeUrl(props.src, 'image-src'))}" alt="${alt}" style="width:${width};max-width:${maxWidth};${height}border-radius:${radius};${border}" /></div>`;
    }

    case "button": {
      const color = props.color || "#ffffff";
      const bgColor = props.bgColor || "#2563eb";
      const align = props.align || "center";
      const size = props.size || "medium";
      const isWellnessCta = ["#b31d15", "#fff8f7"].includes(String(bgColor).toLowerCase()) || String(props.url || "").startsWith("#event-details");
      const href = isWellnessCta ? "#lead-form" : props.url;
      const padding = size === "large" ? "16px 40px" : size === "small" ? "8px 20px" : "12px 32px";
      const fontSize = size === "large" ? "18px" : size === "small" ? "13px" : "15px";
      // #447: <a href="javascript:..."> DOES execute. safeUrl strips the
      // dangerous schemes and falls back to "#" if input fails the allowlist.
      return `<div style="text-align:${align};margin:${isWellnessCta ? "0" : "0 0 16px"};"><a href="${escapeHtml(safeUrl(href, 'link-href'))}" style="display:inline-block;padding:${padding};background:${bgColor};color:${color};text-decoration:none;border-radius:6px;font-size:${fontSize};font-weight:600;cursor:pointer;">${escapeHtml(props.text || "Click")}</a></div>`;
    }

    case "form": {
      const fields = props.variant === "wellness-consultation"
        ? getWellnessFormFields(props.fields)
        : (props.fields || []);
      const submitText = escapeHtml(props.submitText || "Submit");
      const thankYouMessage = escapeHtml(props.thankYouMessage || "Thank you for your submission!");
      const formId = "form_" + Math.random().toString(36).substr(2, 8);
      const isWellnessForm = props.variant === "wellness-consultation";
      const domFormId = isWellnessForm ? "lead-form" : formId;
      const controlStyle = isWellnessForm
        ? "width:100%;padding:14px 16px;border:1px solid var(--wellness-border,#d7e2d0);border-radius:10px;font-size:15px;box-sizing:border-box;background:var(--wellness-bg,#f7fbf4);background-color:var(--wellness-bg,#f7fbf4);color:var(--wellness-ink,#173b2c);opacity:1;color-scheme:light;-webkit-text-fill-color:var(--wellness-ink,#173b2c);"
        : "width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:15px;box-sizing:border-box;background:#ffffff;background-color:#ffffff;color:#1f2937;opacity:1;color-scheme:light;-webkit-text-fill-color:#1f2937;";
      const labelStyle = isWellnessForm
        ? "display:block;margin-bottom:8px;font-weight:700;color:var(--wellness-muted,#63766b);font-size:12px;letter-spacing:0.12em;text-transform:uppercase;"
        : "display:block;margin-bottom:4px;font-weight:500;color:#333;font-size:14px;";
      let fieldsHtml = fields
        .map((f) => {
          const req = f.required ? "required" : "";
          const inputType = f.type || "text";
          const label = escapeHtml(f.label || f.name);
          const requiredMark = f.required && isWellnessForm ? " *" : "";
          const name = escapeHtml(f.name);
          const placeholder = escapeHtml(f.placeholder || "");
          const fieldShellStyle = isWellnessForm
            ? `margin-bottom:18px;flex:${fields.indexOf(f) < 2 ? "1 1 calc(50% - 8px)" : "1 1 100%"};min-width:${fields.indexOf(f) < 2 ? "0" : "100%"};box-sizing:border-box;`
            : "margin-bottom:12px;";
          if (inputType === "textarea") {
            return `<div style="${fieldShellStyle}"><label style="${labelStyle}">${label}${requiredMark}</label><textarea name="${name}" ${req} placeholder="${placeholder}" rows="4" style="${controlStyle}resize:vertical;min-height:98px;"></textarea></div>`;
          }
          if (inputType === "select") {
            const options = (f.options || []).map((option) => `<option value="${escapeHtml(String(option))}">${escapeHtml(String(option))}</option>`).join("");
            return `<div style="${fieldShellStyle}"><label style="${labelStyle}">${label}${requiredMark}</label><select name="${name}" ${req} style="${controlStyle}">${options}</select></div>`;
          }
          return `<div style="${fieldShellStyle}"><label style="${labelStyle}">${label}${requiredMark}</label><input type="${escapeHtml(inputType) }" name="${name}" ${req} placeholder="${placeholder}" style="${controlStyle}" /></div>`;
        })
        .join("\n");

      const enableCaptcha = !!props.enableCaptcha;
      const turnstileSiteKey =
        props.turnstileSiteKey ||
        process.env.TURNSTILE_SITE_KEY ||
        "1x00000000000000000000AA";
      const captchaScript = enableCaptcha
        ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
        : "";
      const captchaHtml = enableCaptcha
        ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}" data-callback="${formId}_onTurnstile" style="margin:0 0 12px;"></div>`
        : "";

      let successRedirectUrl = "";
      if (typeof props.successRedirectUrl === "string" && props.successRedirectUrl.length > 0) {
        try {
          const u = new URL(props.successRedirectUrl);
          if (u.protocol === "http:" || u.protocol === "https:") successRedirectUrl = props.successRedirectUrl;
        } catch (_e) {
          successRedirectUrl = "";
        }
      }

      const successJs = successRedirectUrl
        ? `window.location.assign(${JSON.stringify(successRedirectUrl)});`
        : `form.querySelector("button[type=submit]").style.display = "none";
            var fields = form.querySelectorAll("div > label, div > input, div > textarea, div > select");
            fields.forEach(function(el){ el.parentElement.style.display = "none"; });
            document.getElementById("${formId}_thanks").style.display = "block";`;
      const formTitle = props.title ? `<h2 style="margin:0 0 28px;color:var(--wellness-ink,#173b2c);font-family:Georgia,'Times New Roman',serif;font-size:1.75rem;font-weight:600;">${escapeHtml(props.title)}</h2>` : "";
      const formStyle = isWellnessForm
        ? "width:100%;max-width:520px;margin:0 auto 16px;padding:36px;background:var(--wellness-surface,#fffdf8);border-radius:20px;border:1px solid var(--wellness-border,#d7e2d0);border-top:2px solid var(--wellness-primary,#2f6b50);box-shadow:0 18px 55px rgba(23,59,53,0.10);box-sizing:border-box;"
        : "max-width:480px;margin:0 auto 16px;padding:24px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;";
      const buttonStyle = isWellnessForm
        ? "width:100%;padding:16px;background:linear-gradient(135deg,var(--wellness-primary,#2f6b50),var(--wellness-primary-deep,#194a37));color:var(--wellness-inverse,#fff);border:none;border-radius:999px;font-size:15px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;"
        : "width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;";

      return `${captchaScript}<form id="${domFormId}" style="${formStyle}" onsubmit="return false;">
        ${formTitle}
        <div style="${isWellnessForm ? 'display:flex;flex-wrap:wrap;gap:0 16px;' : ''}">${fieldsHtml}</div>
        ${captchaHtml}
        <button type="submit" style="${buttonStyle}">${submitText}</button>
        <div id="${formId}_thanks" style="display:none;text-align:center;padding:16px;color:#16a34a;font-weight:500;">${thankYouMessage}</div>
      </form>
      <script>
      (function(){
        var form = document.getElementById("${domFormId}");
        ${enableCaptcha ? `var turnstileToken = ""; window["${formId}_onTurnstile"] = function(t){ turnstileToken = t; };` : ""}
        form.addEventListener("submit", function(e){
          e.preventDefault();
          var data = {};
          var inputs = form.querySelectorAll("input, textarea, select");
          inputs.forEach(function(inp){ data[inp.name] = inp.value; });
          var phoneInp = form.querySelector('input[type="tel"]');
          if(phoneInp && phoneInp.value.trim()){
            var digits = phoneInp.value.replace(/\\D/g,'');
            if(digits.length < 10 || digits.length > 15){ alert('Please enter a valid phone number (10-15 digits).'); phoneInp.focus(); return; }
          }
          ${enableCaptcha ? `data.cfTurnstileToken = turnstileToken; if (!turnstileToken) { alert("Please complete the CAPTCHA challenge."); return; }` : ""}
          fetch("/p/${escapeHtml(slug)}/submit", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data)
          }).then(function(r){ return r.json(); }).then(function(j){
            if (j && j.error) { alert(j.error); return; }
            ${successJs}
          }).catch(function(){ alert("Something went wrong. Please try again."); });
        });
      })();
      </script>`;
    }

    case "divider": {
      const color = props.color || "#e5e7eb";
      const margin = props.margin || "24px";
      return `<hr style="border:none;border-top:1px solid ${color};margin:${margin} 0;" />`;
    }

    case "spacer": {
      const height = props.height || "32px";
      return `<div style="height:${height};"></div>`;
    }

    case "video": {
      const width = props.width || "100%";
      // Normalise common URL forms (YouTube watch / Shorts / youtu.be,
      // Vimeo bare ID) to the provider's /embed path. Without this,
      // YouTube + Vimeo send X-Frame-Options: SAMEORIGIN on the non-
      // /embed paths and the iframe shows "refused to connect".
      const normalized = normalizeVideoEmbedUrl(props.url);
      // Local uploads AND remote direct video files (Pexels CDN .mp4,
      // S3-served clips, etc.) render as a native <video> control ?? ?? ?? ?? 
      // iframing a raw byte stream triggers X-Frame-Options blocking
      // because the response isn't an HTML document. safeUrl(iframe-src)
      // already accepts http(s) + relative paths so it's the right
      // allowlist for a media src too.
      if (isDirectVideoFile(normalized)) {
        return `<div style="text-align:center;margin:0 0 16px;"><video controls preload="metadata" src="${escapeHtml(safeUrl(normalized, 'iframe-src'))}" style="width:${width};max-width:100%;border-radius:8px;"></video></div>`;
      }
      // #447: iframe-src restricted to http:/https: only. data:/javascript:
      // are rejected and fall back to about:blank (renders an empty frame
      // rather than executing arbitrary HTML).
      return `<div style="text-align:center;margin:0 0 16px;"><iframe src="${escapeHtml(safeUrl(normalized, 'iframe-src'))}" style="width:${width};max-width:100%;aspect-ratio:16/9;border:none;border-radius:8px;" allowfullscreen></iframe></div>`;
    }

    case "columns": {
      const columns = props.columns || [];
      const gap = props.gap || "24px";
      const variant = props.variant || "";
      const isWellnessCampaignPage = variant === "wellness-campaign-page";
      const isWellnessHeaderRow = variant === "wellness-header-row";
      const isWellnessHeroRow = variant === "wellness-hero-row";
      const isWellnessDetailsStrip = variant === "wellness-details-strip";
      const isWellnessGalleryRow = variant === "wellness-gallery-row";
      const isWellnessBenefitsRow = variant === "wellness-benefits-row";
      const isWellnessProcessRow = variant === "wellness-process-row";
      const isWellnessImpactBand = variant === "wellness-impact-band";
      const isWellnessCtaRow = variant === "wellness-cta-row";
      const isWellnessFormRow = variant === "wellness-form-row";
      const isWellnessFooterRow = variant === "wellness-footer-row";
      const isWellnessRegistrationRow = variant === "wellness-registration-row";
      const isWellnessBenefitCards = variant === "wellness-benefit-cards";
      const isWellnessBenefitGrid = variant === "wellness-benefit-grid";
      const isWellnessStepGrid = variant === "wellness-step-grid";
      const isWellnessMetricGrid = variant === "wellness-metric-grid";
      const isWellnessConsultation = variant === "wellness-consultation";
      const looksLikeWellnessSupporting = columns.some((col) => (col.components || []).some((child) => ["why-title", "after-title"].includes(child.id)));
      const isWellnessSupporting = variant === "wellness-supporting" || looksLikeWellnessSupporting;
      const isWellnessCardGrid = isWellnessBenefitGrid || isWellnessStepGrid || isWellnessMetricGrid;
      const isWellnessSection = isWellnessCampaignPage || isWellnessHeaderRow || isWellnessHeroRow || isWellnessDetailsStrip || isWellnessGalleryRow || isWellnessBenefitsRow || isWellnessProcessRow || isWellnessImpactBand || isWellnessCtaRow || isWellnessFormRow || isWellnessFooterRow || isWellnessRegistrationRow || isWellnessBenefitCards || isWellnessCardGrid || isWellnessConsultation || isWellnessSupporting;
      const isWellnessInnerRow = isWellnessHeaderRow || isWellnessHeroRow || isWellnessDetailsStrip || isWellnessGalleryRow || isWellnessBenefitsRow || isWellnessProcessRow || isWellnessCtaRow || isWellnessFormRow || isWellnessFooterRow || isWellnessRegistrationRow || isWellnessBenefitCards || isWellnessCardGrid;
      const hasFullWidthSupport = isWellnessConsultation && columns.some((col) => col.fullWidth);
      const containerStyle = isWellnessCampaignPage
        ? `display:flex;flex-wrap:wrap;gap:${gap};align-items:stretch;width:100%;max-width:none;min-width:0;margin:0;padding:0;background:#fbfaf4;color:#1f2f2c;border-radius:0;border:none;box-shadow:none;box-sizing:border-box;overflow:visible;`
        : `display:flex;flex-wrap:wrap;gap:${gap};align-items:${isWellnessHeaderRow ? "flex-start" : (isWellnessFooterRow || isWellnessFormRow ? "center" : "stretch")};justify-content:${isWellnessHeaderRow ? "space-between" : (isWellnessFooterRow || isWellnessFormRow ? "center" : "flex-start")};width:${isWellnessDetailsStrip ? "calc(100% - 112px)" : "100%"};max-width:${isWellnessSection ? "100%" : "none"};margin:${isWellnessDetailsStrip ? "0 56px 34px" : isWellnessInnerRow ? "0" : (isWellnessConsultation && !hasFullWidthSupport ? "0 auto 0" : (isWellnessSection ? "0 auto 24px" : "0 0 20px 0"))};padding:${isWellnessHeaderRow ? "6px 56px 4px" : isWellnessHeroRow ? "64px 56px 58px" : isWellnessDetailsStrip ? "22px 24px" : isWellnessGalleryRow ? "18px 56px 36px" : isWellnessBenefitsRow ? "34px 56px 32px" : isWellnessProcessRow ? "28px 56px 36px" : isWellnessImpactBand ? "32px 56px" : isWellnessCtaRow ? "28px 56px" : isWellnessFormRow ? "72px 56px 76px" : isWellnessFooterRow ? "40px 56px" : isWellnessRegistrationRow ? "28px 64px 56px" : isWellnessBenefitCards || isWellnessCardGrid ? "0" : (isWellnessSection ? (isWellnessConsultation ? "36px" : "0 56px 36px") : "0")};background:${isWellnessImpactBand ? "linear-gradient(90deg, var(--wellness-primary-deep, #126052) 0%, var(--wellness-primary, #1f8a70) 100%)" : isWellnessMetricGrid ? "transparent" : isWellnessFormRow ? "var(--wellness-surface-soft, #e8f4ee)" : isWellnessFooterRow ? "var(--wellness-surface, #ffffff)" : (isWellnessHeaderRow ? "var(--wellness-surface, #ffffff)" : (isWellnessInnerRow || isWellnessConsultation || isWellnessSupporting ? "var(--wellness-bg, #f4fbf7)" : "transparent"))};color:${isWellnessImpactBand ? "#ffffff" : (isWellnessSection ? "var(--wellness-ink, #173b35)" : "inherit")};border-radius:${isWellnessHeaderRow ? "0" : isWellnessDetailsStrip ? "16px" : (isWellnessImpactBand ? "0" : isWellnessConsultation ? (hasFullWidthSupport ? "18px" : "18px 18px 0 0") : (isWellnessSupporting ? "0 0 18px 18px" : "0"))};border:${isWellnessDetailsStrip ? "1px solid var(--wellness-border, #cfe3d9)" : "none"};border-top:${isWellnessFooterRow ? "1px solid var(--wellness-border, #cfe3d9)" : "none"};border-bottom:${isWellnessHeaderRow ? "1px solid var(--wellness-border, #cfe3d9)" : "none"};box-shadow:${isWellnessDetailsStrip ? "0 18px 45px rgba(23,59,53,0.08)" : (isWellnessImpactBand ? "inset 0 1px 0 rgba(255,255,255,0.18)" : "none")};box-sizing:border-box;overflow:visible;`;
      const colsHtml = columns
        .map((col, idx) => {
          let flex = col.fullWidth ? "1 1 100%" : "1 1 0";
          if (isWellnessHeaderRow) flex = idx === 0 ? "0 0 360px" : "1 1 auto";
          if (isWellnessHeroRow) flex = idx === 1 ? "0 1 560px" : "1 1 0";
          if (isWellnessDetailsStrip) flex = "1 1 0";
          if (isWellnessBenefitsRow) flex = idx === 0 ? "0 1 360px" : "1 1 0";
          if (isWellnessProcessRow) flex = idx === 0 ? "0 1 360px" : "1 1 0";
          if (isWellnessImpactBand) flex = idx === 0 ? "0 1 360px" : "1 1 0";
          if (isWellnessGalleryRow) flex = "1 1 0";
          if (isWellnessCtaRow) flex = idx === 0 ? "1 1 0" : "0 1 280px";
          if (isWellnessFormRow) flex = columns.length === 1 ? "0 1 560px" : (idx === 0 ? "0 1 520px" : "1 1 520px");
          if (isWellnessFooterRow) flex = "1 1 300px";
          if (isWellnessBenefitCards) flex = "1 1 100%";
          if (isWellnessCardGrid) flex = isWellnessMetricGrid ? "1 1 220px" : "1 1 0";
          if (isWellnessConsultation && idx === 1) flex = "0 1 480px";
          const cardStyle = isWellnessHeaderRow ? (idx === 0 ? "padding:0;background:transparent;border:none;border-radius:0;box-shadow:none;justify-content:flex-start;align-items:flex-start;text-align:left;" : "padding:0;background:transparent;border:none;border-radius:0;box-shadow:none;justify-content:flex-end;align-items:flex-start;text-align:right;") : isWellnessDetailsStrip ? "padding:30px 34px;min-height:154px;background:transparent;border:0;border-radius:0;box-shadow:none;justify-content:center;align-items:center;text-align:left;overflow-wrap:anywhere;" : isWellnessMetricGrid ? "padding:28px 22px;min-height:132px;background:linear-gradient(180deg,var(--wellness-primary-deep, #126052),var(--wellness-primary, #1f8a70));border:1px solid rgba(255,255,255,0.36);border-radius:18px;box-shadow:0 18px 36px rgba(23,59,53,0.24);justify-content:center;align-items:center;text-align:center;color:#ffffff;" : (isWellnessBenefitCards || isWellnessCardGrid || isWellnessSupporting) ? "padding:24px;background:var(--wellness-surface, #ffffff);border:1px solid var(--wellness-border, #cfe3d9);border-radius:14px;box-shadow:0 14px 35px rgba(23,59,53,0.07);justify-content:flex-start;" : isWellnessGalleryRow ? "padding:0;background:transparent;border:none;border-radius:0;box-shadow:none;justify-content:stretch;" : "padding:0;background:transparent;border:none;border-radius:0;box-shadow:none;";
          const minWidth = col.fullWidth ? "100%" : (isWellnessHeaderRow ? (idx === 0 ? "280px" : "0") : isWellnessHeroRow ? (idx === 1 ? "420px" : "500px") : (isWellnessDetailsStrip || isWellnessGalleryRow) ? "0" : isWellnessBenefitsRow ? (idx === 0 ? "360px" : "360px") : isWellnessProcessRow ? (idx === 0 ? "360px" : "320px") : isWellnessImpactBand ? (idx === 0 ? "320px" : "0") : isWellnessCardGrid ? "0" : isWellnessFormRow ? (columns.length === 1 ? "420px" : (idx === 0 ? "420px" : "420px")) : isWellnessCtaRow ? (idx === 0 ? "320px" : "240px") : isWellnessRegistrationRow ? (idx === 0 ? "540px" : "360px") : isWellnessSection ? "240px" : "260px");
          const heroButtons = isWellnessHeroRow ? (col.components || []).filter((c) => c?.type === "button") : [];
          const preferredHeroButton = heroButtons.find((buttonBlock) => buttonBlock.id === "hero-primary-cta") || heroButtons[0];
          const visibleComponents = isWellnessHeroRow && heroButtons.length > 1
            ? (col.components || []).filter((c) => c?.type !== "button" || c === preferredHeroButton)
            : (col.components || []);
          const innerHtml = visibleComponents.map((c) => renderComponent(c, slug, options)).join("\n");
          const direction = isWellnessHeaderRow && idx === 1 ? "row" : "column";
          const headerWrap = isWellnessHeaderRow && idx === 1 ? "flex-wrap:nowrap;justify-content:space-between;align-items:flex-start;width:100%;" : (isWellnessFooterRow ? `align-items:${idx === 0 ? "flex-start" : idx === columns.length - 1 ? "flex-end" : "center"};text-align:${idx === 0 ? "left" : idx === columns.length - 1 ? "right" : "center"};` : "");
          return `<div style="flex:${flex};min-width:${minWidth};max-width:100%;box-sizing:border-box;display:flex;flex-direction:${direction};gap:${isWellnessHeaderRow ? "8px" : isWellnessBenefitCards ? "10px" : "16px"};${headerWrap}${cardStyle}">${innerHtml}</div>`;
        })
        .join("\n");
      const wellnessThemeStyle = isWellnessCampaignPage && options.wellnessTheme
        ? `--wellness-bg:${options.wellnessTheme.bg};--wellness-surface:${options.wellnessTheme.surface};--wellness-surface-soft:${options.wellnessTheme.surfaceSoft};--wellness-ink:${options.wellnessTheme.ink};--wellness-muted:${options.wellnessTheme.muted};--wellness-primary:${options.wellnessTheme.primary};--wellness-primary-deep:${options.wellnessTheme.primaryDeep};--wellness-accent:${options.wellnessTheme.accent};--wellness-accent-soft:${options.wellnessTheme.accentSoft};--wellness-border:${options.wellnessTheme.border};--wellness-inverse:${options.wellnessTheme.inverse};`
        : '';
      const wellnessVariantClass = variant.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      const wellnessLayoutClass = isWellnessCampaignPage
        ? ` wellness-campaign--${String(props.layoutId || 'editorial').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`
        : '';
      const wellnessClass = isWellnessCampaignPage
        ? `wellness-shell wellness-layout wellness-layout--${wellnessVariantClass}${wellnessLayoutClass}`
        : isWellnessSection
          ? `wellness-layout wellness-layout--${wellnessVariantClass}`
          : '';
      const wellnessAnchorId = isWellnessCampaignPage
        ? 'wellness-home'
        : isWellnessBenefitsRow
          ? 'wellness-services'
          : isWellnessProcessRow
            ? 'wellness-about'
            : isWellnessFormRow || isWellnessRegistrationRow
              ? 'wellness-contact'
              : '';
      const anchorAttr = wellnessAnchorId ? ` id="${wellnessAnchorId}"` : '';
      return `<div${anchorAttr} class="${wellnessClass}" style="${containerStyle}${wellnessThemeStyle}">${colsHtml}</div>`;
    }

    // ?? ?? ?? ?? ?? ?? ?? ??  Travel destination blocks ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? 
    // Visual quality parity with the hardcoded Japan /trips page is
    // provided by the shared travel CSS file auto-injected when the
    // page's templateType === "travel_destination". These cases emit
    // semantic markup keyed on the `.t-*` class system; they do NOT
    // inline styles ?? ?? ?? ??  every spacing / palette / typography decision
    // lives in the CSS file so designers can iterate without rebuilding
    // the renderer.

    case "destinationHero": {
      const destination = escapeHtml(props.destination || "");
      const headline = escapeHtml(props.headline || "");
      const subhead = escapeHtml(props.subhead || "");
      const posterUrl = props.posterUrl
        ? escapeHtml(safeUrl(props.posterUrl, "image-src"))
        : "";
      const ctaText = escapeHtml(props.ctaText || "Reserve Your Spot");
      const ctaScrollTarget = escapeHtml(props.ctaScrollTarget || "");
      const palette = props.palette || {};
      const bg = escapeHtml(palette.bg || "#1f1a17");
      const fg = escapeHtml(palette.fg || "#ffffff");
      const accent = escapeHtml(palette.accent || "#b8893b");
      const countdownTo = props.countdownTo || null;
      const wrapperId = travelBlockId("hero");

      const posterStyle = posterUrl
        ? `background-image:linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.65)),url('${posterUrl}');`
        : `background:${bg};`;

      // Countdown markup is rendered server-side with placeholder zeros;
      // the inline script ticks every 1s. If countdownTo is null we
      // simply omit the timer block entirely.
      const countdownBlock = countdownTo
        ? `<div class="t-hero-countdown" id="${wrapperId}_cd" data-target="${escapeHtml(countdownTo)}">
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="d">--</span><span class="t-cd-lbl">Days</span></div>
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="h">--</span><span class="t-cd-lbl">Hours</span></div>
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="m">--</span><span class="t-cd-lbl">Min</span></div>
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="s">--</span><span class="t-cd-lbl">Sec</span></div>
          </div>`
        : "";

      const tmcParentRegistrationUrl = options.tmcParentRegistrationUrl || props.tmcParentRegistrationUrl || "";
      const ctaAttr = tmcParentRegistrationUrl
        ? `href="${escapeHtml(safeUrl(tmcParentRegistrationUrl, "link-href"))}"`
        : ctaScrollTarget
        ? `onclick="document.getElementById('${ctaScrollTarget}')?.scrollIntoView({behavior:'smooth'});return false;" href="#${ctaScrollTarget}"`
        : `href="#"`;

      const countdownScript = countdownTo
        ? tplStr(
            `<script>(function(){
              var root=document.getElementById('{{id}}_cd');
              if(!root)return;
              var target=new Date(root.dataset.target).getTime();
              if(isNaN(target))return;
              function pad(n){return String(n).padStart(2,'0');}
              function tick(){
                var diff=Math.max(0,target-Date.now());
                var d=Math.floor(diff/86400000);
                var h=Math.floor(diff/3600000)%24;
                var m=Math.floor(diff/60000)%60;
                var s=Math.floor(diff/1000)%60;
                var cells=root.querySelectorAll('[data-unit]');
                cells.forEach(function(c){
                  if(c.dataset.unit==='d')c.textContent=pad(d);
                  if(c.dataset.unit==='h')c.textContent=pad(h);
                  if(c.dataset.unit==='m')c.textContent=pad(m);
                  if(c.dataset.unit==='s')c.textContent=pad(s);
                });
              }
              tick();setInterval(tick,1000);
            })();</script>`,
            { id: wrapperId }
          )
        : "";

      return `<section class="t-hero" style="--t-hero-fg:${fg};--t-hero-accent:${accent};${posterStyle}">
        <div class="t-wrap t-hero-inner">
          ${destination ? `<span class="t-tag t-hero-tag">${destination}</span>` : ""}
          ${headline ? `<h1 class="t-hero-headline">${headline}</h1>` : ""}
          ${subhead ? `<p class="t-hero-subhead">${subhead}</p>` : ""}
          ${countdownBlock}
          <a class="t-cta t-hero-cta" ${ctaAttr}>${ctaText}</a>
        </div>
        ${countdownScript}
      </section>`;
    }

    case "cityCards": {
      const title = escapeHtml(props.title || "");
      const subtitle = escapeHtml(props.subtitle || "");
      const cards = Array.isArray(props.cards) ? props.cards : [];
      const cardsHtml = cards
        .map((c) => {
          const tag = escapeHtml(c.tag || "");
          const cTitle = escapeHtml(c.title || "");
          const body = escapeHtml(c.body || "");
          // PR-C: optional cultural-depth pull-quote. AI-generated content
          // can populate this to surface "what this city teaches" without
          // making the body unwieldy. Closes the CULTURAL_HIGHLIGHTS
          // parity gap from TRAVEL_LANDING_PAGE_PARITY_GAPS.md.
          const benefit = escapeHtml(c.benefit || "");
          const img = c.img ? escapeHtml(safeUrl(c.img, "image-src")) : "";
          const imgBlock = img
            ? `<div class="t-city-img" style="background-image:url('${img}')"></div>`
            : `<div class="t-city-img t-city-img--empty" aria-label="Add a city image"><span>City image</span></div>`;
          return `<article class="t-city-card">
            ${imgBlock}
            <div class="t-city-card-body">
              ${tag ? `<span class="t-tag">${tag}</span>` : ""}
              ${cTitle ? `<h3 class="t-city-title">${cTitle}</h3>` : ""}
              ${body ? `<p class="t-city-body t-muted">${body}</p>` : ""}
              ${benefit ? `<p class="t-city-benefit"><span class="t-city-benefit-label">DERIVED BENEFIT</span><em>?? ?? ?? ?? ${benefit}?? ?? ?? ?? </em></p>` : ""}
            </div>
          </article>`;
        })
        .join("\n");
      return `<section class="t-section t-cities">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-city-grid">${cardsHtml}</div>
        </div>
      </section>`;
    }

    case "highlightsGrid": {
      const title = escapeHtml(props.title || "");
      const subtitle = escapeHtml(props.subtitle || "");
      const items = Array.isArray(props.items) ? props.items : [];
      const cellsHtml = items
        .map((it) => {
          const icon = escapeHtml(it.icon || "?? ?? ?? ?? ?? ");
          const iTitle = escapeHtml(it.title || "");
          const body = escapeHtml(it.body || "");
          return `<div class="t-highlight">
            <div class="t-highlight-icon" aria-hidden="true">${icon}</div>
            ${iTitle ? `<h4 class="t-highlight-title">${iTitle}</h4>` : ""}
            ${body ? `<p class="t-highlight-body t-muted">${body}</p>` : ""}
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-highlights">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-highlight-grid">${cellsHtml}</div>
        </div>
      </section>`;
    }

    case "inclusionsGrid": {
      const title = escapeHtml(props.title || "What's Included");
      const subtitle = escapeHtml(props.subtitle || "");
      const items = Array.isArray(props.items) ? props.items : [];
      const itemsHtml = items
        .map((s) => `<li class="t-inclusion-item"><span class="t-check" aria-hidden="true">?? ?? ?? ?? </span><span>${escapeHtml(String(s || ""))}</span></li>`)
        .join("\n");
      return `<section class="t-section t-inclusions">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <ul class="t-inclusion-list">${itemsHtml}</ul>
        </div>
      </section>`;
    }

    case "itineraryTimeline": {
      const title = escapeHtml(props.title || "Day-by-day");
      const subtitle = escapeHtml(props.subtitle || "");
      const days = Array.isArray(props.days) ? props.days : [];
      const daysHtml = days
        .map((d) => {
          const dayNum = Number.isFinite(d.day) ? Number(d.day) : "";
          const dTitle = escapeHtml(d.title || "");
          // PR-C: optional per-day icon (single character, displayed in
          // the day marker) and secondary notes line (italic, below the
          // bullets ?? ?? ?? ??  used for things like "Optional evening activity"
          // or "Free time at this location"). Both empty by default.
          const icon = escapeHtml(d.icon || "");
          const notes = escapeHtml(d.notes || "");
          const bullets = Array.isArray(d.bullets) ? d.bullets : [];
          const bulletsHtml = bullets
            .map((b) => `<li>${escapeHtml(String(b || ""))}</li>`)
            .join("\n");
          // Marker content: icon takes precedence if present (matches the
          // /trips cultural-highlights icon-per-day visual). Otherwise
          // shows the day number as before.
          const markerInner = icon
            ? `<span class="t-day-icon" aria-hidden="true">${icon}</span>`
            : `<span class="t-day-num">${escapeHtml(String(dayNum))}</span>`;
          return `<li class="t-day">
            <div class="t-day-marker">${markerInner}</div>
            <div class="t-day-body">
              ${dTitle ? `<h4 class="t-day-title">${dTitle}</h4>` : ""}
              ${bulletsHtml ? `<ul class="t-day-bullets">${bulletsHtml}</ul>` : ""}
              ${notes ? `<p class="t-day-notes"><em>${notes}</em></p>` : ""}
            </div>
          </li>`;
        })
        .join("\n");
      return `<section class="t-section t-itinerary">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <ol class="t-day-list">${daysHtml}</ol>
        </div>
      </section>`;
    }

    case "tierPricing": {
      const title = escapeHtml(props.title || "Investment");
      const subtitle = escapeHtml(props.subtitle || "");
      const currency = props.currency || "INR";
      const tiers = Array.isArray(props.tiers) ? props.tiers : [];
      const tiersHtml = tiers
        .map((t) => {
          const step = Number.isFinite(t.step) ? Number(t.step) : "";
          const label = escapeHtml(t.label || "");
          const subLabel = escapeHtml(t.subtitle || "");
          const dueDate = escapeHtml(t.dueDate || "");
          const vendor = escapeHtml(t.vendor || "");
          const tag = escapeHtml(t.tag || "");
          // PR-C: optional prominent badge (e.g. "Most Popular", "Early
          // Bird", "Recommended"). Visually distinct from `tag` ?? ?? ?? ?? 
          // sits ABOVE the tier card, ribbon-style. AI never fills this;
          // operator selects from a small allowlist in the builder.
          const badge = escapeHtml(t.badge || "");
          const tierClass = badge ? "t-tier t-tier--badged" : "t-tier";
          return `<div class="${tierClass}">
            ${badge ? `<span class="t-tier-badge">${badge}</span>` : ""}
            <div class="t-tier-step">Step ${escapeHtml(String(step))}</div>
            ${label ? `<h4 class="t-tier-label">${label}</h4>` : ""}
            ${subLabel ? `<div class="t-tier-sublabel t-muted">${subLabel}</div>` : ""}
            ${renderPricingValue(t.amount, currency)}
            ${dueDate ? `<div class="t-tier-due">Due: ${dueDate}</div>` : ""}
            ${vendor ? `<div class="t-tier-vendor">${vendor}</div>` : ""}
            ${tag ? `<span class="t-tier-tag">${tag}</span>` : ""}
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-pricing">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-tier-grid">${tiersHtml}</div>
        </div>
      </section>`;
    }

    case "faqAccordion": {
      const title = escapeHtml(props.title || "Frequently Asked Questions");
      const subtitle = escapeHtml(props.subtitle || "");
      const categories = Array.isArray(props.categories) ? props.categories : [];
      const faqs = Array.isArray(props.faqs) ? props.faqs : [];
      const wrapId = travelBlockId("faq");

      const catBar = categories.length
        ? `<div class="t-faq-cats" role="tablist">${categories
            .map(
              (c) =>
                `<button type="button" class="t-faq-cat" data-cat="${escapeHtml(c.id || "all")}" role="tab">
                  <span class="t-faq-cat-icon" aria-hidden="true">${escapeHtml(c.icon || "?? ?? ?? ?? ")}</span>
                  <span>${escapeHtml(c.label || "")}</span>
                </button>`
            )
            .join("\n")}</div>`
        : "";

      const faqsHtml = faqs
        .map((f) => {
          const cat = escapeHtml(f.cat || "");
          const q = escapeHtml(f.q || "");
          const a = escapeHtml(f.a || "");
          return `<details class="t-faq" data-cat="${cat}">
            <summary class="t-faq-q">
              <span>${q}</span>
              <span class="t-faq-icon" aria-hidden="true">+</span>
            </summary>
            <div class="t-faq-a">${a}</div>
          </details>`;
        })
        .join("\n");

      const faqScript = `<script>(function(){
        var root=document.getElementById('${wrapId}');
        if(!root)return;
        var buttons=root.querySelectorAll('.t-faq-cat');
        var items=root.querySelectorAll('.t-faq');
        var active='all';
        buttons.forEach(function(b){
          b.addEventListener('click',function(){
            active=b.dataset.cat||'all';
            buttons.forEach(function(x){x.classList.toggle('is-active',x===b);});
            items.forEach(function(it){
              var c=it.dataset.cat||'';
              it.style.display=(active==='all'||c===active)?'':'none';
            });
          });
        });
        if(buttons[0])buttons[0].classList.add('is-active');
      })();</script>`;

      return `<section class="t-section t-faqs" id="${wrapId}">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          ${catBar}
          <div class="t-faq-list">${faqsHtml}</div>
        </div>
        ${faqScript}
      </section>`;
    }

    case "reviewCarousel": {
      // Manual-only block. AI generator MUST emit zero of these ?? ?? ?? ??  the
      // landing-page guardrail strips any AI-emitted review block. This
      // renderer treats whatever the operator typed as authoritative.
      const title = escapeHtml(props.title || "What People Say");
      const subtitle = escapeHtml(props.subtitle || "");
      const reviews = Array.isArray(props.reviews) ? props.reviews : [];
      const reviewsHtml = reviews
        .map((r) => {
          const initial = escapeHtml(String(r.initial || (r.name || "?").slice(0, 1)).toUpperCase());
          const name = escapeHtml(r.name || "");
          const text = escapeHtml(r.text || "");
          return `<figure class="t-review">
            <div class="t-review-avatar" aria-hidden="true">${initial}</div>
            <blockquote class="t-review-text">${text}</blockquote>
            ${name ? `<figcaption class="t-review-name">${name}</figcaption>` : ""}
          </figure>`;
        })
        .join("\n");
      return `<section class="t-section t-reviews">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-review-grid">${reviewsHtml}</div>
        </div>
      </section>`;
    }

    // ?? ?? ?? ?? ?? ?? ?? ??  PR-C: new travel blocks ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? 

    case "travelVideo": {
      // Operator-added block. URL comes either from (a) a YouTube /
      // Vimeo / Wistia paste ?? ?? ?? ??  normalised to the provider's /embed
      // path so X-Frame-Options doesn't block the render ?? ?? ?? ??  or (b) an
      // upload via POST /api/landing-pages/upload-video, which lands
      // at /api/uploads/landing-page-videos/tenant-<id>/<file> and
      // renders as a native <video> control.
      const title = escapeHtml(props.title || "");
      const subtitle = escapeHtml(props.subtitle || "");
      const normalized = normalizeVideoEmbedUrl(props.url);
      const safeFrameUrl = normalized ? escapeHtml(safeUrl(normalized, "iframe-src")) : "";
      const aspectRatio = props.aspectRatio === "9:16" ? "9 / 16"
        : props.aspectRatio === "4:3" ? "4 / 3"
        : "16 / 9";
      let frame;
      if (!safeFrameUrl) {
        frame = `<div class="t-video-empty" aria-label="Add a YouTube, Vimeo, Wistia embed URL or upload an MP4"
             style="width:100%;aspect-ratio:${aspectRatio};border-radius:6px;">
             <span>Paste a video URL or upload an MP4</span>
           </div>`;
      } else if (isDirectVideoFile(normalized)) {
        frame = `<video controls preload="metadata" src="${safeFrameUrl}"
             style="width:100%;aspect-ratio:${aspectRatio};border-radius:6px;background:#000;"
             title="${title || 'Uploaded video'}"></video>`;
      } else {
        frame = `<iframe src="${safeFrameUrl}" allowfullscreen loading="lazy"
             style="width:100%;aspect-ratio:${aspectRatio};border:none;border-radius:6px;"
             title="${title || 'Video preview'}"></iframe>`;
      }
      return `<section class="t-section t-video-block">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-video-frame">${frame}</div>
        </div>
      </section>`;
    }

    case "safetyFeatures": {
      // Distinct from highlightsGrid ?? ?? ?? ??  same data shape (icon/title/body
      // items) but rendered dark-on-light to mirror the /trips SAFETY
      // section. AI can populate this with generic descriptive content
      // (e.g. "Travel insurance included", "Pre-vetted accommodations")
      // ?? ?? ?? ??  operator-specific ratios / claims stay in the operator's edit.
      const title = escapeHtml(props.title || "Engineered for Safety");
      const subtitle = escapeHtml(props.subtitle || "");
      const items = Array.isArray(props.items) ? props.items : [];
      const cellsHtml = items
        .map((it) => {
          const icon = escapeHtml(it.icon || "?? ?? ?? ?? ?? ");
          const iTitle = escapeHtml(it.title || "");
          const body = escapeHtml(it.body || "");
          return `<div class="t-safety-item">
            <div class="t-safety-icon" aria-hidden="true">${icon}</div>
            ${iTitle ? `<h4 class="t-safety-title">${iTitle}</h4>` : ""}
            ${body ? `<p class="t-safety-body">${body}</p>` : ""}
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-safety">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-section-sub">${subtitle}</p>` : ""}
          <div class="t-safety-grid">${cellsHtml}</div>
        </div>
      </section>`;
    }

    case "brochureDownload": {
      // Closes the brochure-CTA gap from the parity audit. Two modes:
      //   - fileUrl set: button is a direct download link to the PDF
      //   - fileUrl null: button opens the optional lead-capture form;
      //     submission redirects to the file. Form fields default to
      //     name/email/phone but operator can edit.
      // AI emits this as a shell (fileUrl: null, form fields: default).
      // Operator uploads the brochure PDF via the existing
      // /api/landing-pages/upload endpoint and pastes the URL into
      // `fileUrl`.
      const title = escapeHtml(props.title || "Download the Brochure");
      const subtitle = escapeHtml(props.subtitle || "");
      const ctaText = escapeHtml(props.ctaText || "Get the Brochure");
      const fileUrl = props.fileUrl ? escapeHtml(safeUrl(props.fileUrl, "link-href")) : "";
      const blockId = travelBlockId("broch");

      // When a fileUrl is present we render a simple download button.
      // When absent, we render an inline form so visitors can request
      // the brochure (lead-capture). The form posts to the same submit
      // endpoint used by the generic form block.
      if (fileUrl) {
        return `<section class="t-section t-brochure">
          <div class="t-wrap t-narrow t-center">
            ${title ? `<h2>${title}</h2>` : ""}
            ${subtitle ? `<p class="t-muted t-section-sub">${subtitle}</p>` : ""}
            <a class="t-cta t-brochure-cta" href="${fileUrl}" target="_blank" rel="noopener" download>${ctaText}</a>
          </div>
        </section>`;
      }
      const fields = Array.isArray(props.formFields) && props.formFields.length > 0
        ? props.formFields
        : [
            { label: "Full name", name: "name", type: "text", required: true },
            { label: "Email", name: "email", type: "email", required: true },
            { label: "Phone", name: "phone", type: "tel", required: false },
          ];
      const fieldsHtml = fields
        .map((f) => {
          const req = f.required ? "required" : "";
          return `<div class="t-broch-field">
            <label>${escapeHtml(f.label || f.name)}${f.required ? ' *' : ''}</label>
            <input type="${escapeHtml(f.type || 'text')}" name="${escapeHtml(f.name)}" ${req} />
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-brochure">
        <div class="t-wrap t-narrow t-center">
          ${title ? `<h2>${title}</h2>` : ""}
          ${subtitle ? `<p class="t-muted t-section-sub">${subtitle}</p>` : ""}
          <form id="${blockId}" class="t-brochure-form" onsubmit="return false;">
            ${fieldsHtml}
            <button type="submit" class="t-cta">${ctaText}</button>
            <div id="${blockId}_thanks" class="t-brochure-thanks" style="display:none;">Thank you ?? ?? ?? ??  check your email for the brochure.</div>
          </form>
        </div>
        <script>(function(){
          var form=document.getElementById('${blockId}');
          if(!form)return;
          form.addEventListener('submit',function(e){
            e.preventDefault();
            var data={brochureRequest:true};
            form.querySelectorAll('input').forEach(function(i){data[i.name]=i.value;});
            var brPhoneInp=form.querySelector('input[type="tel"]');
            if(brPhoneInp&&brPhoneInp.value.trim()){var d=brPhoneInp.value.replace(/\\D/g,'');if(d.length<10||d.length>15){alert('Please enter a valid phone number (10?? ?? ?? ?? 15 digits).');brPhoneInp.focus();return;}}
            fetch('/p/${escapeHtml(slug)}/submit',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify(data)
            }).then(function(r){return r.json();}).then(function(){
              form.querySelectorAll('input, button').forEach(function(el){el.style.display='none';});
              document.getElementById('${blockId}_thanks').style.display='block';
            }).catch(function(){alert('Something went wrong. Please try again.');});
          });
        })();</script>
      </section>`;
    }

    case "registrationForm": {
      // Travel registration form with audience presets (TMC / RFU /
      // Travel Stall / Visa Sure / Inquiry / Custom). Field shape is
      // owned by backend/lib/travelRegistrationPresets.js; this case
      // just renders whatever `props.fields` array the operator
      // currently has ?? ?? ?? ??  the preset only seeds defaults at insert-time
      // in the builder.
      //
      // Submission flow matches brochureDownload: posts to the same
      // /p/<slug>/submit endpoint, which honours per-form
      // leadRoutingRuleId + enableCaptcha + audience tagging.
      //
      // Phase 6 - when props.mode === "registration-draft" the inline
      // submit script wraps the form values in `fields:` (which the
      // backend's handleRegistrationDraft expects) and follows
      // response.redirect.url on success. Non-draft blocks keep the
      // original "show thank-you message" behaviour.
      const title = escapeHtml(props.title || "Register your interest");
      const subtitle = escapeHtml(props.subtitle || "");
      const submitText = escapeHtml(props.submitText || "Submit");
      const audience = escapeHtml(props.audience || "inquiry");
      const subBrand = props.subBrand ? escapeHtml(props.subBrand) : "";
      const isDraftMode = props.mode === "registration-draft";
      const blockId = travelBlockId("reg");
      const fields = Array.isArray(props.fields) && props.fields.length > 0
        ? props.fields
        : (getRegistrationPreset(props.audience) || getRegistrationPreset("inquiry")).fields;
      const fieldsHtml = fields
        .map((f) => {
          const req = f.required ? "required" : "";
          const name = escapeHtml(f.name || "");
          const label = escapeHtml(f.label || f.name || "");
          const type = escapeHtml(f.type || "text");
          return `<div class="t-reg-field">
            <label for="${blockId}_${name}">${label}${f.required ? ' *' : ''}</label>
            <input id="${blockId}_${name}" type="${type}" name="${name}" ${req} />
          </div>`;
        })
        .join("\n");
      const thanksMsg = escapeHtml(props.thankYouMessage || "Thank you ?? ?? ?? ??  we will be in touch shortly.");
      return `<section class="t-section t-reg">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-section-sub">${subtitle}</p>` : ""}
          <form id="${blockId}" class="t-reg-form" onsubmit="return false;" data-audience="${audience}"${subBrand ? ` data-sub-brand="${subBrand}"` : ""}${isDraftMode ? ' data-mode="registration-draft"' : ""}>
            <input type="hidden" name="audience" value="${audience}" />
            ${subBrand ? `<input type="hidden" name="subBrand" value="${subBrand}" />` : ""}
            ${fieldsHtml}
            <button type="submit" class="t-cta t-reg-submit">${submitText}</button>
            <div id="${blockId}_thanks" class="t-reg-thanks" style="display:none;">${thanksMsg}</div>
          </form>
        </div>
        <script>(function(){
          var form=document.getElementById('${blockId}');
          if(!form)return;
          var isDraft=${isDraftMode ? "true" : "false"};
          form.addEventListener('submit',function(e){
            e.preventDefault();
            var data={registrationForm:true};
            form.querySelectorAll('input').forEach(function(i){if(i.name)data[i.name]=i.value;});
            var regPhoneInp=form.querySelector('input[type="tel"]');
            if(regPhoneInp&&regPhoneInp.value.trim()){var d=regPhoneInp.value.replace(/\\D/g,'');if(d.length<10||d.length>15){alert('Please enter a valid phone number (10-15 digits).');regPhoneInp.focus();return;}}
            // Phase 6 - registration-draft mode wraps values in
            // a fields object so handleRegistrationDraft can
            // pluck student_name / parent_phone / etc. out of the
            // expected shape. Audience + subBrand stay at top level
            // so pickFormFromContent can still disambiguate the form
            // block. Lead-capture mode keeps the original flat shape.
            var body=isDraft
              ? Object.assign({},data,{fields:data,mode:'registration-draft'})
              : data;
            fetch('/p/${escapeHtml(slug)}/submit',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify(body)
            }).then(function(r){return r.json().then(function(j){return{status:r.status,body:j};});}).then(function(resp){
              if(resp.body && resp.body.error){alert(resp.body.error);return;}
              // Phase 6 - when the backend returns a microsite redirect
              // (registration-draft path), navigate there. The URL
              // carries only the opaque draftToken; no PII leaks via
              // Query string. Fallback when no redirect is present: show the
              // thank-you panel.
              var redirect=resp.body && resp.body.redirect;
              if(redirect && redirect.type==='customer-registration' && redirect.url){
                window.location.assign(redirect.url);
                return;
              }
              form.querySelectorAll('input, button').forEach(function(el){el.style.display='none';});
              var thanksEl=document.getElementById('${blockId}_thanks');
              if(thanksEl){
                if(redirect && redirect.type==='thanks' && resp.body.message){
                  thanksEl.textContent=resp.body.message;
                }
                thanksEl.style.display='block';
              }
            }).catch(function(){alert('Something went wrong. Please try again.');});
          });
        })();</script>
      </section>`;
    }

    case "contactFooter": {
      // Bottom-of-page contact strip ?? ?? ?? ??  phone, email, optional CTA. AI
      // emits this as a shell (phone: null, email: null) because phone
      // and email are operator-specific. The structural ctaText can be
      // AI-generated; the operator types in the real phone/email/url.
      const brandName = escapeHtml(props.brandName || "");
      const phone = props.phone ? String(props.phone).trim() : "";
      const email = props.email ? String(props.email).trim() : "";
      const ctaText = escapeHtml(props.ctaText || "");
      const ctaUrl = props.ctaUrl ? escapeHtml(safeUrl(props.ctaUrl, "link-href")) : "";
      // Phone display is escaped + the tel: link uses a digits-only
      // version so a "+91 99-12345" display value still produces a
      // dial-able tel: URL.
      const phoneHref = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "";
      return `<footer class="t-section t-contact-footer">
        <div class="t-wrap t-center">
          ${brandName ? `<div class="t-contact-brand">${brandName}</div>` : ""}
          <div class="t-contact-row">
            ${phone ? `<a class="t-contact-link" href="${escapeHtml(phoneHref)}">${escapeHtml(phone)}</a>` : `<span class="t-contact-empty">[Add phone]</span>`}
            <span class="t-contact-sep" aria-hidden="true">?? ?? ?? </span>
            ${email ? `<a class="t-contact-link" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : `<span class="t-contact-empty">[Add email]</span>`}
          </div>
          ${ctaText && ctaUrl ? `<a class="t-cta t-contact-cta" href="${ctaUrl}">${ctaText}</a>` : ""}
        </div>
      </footer>`;
    }

    default:
      return "";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Travel CSS is loaded once at module init from a sibling file and
// inlined into every travel_destination render. The file is checked into
// the repo (see landingPageRenderer.travel.css) so visual quality is a
// source-controlled artifact, not an env-time concern.
const fs = require("fs");
const path = require("path");
let _TRAVEL_CSS_CACHE = null;
function loadTravelCss() {
  if (_TRAVEL_CSS_CACHE !== null) return _TRAVEL_CSS_CACHE;
  try {
    _TRAVEL_CSS_CACHE = fs.readFileSync(
      path.join(__dirname, "landingPageRenderer.travel.css"),
      "utf8"
    );
  } catch (_e) {
    // Fail-soft: in dev/CI where the file might be missing, ship a
    // minimal fallback that at least gives semantic structure.
    _TRAVEL_CSS_CACHE = "";
  }
  return _TRAVEL_CSS_CACHE;
}

function isTravelDestinationPage(landingPage, components) {
  if (landingPage && landingPage.templateType === "travel_destination") return true;
  // Defensive: a page may have travel blocks even without the
  // templateType marker (e.g. a generic page the user augmented). If any
  // block is a travel block, ship the CSS so it renders correctly.
  const TRAVEL_TYPES = new Set([
    "destinationHero",
    "cityCards",
    "highlightsGrid",
    "inclusionsGrid",
    "itineraryTimeline",
    "tierPricing",
    "faqAccordion",
    "reviewCarousel",
    // PR-C additions
    "travelVideo",
    "safetyFeatures",
    "brochureDownload",
    "contactFooter",
    "registrationForm",
  ]);
  return Array.isArray(components) && components.some((c) => c && TRAVEL_TYPES.has(c.type));
}

function renderPage(landingPage, options = {}) {
  // ?? ?? ?? ?? ?? ?? ?? ??  Phase D1 ?? ?? ?? ??  template-driven travel microsite dispatch ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? 
  //
  // If the page's templateType matches a registered template id, the
  // semantic-payload template renderer takes over. The content for
  // these pages is a JSON OBJECT (not array) keyed to template slots.
  //
  // Everything else falls through to the existing block-array path
  // below ?? ?? ?? ??  backwards compatible with every landing page already in
  // the database.
  //
  // Late-required (cycle avoidance ?? ?? ?? ??  the templates require this
  // module for safeUrl).
  //
  // `options.preview` ?? ?? ?? ??  when true, the rendered HTML omits the analytics
  // tracking pixel so operator previews don't inflate `visits` counters.
  // No visual change: the pixel is a 1x1 invisible image. This is the
  // single concession to a "preview-specific" path, scoped to analytics
  // only ?? ?? ?? ??  everything else (CSS / JS / animations / DOM) is identical
  // to production.
  const previewMode = !!options.preview;
  const templates = require("./templates");
  if (templates.isTemplatePage(landingPage)) {
    return templates.renderTemplate(landingPage, {
      preview: previewMode,
      tmcParentRegistrationUrl: options.tmcParentRegistrationUrl || landingPage.tmcParentRegistrationUrl || "",
    });
  }

  const {
    title = "Landing Page",
    slug = "",
    metaTitle,
    metaDescription,
    content,
    cssOverrides,
  } = landingPage;

  let components = [];
  if (content) {
    try {
      components = typeof content === "string" ? JSON.parse(content) : content;
    } catch (_e) {
      components = [];
    }
  }
  // Defensive: if content parsed to a non-array (e.g. a misconfigured
  // page whose templateType doesn't match a registered template but
  // whose content is the new object payload), coerce to empty so
  // `.map` doesn't crash. Phase D1 dispatcher above handles the
  // common case; this guard is the belt-and-braces for misconfig.
  if (!Array.isArray(components)) components = [];
  const isWellnessLandingPage = require('./wellnessLandingThemes').isWellnessLandingPage(landingPage, components);
  if (isWellnessLandingPage && !hasWellnessRoot(components)) {
    components = buildWellnessCampaignPage(landingPage, components);
  }
  if (isWellnessLandingPage) {
    components = normalizeWellnessCampaignComponents(components);
  }

  const wellnessRoot = components.find((block) => block?.type === 'columns' && block.props?.variant === 'wellness-campaign-page');
  const wellnessTheme = isWellnessLandingPage
    ? resolveWellnessLandingTheme(wellnessRoot?.props?.themeId || landingPage.wellnessTheme || landingPage.themeId, wellnessRoot?.props?.customColors || landingPage.wellnessCustomColors)
    : null;
  const wellnessLayout = isWellnessLandingPage
    ? resolveWellnessLandingLayout(wellnessRoot?.props?.layoutId || landingPage.wellnessLayout || landingPage.layoutId)
    : null;
  const wellnessVars = wellnessTheme
    ? Object.entries({
        '--wellness-bg': wellnessTheme.bg,
        '--wellness-surface': wellnessTheme.surface,
        '--wellness-surface-soft': wellnessTheme.surfaceSoft,
        '--wellness-ink': wellnessTheme.ink,
        '--wellness-muted': wellnessTheme.muted,
        '--wellness-primary': wellnessTheme.primary,
        '--wellness-primary-deep': wellnessTheme.primaryDeep,
        '--wellness-accent': wellnessTheme.accent,
        '--wellness-accent-soft': wellnessTheme.accentSoft,
        '--wellness-border': wellnessTheme.border,
        '--wellness-inverse': wellnessTheme.inverse,
      }).map(([key, value]) => `${key}:${value}`).join(';')
    : '';
  const renderOptions = wellnessTheme ? { ...options, wellnessTheme, wellnessLayout } : options;
  const bodyHtml = components.map((c) => renderComponent(c, slug, renderOptions)).join("\n");
  const pageTitle = escapeHtml(metaTitle || title);
  const pageDescription = metaDescription ? `<meta name="description" content="${escapeHtml(metaDescription)}" />` : "";
  const overrides = cssOverrides ? `<style>${cssOverrides}</style>` : "";

  const isTravel = isTravelDestinationPage(landingPage, components);
  const travelCss = isTravel ? `<style>${loadTravelCss()}</style>` : "";
  // Travel pages use the full-bleed `.trips-page` wrapper (no
  // lp-container padding) so the hero / city grids span edge-to-edge.
  const wrapperOpen = isTravel
    ? `<div class="trips-page">`
    : `<div class="lp-container${isWellnessLandingPage ? ' lp-container--wellness' : ''}"${wellnessTheme ? ` style="${wellnessVars}"` : ''}>`;
  const wrapperClose = `</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pageTitle}</title>
  ${pageDescription}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1a1a1a;
      background: #ffffff;
      -webkit-font-smoothing: antialiased;
    }
    .lp-container {
      max-width: 960px;
      margin: 0 auto;
      padding: 40px 24px;
    }
    .lp-container--wellness {
      max-width: none;
      width: 100%;
      padding: 0;
      background: var(--wellness-bg, #f4fbf7);
      overflow-x: hidden;
    }
    img { max-width: 100%; height: auto; }
    input:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
    a:hover { opacity: 0.9; }
    .lp-container--wellness .wellness-shell {
      position: relative;
      isolation: isolate;
      background: var(--wellness-bg, #f4fbf7) !important;
      color: var(--wellness-ink, #173b35) !important;
      overflow: hidden !important;
    }
    .lp-container--wellness .wellness-shell::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 540px;
      z-index: -1;
      pointer-events: none;
      background:
        radial-gradient(circle at 12% 8%, color-mix(in srgb, var(--wellness-accent, #ef9b59) 22%, transparent), transparent 30%),
        radial-gradient(circle at 88% 2%, color-mix(in srgb, var(--wellness-primary, #1f8a70) 20%, transparent), transparent 34%);
    }
    .lp-container--wellness .wellness-shell > div { min-width: 0 !important; }
    .lp-container--wellness .wellness-shell [style*="color:#b31d15"] { color: var(--wellness-primary, #1f8a70) !important; }
    .lp-container--wellness .wellness-shell [style*="color:#1f2f2c"] { color: var(--wellness-ink, #173b35) !important; }
    .lp-container--wellness .wellness-shell [style*="color:#5f6c67"],
    .lp-container--wellness .wellness-shell [style*="color:#4d5d58"],
    .lp-container--wellness .wellness-shell [style*="color:#7b807a"] { color: var(--wellness-muted, #5d746d) !important; }
    .lp-container--wellness .wellness-shell [style*="background:#b31d15"] { background: linear-gradient(135deg, var(--wellness-primary, #1f8a70), var(--wellness-primary-deep, #126052)) !important; }
    .lp-container--wellness .wellness-shell [style*="background:#fff8f7"] { background: var(--wellness-accent-soft, #fff0df) !important; }
    .lp-container--wellness .wellness-media {
      position: relative;
      overflow: hidden;
      margin: 0;
      border: 1px solid var(--wellness-border, #cfe3d9);
      background: linear-gradient(145deg, var(--wellness-primary-deep, #126052), var(--wellness-primary, #1f8a70) 58%, var(--wellness-accent, #ef9b59));
      box-shadow: 0 22px 44px color-mix(in srgb, var(--wellness-primary-deep, #126052) 16%, transparent);
    }
    .lp-container--wellness .wellness-media--hero { min-height: clamp(360px, 43vw, 590px); border-radius: 34px 10px 34px 10px; transform: rotate(1deg); }
    .lp-container--wellness .wellness-media--gallery { min-height: 250px; border-radius: 22px 8px 22px 8px; }
    .lp-container--wellness .wellness-media--cta { min-height: 300px; height: 100%; border-radius: 28px 8px 28px 8px; }
    .lp-container--wellness .wellness-media img { display: block; width: 100%; height: 100%; min-height: inherit; object-fit: cover; transition: transform 700ms cubic-bezier(.2,.7,.2,1); }
    .lp-container--wellness .wellness-media:hover img { transform: scale(1.06); }
    .lp-container--wellness .wellness-media-placeholder { display: grid; place-items: center; min-height: inherit; padding: 2rem; color: rgba(255,255,255,.92); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; text-align: center; }
    @keyframes wellness-float-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
    .lp-container--wellness .wellness-shell > div { animation: wellness-float-in .65s ease both; }
    .lp-container--wellness .wellness-shell > div:nth-child(2) { animation-delay: .06s; }
    .lp-container--wellness .wellness-shell > div:nth-child(3) { animation-delay: .12s; }
    .lp-container--wellness .wellness-shell > div:nth-child(4) { animation-delay: .18s; }
    @media (prefers-reduced-motion: reduce) { .lp-container--wellness .wellness-shell > div { animation: none; } .lp-container--wellness .wellness-media img { transition: none; } }
    /* Wellness campaign layout: full-bleed landing page bands, not a stack of cards. */
    .lp-container--wellness .wellness-shell { display:block !important; width:100% !important; min-width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; }
    .lp-container--wellness .wellness-shell > div { width:100% !important; max-width:none !important; min-width:0 !important; margin:0 !important; padding:0 !important; display:block !important; background:transparent !important; border:0 !important; box-shadow:none !important; }
    .lp-container--wellness .wellness-layout { width:100% !important; max-width:none !important; margin:0 !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; overflow:visible !important; }
    .lp-container--wellness .wellness-layout > div { min-width:0 !important; max-width:none !important; margin:0 !important; background:transparent !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; }
    .lp-container--wellness .wellness-layout--wellness-header-row { display:grid !important; grid-template-columns:minmax(0,1fr) auto !important; align-items:center !important; gap:28px !important; padding:28px clamp(24px,7vw,120px) !important; background:color-mix(in srgb,var(--wellness-surface,#fff) 92%,transparent) !important; border-bottom:1px solid var(--wellness-border,#cfe3d9) !important; }
    .lp-container--wellness .wellness-layout--wellness-header-row > div:first-child { display:flex !important; flex-direction:row !important; align-items:center !important; gap:0 !important; min-width:0 !important; }
    .lp-container--wellness .wellness-layout--wellness-header-row > div:first-child .wellness-brand-subline { display:none !important; }
    .lp-container--wellness .wellness-layout--wellness-header-row > div:first-child .wellness-logo { white-space:nowrap !important; }
    .lp-container--wellness .wellness-layout--wellness-header-row > div:last-child { display:flex !important; flex-direction:row !important; align-items:center !important; justify-content:flex-end !important; gap:clamp(20px,3vw,44px) !important; min-width:0 !important; }
    .lp-container--wellness .wellness-layout--wellness-header-row > div:last-child .wellness-nav { display:flex !important; align-items:center !important; justify-content:flex-end !important; flex-wrap:nowrap !important; gap:clamp(16px,2.2vw,32px) !important; white-space:nowrap !important; word-spacing:normal !important; letter-spacing:.12em !important; }
    .lp-container--wellness .wellness-layout--wellness-header-row > div > div { margin:0 !important; min-width:0 !important; }
    .lp-container--wellness .wellness-layout--wellness-hero-row { display:grid !important; grid-template-columns:minmax(0,.92fr) minmax(360px,.88fr) !important; align-items:center !important; gap:clamp(40px,7vw,120px) !important; min-height:min(780px,calc(100vh - 92px)) !important; padding:clamp(72px,10vw,150px) clamp(24px,8vw,144px) !important; background:radial-gradient(circle at 80% 22%,color-mix(in srgb,var(--wellness-accent,#ef9b59) 24%,transparent),transparent 30%),linear-gradient(120deg,var(--wellness-bg,#f4fbf7),var(--wellness-surface-soft,#e8f4ee)) !important; }
    .lp-container--wellness .wellness-layout--wellness-hero-row > div { justify-content:center !important; }
    .lp-container--wellness .wellness-layout--wellness-hero-row > div:first-child { max-width:720px !important; }
    .lp-container--wellness .wellness-layout--wellness-hero-row .wellness-media--hero { width:100% !important; height:min(620px,48vw) !important; min-height:420px !important; border-radius:36px 36px 36px 110px !important; transform:none !important; box-shadow:0 32px 70px color-mix(in srgb,var(--wellness-primary-deep,#126052) 22%,transparent) !important; }
    .lp-container--wellness .wellness-layout--wellness-details-strip { display:grid !important; grid-template-columns:repeat(4,minmax(0,1fr)) !important; gap:0 !important; padding:0 clamp(24px,8vw,144px) !important; background:var(--wellness-surface,#fff) !important; border-top:1px solid var(--wellness-border,#cfe3d9) !important; border-bottom:1px solid var(--wellness-border,#cfe3d9) !important; }
    .lp-container--wellness .wellness-layout--wellness-details-strip > div { min-height:136px !important; padding:30px 26px !important; justify-content:center !important; border-right:1px solid var(--wellness-border,#cfe3d9) !important; }
    .lp-container--wellness .wellness-layout--wellness-details-strip > div:last-child { border-right:0 !important; }
    .lp-container--wellness .wellness-layout--wellness-gallery-row { display:grid !important; grid-template-columns:minmax(0,1.2fr) repeat(2,minmax(0,.8fr)) !important; gap:20px !important; padding:clamp(58px,8vw,110px) clamp(24px,8vw,144px) !important; background:var(--wellness-surface-soft,#e8f4ee) !important; }
    .lp-container--wellness .wellness-layout--wellness-gallery-row > div { min-height:320px !important; }
    .lp-container--wellness .wellness-layout--wellness-gallery-row .wellness-media--gallery { width:100% !important; height:clamp(280px,28vw,420px) !important; min-height:280px !important; border-radius:26px !important; box-shadow:0 18px 46px color-mix(in srgb,var(--wellness-primary-deep,#126052) 14%,transparent) !important; }
    .lp-container--wellness .wellness-layout--wellness-gallery-row > div:first-child .wellness-media--gallery { height:clamp(360px,36vw,520px) !important; }
    .lp-container--wellness .wellness-layout--wellness-benefits-row,
    .lp-container--wellness .wellness-layout--wellness-process-row { display:grid !important; grid-template-columns:minmax(260px,.62fr) minmax(0,1.38fr) !important; align-items:start !important; gap:clamp(40px,7vw,120px) !important; padding:clamp(70px,9vw,128px) clamp(24px,8vw,144px) !important; }
    .lp-container--wellness .wellness-layout--wellness-benefits-row { background:var(--wellness-surface,#fff) !important; }
    .lp-container--wellness .wellness-layout--wellness-process-row { background:var(--wellness-bg,#f4fbf7) !important; }
    .lp-container--wellness .wellness-layout--wellness-benefit-grid,
    .lp-container--wellness .wellness-layout--wellness-step-grid { display:grid !important; grid-template-columns:repeat(4,minmax(0,1fr)) !important; gap:18px !important; }
    .lp-container--wellness .wellness-layout--wellness-benefit-grid > div,
    .lp-container--wellness .wellness-layout--wellness-step-grid > div { min-height:210px !important; padding:28px !important; background:var(--wellness-bg,#f4fbf7) !important; border:1px solid var(--wellness-border,#cfe3d9) !important; border-radius:22px !important; box-shadow:none !important; }
    .lp-container--wellness .wellness-layout--wellness-step-grid > div { background:var(--wellness-surface,#fff) !important; }
    .lp-container--wellness .wellness-layout--wellness-impact-band { display:grid !important; grid-template-columns:minmax(260px,.72fr) minmax(0,1.28fr) !important; align-items:center !important; gap:clamp(40px,7vw,120px) !important; padding:clamp(58px,8vw,96px) clamp(24px,8vw,144px) !important; background:linear-gradient(120deg,var(--wellness-primary-deep,#126052),var(--wellness-primary,#1f8a70)) !important; color:var(--wellness-inverse,#fff) !important; overflow:hidden !important; }
    .lp-container--wellness .wellness-layout--wellness-impact-band > div { min-width:0 !important; }
    .lp-container--wellness .wellness-layout--wellness-impact-band .landing-heading--wellness-band-title { max-width:620px !important; line-height:1.12 !important; overflow-wrap:anywhere !important; }
    .lp-container--wellness .wellness-layout--wellness-impact-band .landing-text--wellness-band-copy { max-width:580px !important; color:color-mix(in srgb,var(--wellness-inverse,#fff) 90%,transparent) !important; line-height:1.55 !important; overflow-wrap:anywhere !important; }
    .lp-container--wellness .wellness-layout--wellness-impact-band .landing-text--wellness-eyebrow { color:var(--wellness-accent-soft,#fff1d8) !important; }
    .lp-container--wellness .wellness-layout--wellness-metric-grid { display:grid !important; grid-template-columns:repeat(4,minmax(0,1fr)) !important; gap:14px !important; min-width:0 !important; }
    .lp-container--wellness .wellness-layout--wellness-metric-grid > div { min-width:0 !important; width:100% !important; min-height:170px !important; padding:22px 14px !important; background:rgba(255,255,255,.12) !important; border:1px solid rgba(255,255,255,.25) !important; border-radius:18px !important; box-shadow:none !important; box-sizing:border-box !important; overflow-wrap:anywhere !important; }
    .lp-container--wellness .wellness-layout--wellness-metric-grid .landing-heading--wellness-metric-value { width:100% !important; max-width:100% !important; min-width:0 !important; margin:0 0 8px !important; font-size:clamp(1.15rem,1.4vw,1.85rem) !important; line-height:1.08 !important; white-space:normal !important; overflow-wrap:anywhere !important; word-break:normal !important; text-align:center !important; }
    .lp-container--wellness .wellness-layout--wellness-metric-grid .landing-text--wellness-metric-label { width:100% !important; max-width:100% !important; min-width:0 !important; margin:0 !important; color:color-mix(in srgb,var(--wellness-inverse,#fff) 92%,transparent) !important; line-height:1.35 !important; overflow-wrap:anywhere !important; }
    .lp-container--wellness .wellness-layout--wellness-cta-row { display:grid !important; grid-template-columns:minmax(280px,.9fr) minmax(0,1.1fr) !important; align-items:center !important; gap:32px !important; padding:clamp(54px,7vw,88px) clamp(24px,8vw,144px) !important; background:var(--wellness-surface,#fff) !important; }
    .lp-container--wellness .wellness-layout--wellness-cta-row > div:first-child { min-height:300px !important; }
    .lp-container--wellness .wellness-layout--wellness-cta-row > div:last-child { max-width:680px !important; }
    .lp-container--wellness .wellness-layout--wellness-form-row { display:grid !important; grid-template-columns:minmax(320px,.78fr) minmax(0,1.22fr) !important; align-items:start !important; gap:clamp(40px,7vw,120px) !important; padding:clamp(72px,9vw,132px) clamp(24px,8vw,144px) !important; background:var(--wellness-surface-soft,#e8f4ee) !important; }
    .lp-container--wellness .wellness-layout--wellness-form-row > div:first-child { padding:clamp(24px,3vw,46px) !important; background:var(--wellness-surface,#fff) !important; border:1px solid var(--wellness-border,#cfe3d9) !important; border-radius:28px !important; box-shadow:0 22px 60px color-mix(in srgb,var(--wellness-primary-deep,#126052) 12%,transparent) !important; }
    .lp-container--wellness .wellness-layout--wellness-form-row > div:only-child { grid-column:1 / -1 !important; width:min(100%,760px) !important; max-width:760px !important; margin:0 auto !important; }
    .lp-container--wellness .wellness-layout--wellness-form-row #lead-form { margin:0 !important; padding:0 !important; max-width:none !important; background:transparent !important; border:0 !important; box-shadow:none !important; }
    .lp-container--wellness .wellness-layout--wellness-registration-row { display:grid !important; grid-template-columns:minmax(320px,.78fr) minmax(0,1.22fr) !important; align-items:start !important; gap:clamp(40px,7vw,120px) !important; padding:clamp(72px,9vw,132px) clamp(24px,8vw,144px) !important; background:var(--wellness-surface-soft,#e8f4ee) !important; }
    .lp-container--wellness .wellness-layout--wellness-registration-row > div { min-width:0 !important; }
    .lp-container--wellness .wellness-layout--wellness-registration-row > div:first-child { padding:clamp(24px,3vw,46px) !important; background:var(--wellness-surface,#fff) !important; border:1px solid var(--wellness-border,#cfe3d9) !important; border-radius:28px !important; box-shadow:0 22px 60px color-mix(in srgb,var(--wellness-primary-deep,#126052) 12%,transparent) !important; }
    .lp-container--wellness .wellness-layout--wellness-registration-row > div:only-child { grid-column:1 / -1 !important; width:min(100%,760px) !important; max-width:760px !important; margin:0 auto !important; }
    .lp-container--wellness .wellness-layout--wellness-registration-row #lead-form { margin:0 !important; padding:0 !important; max-width:none !important; background:transparent !important; border:0 !important; box-shadow:none !important; }
    .lp-container--wellness .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid { grid-template-columns:repeat(2,minmax(0,1fr)) !important; margin-top:28px !important; }
    .lp-container--wellness .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid > div { min-height:0 !important; padding:22px !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row { display:grid !important; grid-template-columns:1fr 1fr !important; align-items:end !important; gap:40px !important; padding:42px clamp(24px,8vw,144px) !important; background:var(--wellness-ink,#173b35) !important; color:var(--wellness-inverse,#fff) !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row > div:last-child { text-align:right !important; }
     .lp-container--wellness .landing-text--wellness-badge { display:grid !important; place-items:center !important; width:48px !important; height:48px !important; margin:0 0 18px !important; padding:0 !important; border-radius:50% !important; background:var(--wellness-accent-soft,#e2f2e5) !important; color:var(--wellness-primary-deep,#126052) !important; font-size:1.35rem !important; line-height:1 !important; }
     .lp-container--wellness .landing-text--wellness-badge .wellness-icon { width:20px !important; height:20px !important; }
     .lp-container--wellness .landing-text--wellness-logo-mark { display:inline-grid !important; place-items:center !important; width:32px !important; height:32px !important; margin:0 !important; padding:0 !important; line-height:1 !important; }
     .lp-container--wellness .landing-text--wellness-logo-mark .wellness-icon { width:26px !important; height:26px !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip .landing-text--wellness-detail-label { display:flex !important; align-items:center !important; justify-content:center !important; }
     .lp-container--wellness .wellness-detail-label-content { display:inline-flex !important; align-items:center !important; gap:10px !important; }
     .lp-container--wellness .wellness-detail-icon { display:inline-grid !important; place-items:center !important; width:36px !important; height:36px !important; flex:0 0 36px !important; border-radius:50% !important; background:var(--wellness-accent-soft,#e2f2e5) !important; color:var(--wellness-primary-deep,#126052) !important; }
     .lp-container--wellness .wellness-detail-icon .wellness-icon { width:18px !important; height:18px !important; }
     .lp-container--wellness .wellness-layout a[href="#lead-form"] { border-radius:999px !important; font-weight:800 !important; letter-spacing:.06em !important; text-transform:uppercase !important; }

     /* Keep generated and edited wellness pages on one coherent visual system. */
     .lp-container--wellness .wellness-layout--wellness-header-row { min-height:96px !important; padding:24px clamp(24px,6vw,104px) !important; background:var(--wellness-surface,#fffdf8) !important; border-bottom:1px solid var(--wellness-border,#d7e2d0) !important; box-shadow:0 8px 24px color-mix(in srgb,var(--wellness-primary-deep,#194a37) 8%,transparent) !important; }
     .lp-container--wellness .wellness-layout--wellness-header-row > div:first-child { flex:1 1 auto !important; width:auto !important; min-width:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-header-row > div:last-child { flex:0 0 auto !important; width:auto !important; min-width:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-header-row .landing-heading--wellness-logo { font-size:clamp(1rem,1.5vw,1.25rem) !important; line-height:1.25 !important; white-space:normal !important; overflow-wrap:anywhere !important; }
     .lp-container--wellness .wellness-layout--wellness-header-row .landing-heading--wellness-logo,
     .lp-container--wellness .wellness-layout--wellness-header-row .landing-text--wellness-logo-mark { color:var(--wellness-primary-deep,#194a37) !important; }
     .lp-container--wellness .wellness-layout--wellness-header-row .landing-text--wellness-nav { color:var(--wellness-muted,#63766b) !important; display:flex !important; align-items:center !important; justify-content:flex-end !important; flex-wrap:nowrap !important; gap:clamp(16px,2.2vw,32px) !important; font-size:.82rem !important; line-height:1.4 !important; letter-spacing:.12em !important; word-spacing:normal !important; white-space:nowrap !important; }
     .lp-container--wellness .wellness-layout--wellness-header-row .wellness-nav a,
     .lp-container--wellness .wellness-layout--wellness-header-row .wellness-nav span { color:inherit !important; text-decoration:none !important; font-weight:700 !important; }
     .lp-container--wellness .wellness-layout--wellness-header-row .wellness-nav a:hover,
     .lp-container--wellness .wellness-layout--wellness-header-row .wellness-nav a:focus-visible { color:var(--wellness-primary,#2f6b50) !important; text-decoration:none !important; }
     .lp-container--wellness [id^="wellness-"] { scroll-margin-top:24px; }
     .lp-container--wellness .wellness-layout--wellness-hero-row { min-height:min(720px,calc(100vh - 96px)) !important; padding:clamp(58px,7vw,112px) clamp(24px,8vw,144px) !important; }
     .lp-container--wellness .wellness-layout--wellness-hero-row .landing-heading--wellness-display { color:var(--wellness-ink,#173b2c) !important; }
     .lp-container--wellness .wellness-layout--wellness-hero-row .landing-heading--wellness-hero-accent { color:var(--wellness-primary,#2f6b50) !important; }
     .lp-container--wellness .wellness-layout--wellness-hero-row .landing-text--wellness-body,
     .lp-container--wellness .wellness-layout--wellness-hero-row .landing-text--wellness-note { color:var(--wellness-muted,#63766b) !important; }

     .lp-container--wellness .wellness-layout--wellness-details-strip { position:relative !important; z-index:2 !important; display:grid !important; grid-template-columns:repeat(4,minmax(0,1fr)) !important; gap:0 !important; width:min(calc(100% - clamp(48px,8vw,240px)),1816px) !important; margin:0 auto 24px !important; padding:0 !important; overflow:visible !important; background:var(--wellness-surface,#fffdf8) !important; border:1px solid var(--wellness-border,#d7e2d0) !important; border-radius:18px !important; box-shadow:0 18px 42px color-mix(in srgb,var(--wellness-primary-deep,#194a37) 12%,transparent) !important; align-items:stretch !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip > div { display:grid !important; grid-template-columns:80px minmax(0,1fr) !important; grid-template-rows:auto auto !important; column-gap:18px !important; row-gap:6px !important; min-height:154px !important; padding:30px 34px !important; background:transparent !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; align-items:center !important; position:relative !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip > div:not(:last-child)::after { content:''; position:absolute; top:30px; right:0; bottom:30px; width:1px; background:var(--wellness-border,#d7e2d0); }
     .lp-container--wellness .wellness-layout--wellness-details-strip > div > div { display:contents !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip .landing-text--wellness-detail-label { display:contents !important; color:var(--wellness-primary,#2f6b50) !important; font-weight:800 !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip .wellness-detail-label-content { display:contents !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip .wellness-detail-icon { display:inline-grid !important; grid-column:1; grid-row:1 / span 2; align-self:center; justify-self:start; width:80px !important; height:80px !important; flex:0 0 80px !important; background:var(--wellness-accent-soft,#e2f2e5) !important; color:var(--wellness-primary-deep,#126052) !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip .wellness-detail-icon .wellness-icon { width:38px !important; height:38px !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip .wellness-detail-label-content > span:last-child { grid-column:2; grid-row:1; min-width:0; margin:0; color:var(--wellness-primary,#2f6b50); font-size:.78rem; line-height:1.2; font-weight:800; letter-spacing:.08em; text-align:left !important; text-transform:uppercase; white-space:nowrap; justify-self:start; }
     .lp-container--wellness .wellness-layout--wellness-details-strip .landing-heading--wellness-detail-value { grid-column:2; grid-row:2; min-width:0; margin:0 !important; color:var(--wellness-ink,#173b2c) !important; font-size:clamp(1rem,1.1vw,1.35rem) !important; line-height:1.3 !important; text-align:left !important; overflow-wrap:anywhere; justify-self:start; }
     .lp-container--wellness .wellness-layout--wellness-details-strip > div:not(:has(.wellness-detail-icon)) { grid-template-columns:minmax(0,1fr) !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip > div:not(:has(.wellness-detail-icon)) .landing-text--wellness-detail-label { display:block !important; grid-column:1; grid-row:1; margin:0 !important; text-align:left !important; }
     .lp-container--wellness .wellness-layout--wellness-details-strip > div:not(:has(.wellness-detail-icon)) .landing-heading--wellness-detail-value { grid-column:1; grid-row:2; }

     .lp-container--wellness .wellness-layout--wellness-benefits-row { background:linear-gradient(180deg,var(--wellness-surface-soft,#e8f1e5),var(--wellness-bg,#f7fbf4)) !important; border-top:1px solid var(--wellness-border,#d7e2d0) !important; border-bottom:1px solid var(--wellness-border,#d7e2d0) !important; }
     .lp-container--wellness .wellness-layout--wellness-process-row { background:var(--wellness-surface,#fffdf8) !important; }
     .lp-container--wellness .wellness-layout--wellness-gallery-row { background:linear-gradient(135deg,color-mix(in srgb,var(--wellness-surface,#fffdf8) 92%,var(--wellness-accent-soft,#fff1d8)),var(--wellness-surface,#fffdf8)) !important; border-bottom:1px solid var(--wellness-border,#d7e2d0) !important; }
     .lp-container--wellness .wellness-layout--wellness-benefits-row { background:linear-gradient(180deg,color-mix(in srgb,var(--wellness-surface-soft,#e8f1e5) 82%,var(--wellness-primary,#2f6b50)),var(--wellness-bg,#f7fbf4)) !important; }
     .lp-container--wellness .wellness-layout--wellness-benefits-row,
     .lp-container--wellness .wellness-layout--wellness-process-row { align-items:stretch !important; }
     .lp-container--wellness .wellness-layout--wellness-benefits-row > div,
     .lp-container--wellness .wellness-layout--wellness-process-row > div { align-self:stretch !important; min-width:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-benefits-row > div:first-child,
     .lp-container--wellness .wellness-layout--wellness-process-row > div:first-child { padding-top:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-benefits-row > div:last-child,
     .lp-container--wellness .wellness-layout--wellness-process-row > div:last-child { padding-top:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-benefits-row > div:last-child > .wellness-layout--wellness-benefit-grid,
     .lp-container--wellness .wellness-layout--wellness-process-row > div:last-child > .wellness-layout--wellness-step-grid { margin-top:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-benefit-grid > div,
     .lp-container--wellness .wellness-layout--wellness-step-grid > div { background:var(--wellness-surface,#fffdf8) !important; border:1px solid var(--wellness-border,#d7e2d0) !important; box-shadow:0 12px 28px color-mix(in srgb,var(--wellness-primary-deep,#194a37) 8%,transparent) !important; }
     .lp-container--wellness .wellness-layout--wellness-benefit-grid,
     .lp-container--wellness .wellness-layout--wellness-step-grid { background:transparent !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; }
     .lp-container--wellness .wellness-layout--wellness-benefit-grid,
     .lp-container--wellness .wellness-layout--wellness-step-grid { display:grid !important; grid-template-columns:repeat(4,minmax(0,1fr)) !important; gap:16px !important; width:100% !important; }
     .lp-container--wellness .wellness-layout--wellness-benefit-grid > div,
     .lp-container--wellness .wellness-layout--wellness-step-grid > div { width:100% !important; min-width:0 !important; height:100% !important; }
     .lp-container--wellness .landing-heading--wellness-section-title,
     .lp-container--wellness .landing-heading--wellness-card-title { color:var(--wellness-ink,#173b2c) !important; }
     .lp-container--wellness .landing-text--wellness-body,
     .lp-container--wellness .landing-text--wellness-note,
     .lp-container--wellness .landing-text--wellness-card-body,
     .lp-container--wellness .landing-text--wellness-bullet-list { color:var(--wellness-muted,#63766b) !important; }
     .lp-container--wellness .landing-text--wellness-eyebrow,
     .lp-container--wellness .landing-text--wellness-badge,
     .lp-container--wellness .landing-heading--wellness-hero-accent { color:var(--wellness-primary,#2f6b50) !important; }
     .lp-container--wellness a[href="#lead-form"] { background:linear-gradient(135deg,var(--wellness-primary,#2f6b50),var(--wellness-primary-deep,#194a37)) !important; color:var(--wellness-inverse,#fff) !important; border:0 !important; }

     .lp-container--wellness .wellness-layout--wellness-registration-row,
     .lp-container--wellness .wellness-layout--wellness-form-row { background:var(--wellness-surface-soft,#e8f1e5) !important; }
     .lp-container--wellness .wellness-layout--wellness-registration-row > div:first-child,
     .lp-container--wellness .wellness-layout--wellness-form-row > div:first-child { background:var(--wellness-surface,#fffdf8) !important; border-color:var(--wellness-border,#d7e2d0) !important; }
     .lp-container--wellness .wellness-layout--wellness-registration-row .wellness-layout--wellness-step-grid > div,
     .lp-container--wellness .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid > div { background:var(--wellness-surface,#fffdf8) !important; }
     .lp-container--wellness .wellness-layout--wellness-registration-row .wellness-layout--wellness-step-grid,
     .lp-container--wellness .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid { display:grid !important; grid-template-columns:repeat(2,minmax(0,1fr)) !important; gap:16px !important; width:100% !important; margin-top:24px !important; }
     .lp-container--wellness .wellness-layout--wellness-registration-row .wellness-layout--wellness-step-grid > div,
     .lp-container--wellness .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid > div { min-width:0 !important; min-height:170px !important; padding:24px !important; }
     .lp-container--wellness .wellness-layout--wellness-registration-row .landing-heading--wellness-section-title,
     .lp-container--wellness .wellness-layout--wellness-form-row .landing-heading--wellness-section-title { color:var(--wellness-ink,#173b2c) !important; }

     .lp-container--wellness .wellness-layout--wellness-footer-row { grid-template-columns:minmax(0,1fr) minmax(0,1fr) !important; min-height:180px !important; padding:42px clamp(24px,8vw,144px) !important; background:var(--wellness-primary-deep,#194a37) !important; color:var(--wellness-inverse,#fff) !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row .landing-heading,
     .lp-container--wellness .wellness-layout--wellness-footer-row .landing-text { color:var(--wellness-inverse,#fff) !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row .landing-text--wellness-footer-links { color:color-mix(in srgb,var(--wellness-inverse,#fff) 82%,transparent) !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row .landing-text--wellness-footer-contact { color:color-mix(in srgb,var(--wellness-inverse,#fff) 92%,transparent) !important; white-space:pre-line !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row .landing-text--wellness-footer-copy { color:color-mix(in srgb,var(--wellness-inverse,#fff) 68%,transparent) !important; }
     .lp-container--wellness .wellness-media-placeholder { color:var(--wellness-primary-deep,#194a37) !important; background:linear-gradient(135deg,var(--wellness-surface-soft,#e8f1e5),var(--wellness-accent-soft,#fff1d8)) !important; }
     .lp-container--wellness .wellness-media-placeholder { width:100% !important; height:100% !important; min-height:inherit !important; box-sizing:border-box !important; }
     .lp-container--wellness .wellness-media:not(:has(img)) { background:linear-gradient(135deg,var(--wellness-surface-soft,#e8f1e5),var(--wellness-accent-soft,#fff1d8)) !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row > div { min-width:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row > div:first-child { display:flex !important; flex-direction:column !important; gap:8px !important; align-items:flex-start !important; }
     .lp-container--wellness .wellness-layout--wellness-footer-row > div:last-child { display:flex !important; flex-direction:column !important; gap:8px !important; align-items:flex-end !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row > div { min-width:0 !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row > div:last-child { display:flex !important; flex-direction:column !important; align-items:flex-start !important; justify-content:center !important; gap:10px !important; width:100% !important; max-width:680px !important; justify-self:stretch !important; padding:clamp(20px,4vw,48px) 0 !important; background:transparent !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row .landing-heading,
     .lp-container--wellness .wellness-layout--wellness-cta-row .landing-text { max-width:620px !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row { grid-template-columns:minmax(0,1.04fr) minmax(0,.96fr) !important; gap:clamp(38px,6vw,96px) !important; padding:clamp(64px,8vw,112px) clamp(24px,8vw,144px) !important; background:linear-gradient(135deg,var(--wellness-surface,#fffdf8),var(--wellness-surface-soft,#e8f1e5)) !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row > div:first-child { min-height:360px !important; align-self:stretch !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row .wellness-media--cta { width:100% !important; height:min(430px,34vw) !important; min-height:360px !important; border-radius:30px 12px 30px 12px !important; border:1px solid var(--wellness-border,#d7e2d0) !important; box-shadow:0 24px 56px color-mix(in srgb,var(--wellness-primary-deep,#194a37) 16%,transparent) !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row > div:last-child { max-width:620px !important; gap:16px !important; padding:18px 0 !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row .landing-heading--wellness-section-title { margin:0 0 4px !important; color:var(--wellness-ink,#173b2c) !important; font-size:clamp(1.85rem,3vw,2.75rem) !important; line-height:1.08 !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row .landing-text--wellness-body { max-width:560px !important; margin:0 !important; color:var(--wellness-muted,#63766b) !important; font-size:1rem !important; line-height:1.65 !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row .landing-text--wellness-note { max-width:560px !important; margin:2px 0 6px !important; padding:12px 16px !important; color:var(--wellness-primary-deep,#194a37) !important; background:color-mix(in srgb,var(--wellness-accent-soft,#fff1d8) 62%,transparent) !important; border-left:3px solid var(--wellness-accent,#ef9b59) !important; border-radius:0 12px 12px 0 !important; font-size:.88rem !important; line-height:1.5 !important; }
     .lp-container--wellness .wellness-layout--wellness-cta-row a[href="#lead-form"] { display:inline-flex !important; align-items:center !important; justify-content:center !important; width:auto !important; min-height:44px !important; margin:2px 0 0 !important; padding:12px 24px !important; font-size:.78rem !important; line-height:1 !important; letter-spacing:.1em !important; box-shadow:0 12px 24px color-mix(in srgb,var(--wellness-primary-deep,#194a37) 18%,transparent) !important; }

     /* Alternate wellness compositions selected during campaign generation. */
    .lp-container--wellness .wellness-campaign--clinical .wellness-layout--wellness-hero-row { grid-template-columns:minmax(0,.76fr) minmax(360px,1.24fr) !important; background:var(--wellness-surface,#fff) !important; }
    .lp-container--wellness .wellness-campaign--clinical .wellness-layout--wellness-hero-row > div:first-child { order:2; }
    .lp-container--wellness .wellness-campaign--clinical .wellness-layout--wellness-hero-row > div:last-child { order:1; }
    .lp-container--wellness .wellness-campaign--clinical .wellness-media--hero { height:min(560px,42vw) !important; min-height:380px !important; border-radius:20px !important; box-shadow:0 18px 44px color-mix(in srgb,var(--wellness-primary-deep,#126052) 14%,transparent) !important; }
    .lp-container--wellness .wellness-campaign--clinical .wellness-layout--wellness-benefit-grid { grid-template-columns:repeat(4,minmax(0,1fr)) !important; }
    .lp-container--wellness .wellness-campaign--clinical .wellness-layout--wellness-benefit-grid > div { min-height:240px !important; }
    .lp-container--wellness .wellness-campaign--clinical .wellness-layout--wellness-impact-band { background:var(--wellness-primary-deep,#126052) !important; }
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-hero-row { position:relative !important; display:block !important; min-height:min(820px,calc(100vh - 92px)) !important; padding:clamp(110px,14vw,210px) clamp(24px,9vw,160px) !important; background:var(--wellness-primary-deep,#126052) !important; }
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-hero-row::before { content:""; position:absolute; inset:0; z-index:1; pointer-events:none; background:linear-gradient(90deg,color-mix(in srgb,var(--wellness-primary-deep,#126052) 96%,transparent),color-mix(in srgb,var(--wellness-primary-deep,#126052) 62%,transparent) 58%,transparent); }
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-hero-row > div:first-child { position:relative; z-index:2; max-width:720px !important; }
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-hero-row > div:last-child { position:absolute; inset:0; z-index:0; }
    .lp-container--wellness .wellness-campaign--immersive .wellness-media--hero { width:100% !important; height:100% !important; min-height:100% !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; }
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-hero-row h1,
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-hero-row p { color:#fff !important; }
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-hero-row .wellness-media-placeholder { background:linear-gradient(135deg,var(--wellness-primary-deep,#126052),var(--wellness-primary,#1f8a70)); }
    .lp-container--wellness .wellness-campaign--immersive .wellness-layout--wellness-gallery-row { background:var(--wellness-surface,#fff) !important; }
    .lp-container--wellness .wellness-campaign--community .wellness-layout--wellness-hero-row { background:linear-gradient(120deg,var(--wellness-surface-soft,#e8f4ee),var(--wellness-bg,#f4fbf7)) !important; }
    .lp-container--wellness .wellness-campaign--community .wellness-layout--wellness-hero-row > div:first-child { order:2; }
    .lp-container--wellness .wellness-campaign--community .wellness-layout--wellness-hero-row > div:last-child { order:1; }
    .lp-container--wellness .wellness-campaign--community .wellness-media--hero { border-radius:50% 50% 24px 24px !important; transform:none !important; }
    .lp-container--wellness .wellness-campaign--community .wellness-layout--wellness-benefits-row { background:var(--wellness-surface-soft,#e8f4ee) !important; }
    .lp-container--wellness .wellness-campaign--community .wellness-layout--wellness-benefit-grid > div { background:var(--wellness-surface,#fff) !important; border-radius:28px !important; }

    @media (max-width: 640px) {
      .lp-container { padding: 24px 16px; }
      .lp-container--wellness { padding: 0; }
      .lp-container--wellness .wellness-shell > div > div { flex: 1 1 100% !important; min-width: 0 !important; }
      .lp-container--wellness .wellness-media--hero { min-height: 320px; }
      .lp-container--wellness .wellness-media--gallery { min-height: 180px; }
      .lp-container--wellness .wellness-layout--wellness-header-row,
      .lp-container--wellness .wellness-layout--wellness-hero-row,
      .lp-container--wellness .wellness-layout--wellness-benefits-row,
      .lp-container--wellness .wellness-layout--wellness-process-row,
      .lp-container--wellness .wellness-layout--wellness-impact-band,
      .lp-container--wellness .wellness-layout--wellness-form-row,
      .lp-container--wellness .wellness-layout--wellness-registration-row { grid-template-columns:1fr !important; }
      .lp-container--wellness .wellness-layout--wellness-header-row > div:first-child,
      .lp-container--wellness .wellness-layout--wellness-header-row > div:last-child { justify-content:flex-start !important; flex-wrap:wrap !important; row-gap:14px !important; }
      .lp-container--wellness .wellness-layout--wellness-header-row > div:last-child { justify-content:flex-start !important; flex-wrap:wrap !important; }
      .lp-container--wellness .wellness-layout--wellness-header-row .wellness-nav { justify-content:flex-start !important; flex-wrap:wrap !important; gap:12px 18px !important; white-space:normal !important; }
      .lp-container--wellness .wellness-layout--wellness-details-strip { grid-template-columns:1fr !important; }
      .lp-container--wellness .wellness-layout--wellness-details-strip > div { min-height:104px !important; padding:20px 22px !important; }
      .lp-container--wellness .wellness-layout--wellness-details-strip > div:not(:last-child)::after { top:auto; right:22px; bottom:0; left:22px; width:auto; height:1px; }
      .lp-container--wellness .wellness-layout--wellness-details-strip .wellness-detail-icon { width:56px !important; height:56px !important; flex-basis:56px !important; }
      .lp-container--wellness .wellness-layout--wellness-details-strip .wellness-detail-icon .wellness-icon { width:28px !important; height:28px !important; }
      .lp-container--wellness .wellness-layout--wellness-gallery-row { grid-template-columns:1fr !important; }
      .lp-container--wellness .wellness-layout--wellness-gallery-row > div:first-child .wellness-media--gallery,
      .lp-container--wellness .wellness-layout--wellness-gallery-row .wellness-media--gallery { height:260px !important; min-height:220px !important; }
      .lp-container--wellness .wellness-layout--wellness-benefit-grid,
      .lp-container--wellness .wellness-layout--wellness-step-grid,
      .lp-container--wellness .wellness-layout--wellness-metric-grid { grid-template-columns:1fr !important; }
      .lp-container--wellness .wellness-layout--wellness-cta-row,
      .lp-container--wellness .wellness-layout--wellness-footer-row { display:grid !important; grid-template-columns:1fr !important; }
      .lp-container--wellness .wellness-layout--wellness-cta-row > div:first-child { min-height:220px !important; }
      .lp-container--wellness .wellness-media--cta { height:260px !important; min-height:220px !important; border-radius:24px 10px 24px 10px !important; }
      .lp-container--wellness .wellness-layout--wellness-cta-row > div:last-child { gap:14px !important; padding:8px 0 0 !important; }
      .lp-container--wellness .wellness-layout--wellness-cta-row .landing-heading--wellness-section-title { font-size:2rem !important; }
      .lp-container--wellness .wellness-layout--wellness-cta-row a[href="#lead-form"] { padding:11px 20px !important; }
      .lp-container--wellness .wellness-layout--wellness-registration-row > div:only-child { width:100% !important; max-width:760px !important; }
      .lp-container--wellness .wellness-layout--wellness-footer-row > div:last-child { text-align:left !important; }
    }
    @media (max-width: 640px) {
      h1 { font-size: 28px !important; }
      h2 { font-size: 22px !important; }
    }
  </style>
  ${travelCss}
  ${overrides}
</head>
<body>
  ${wrapperOpen}
    ${bodyHtml}
  ${wrapperClose}
  ${previewMode ? '' : `<img src="/api/pages/${escapeHtml(slug)}/track?event=VISIT" width="1" height="1" style="position:absolute;opacity:0;" />`}
</body>
</html>`;
}

module.exports = {
  renderPage,
  buildWellnessCampaignPage,
  safeUrl,
  renderComponent,
  isTravelDestinationPage,
  // Test-only: exposed so vitest can hot-reset the cache between tests.
  _resetTravelCssCache: () => { _TRAVEL_CSS_CACHE = null; },
};






