/**
 * LandingForm.test.jsx — dynamic hero web-form on the public marketing page.
 *
 * SUT: frontend/src/pages/Landing.jsx (server-rendered form + shadow injection)
 *   - On mount, Landing immediately injects the complete public form document
 *     into a CLOSED shadow root under #hero-form-mount. The document response
 *     contains the active form definition and performs no follow-up load.
 *   - Privacy contract (the whole point): the form link never appears in the
 *     light DOM, so DevTools Elements shows only `#shadow-root (closed)`.
 *     Every test below asserts `container.querySelector('iframe') === null`.
 *   - Management lives on the Web Forms page (allowlist-gated per-card
 *     control) — Landing itself renders no manage UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Landing from '../pages/Landing';
import {
  heroFormEmbedSrc,
  injectLandingHeroForm,
  injectHeroForm,
  landingHeroFormEmbedSrc,
  resizeHeroFormFrame,
  responsiveFormDevice,
  sendHeroFormContext,
} from '../utils/landingHeroForm';

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Landing />
    </MemoryRouter>
  );
}

function lightDomFrame(container) {
  return container.querySelector('iframe');
}

describe('heroFormEmbedSrc', () => {
  it('builds the embed URL for a form id', () => {
    expect(heroFormEmbedSrc(11)).toBe('/embed/web-form.html?id=11');
  });

  it('uses one server-rendered document for the landing form', () => {
    expect(landingHeroFormEmbedSrc()).toBe('/api/landing-form-config/embed?host=landing');
  });
});

describe('responsiveFormDevice', () => {
  it('uses the host page viewport instead of the iframe column width', () => {
    expect(responsiveFormDevice(1280)).toBe('desktop');
    expect(responsiveFormDevice(768)).toBe('tablet');
    expect(responsiveFormDevice(390)).toBe('mobile');
  });
});

describe('sendHeroFormContext', () => {
  it('forwards the landing-page URL and title to the embedded form', () => {
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } };

    expect(sendHeroFormContext(
      frame,
      'https://example.com/?utm_source=adwords&utm_medium=ppc',
      'Campaign page',
      'https://example.com',
    )).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      source: 'gbs-web-form-host',
      type: 'context',
      pageUrl: 'https://example.com/?utm_source=adwords&utm_medium=ppc',
      pageTitle: 'Campaign page',
    }, 'https://example.com');
  });

  it('does nothing when the embedded frame is unavailable', () => {
    expect(sendHeroFormContext(null)).toBe(false);
  });
});

describe('injectHeroForm', () => {
  it('starts the complete landing-form document eagerly with the page', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    try {
      const frame = injectLandingHeroForm(mount);
      expect(frame.getAttribute('src')).toBe('/api/landing-form-config/embed?host=landing');
      expect(frame.getAttribute('loading')).toBe('eager');
      expect(frame.getAttribute('fetchpriority')).toBe('high');
      expect(mount.shadowRoot).toBeNull();
    } finally {
      mount.remove();
    }
  });

  it('injects the iframe into a closed shadow root', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    try {
      const frame = injectHeroForm(mount, 11);
      expect(frame).toBeTruthy();
      expect(frame.getAttribute('src')).toBe('/embed/web-form.html?id=11');
      expect(frame.getAttribute('allow')).toBe('geolocation *');
      expect(frame.getAttribute('loading')).toBe('eager');
      expect(frame.style.height).toBe('auto');
      expect(frame.style.minHeight).toBe('0px');
      expect(mount.shadowRoot).toBeNull();
      expect(mount.querySelector('iframe')).toBeNull();
    } finally {
      mount.remove();
    }
  });

  it('rejects missing mount / bad ids without touching the DOM', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    try {
      expect(injectHeroForm(null, 11)).toBeNull();
      expect(injectHeroForm(mount, 0)).toBeNull();
      expect(injectHeroForm(mount, NaN)).toBeNull();
      expect(mount.childNodes.length).toBe(0);
    } finally {
      mount.remove();
    }
  });

  it('uses the embedded form measurement instead of a fixed frame height', () => {
    const frame = document.createElement('iframe');
    frame.style.height = 'auto';
    frame.style.minHeight = '0px';

    expect(resizeHeroFormFrame(frame, 641.2)).toBe(true);
    expect(frame.style.height).toBe('642px');
    expect(frame.style.minHeight).toBe('0px');

    expect(resizeHeroFormFrame(frame, 0)).toBe(false);
    expect(resizeHeroFormFrame(frame, 'not-a-height')).toBe(false);
    expect(frame.style.height).toBe('642px');
  });
});

describe('Landing dynamic hero form', () => {
  let realFetch;

  beforeEach(() => {
    realFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('mounts the complete form document without a client-side config request', async () => {
    global.fetch = vi.fn();
    const { container } = renderLanding();
    await waitFor(() => {
      expect(container.querySelector('#hero-form-mount')).toBeTruthy();
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(lightDomFrame(container)).toBeNull();
  });

  it('renders no form-management UI on the public page', async () => {
    global.fetch = vi.fn();
    renderLanding();
    expect(screen.queryByRole('button', { name: /landing page|Change form|Add form/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
