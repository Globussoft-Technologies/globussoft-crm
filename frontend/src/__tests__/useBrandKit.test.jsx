// Branding Wave 4 G102 — useBrandKit hook tests.
//
// Pins the per-sub-brand BrandKit lookup contract that Sidebar + the
// Travel operator pages rely on:
//   - Mounts → fetches /api/brand-kits/active/<subBrand>
//   - Caches per-subBrand at module scope (no re-fetch within a page)
//   - 404 / null response caches a `null` result (no re-fetch)
//   - null subBrand translates to /active/_ (tenant-wide kit)
//   - brandPrimaryColor / brandLogoUrl convenience accessors return the
//     kit's value or the documented fallback.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import {
  useBrandKit,
  brandPrimaryColor,
  brandLogoUrl,
  __resetBrandKitCache,
} from '../hooks/useBrandKit';

function Probe({ subBrand }) {
  const { brandKit, loading } = useBrandKit(subBrand);
  return (
    <div>
      <span data-testid="loading">{loading ? 'yes' : 'no'}</span>
      <span data-testid="logo">{brandKit?.logoUrl || ''}</span>
      <span data-testid="primary">{brandKit?.primaryColor || ''}</span>
      <span data-testid="kit-id">{brandKit?.id ?? 'null'}</span>
    </div>
  );
}

beforeEach(() => {
  __resetBrandKitCache();
  fetchApi.mockReset();
});

afterEach(() => {
  __resetBrandKitCache();
});

describe('useBrandKit', () => {
  it('fetches the sub-brand-scoped kit on mount', async () => {
    fetchApi.mockResolvedValue({
      brandKit: {
        id: 7,
        tenantId: 9,
        subBrand: 'tmc',
        isActive: true,
        logoUrl: 'https://cdn.example/tmc.png',
        primaryColor: '#122647',
      },
    });
    render(<Probe subBrand="tmc" />);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('no'));
    expect(fetchApi).toHaveBeenCalledWith('/api/brand-kits/active/tmc', expect.any(Object));
    expect(screen.getByTestId('logo').textContent).toBe('https://cdn.example/tmc.png');
    expect(screen.getByTestId('primary').textContent).toBe('#122647');
    expect(screen.getByTestId('kit-id').textContent).toBe('7');
  });

  it('caches per-subBrand (second mount does not re-fetch)', async () => {
    fetchApi.mockResolvedValue({
      brandKit: { id: 7, tenantId: 9, subBrand: 'tmc', primaryColor: '#122647' },
    });
    const { unmount } = render(<Probe subBrand="tmc" />);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('no'));
    unmount();
    fetchApi.mockClear();
    render(<Probe subBrand="tmc" />);
    // Cache hit: loading should NOT be 'yes' (instant resolution).
    expect(screen.getByTestId('loading').textContent).toBe('no');
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('caches null for sub-brand with no kit (404 / endpoint missing)', async () => {
    fetchApi.mockResolvedValue({ brandKit: null });
    render(<Probe subBrand="rfu" />);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('no'));
    expect(screen.getByTestId('kit-id').textContent).toBe('null');
    expect(screen.getByTestId('logo').textContent).toBe('');
    // Re-mount: still cached, no new fetch
    fetchApi.mockClear();
    render(<Probe subBrand="rfu" />);
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('translates null subBrand to the /_ tenant-wide path', async () => {
    fetchApi.mockResolvedValue({
      brandKit: { id: 1, tenantId: 9, subBrand: null, primaryColor: '#000000' },
    });
    render(<Probe subBrand={null} />);
    await waitFor(() => expect(screen.getByTestId('kit-id').textContent).toBe('1'));
    expect(fetchApi).toHaveBeenCalledWith('/api/brand-kits/active/_', expect.any(Object));
  });

  it('returns null on fetch failure (degrades gracefully)', async () => {
    fetchApi.mockRejectedValue(new Error('network'));
    render(<Probe subBrand="visasure" />);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('no'));
    expect(screen.getByTestId('kit-id').textContent).toBe('null');
  });

  it('caches separately per sub-brand (tmc vs rfu)', async () => {
    fetchApi
      .mockResolvedValueOnce({ brandKit: { id: 7, primaryColor: '#122647' } })
      .mockResolvedValueOnce({ brandKit: { id: 8, primaryColor: '#265855' } });
    const { unmount: u1 } = render(<Probe subBrand="tmc" />);
    await waitFor(() => expect(screen.getByTestId('primary').textContent).toBe('#122647'));
    u1();
    render(<Probe subBrand="rfu" />);
    await waitFor(() => expect(screen.getByTestId('primary').textContent).toBe('#265855'));
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });
});

describe('brandPrimaryColor', () => {
  it('returns the kit primaryColor when present', () => {
    expect(brandPrimaryColor({ primaryColor: '#122647' })).toBe('#122647');
  });

  it('returns the fallback when kit is null', () => {
    expect(brandPrimaryColor(null)).toBe('var(--primary-color, var(--accent-color))');
  });

  it('returns the fallback when kit has no primaryColor', () => {
    expect(brandPrimaryColor({ logoUrl: 'x.png' })).toBe('var(--primary-color, var(--accent-color))');
  });

  it('honours an explicit fallback override', () => {
    expect(brandPrimaryColor(null, '#abcdef')).toBe('#abcdef');
  });
});

describe('brandLogoUrl', () => {
  it('returns the kit logoUrl when present', () => {
    expect(brandLogoUrl({ logoUrl: 'https://cdn/x.png' })).toBe('https://cdn/x.png');
  });

  it('returns null when kit is missing or has no logoUrl', () => {
    expect(brandLogoUrl(null)).toBeNull();
    expect(brandLogoUrl({ primaryColor: '#000' })).toBeNull();
  });
});
