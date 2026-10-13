import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildWebFormEmbedCode, buildWebFormPreviewUrl, getWebFormPreviewViewportWidth, slugifyWebFormName, textOrBlank } from '../utils/webForms';

describe('webForms helpers', () => {
  test('keeps an explicitly cleared string blank', () => {
    expect(textOrBlank('')).toBe('');
    expect(textOrBlank(null, 'Fallback')).toBe('Fallback');
    expect(textOrBlank(undefined, 'Fallback')).toBe('Fallback');
  });

  test('slugifies a form name for public URLs', () => {
    expect(slugifyWebFormName('EmpMonitor Demo')).toBe('empmonitor-demo');
    expect(slugifyWebFormName('   ')).toBe('web-form');
  });
});

describe('buildWebFormPreviewUrl', () => {
  test('uses representative viewport widths for device previews', () => {
    expect(getWebFormPreviewViewportWidth('desktop')).toBe('100%');
    expect(getWebFormPreviewViewportWidth('tablet')).toBe('768px');
    expect(getWebFormPreviewViewportWidth('mobile')).toBe('440px');
    expect(getWebFormPreviewViewportWidth('unknown')).toBe('100%');
  });

  test('embeds the draft payload for previewing unsaved changes', () => {
    const url = buildWebFormPreviewUrl({ name: 'Draft Form', slug: 'draft-form' }, 'https://crm.example.com');

    expect(url).toContain('https://crm.example.com/embed/web-form.html?previewVersion=');
    expect(url).toContain('#preview=');
    expect(url).toContain(encodeURIComponent('Draft Form'));
  });

  test('preserves Travel scope and preview device in the embedded runtime URL', () => {
    const url = buildWebFormPreviewUrl(
      { name: 'Travel Enquiry', slug: 'travel-enquiry', scope: 'travel' },
      'https://crm.example.com',
      { previewDevice: 'mobile' },
    );
    const parsed = new URL(url);

    expect(parsed.searchParams.get('scope')).toBe('travel');
    expect(parsed.searchParams.get('device')).toBe('mobile');
  });
});

describe('buildWebFormEmbedCode', () => {
  test('builds an iframe snippet and public link for the form slug', () => {
    const code = buildWebFormEmbedCode({ name: 'Contact Us', slug: 'contact-us' }, 'https://crm.example.com');

    expect(code).toContain('https://crm.example.com/embed/web-form.html?slug=contact-us');
    expect(code.match(/https:\/\/crm\.example\.com\/embed\/web-form\.html\?slug=contact-us/g)).toHaveLength(2);
    expect(code).toContain('title="Contact Us"');
    expect(code).toContain('style="width:100%;height:auto;border:0;display:block;"');
    expect(code).toContain('allow="geolocation *"');
    expect(code).not.toContain('min-height:760px');
    expect(code).toContain('source!=="gbs-web-form"');
  });

  test('escapes the iframe title safely', () => {
    const code = buildWebFormEmbedCode({ name: 'Lead <Form>', slug: 'lead-form' }, 'https://crm.example.com');

    expect(code).toContain('title="Lead &lt;Form&gt;"');
  });

  test('prefers the stable numeric id for public links when present', () => {
    const code = buildWebFormEmbedCode({ id: 101, name: 'Contact Us', slug: 'contact-us' }, 'https://crm.example.com');

    expect(code).toContain('https://crm.example.com/embed/web-form.html?id=101');
    expect(code).not.toContain('?slug=contact-us');
  });
});

