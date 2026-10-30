import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { buildWebFormEmbedCode, buildWebFormPreviewUrl, buildWebFormScriptEmbedCode, getWebFormPreviewViewportWidth, slugifyWebFormName, textOrBlank } from '../utils/webForms';

// These assertions check source contracts, not the formatter's quote style
// or whitespace. Runtime/layout assertions below remain unchanged.
function expectSourceContains(source, snippet) {
  const normalize = (value) => value.replace(/\s+/g, '').replace(/'/g, '"').replace(/;(?=}|$)/g, '');
  expect(normalize(source).includes(normalize(snippet)), `Missing embed source contract: ${snippet}`).toBe(true);
}

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
    expect(code).toContain('type:"responsive-device"');
    expect(code).toContain('window.innerWidth');
    expect(code).toContain('Max-Age="+maxAge');
    expect(code).toContain('attribution:savedAttribution');
    expect(code).toContain('"utm_source"');
    expect(code).toContain('"hsa_ver"');
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

  test('keeps host attribution cookies scoped to Generic CRM forms', () => {
    const code = buildWebFormEmbedCode(
      { id: 102, name: 'Travel Enquiry', slug: 'travel-enquiry', scope: 'travel' },
      'https://crm.example.com',
    );

    expect(code).not.toContain('Max-Age="+maxAge');
    expect(code).not.toContain('attribution:savedAttribution');
    expect(code).toContain('type:"responsive-device"');
  });

  test('captures and forwards first-touch attribution from the external page', () => {
    const code = buildWebFormEmbedCode(
      { id: 103, name: 'External Contact', slug: 'external-contact', scope: 'generic' },
      'https://crm.example.com',
    );
    const scriptBody = code.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const messages = [];
    const frameListeners = {};
    const frame = {
      contentWindow: { postMessage: (message) => messages.push(message) },
      addEventListener: (name, callback) => { frameListeners[name] = callback; },
      style: {},
    };
    const originalUrl = window.location.href;

    document.cookie = 'gbs_utm_source=; Max-Age=0; Path=/';
    document.cookie = 'gbs_utm_medium=; Max-Age=0; Path=/';
    document.cookie = 'gbs_gclid=; Max-Age=0; Path=/';
    window.history.replaceState({}, '', '/contact?utm_source=adwords&utm_medium=ppc&gclid=click-123');
    globalThis.__gbsEmbedTestFrame = frame;

    try {
      const executable = scriptBody.replace(
        'document.currentScript.previousElementSibling',
        'globalThis.__gbsEmbedTestFrame',
      );
      Function(executable)();
      frameListeners.load();

      expect(document.cookie).toContain('gbs_utm_source=adwords');
      expect(document.cookie).toContain('gbs_utm_medium=ppc');
      expect(document.cookie).toContain('gbs_gclid=click-123');
      expect(messages).toContainEqual(expect.objectContaining({
        source: 'gbs-web-form-host',
        type: 'context',
        attribution: expect.objectContaining({
          utm_source: 'adwords',
          utm_medium: 'ppc',
          gclid: 'click-123',
        }),
      }));
    } finally {
      delete globalThis.__gbsEmbedTestFrame;
      document.cookie = 'gbs_utm_source=; Max-Age=0; Path=/';
      document.cookie = 'gbs_utm_medium=; Max-Age=0; Path=/';
      document.cookie = 'gbs_gclid=; Max-Age=0; Path=/';
      window.history.replaceState({}, '', originalUrl);
    }
  });

  test('preserves first-touch attribution when a later visit has new campaign parameters', () => {
    const code = buildWebFormEmbedCode(
      { id: 106, name: 'External Contact', scope: 'generic' },
      'https://crm.example.com',
    );
    const scriptBody = code.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const messages = [];
    const frameListeners = {};
    const frame = {
      contentWindow: { postMessage: (message) => messages.push(message) },
      addEventListener: (name, callback) => { frameListeners[name] = callback; },
      style: {},
    };
    const originalUrl = window.location.href;

    document.cookie = 'gbs_utm_source=first-campaign; Path=/';
    document.cookie = 'gbs_utm_campaign=launch-one; Path=/';
    window.history.replaceState({}, '', '/contact?utm_source=later-campaign&utm_campaign=launch-two');
    globalThis.__gbsEmbedTestFrame = frame;

    try {
      Function(scriptBody.replace(
        'document.currentScript.previousElementSibling',
        'globalThis.__gbsEmbedTestFrame',
      ))();
      frameListeners.load();

      expect(document.cookie).toContain('gbs_utm_source=first-campaign');
      expect(document.cookie).toContain('gbs_utm_campaign=launch-one');
      expect(messages).toContainEqual(expect.objectContaining({
        source: 'gbs-web-form-host',
        type: 'context',
        attribution: expect.objectContaining({
          utm_source: 'first-campaign',
          utm_campaign: 'launch-one',
        }),
      }));
    } finally {
      delete globalThis.__gbsEmbedTestFrame;
      document.cookie = 'gbs_utm_source=; Max-Age=0; Path=/';
      document.cookie = 'gbs_utm_campaign=; Max-Age=0; Path=/';
      window.history.replaceState({}, '', originalUrl);
    }
  });
});

