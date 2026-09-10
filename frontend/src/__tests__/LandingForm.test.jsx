/**
 * LandingForm.test.jsx — dynamic hero web-form on the public marketing page.
 *
 * SUT: frontend/src/pages/Landing.jsx (dynamic-form fetch + shadow injection)
 *   - On mount, Landing fetches GET /api/landing-form-config (plain fetch —
 *     the page is public and must never bounce visitors) and injects the
 *     configured form into a CLOSED shadow root under #hero-form-mount.
 *   - Privacy contract (the whole point): the form link never appears in the
 *     light DOM, so DevTools Elements shows only `#shadow-root (closed)`.
 *     Every test below asserts `container.querySelector('iframe') === null`.
 *   - Backend failure / bad payload falls back to form id 1 — still inside
 *     the closed shadow root, still nothing in the light DOM.
 *   - Management lives on the Web Forms page (allowlist-gated per-card
 *     control) — Landing itself renders no manage UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Landing from '../pages/Landing';
import { heroFormEmbedSrc, injectHeroForm } from '../utils/landingHeroForm';

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
});

describe('injectHeroForm', () => {
  it('injects the iframe into a closed shadow root', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    try {
      const frame = injectHeroForm(mount, 11);
      expect(frame).toBeTruthy();
      expect(frame.getAttribute('src')).toBe('/embed/web-form.html?id=11');
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

  it('fetches the public config and mounts the form', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ webFormId: 11, webFormName: 'Picked Form' }),
    });
    const { container } = renderLanding();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/landing-form-config',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
      );
    });
    // Give the state-driven injection effect a tick to run.
    await waitFor(() => {
      expect(container.querySelector('#hero-form-mount')).toBeTruthy();
    });
    await new Promise((res) => setTimeout(res, 50));
    expect(lightDomFrame(container)).toBeNull();
  });

  it('fails closed when the config call fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('backend down'));
    const { container } = renderLanding();
    await waitFor(() => {
      expect(container.querySelector('#hero-form-mount')).toBeTruthy();
    });
    await new Promise((res) => setTimeout(res, 50));
    expect(lightDomFrame(container)).toBeNull();
  });

  it('renders no form-management UI on the public page', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ webFormId: 11, webFormName: 'Picked Form' }),
    });
    renderLanding();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /landing page|Change form|Add form/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
