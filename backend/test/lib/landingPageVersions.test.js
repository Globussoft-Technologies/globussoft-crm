// Unit tests for backend/lib/landingPageVersions.js
//
// Mocking strategy mirrors backend/test/lib/audit.test.js — patch the
// prisma singleton's `landingPageVersion` model with vi.fn() shapes at
// beforeAll(). vitest 4's vi.mock does NOT intercept CJS require() so
// the singleton-patch is the load-bearing seam.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { snapshot, snapshotSafe, VERSION_SOURCES } = requireCJS('../../lib/landingPageVersions');

beforeAll(() => {
  prisma.landingPageVersion = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
});

beforeEach(() => {
  prisma.landingPageVersion.findFirst.mockReset().mockResolvedValue(null);
  prisma.landingPageVersion.create.mockReset().mockImplementation(({ data }) => Promise.resolve({ id: 99, ...data }));
});

function pageRow(overrides = {}) {
  return {
    id: 7,
    title: 'Spring Sale',
    slug: 'spring-sale',
    content: '[{"type":"heading","props":{"text":"Hi"}}]',
    tenantId: 1,
    ...overrides,
  };
}

describe('lib/landingPageVersions — module shape', () => {
  test('exports snapshot, snapshotSafe, and the VERSION_SOURCES enum', () => {
    expect(typeof snapshot).toBe('function');
    expect(typeof snapshotSafe).toBe('function');
    expect(VERSION_SOURCES).toEqual({
      CREATE: 'CREATE',
      MANUAL_SAVE: 'MANUAL_SAVE',
      PUBLISH: 'PUBLISH',
      AI_GENERATION: 'AI_GENERATION',
      RESTORE: 'RESTORE',
    });
  });

  test('VERSION_SOURCES is frozen', () => {
    expect(Object.isFrozen(VERSION_SOURCES)).toBe(true);
  });
});

describe('snapshot()', () => {
  test('rejects when page row has no numeric id', async () => {
    await expect(snapshot(prisma, { id: 'abc' }, VERSION_SOURCES.CREATE, {})).rejects.toThrow(/numeric id/);
  });

  test('rejects an unknown source', async () => {
    await expect(snapshot(prisma, pageRow(), 'BOGUS', {})).rejects.toThrow(/source must be one of/);
  });

  test('assigns versionNumber=1 when no prior versions exist', async () => {
    prisma.landingPageVersion.findFirst.mockResolvedValue(null);
    await snapshot(prisma, pageRow(), VERSION_SOURCES.CREATE, { userId: 4 });
    const arg = prisma.landingPageVersion.create.mock.calls[0][0];
    expect(arg.data.versionNumber).toBe(1);
    expect(arg.data.source).toBe('CREATE');
    expect(arg.data.landingPageId).toBe(7);
    expect(arg.data.createdById).toBe(4);
    expect(arg.data.tenantId).toBe(1);
  });

  test('increments versionNumber from the last existing snapshot', async () => {
    prisma.landingPageVersion.findFirst.mockResolvedValue({ versionNumber: 12 });
    await snapshot(prisma, pageRow(), VERSION_SOURCES.MANUAL_SAVE, { userId: 4 });
    expect(prisma.landingPageVersion.create.mock.calls[0][0].data.versionNumber).toBe(13);
  });

  test('stringifies an object content body before storing', async () => {
    const blocks = [{ type: 'heading', props: { text: 'Hi' } }];
    await snapshot(prisma, pageRow({ content: blocks }), VERSION_SOURCES.CREATE, {});
    const writtenContent = prisma.landingPageVersion.create.mock.calls[0][0].data.content;
    expect(typeof writtenContent).toBe('string');
    expect(JSON.parse(writtenContent)).toEqual(blocks);
  });

  test('passes restoredFromVersionId through when supplied', async () => {
    await snapshot(prisma, pageRow(), VERSION_SOURCES.RESTORE, { userId: 4 }, { restoredFromVersionId: 41 });
    expect(prisma.landingPageVersion.create.mock.calls[0][0].data.restoredFromVersionId).toBe(41);
  });

  test('defaults restoredFromVersionId to null when omitted', async () => {
    await snapshot(prisma, pageRow(), VERSION_SOURCES.MANUAL_SAVE, { userId: 4 });
    expect(prisma.landingPageVersion.create.mock.calls[0][0].data.restoredFromVersionId).toBeNull();
  });

  test('tolerates a null actor (createdById ends up null)', async () => {
    await snapshot(prisma, pageRow(), VERSION_SOURCES.PUBLISH, null);
    expect(prisma.landingPageVersion.create.mock.calls[0][0].data.createdById).toBeNull();
  });

  test('substitutes empty string for missing title/slug', async () => {
    await snapshot(prisma, pageRow({ title: undefined, slug: undefined }), VERSION_SOURCES.CREATE, {});
    const data = prisma.landingPageVersion.create.mock.calls[0][0].data;
    expect(data.title).toBe('');
    expect(data.slug).toBe('');
  });
});

describe('snapshotSafe()', () => {
  test('returns the created row on success', async () => {
    const result = await snapshotSafe(prisma, pageRow(), VERSION_SOURCES.CREATE, { userId: 4 });
    expect(result).toBeTruthy();
    expect(result.versionNumber).toBe(1);
  });

  test('swallows errors and returns null', async () => {
    prisma.landingPageVersion.create.mockRejectedValue(new Error('db down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await snapshotSafe(prisma, pageRow(), VERSION_SOURCES.CREATE, { userId: 4 });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