describe('buildWebFormScriptEmbedCode', () => {
  test('builds a script-only Generic CRM embed that creates the iframe and retains tracking', () => {
    const code = buildWebFormScriptEmbedCode(
      { id: 104, name: 'Contact </script> Form', scope: 'generic' },
      'https://crm.example.com',
    );

    expect(code).toMatch(/^<script>/);
    expect(code).toContain('document.createElement("iframe")');
    expect(code).toContain('https://crm.example.com/embed/web-form.html?id=104');
    expect(code).toContain('frame.allow="geolocation *"');
    expect(code).toContain('attribution:savedAttribution');
    expect(code).toContain('frameUrl.searchParams.set(key');
    expect(code).toContain('readTrackingCookie("gbs_"+key)');
    expect(code).toContain('Max-Age="+maxAge');
    expect(code).not.toContain('Contact </script> Form');
    expect(code).toContain('Contact \\u003c/script> Form');
    expect(() => Function(code.slice('<script>'.length, -'</script>'.length))).not.toThrow();
  });

  test('does not generate the script-only option for non-Generic CRM forms', () => {
    expect(buildWebFormScriptEmbedCode(
      { id: 105, name: 'Travel Enquiry', scope: 'travel' },
      'https://crm.example.com',
    )).toBe('');
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
    expectSourceContains(html, 'name="phoneCountry"');
    expect(html).toMatch(/\.phone-country-picker\.open\s*\{\s*z-index:\s*40\s*;\s*\}/);
    expect(html).toMatch(/\.phone-country-picker\s*>\s*input:focus\s*\+\s*\.phone-country-options\s*\{\s*display:\s*block\s*;\s*\}/);
    expect(html).toMatch(/options\.style\.display\s*=\s*["']block["']/);
    expect(html).toMatch(/trigger\.addEventListener\(["']keydown["']\s*,\s*openCountryPicker\)/);
    expect(html).toMatch(/trigger\.addEventListener\(["']pointerdown["']/);
    expect(html).toMatch(/allowedCountries\.length\s*>\s*0/);
    expect(html).toMatch(/pickerAllowedCountries\.length\s*>\s*0/);
    expect(html).toMatch(/trigger\.inputMode\s*=\s*["']tel["']/);
    expectSourceContains(html, 'var visibleQuery = (hasLeadingPlus ? "+" : "") + numericQuery');
    expectSourceContains(html, "var numericQuery = trigger.value.replace(/\\D/g, '')");
    expect(html).toMatch(/fd\.set\(["']phone["']\s*,\s*nationalDigits\)/);
    expect(html).toMatch(/if\s*\(\s*advanced\s*&&\s*fd\.get\(["']phone["']\)\s*&&\s*fd\.get\(["']phoneCountry["']\)\s*\)/);
    expectSourceContains(html, 'grid-template-columns: minmax(96px, 24%) minmax(0, 1fr);');
    expectSourceContains(html, 'grid-template-columns: minmax(96px, 24%) minmax(0, 1fr)!important;');
    expectSourceContains(html, 'generic-public-desktop-columns');
    expectSourceContains(html, 'generic-two-columns');
    expectSourceContains(html, '!isBuilderPreview');
    expectSourceContains(html, 'grid-template-columns: minmax(92px, 34%) minmax(0, 1fr) !important;');
    expectSourceContains(html, 'padding-left: 44px;');
    expectSourceContains(html, '@media (max-width: 640px)');
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
    expectSourceContains(html, '@media (min-width: 641px) and (max-width: 900px)');
    expectSourceContains(html, 'grid-template-columns: var(--gbs-tablet-columns, minmax(0, 1fr)) !important;');
    expectSourceContains(html.slice(responsiveRule), 'grid-template-columns: var(--gbs-mobile-columns, minmax(0, 1fr)) !important;');
    expectSourceContains(html.slice(responsiveRule), 'grid-column: auto !important;');
    expectSourceContains(html, 'class="field phone-field ');
    expectSourceContains(html, '@media (max-width: 480px)');
    expectSourceContains(html, '@media (max-width: 359px)');
    expectSourceContains(html, 'grid-column: 1 / -1 !important;');
    expectSourceContains(html.slice(responsiveRule), 'grid-template-columns: minmax(68px, 42%) minmax(0, 1fr) !important;');
    expectSourceContains(html, 'html.generic-preview-mobile.generic-scope .phone-input');
    expectSourceContains(html, 'padding: 0 3px 0 34px;');
    expectSourceContains(html, 'grid-template-columns: minmax(104px, 30%) minmax(0, 1fr) !important;');
    expectSourceContains(html, 'padding: 0 8px 0 54px;');
    expectSourceContains(html, 'html.generic-preview-mobile.generic-scope .grid .full');
    expectSourceContains(html, 'html.generic-host-desktop.generic-scope .grid');
    expectSourceContains(html, 'html.generic-host-tablet.generic-scope .grid');
    expectSourceContains(html, 'html.generic-host-mobile.generic-scope .grid');
    expectSourceContains(html, 'type !== "responsive-device"');
    expectSourceContains(html, 'grid-template-columns: var(--gbs-columns) !important;');
    expectSourceContains(html, 'grid-template-columns: var(--gbs-tablet-columns) !important;');
    expectSourceContains(html, 'grid-template-columns: var(--gbs-mobile-columns) !important;');
    expectSourceContains(html, '--gbs-tablet-full-span');
    expectSourceContains(html, '--gbs-mobile-full-span');
    expectSourceContains(html, 'grid-column: var(--gbs-tablet-full-span, 1/-1) !important;');
    expectSourceContains(html, 'grid-column: var(--gbs-mobile-full-span, 1/-1) !important;');
    expect(html.lastIndexOf('html.generic-preview-desktop.generic-scope .grid')).toBeGreaterThan(html.lastIndexOf('@media (min-width: 641px) and (max-width: 900px)'));
    expectSourceContains(html, '.choices.horizontal .check');
    expectSourceContains(html, 'width: fit-content;');
    expectSourceContains(html, 'flex: 0 1 auto;');
    expectSourceContains(html.slice(responsiveRule), 'overflow-wrap: anywhere;');
  });

  test('sizes the live preview iframe to the selected device viewport', () => {
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(builder).toContain('getWebFormPreviewViewportWidth(previewDevice)');
    expect(builder).toContain('min(100%, ${previewViewportWidth})');
    expect(builder).toContain('margin: "0 auto"');
    expect(html).toContain('function hydratePreviewRecaptcha(previewForm)');
    expect(html).toContain('previewForm = await hydratePreviewRecaptcha(previewForm)');
    expect(html).toContain('hydratePreviewRecaptcha(event.data.form).then');
    expect(html).toContain('previewForm.settings.recaptchaSiteKey');
  });

  test('renders the numeric phone control for the default phone field', () => {
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(builder).toContain('{ value: "phone", label: "Phone", fieldType: "number"');
    expect(html).toContain("input[name=\"phone\"]");
  });

  test('keeps the WhatsApp implementation behind the opt-in setting', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expectSourceContains(html, 'setupGenericWhatsapp');
    expectSourceContains(html, 'name="whatsappSameAsPhone"');
    expectSourceContains(html, 'WhatsApp number is the same as phone number');
    expectSourceContains(html, "whatsappCountry.name = 'whatsappPhoneCountry'");
    expectSourceContains(html, 'name="whatsappPhone"');
    expectSourceContains(html, 'WhatsApp country code');
    expectSourceContains(html, 'setupGenericWhatsappPhone');
    expectSourceContains(html, 'Enter a valid WhatsApp number with ');
    expectSourceContains(html, 'setupGenericCountryPicker(whatsappCountrySelect');
    expectSourceContains(html, '.generic-whatsapp-section{display:block;margin-top:8px;padding-left:0}');
    expectSourceContains(html, 'wrapper.className = "field generic-whatsapp-section"');
    expectSourceContains(html, 'phoneField.insertAdjacentElement("afterend", wrapper)');
    expectSourceContains(html, 'formGrid.classList.add("generic-whatsapp-grid")');
    expectSourceContains(html, 'grid-auto-flow: row dense');
    expectSourceContains(html, 'white-space:normal;line-height:1.35;font-weight:var(--gbs-form-weight,400)');
    expectSourceContains(html, '.generic-whatsapp-section>.check span{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}');
    expectSourceContains(html, 'function fitRecaptcha()');
    expectSourceContains(html, 'widget.style.transformOrigin = "top left"');
    expectSourceContains(html, 'container.style.height = Math.ceil(widgetHeight * scale) + "px"');
    expectSourceContains(html, '.generic-whatsapp-phone{margin-bottom:0}');
    expectSourceContains(html, "phoneField.classList.add('generic-phone-with-whatsapp')");
    expectSourceContains(html, 'generic-whatsapp-number');
    expectSourceContains(html, "formData.settings.whatsappEnabled !== true");
  });

  test('uses field-specific Enter placeholders instead of one email example for every field', () => {
    const builder = readFileSync(join(process.cwd(), 'src/pages/WebForms.jsx'), 'utf8');

    expect(builder).toContain('placeholder={fieldPlaceholderHint(field)}');
    expect(builder).toContain('placeholder: "Enter email"');
    expect(builder).toContain('placeholder: "Enter phone"');
    expect(builder).toContain('function fieldPlaceholderHint(field)');
  });

  test('uses the native browser location prompt automatically on Generic web-form surfaces', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toMatch(/country\.value\s*=\s*["']\+91["']/);
    expect(html).toContain('function detectGenericCountryFromLocale');
    expect(html).toContain('function detectGenericCountryFromLocationOrIp');
    expect(html).toContain('navigator.geolocation.getCurrentPosition');
    expect(html).toContain('addressdetails=1&zoom=18');
    expect(html).toContain('address.neighbourhood');
    expect(html).toContain('locationPostalCode: String(address.postcode || "")');
    expect(html).toContain('locationLatitude: Number(coords.latitude).toFixed(6)');
    expect(html).toContain('if (scope === "generic")');
    expect(html).toContain('await phoneCountryDetectionPromise.catch');
    expect(html).toContain('tracking[key] = detectedLocationMetadata[key]');
    expect(html).not.toContain('https://ipapi.co/json/');
    expect(html).toContain("keep the form's configured/default country code");
    expect(html).not.toContain('location-permission');
    expect(html).not.toContain('var requestBrowserLocation = function ()');
    expect(html).toContain('direct links and all embeds');
    expect(html).toMatch(/detectGenericCountryFromLocationOrIp\s*\(\s*country\s*,\s*input\s*,\s*allowedCountries\s*,\s*restrictedCountries\s*,\s*applyRule\s*,\s*phoneState\s*,?\s*\)/);
    expect(html).toMatch(/if\s*\(!advanced\)\s*return Promise\.resolve\(false\)/);
    expect(html).toMatch(/if\s*\(phoneCountryDetectionStarted\)\s*return phoneCountryDetectionPromise\.then\(apply\)/);
    expect(html).toContain('if (scope === "generic" && !phoneCountryDetectionStarted)');
    expect(html).toContain('detectGenericCountryFromLocationOrIp();');
    expect(html).toContain('scope === "generic" || phoneSettings.phoneAutoDetectCountry === true');
    expect(html).not.toContain("detectGenericCountryFromTimeZone(country, input, allowedCountries, restrictedCountries, applyRule, phoneState);");
  });

  test.each([
    ['generic', undefined, 1],
    ['generic', false, 1],
    ['travel', undefined, 0],
    ['travel', false, 0],
    ['travel', 'true', 0],
    ['travel', true, 1],
    ['wellness', true, 0],
  ])('country detection respects %s opt-in %s', async (scope, optIn, expectedCalls) => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');
    const start = html.indexOf('function detectGenericCountryFromLocationOrIp(');
    const end = html.indexOf('function detectGenericCountryFromTimeZone(', start);
    let calls = 0;
    const context = {
      scope,
      advanced: scope === 'generic' || scope === 'travel',
      formData: { settings: { phoneAutoDetectCountry: optIn } },
      phoneCountryDetectionStarted: false,
      phoneCountryDetectionPromise: Promise.resolve(false),
      window: { isSecureContext: true },
      navigator: { geolocation: { getCurrentPosition(_success, failure) {
        calls += 1;
        failure({ code: 1 });
      } } },
    };
    runInNewContext(html.slice(start, end), context);
    await context.detectGenericCountryFromLocationOrIp();
    expect(calls).toBe(expectedCalls);
    expect(context.phoneCountryDetectionStarted).toBe(expectedCalls > 0);
  });

  test('keeps Generic tracking cookies for exactly 90 days', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('var TRACKING_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;');
    expect(html).toContain('TRACKING_COOKIE_MAX_AGE_SECONDS +');
  });

  test('stores a clean submission page URL while preserving query attribution', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function pageUrlWithoutQueryOrHash(value)');
    expect(html).toContain('var pageUrl = pageUrlWithoutQueryOrHash(capturedPageUrl);');
    expect(html).toContain('pageUrlObject = new URL(capturedPageUrl);');
    expect(html).toContain('var query = pageUrlObject');
    expect(html).toContain('fd.set("_gbsTracking", JSON.stringify(tracking));');
    expect(html).not.toContain('requestHeaders["X-GBS-Tracking"]');
  });

  test('submits Generic attribution when third-party iframe cookies are blocked', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');
    const start = html.indexOf('function resolveTrackingAttribution(');
    const end = html.indexOf('function pageUrlWithoutQueryOrHash(', start);
    const remembered = [];
    const context = {
      TRACKING_QUERY_KEYS: ['utm_source', 'utm_campaign', 'gclid'],
      readCookie: () => '',
      rememberCookie: (name, value) => remembered.push([name, value]),
    };

    runInNewContext(html.slice(start, end), context);
    const query = {
      get: (key) => ({ utm_source: 'google', utm_campaign: 'metros', gclid: 'click-123' })[key] || '',
    };
    const attribution = context.resolveTrackingAttribution(query, {});

    expect(attribution).toEqual({
      utm_source: 'google',
      utm_campaign: 'metros',
      gclid: 'click-123',
    });
    expect(remembered).toContainEqual(['gbs_utm_source', 'google']);
    expect(html).toContain('var value = resolvedAttribution[key];');
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

  test('explicitly renders reCAPTCHA in live preview updates and public forms', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('var recaptcha = recaptchaEnabled');
    expect(html).toContain('function initializeRecaptcha()');
    expect(html).toContain('https://www.google.com/recaptcha/api.js?render=explicit');
    expect(html).toContain('var initialPreviewSequence = ++previewUpdateSequence;');
    expect(html).toContain('function waitForRecaptchaApi(attempt)');
    expect(html).toContain('waitForRecaptchaApi(attempt + 1);');
    expect(html).toContain('window.grecaptcha.render(widget, {');
    expect(html).toContain('data-gbs-rendered');
    expect(html).toContain('window.grecaptcha.getResponse(');
    expect(html).toContain('reCAPTCHA is enabled, but no site key is available.');
    expect(html).not.toContain('document.createElement("script");\n            script.src = "https://www.google.com/recaptcha/api.js";');
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

    expectSourceContains(html, 'function nationalPhoneMaxLength()');
    expectSourceContains(html, 'return Math.max(1, 15 - countryDigits.length)');
    expectSourceContains(html, 'function setupGenericPhoneInputLimit(countrySelect, input)');
    expectSourceContains(html, "input.setAttribute('maxlength', '16')");
    expectSourceContains(html, "input.setAttribute('inputmode', 'numeric')");
    expectSourceContains(html, 'slice(0, nationalPhoneMaxLength())');
    expectSourceContains(html, "rawPhoneInput.trim().charAt(0) === '+'");
    expectSourceContains(html, "var numericQuery = trigger.value.replace(/\\D/g, '')");
    expectSourceContains(html, "option.value.replace(/^\\+/, '') === numericQuery");
    expectSourceContains(html, '/^\\+[1-9]\\d{7,14}$/.test(internationalPhone)');
    expectSourceContains(html, 'Enter a valid international phone number.');
    expect(html).not.toContain("/^\\d{9,11}$/.test(nationalDigits)");
    expect(html).not.toContain("genericPhoneInput.setAttribute('pattern'");
  });
});
