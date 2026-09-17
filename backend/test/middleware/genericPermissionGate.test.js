import { beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import {
  genericPermissionGate,
  permissionForRequest,
} from '../../middleware/genericPermissionGate.js';
import { clearAllCache } from '../../middleware/requirePermission.js';

beforeEach(() => {
  prisma.tenant = { findUnique: vi.fn() };
  prisma.userRole = { findMany: vi.fn() };
  clearAllCache();
});

describe('genericPermissionGate', () => {
  test('maps every generic-only API surface to method-specific permissions', () => {
    const prefixes = {
      '/cpq': 'cpq',
      '/playbooks': 'playbooks',
      '/territories': 'territories',
      '/live-chat': 'live_chat',
      '/support': 'support',
      '/sla': 'sla',
      '/social': 'social',
      '/field-permissions': 'field_permissions',
      '/sandbox': 'sandbox',
      '/document-templates': 'document_templates',
      '/custom_objects': 'custom_objects',
      '/ai_scoring': 'lead_scoring',
      '/deal-insights': 'deal_insights',
      '/calendar': 'calendar',
      '/ab-tests': 'ab_tests',
      '/booking-pages': 'booking_pages',
      '/forms': 'web_forms',
    };

    for (const [prefix, module] of Object.entries(prefixes)) {
      expect(permissionForRequest(`${prefix}/42`, 'GET')).toEqual({ module, action: 'read' });
      expect(permissionForRequest(prefix, 'POST')).toEqual({ module, action: 'write' });
      expect(permissionForRequest(prefix, 'PATCH')).toEqual({ module, action: 'update' });
      expect(permissionForRequest(prefix, 'DELETE')).toEqual({ module, action: 'delete' });
    }
    expect(permissionForRequest('/wellness/patients', 'GET')).toBeNull();
  });

  test('does not change wellness or travel API behavior', async () => {
    for (const vertical of ['wellness', 'travel']) {
      const req = { path: '/cpq', method: 'GET', user: { tenantId: 7, vertical } };
      const next = vi.fn();
      await genericPermissionGate(req, {}, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  test('fails closed when generic tenant ownership cannot be resolved', async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error('database unavailable'));
    const req = { path: '/cpq', method: 'GET', user: { tenantId: 7 } };
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const next = vi.fn();

    await genericPermissionGate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_ACCESS_UNAVAILABLE' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('denies direct generic API calls without the mapped permission', async () => {
    prisma.userRole.findMany.mockResolvedValue([{ role: { permissions: [] } }]);
    const req = {
      path: '/cpq',
      method: 'GET',
      user: { tenantId: 7, userId: 9, vertical: 'generic', role: 'USER' },
    };
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const next = vi.fn();

    await genericPermissionGate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'RBAC_DENIED',
      required: 'cpq.read',
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('allows direct generic API calls with the mapped permission', async () => {
    prisma.userRole.findMany.mockResolvedValue([{
      role: { permissions: [{ module: 'cpq', action: 'read' }] },
    }]);
    const req = {
      path: '/cpq',
      method: 'GET',
      user: { tenantId: 7, userId: 9, vertical: 'generic', role: 'USER' },
    };
    const next = vi.fn();

    await genericPermissionGate(req, {}, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
