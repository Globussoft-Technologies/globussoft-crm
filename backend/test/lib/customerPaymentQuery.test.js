import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const { customerPaymentQuery } = requireCJS('../../lib/customerPaymentQuery');

describe('customer payment ownership SQL', () => {
  test('excludes standalone payments even when the family shares a contact', () => {
    const query = customerPaymentQuery({ tenantId: 14, patientId: 7 });
    expect(query.sql).toContain('p.invoiceId IS NOT NULL');
    expect(query.sql).not.toContain('contactId');
    expect(query.sql).toContain('i.patientId = ?');
    expect(query.sql).toContain('i.patientId IS NULL AND EXISTS');
    expect(query.sql).toContain('v.patientId = ?');
    expect(query.sql).toContain('i.tenantId = p.tenantId');
    expect(query.sql).toContain('v.tenantId = i.tenantId');
    expect(query.values).toEqual([14, 7, 7, 200]);
  });
  test('uses bounded, deterministic database-side lookups with bound filters', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const query = customerPaymentQuery({ tenantId: 14, patientId: 7, invoiceId: 8, status: 'SUCCESS', gateway: 'stripe', createdAt: { gte: from }, limit: 50 });
    expect(query.sql).toContain('ORDER BY p.createdAt DESC, p.id DESC LIMIT ?');
    expect(query.values).toEqual([14, 7, 7, 8, 'SUCCESS', 'stripe', from, 50]);
    expect(query.sql).not.toContain(' IN ');
    expect(query.sql).not.toContain('metadata');
  });
  test('detail lookup uses the same ownership predicate with a one-row limit', () => {
    const query = customerPaymentQuery({ tenantId: 14, patientId: 7, id: 9 });
    expect(query.values).toEqual([14, 7, 7, 9, 1]);
    expect(query.sql).toContain('AND p.id = ?');
  });
});
