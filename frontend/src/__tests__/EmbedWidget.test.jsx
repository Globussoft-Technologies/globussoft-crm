import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WIDGET_PATH = path.resolve(process.cwd(), 'public', 'embed', 'widget.js');
const WIDGET_SOURCE = readFileSync(WIDGET_PATH, 'utf8');

function mountWidgetFixture() {
  document.body.innerHTML = '';
  window.__gbsFormLoaded = undefined;
  window.MutationObserver = undefined;

  const target = document.createElement('div');
  target.setAttribute('data-gbs-form', '');
  target.setAttribute('data-key', 'glbs_testkey');
  target.setAttribute('data-title', 'Hello');
  document.body.appendChild(target);

  const script = document.createElement('script');
  script.src = 'https://crm.globusdemos.com/embed/widget.js';
  document.body.appendChild(script);

  window.eval(WIDGET_SOURCE);
  return target;
}

describe('embed/widget.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.__gbsFormLoaded = undefined;
    window.MutationObserver = undefined;
  });

  it('mounts an iframe and forwards the current page origin as partner_origin', () => {
    const target = mountWidgetFixture();
    const iframe = target.querySelector('iframe');

    expect(iframe).toBeTruthy();
    const iframeUrl = new URL(iframe.src);
    expect(iframeUrl.origin).toBe('https://crm.globusdemos.com');
    expect(iframeUrl.pathname).toBe('/embed/lead-form.html');
    expect(iframeUrl.searchParams.get('key')).toBe('glbs_testkey');
    expect(iframeUrl.searchParams.get('partner_origin')).toBe(window.location.origin);
    expect(iframeUrl.searchParams.get('api')).toBe('https://crm.globusdemos.com');
  });

  it('keeps the lead form src stable when multiple mounts happen', () => {
    const target = mountWidgetFixture();
    const firstIframe = target.querySelector('iframe');
    const firstSrc = firstIframe?.src;

    window.eval(WIDGET_SOURCE);

    const secondIframe = target.querySelector('iframe');
    expect(secondIframe).toBe(firstIframe);
    expect(secondIframe?.src).toBe(firstSrc);
  });
});
