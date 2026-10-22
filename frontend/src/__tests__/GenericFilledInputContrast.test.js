import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Generic CRM filled input contrast', () => {
  it('keeps Create Lead values emphasized after the field loses focus', () => {
    const css = readFileSync(join(process.cwd(), 'src/pages/Leads.css'), 'utf8');

    expect(css).toContain(
      '.create-lead-modal--generic .create-lead-form--generic input:not([type="checkbox"]):not([type="radio"]):not(:placeholder-shown)',
    );
    expect(css).toContain(
      '.create-lead-modal--generic .create-lead-form--generic input:-webkit-autofill',
    );
  });

  it('keeps public web-form values emphasized after the field loses focus', () => {
    const html = readFileSync(join(process.cwd(), 'public/embed/web-form.html'), 'utf8');

    expect(html).toContain(
      'html.generic-scope #gbs-form input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not(:placeholder-shown)',
    );
    expect(html).toContain('html.generic-scope #gbs-form input:-webkit-autofill');
  });
});
