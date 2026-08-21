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
  });

  test('escapes the iframe title safely', () => {
    const code = buildWebFormEmbedCode({ name: 'Lead <Form>', slug: 'lead-form' }, 'https://crm.example.com');

    expect(code).toContain('title="Lead &lt;Form&gt;"');
  });
});

describe('public web form embed footer', () => {
  test('links the powered-by footer to the home page', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain('<a href="/" target="_top" rel="noopener noreferrer" aria-label="Go to GlobusCRM home page">Powered By GlobusCRM</a>');
  });
});