describe('public web form embed footer', () => {
  test('supports saved custom CSS overrides in the embedded runtime', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');

    expect(builder).toContain('Custom CSS');
    expect(builder).toContain('Apply CSS');
    expect(builder).toContain('customCssDraft');
    expect(builder).toContain('aria-expanded={selection === "customCss"}');
    expect(builder).toContain('height: 360px');
    expect(builder).toContain('> div:first-child:not(.wf-custom-css-editor) > div');
    expect(builder).toContain('> div:first-child:not(.wf-custom-css-editor) > div > button');
    expect(builder).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(html).toContain('gbs-custom-form-css');
    expect(html).toContain('customCss.textContent = sanitizeCustomCss(style.customCss)');
  });

  test('links the powered-by footer to the home page', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('<a href="/" target="_top" rel="noopener noreferrer" aria-label="Go to GlobusCRM home page">Powered By GlobusCRM</a>');
  });

  test('honors the per-form powered-by setting while defaulting it on', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('formData.settings.showPoweredBy === false');
    expect(html).toContain('var footerLink');
    expect(html).toMatch(/footerLink\s*\?[\s\S]*note powered-by/);
  });

  test('combines a searchable country code with phone submissions for every web-form scope', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toMatch(/if\s*\(advanced\s*&&\s*field\.sourceKey\s*===\s*["']phone["']\)/);
    expect(html).toMatch(/field\.fieldType\s*===\s*["']number["']\s*\?\s*["']number["']\s*:\s*["']tel["']/);
    expect(html).toContain('name="phoneCountry"');
    expect(html).toMatch(/\.phone-country-picker\.open\s*\{\s*z-index:\s*40\s*;\s*\}/);
    expect(html).toMatch(/\.phone-country-picker\s*>\s*input:focus\s*\+\s*\.phone-country-options\s*\{\s*display:\s*block\s*;\s*\}/);
    expect(html).toMatch(/options\.style\.display\s*=\s*["']block["']/);
    expect(html).toMatch(/trigger\.addEventListener\(["']keydown["']\s*,\s*openCountryPicker\)/);
    expect(html).toMatch(/trigger\.addEventListener\(["']pointerdown["']/);
    expect(html).toMatch(/allowedCountries\.length\s*>\s*0/);
    expect(html).toMatch(/pickerAllowedCountries\.length\s*>\s*0/);
    expect(html).toMatch(/trigger\.inputMode\s*=\s*["']numeric["']/);
    expect(html).toContain("var numericQuery = trigger.value.replace(/\\D/g, '')");
    expect(html).toMatch(/fd\.set\(["']phone["']\s*,\s*nationalDigits\)/);
    expect(html).toMatch(/if\s*\(\s*advanced\s*&&\s*fd\.get\(["']phone["']\)\s*&&\s*fd\.get\(["']phoneCountry["']\)\s*\)/);
    expect(html).toContain('grid-template-columns: minmax(96px, 24%) minmax(0, 1fr);');
    expect(html).toContain('grid-template-columns: minmax(96px, 24%) minmax(0, 1fr)!important;');
    expect(html).toContain('generic-public-desktop-columns');
    expect(html).toContain('generic-two-columns');
    expect(html).toContain('!isBuilderPreview');
    expect(html).toContain('grid-template-columns: minmax(92px, 34%) minmax(0, 1fr) !important;');
    expect(html).toContain('padding-left: 44px;');
    expect(html).toContain('@media (max-width: 640px)');
  });

  test('renders the Generic CRM phone selector as a single compact control', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('grid-template-columns: 100px minmax(0, 1fr) !important;');
    expect(html).toContain('var(--gbs-phone-country-bg, #eef2f7)');
    expect(html).toMatch(/.phone-country-picker::after/);
    expect(html).toMatch(/.phone-input:focus-within/);
  });

  test('keeps public tablet and mobile layouts aligned with the builder preview', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');
    const desktopRule = html.indexOf('html.generic-public-desktop-columns .grid {');
    const responsiveRule = html.lastIndexOf('html.generic-public-desktop-columns .grid,');

    expect(desktopRule).toBeGreaterThan(-1);
    expect(responsiveRule).toBeGreaterThan(desktopRule);
    expect(html).toContain('@media (min-width: 641px) and (max-width: 900px)');
    expect(html).toContain('grid-template-columns: var(--gbs-tablet-columns, minmax(0, 1fr)) !important;');
    expect(html.slice(responsiveRule)).toContain('grid-template-columns: var(--gbs-mobile-columns, minmax(0, 1fr)) !important;');
    expect(html.slice(responsiveRule)).toContain('grid-column: auto !important;');
    expect(html).toContain('class="field phone-field ');
    expect(html).toContain('@media (max-width: 480px)');
    expect(html).toContain('@media (max-width: 359px)');
    expect(html).toContain('grid-column: 1 / -1 !important;');
    expect(html.slice(responsiveRule)).toContain('grid-template-columns: minmax(68px, 42%) minmax(0, 1fr) !important;');
    expect(html).toContain('html.generic-preview-mobile.generic-scope .phone-input');
    expect(html).toContain('padding: 0 3px 0 34px;');
    expect(html).toContain('.choices.horizontal .check');
    expect(html).toContain('width: fit-content;');
    expect(html).toContain('flex: 0 1 auto;');
    expect(html.slice(responsiveRule)).toContain('overflow-wrap: anywhere;');
  });

  test('sizes the live preview iframe to the selected device viewport', () => {
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');

    expect(builder).toContain('getWebFormPreviewViewportWidth(previewDevice)');
    expect(builder).toContain('min(100%, ${previewViewportWidth})');
    expect(builder).toContain('margin: "0 auto"');
  });

  test('renders the numeric phone control for the default phone field', () => {
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(builder).toContain('{ value: "phone", label: "Phone", fieldType: "number"');
    expect(html).toContain("input[name=\"phone\"]");
  });

  test('keeps the WhatsApp implementation behind the opt-in setting', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('setupGenericWhatsapp');
    expect(html).toContain('name="whatsappSameAsPhone"');
    expect(html).toContain('WhatsApp number is the same as phone number');
    expect(html).toContain("whatsappCountry.name = 'whatsappPhoneCountry'");
    expect(html).toContain('name="whatsappPhone"');
    expect(html).toContain('WhatsApp country code');
    expect(html).toContain('setupGenericWhatsappPhone');
    expect(html).toContain('Enter a valid WhatsApp number with ');
    expect(html).toContain('setupGenericCountryPicker(whatsappCountrySelect');
    expect(html).toContain('.generic-whatsapp-section{display:block;margin-top:8px;padding-left:0}');
    expect(html).toContain('white-space:normal;line-height:1.35;font-weight:var(--gbs-form-weight,400)');
    expect(html).toContain('.generic-whatsapp-phone{margin-bottom:0}');
    expect(html).toContain("phoneField.classList.add('generic-phone-with-whatsapp')");
    expect(html).toContain('generic-whatsapp-number');
    expect(html).toContain("formData.settings.whatsappEnabled !== true");
  });

  test('uses field-specific Enter placeholders instead of one email example for every field', () => {
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');

    expect(builder).toContain('placeholder={fieldPlaceholderHint(field)}');
    expect(builder).toContain('placeholder: "Enter email"');
    expect(builder).toContain('placeholder: "Enter phone"');
    expect(builder).toContain('function fieldPlaceholderHint(field)');
  });

  test('prefers browser location and falls back to IP for Generic phone country detection', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toMatch(/country\.value\s*=\s*["']\+91["']/);
    expect(html).toContain('function detectGenericCountryFromLocale');
    expect(html).toContain('function detectGenericCountryFromLocationOrIp');
    expect(html).toContain('navigator.geolocation.getCurrentPosition');
    expect(html).toContain('https://ipapi.co/json/');
    expect(html).toContain('new Intl.Locale(locale).region');
    expect(html).toMatch(/detectGenericCountryFromLocationOrIp\s*\(\s*country\s*,\s*input\s*,\s*allowedCountries\s*,\s*restrictedCountries\s*,\s*applyRule\s*,\s*phoneState\s*,?\s*\)/);
    expect(html).not.toContain("detectGenericCountryFromTimeZone(country, input, allowedCountries, restrictedCountries, applyRule, phoneState);");
  });

  test('preserves Generic phone country choices made by the visitor', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('phoneState.userEnteredPhone || phoneState.userSelectedCountry');
    expect(html).toMatch(/if\s*\(!phoneState\.applyingDetectedCountry\)\s*phoneState\.userSelectedCountry\s*=\s*true\s*;/);
    expect(html).toMatch(/detectGenericCountryFromLocale\s*\(\s*country\s*,\s*input\s*,\s*allowedCountries\s*,\s*restrictedCountries\s*,\s*applyRule\s*,\s*phoneState\s*,?\s*\)/);
  });

  test('keeps the Generic CRM email-domain picker opaque across themes', () => {
    const html = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');

    expect(html).toContain('web-form-builder-generic');
    expect(html).toContain('scope === "generic" ? "web-form-builder web-form-builder-generic" : "web-form-builder"');
    expect(html).toContain('wf-email-domain-popover');
    expect(html).toContain('background: "var(--wf-popover-bg, #fff)"');
    expect(html).toContain('zIndex: 1000');
    expect(html).toContain('opacity: 1 }}');
    expect(html).toContain('isolation: isolate');
    expect(html).toContain('opacity: 1 !important');
    expect(html).toContain('--wf-popover-bg: #ffffff');
    expect(html).toContain('--wf-popover-bg: #1a1d24');
  });

  test('limits country detection to the Generic and Travel runtimes', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain("if (!advanced || localeCountryDetectionStarted) return;");
    expect(html).toContain("if (!advanced) return;");
  });

  test('contains the Generic multi-step navigation and validation runtime', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function multiStepConfig()');
    expect(html).toContain('function validateStep(stepIndex)');
    expect(html).toMatch(/document\s*\.\s*getElementById\(["']step-next["']\)\s*\.\s*addEventListener/);
    expect(html).toContain('showStep(currentStepIndex + 1)');
    expect(html).toContain('showStep(currentStepIndex - 1)');
  });

  test('keeps the Generic form visible when reCAPTCHA is incomplete', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function showInlineError(text)');
    expect(html).toMatch(/Please complete the "I\\'m not a robot" verification\./);
    expect(html).not.toContain("if (!captchaToken) { setMessage('error'");
  });

  test('keeps submit clickable so required-field validation can explain incomplete fields', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function updateGenericSubmitState(fields)');
    expect(html).toContain('button.disabled = false;');
    expect(html).toContain('updateGenericSubmitState(fields);');
    expect(html).toMatch(/if\s*\(!flag\s*&&\s*advanced\)\s*updateGenericSubmitState\(formData\.fields\s*\|\|\s*\[\]\);/);
  });

  test('does not cap long forms in an internal scroll container', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).not.toContain('grid-scroll');
    expect(html).not.toContain('max-height:500px');
    expect(html).not.toContain('overflow-y:auto;overflow-x:hidden');
  });

  test('shows the WhatsApp validation message only when it is active', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');
    const style = document.createElement('style');
    style.textContent = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    const error = document.createElement('span');
    error.className = 'field-error';
    error.hidden = true;
    document.head.appendChild(style);
    document.body.appendChild(error);
    try {
      expect(getComputedStyle(error).display).toBe('none');
      error.hidden = false;
      expect(getComputedStyle(error).display).toBe('block');
    } finally {
      error.remove();
      style.remove();
    }
  });

  test('applies configured form and submit-button colors through CSS variables', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toMatch(/\.panel\s*\{\s*background:\s*var\(--gbs-form/);
    expect(html).toMatch(/\.primary\s*\{\s*background:\s*var\(--gbs-button/);
    expect(html).not.toMatch(/\.primary\s*\{\s*background:\s*linear-gradient\(135deg,#4f46e5,#7c3aed\)/);
  });

  test('normalizes Generic CRM phone fields without rejecting valid international lengths', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function nationalPhoneMaxLength()');
    expect(html).toContain('return Math.max(1, 15 - countryDigits.length)');
    expect(html).toContain('function setupGenericPhoneInputLimit(countrySelect, input)');
    expect(html).toContain("input.setAttribute('maxlength', '16')");
    expect(html).toContain("input.setAttribute('inputmode', 'numeric')");
    expect(html).toContain('slice(0, nationalPhoneMaxLength())');
    expect(html).toContain("rawPhoneInput.trim().charAt(0) === '+'");
    expect(html).toContain("var numericQuery = trigger.value.replace(/\\D/g, '')");
    expect(html).toContain("option.value.replace(/^\\+/, '') === numericQuery");
    expect(html).toContain('/^\\+[1-9]\\d{7,14}$/.test(internationalPhone)');
    expect(html).toContain('Enter a valid international phone number.');
    expect(html).not.toContain("/^\\d{9,11}$/.test(nationalDigits)");
    expect(html).not.toContain("genericPhoneInput.setAttribute('pattern'");
  });
});
