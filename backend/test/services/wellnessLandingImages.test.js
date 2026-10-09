import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const imageProvider = requireCjs('../../services/destinationImageProvider.js');
const service = requireCjs('../../services/wellnessLandingImages.js');

function image(id, src = '') {
  return {
    id,
    type: 'image',
    props: { src, alt: '', variant: id === 'cta-image' ? 'wellness-cta-image' : 'wellness-hero-image' },
  };
}

function wellnessContent() {
  return [{
    id: 'wellness-page',
    type: 'columns',
    props: {
      variant: 'wellness-campaign-page',
      columns: [{
        components: [{
          id: 'wellness-hero-row',
          type: 'columns',
          props: {
            variant: 'wellness-hero-row',
            columns: [{ components: [image('hero-image', 'https://example.com/hero.jpg')] }],
          },
        }, {
          id: 'wellness-gallery-row',
          type: 'columns',
          props: {
            variant: 'wellness-gallery-row',
            columns: [{ components: [image('gallery-image-1', 'https://example.com/hero.jpg')] }, { components: [image('gallery-image-2')] }, { components: [image('gallery-image-3')] }],
          },
        }, {
          id: 'wellness-cta-row',
          type: 'columns',
          props: {
            variant: 'wellness-cta-row',
            columns: [{ components: [image('cta-image')] }],
          },
        }],
      }],
    },
  }];
}

afterEach(() => {
  delete process.env.PEXELS_API_KEY;
  service._resetForTests();
  vi.restoreAllMocks();
});

describe('hydrateWellnessLandingImages', () => {
  test('leaves Generic and Travel pages untouched without image lookups or writes', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    const fetchOne = vi.spyOn(imageProvider, 'fetchOne');
    const updateMany = vi.fn();
    for (const templateType of ['generic-site-real_estate-v1', 'generic-site-technology-v1', 'travel-stall-v1']) {
      const page = { id: 42, tenantId: 7, templateType, content: '[]' };
      expect(await service.hydrateWellnessLandingImages(page, { db: { landingPage: { updateMany } } })).toBe(page);
    }
    expect(fetchOne).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  test('a concurrent edit wins over the image hydration snapshot', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    vi.spyOn(imageProvider, 'fetchOne').mockResolvedValue({ url: 'https://images.pexels.com/new.jpg', attribution: { providerId: 'pexels' } });
    const page = { id: 42, tenantId: 7, content: JSON.stringify(wellnessContent()), updatedAt: new Date('2026-01-01') };
    const latest = { ...page, content: '[]', title: 'Newer edit' };
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirst = vi.fn().mockResolvedValue(latest);
    const result = await service.hydrateWellnessLandingImages(page, { db: { landingPage: { updateMany, findFirst } } });
    expect(result).toBe(latest);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42, tenantId: 7, content: page.content, updatedAt: page.updatedAt } }));
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 42, tenantId: 7 } });
  });

  test('historical preview stays immutable while the same live page is hydrating', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    let resolveImage;
    const firstImage = new Promise(resolve => { resolveImage = resolve; });
    vi.spyOn(imageProvider, 'fetchOne').mockReturnValueOnce(firstImage).mockResolvedValue(null);
    const page = { id: 42, tenantId: 7, title: 'Live', content: JSON.stringify(wellnessContent()) };
    const live = service.hydrateWellnessLandingImages(page);
    const historical = { ...page, title: 'Historical version', content: '[]' };
    expect(await service.hydrateWellnessLandingImages(historical, { persist: false })).toBe(historical);
    resolveImage({ url: 'https://images.pexels.com/live.jpg', attribution: { providerId: 'pexels' } });
    expect((await live).title).toBe('Live');
  });
  test('fills missing and duplicate slots with distinct Pexels images and persists them', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    const images = ['gallery-one.jpg', 'gallery-two.jpg', 'gallery-three.jpg', 'cta.jpg'];
    const fetchOne = vi.spyOn(imageProvider, 'fetchOne').mockImplementation(async () => ({
      url: `https://images.pexels.com/${images.shift()}`,
      attribution: { providerId: 'pexels', photographer: 'Test Photographer' },
    }));
    const update = vi.fn().mockResolvedValue({ count: 1 });
    const page = {
      id: 42,
      slug: 'wellness-event',
      tenantId: 7,
      title: 'Eye Checkup Event',
      description: 'A community eye health consultation day.',
      content: JSON.stringify(wellnessContent()),
    };

    const result = await service.hydrateWellnessLandingImages(page, {
      db: { landingPage: { updateMany: update } },
    });
    const parsed = JSON.parse(result.content);
    const slots = service._collectBlocks(parsed).filter((block) => block.type === 'image');
    const urls = slots.map((block) => block.props.src).filter(Boolean);

    expect(fetchOne).toHaveBeenCalledTimes(4);
    expect(fetchOne.mock.calls.every(([, options]) => options.excludeProviders.includes('unsplash'))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
    expect(slots.find((block) => block.id === 'cta-image').props.src).toContain('cta.jpg');
    expect(slots.find((block) => block.id === 'cta-image').props.imageProvider).toBe('pexels');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42, tenantId: 7, content: page.content }, data: expect.objectContaining({ content: expect.any(String) }) }));
  });

  test('does not call a provider when the Pexels key is unavailable', async () => {
    const fetchOne = vi.spyOn(imageProvider, 'fetchOne');
    const page = { id: 42, slug: 'wellness-event', content: JSON.stringify(wellnessContent()) };
    const result = await service.hydrateWellnessLandingImages(page);

    expect(result).toBe(page);
    expect(fetchOne).not.toHaveBeenCalled();
  });

  test('builds and hydrates an empty generic wellness scaffold', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    vi.spyOn(imageProvider, 'fetchOne').mockImplementation(async (_query, options) => ({
      url: `https://images.pexels.com/${options.aspectRatio.replace(':', '-')}-${Math.random()}.jpg`,
      attribution: { providerId: 'pexels', photographer: 'Test Photographer' },
    }));
    const page = {
      id: 43,
      slug: 'new-wellness-event',
      templateType: 'generic-site-health-v1',
      title: 'New Wellness Event',
      content: '[]',
    };

    const result = await service.hydrateWellnessLandingImages(page);
    const parsed = JSON.parse(result.content);

    expect(parsed.some((block) => block.props?.variant === 'wellness-campaign-page')).toBe(true);
    expect(service._collectBlocks(parsed).filter((block) => block.type === 'image' && block.props?.src).length).toBe(5);
  });
});
