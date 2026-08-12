import { describe, it, expect } from 'vitest';

const {
  parseSubBrandScope,
  resolveRoleSubBrandAccess,
  serializeSubBrandScope,
} = require('../../lib/rbacScope');

describe('rbacScope helpers', () => {
  it('serializes empty sub-brand scopes as null', () => {
    expect(serializeSubBrandScope([])).toBeNull();
    expect(serializeSubBrandScope(null)).toBeNull();
    expect(serializeSubBrandScope('')).toBeNull();
  });

  it('parses only valid sub-brand codes', () => {
    expect(parseSubBrandScope(['tmc', ' ', 'rfu', 'bad'])).toEqual(['tmc', 'rfu']);
  });

  it('treats empty role scopes as unrestricted when resolving access', () => {
    const access = resolveRoleSubBrandAccess({
      roles: [
        { subBrandScopeJson: null, subBrandScope: [] },
        { subBrandScopeJson: '["tmc"]', subBrandScope: ['tmc'] },
      ],
    });

    expect(Array.from(access || [])).toEqual(['tmc']);
  });

  it('returns null when no explicit role scope exists', () => {
    expect(resolveRoleSubBrandAccess({ roles: [{ subBrandScopeJson: null, subBrandScope: [] }] })).toBeNull();
  });
});
