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

    expect(url).toContain('https://crm.example.com/embed/web-form.html#preview=');
    expect(url).toContain(encodeURIComponent('Draft Form'));
  });
});

describe('buildWebFormEmbedCode', () => {
  test('builds an iframe snippet and public link for the form slug', () => {
    const code = buildWebFormEmbedCode({ name: 'Contact Us', slug: 'contact-us' }, 'https://crm.example.com');

    expect(code).toContain('https://crm.example.com/embed/web-form.html?slug=contact-us');
    expect(code.match(/https:\/\/crm\.example\.com\/embed\/web-form\.html\?slug=contact-us/g)).toHaveLength(2);
    expect(code).toContain('title="Contact Us"');
    expect(code).toContain('style="width:100%;height:auto;border:0;display:block;"');
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
    expect(html).toContain("(footerLink ? '<div class=\"note\">' + footerLink + '</div>' : '')");
  });

  test('combines a searchable country code with Generic phone submissions only', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain("scope === 'generic' && field.sourceKey === 'phone'");
    expect(html).toContain('name="phoneCountry"');
    expect(html).toContain("fd.set('phone', internationalPhone)");
  });

  test('detects a Generic phone country locally without disclosing visitor IPs', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function detectGenericCountryFromLocale');
    expect(html).toContain('new Intl.Locale(locale).region');
    expect(html).not.toContain('ipapi.co');
    expect(html).not.toContain('ipwho.is');
    expect(html).not.toContain('api.country.is');
  });

  test('contains the Generic multi-step navigation and validation runtime', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('function multiStepConfig()');
    expect(html).toContain('function validateStep(stepIndex)');
    expect(html).toContain("document.getElementById('step-next').addEventListener");
    expect(html).toContain('showStep(currentStepIndex + 1)');
    expect(html).toContain('showStep(currentStepIndex - 1)');
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
    expect(html).toContain("var numericQuery = query.replace(/^\\+/, '')");
    expect(html).toContain("option.value.replace(/^\\+/, '') === numericQuery");
    expect(html).toContain('/^\\+[1-9]\\d{7,14}$/.test(internationalPhone)');
    expect(html).toContain('Enter a valid international phone number.');
    expect(html).not.toContain("/^\\d{9,11}$/.test(nationalDigits)");
    expect(html).not.toContain("genericPhoneInput.setAttribute('pattern'");
  });
});
