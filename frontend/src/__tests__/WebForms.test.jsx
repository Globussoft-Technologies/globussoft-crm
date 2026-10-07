import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildWebFormEmbedCode, buildWebFormPreviewUrl, slugifyWebFormName, textOrBlank } from '../utils/webForms';

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
  test('links the powered-by footer to the home page', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('<a href="/" target="_top" rel="noopener noreferrer" aria-label="Go to GlobusCRM home page">Powered By GlobusCRM</a>');
  });

  test('honors the per-form powered-by setting while defaulting it on', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('formData.settings.showPoweredBy === false');
    expect(html).toContain("(footerLink ? '<div class=\"note powered-by\">' + footerLink + '</div>' : '')");
  });

  test('combines a searchable country code with phone submissions for every web-form scope', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain("if (advanced && field.sourceKey === 'phone')");
    expect(html).toContain("type=\"' + (field.fieldType === 'number' ? 'number' : 'tel') + '\"");
    expect(html).toContain('name="phoneCountry"');
    expect(html).toContain('.phone-country-picker.open{z-index:40}');
    expect(html).toContain('.phone-country-picker>input:focus + .phone-country-options{display:block}');
    expect(html).toContain("options.style.display = 'block'");
    expect(html).toContain('trigger.addEventListener(\'keydown\', openCountryPicker)');
    expect(html).toContain("trigger.addEventListener('pointerdown'");
    expect(html).toContain("&& allowedCountries.length > 0");
    expect(html).toContain("&& pickerAllowedCountries.length > 0");
    expect(html).toContain("trigger.inputMode = 'numeric'");
    expect(html).toContain("var numericQuery = trigger.value.replace(/\\D/g, '')");
    expect(html).toContain("fd.set('phone', nationalDigits)");
    expect(html).toContain("if (advanced && fd.get('phone') && fd.get('phoneCountry'))");
  });

  test('renders the numeric phone control for the default phone field', () => {
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(builder).toContain('{ value: "phone", label: "Phone", fieldType: "number"');
    expect(html).toContain("input[name=\"phone\"]");
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

    expect(html).toContain("country.value = '+91'");
    expect(html).toContain('function detectGenericCountryFromLocale');
    expect(html).toContain('function detectGenericCountryFromLocationOrIp');
    expect(html).toContain('navigator.geolocation.getCurrentPosition');
    expect(html).toContain('https://ipapi.co/json/');
    expect(html).toContain('new Intl.Locale(locale).region');
    expect(html).toContain("detectGenericCountryFromLocationOrIp(country, input, allowedCountries, restrictedCountries, applyRule, phoneState);");
    expect(html).not.toContain("detectGenericCountryFromTimeZone(country, input, allowedCountries, restrictedCountries, applyRule, phoneState);");
  });

  test('preserves Generic phone country choices made by the visitor', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('phoneState.userEnteredPhone || phoneState.userSelectedCountry');
    expect(html).toContain("if (!phoneState.applyingDetectedCountry) phoneState.userSelectedCountry = true;");
    expect(html).toContain("detectGenericCountryFromLocale(country, input, allowedCountries, restrictedCountries, applyRule, phoneState);");
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
    expect(html).toContain("document.getElementById('step-next').addEventListener");
    expect(html).toContain('showStep(currentStepIndex + 1)');
    expect(html).toContain('showStep(currentStepIndex - 1)');
  });

  test('keeps the Generic form visible when reCAPTCHA is incomplete', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function showInlineError(text)');
    expect(html).toContain('showInlineError(\'Please complete the "I\\\'m not a robot" verification.\')');
    expect(html).not.toContain("if (!captchaToken) { setMessage('error'");
  });

  test('disables the Generic and Travel submit buttons until required fields are complete', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function updateGenericSubmitState(fields)');
    expect(html).toContain('button.disabled = !complete;');
    expect(html).toContain('updateGenericSubmitState(fields);');
    expect(html).toContain("if (!flag && advanced) updateGenericSubmitState(formData.fields || []);");
  });

  test('does not cap long forms in an internal scroll container', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).not.toContain('grid-scroll');
    expect(html).not.toContain('max-height:500px');
    expect(html).not.toContain('overflow-y:auto;overflow-x:hidden');
  });

  test('applies configured form and submit-button colors through CSS variables', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('.panel{background:var(--gbs-form');
    expect(html).toContain('.primary{background:var(--gbs-button');
    expect(html).not.toContain('.primary{background:linear-gradient(135deg,#4f46e5,#7c3aed)');
  });

  test('normalizes Generic CRM phone fields without rejecting valid international lengths', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function nationalPhoneMaxLength()');
    expect(html).toContain('return Math.max(1, 15 - countryDigits.length)');
    expect(html).toContain("genericPhoneInput.setAttribute('maxlength', '16')");
    expect(html).toContain("genericPhoneInput.setAttribute('inputmode', 'numeric')");
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
