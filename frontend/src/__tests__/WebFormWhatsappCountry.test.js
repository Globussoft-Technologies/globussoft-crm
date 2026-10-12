import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, vi } from 'vitest';

test.each([
  ['+44', '+44 7700 900123', '7700900123'],
  ['+91', '+91 98765 43210', '9876543210'],
])('pasted WhatsApp numbers use the independently selected country %s', (country, pasted, expected) => {
  const html = readFileSync(resolve(process.cwd(), 'public/embed/web-form.html'), 'utf8');
  const body = html.match(/function keepWhatsappNumeric\(value\) \{([\s\S]*?)\n\s*\}\n\s*function syncWhatsappField/)[1];
  const input = { value: '' };
  const showError = vi.fn();
  // Execute the actual embedded handler. No phoneCountry binding is supplied:
  // using the main phone's selector must fail this regression test.
  const handler = new Function('whatsappCountry', 'whatsappInput', 'showWhatsappError', 'value', body);
  handler({ value: country }, input, showError, pasted);
  expect(input.value).toBe(expected);
  expect(showError).toHaveBeenCalledWith(false);
});
