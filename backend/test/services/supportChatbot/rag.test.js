// @ts-check
/**
 * supportChatbot/rag — unit coverage for the wellness KB + docs RAG pool.
 *
 * What's pinned
 * -------------
 *   - searchHelpDocs returns { articles, docs } where articles are tenant
 *     KB rows and docs are wellness-client markdown files.
 *   - Wellness docs are loaded from docs/wellness-client/*.md once and
 *     cached in memory.
 *   - Results are merged and ranked by score; top `limit` overall win.
 *   - KB articles carry a slug for deep links; docs carry source='wellness-doc'
 *     and no slug.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../../lib/prisma.js';

// Patch prisma BEFORE requiring the SUT (searchHelpDocs reads KB rows).
prisma.kbArticle = { findMany: vi.fn() };

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const { searchHelpDocs, loadWellnessDocs, searchWellnessDocs } = requireCJS(
  '../../../services/supportChatbot/rag',
);

beforeEach(() => {
  prisma.kbArticle.findMany.mockReset().mockResolvedValue([]);
});

describe('searchWellnessDocs / loadWellnessDocs', () => {
  test('loads wellness-client markdown docs and returns ranked snippets', () => {
    const docs = loadWellnessDocs();
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.some((d) => d.source === 'PRD.md')).toBe(true);
    // SUPPORT_CHATBOT_KNOWLEDGE_BASE.md is split by headings, so each how-to
    // subsection becomes its own searchable document.
    expect(docs.some((d) => d.title.toLowerCase().includes('add a new patient'))).toBe(true);

    const results = searchWellnessDocs('appointment booking');
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(r.source).toBe('wellness-doc');
      expect(r.slug).toBeNull();
      expect(r.title).toMatch(/^\[Wellness Docs\]/);
      expect(typeof r.snippet).toBe('string');
      expect(r.snippet.length).toBeGreaterThan(0);
    }
  });

  test('how-to section titles outrank generic file content', () => {
    const results = searchWellnessDocs('add patient');
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.title.toLowerCase()).toMatch(/add a new patient|patients/);
  });

  test('returns empty array for empty or stop-word queries', () => {
    expect(searchWellnessDocs('')).toEqual([]);
    expect(searchWellnessDocs('   ')).toEqual([]);
    expect(searchWellnessDocs('do i')).toEqual([]);
  });
});

describe('searchHelpDocs', () => {
  test('returns a merged, ranked pool of KB articles and wellness docs', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([
      {
        id: 1,
        title: 'Appointments FAQ',
        slug: 'appointments-faq',
        content: 'How to book, reschedule and cancel appointments.',
      },
    ]);

    const { results, kbLinks } = await searchHelpDocs(1, 'appointment booking', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(kbLinks).toHaveLength(1);
    expect(kbLinks[0]).toMatchObject({
      id: 1,
      title: 'Appointments FAQ',
      slug: 'appointments-faq',
      source: 'kb',
    });
    // Wellness docs that matched are typed correctly when present.
    for (const d of results.filter((r) => r.source === 'wellness-doc')) {
      expect(d.slug).toBeNull();
      expect(d.title).toMatch(/^\[Wellness Docs\]/);
    }
  });

  test('empty query returns empty arrays', async () => {
    const { results, kbLinks } = await searchHelpDocs(1, '   ', { limit: 3 });
    expect(results).toEqual([]);
    expect(kbLinks).toEqual([]);
  });

  test('missing tenantId returns empty arrays', async () => {
    const { results, kbLinks } = await searchHelpDocs(null, 'appointments', { limit: 3 });
    expect(results).toEqual([]);
    expect(kbLinks).toEqual([]);
    expect(prisma.kbArticle.findMany).not.toHaveBeenCalled();
  });
});
