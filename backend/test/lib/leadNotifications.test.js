import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

const notifyMock = vi.fn();

// Patch the real CJS dependency before loading the SUT so the require() call
// inside backend/lib/leadNotifications.js sees our mock notify() helper.
const notificationServicePath = requireCJS.resolve('../../lib/notificationService.js');
Module._cache[notificationServicePath] = {
  id: notificationServicePath,
  filename: notificationServicePath,
  loaded: true,
  exports: { notify: notifyMock },
  children: [],
  paths: [],
};

const leadNotifications = requireCJS('../../lib/leadNotifications.js');

const {
  allowlistEntryMatchesOrigin,
  isEmbedOriginAllowed,
  normalizeEmbedOrigin,
  notifyAdminsOfBlockedLeadOrigin,
} = leadNotifications;

describe('lib/leadNotifications', () => {
  beforeEach(() => {
    notifyMock.mockReset();
    prisma.user = prisma.user || {};
    prisma.user.findMany = vi.fn();
  });

  test('normalizeEmbedOrigin trims, lowercases and strips path/query/hash', () => {
    expect(normalizeEmbedOrigin(' https://APP.Example.com/path?q=1#frag ')).toBe(
      'https://app.example.com',
    );
  });

  test('allowlistEntryMatchesOrigin supports leftmost wildcards', () => {
    expect(
      allowlistEntryMatchesOrigin(
        'https://sub.mysite.com',
        'https://*.mysite.com',
      ),
    ).toBe(true);
    expect(
      allowlistEntryMatchesOrigin(
        'https://mysite.com',
        'https://*.mysite.com',
      ),
    ).toBe(true);
  });

  test('isEmbedOriginAllowed returns false for blocked origins when an allowlist is present', () => {
    const allowlist = JSON.stringify(['https://*.mysite.com']);
    expect(isEmbedOriginAllowed('https://sub.mysite.com', allowlist)).toBe(true);
    expect(isEmbedOriginAllowed('https://mysite.com', allowlist)).toBe(true);
    expect(isEmbedOriginAllowed('https://evil.com', allowlist)).toBe(false);
  });

  test('notifyAdminsOfBlockedLeadOrigin notifies each tenant admin with a settings link', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 11 }, { id: 22 }]);
    notifyMock.mockResolvedValue({ id: 99 });

    const result = await notifyAdminsOfBlockedLeadOrigin({
      tenantId: 7,
      origin: 'https://blocked.example.com/path',
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 7,
        role: 'ADMIN',
        deactivatedAt: null,
      },
      select: { id: true },
    });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 11,
        tenantId: 7,
        title: 'External lead origin blocked',
        type: 'warning',
        category: 'lead',
        priority: 'high',
        link: '/settings',
        entityType: 'lead_domain',
        channels: ['db', 'socket'],
      }),
    );
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 22,
        tenantId: 7,
        message: expect.stringContaining('https://blocked.example.com'),
      }),
    );
    expect(result).toHaveLength(2);
  });
});
