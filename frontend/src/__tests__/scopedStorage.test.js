import { describe, expect, it } from 'vitest';
import { scopedStorageKey } from '../utils/scopedStorage';

describe('scopedStorageKey', () => {
  it('isolates values by tenant and user', () => {
    expect(scopedStorageKey('draft', { tenantId: 1, userId: 2 }))
      .not.toBe(scopedStorageKey('draft', { tenantId: 1, userId: 3 }));
    expect(scopedStorageKey('draft', { tenantId: 1, userId: 2 }))
      .not.toBe(scopedStorageKey('draft', { tenantId: 2, userId: 2 }));
  });

  it('adds a resource discriminator when supplied', () => {
    expect(scopedStorageKey('draft', { tenantId: 1, userId: 2, resourceId: 9 }))
      .toBe('draft:tenant:1:user:2:resource:9');
  });
});
