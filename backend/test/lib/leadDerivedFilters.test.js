import { describe, expect, test, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const { matchingContactIds, distinctValues, literalLike } = requireCJS('../../lib/leadDerivedFilters');
prisma.$queryRaw = vi.fn();
beforeEach(() => prisma.$queryRaw.mockReset().mockResolvedValue([]));

describe('derived Lead filters', () => {
  test.each(['first', 'last'])('filters the %s name expression, not the full name', async (namePart) => {
    await matchingContactIds({ tenantId: 14, status: 'Lead', assignedToId: 7, namePart, operator: 'contains', values: ['John'] });
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.sql).toContain(namePart === 'first' ? 'SUBSTRING_INDEX' : 'LOCATE');
    expect(query.sql).toContain('REGEXP_REPLACE');
    expect(query.values).toEqual(expect.arrayContaining([14, 'Lead', 7, '%John%']));
    expect(query.sql).not.toContain('LIMIT');
  });
  test.each(['contains', 'not_contains', 'is_empty', 'is_not_empty'])('tracking %s uses a guarded JSON path and tenant-owned submissions', async (operator) => {
    await matchingContactIds({ tenantId: 14, trackingField: 'utm_source', operator, values: ['Google'] });
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.sql).toContain('JSON_VALID');
    expect(query.sql).toContain('JSON_TYPE');
    expect(query.sql).toContain('s.tenantId = c.tenantId');
    expect(query.values).toContain('$._meta.tracking.utm_source');
    if (operator.endsWith('empty')) expect(query.sql).toContain("<> ''");
    if (operator === 'not_contains' || operator === 'is_empty') expect(query.sql).toContain('NOT');
  });
  test.each([{ namePart: 'first' }, { namePart: 'last' }, { trackingField: 'utm_source' }])('searches the complete dataset before DISTINCT and the result limit: %o', async (field) => {
    prisma.$queryRaw.mockResolvedValue([{ value: 'Match beyond row 1000' }]);
    const values = await distinctValues({ tenantId: 14, status: 'Lead', search: 'beyond', ...field });
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.sql).toContain('SELECT DISTINCT');
    expect(query.sql.indexOf('LIKE')).toBeLessThan(query.sql.indexOf('LIMIT 200'));
    expect(query.sql).not.toContain('1000');
    expect(query.values).toEqual(expect.arrayContaining([14, 'Lead', '%beyond%']));
    expect(values).toEqual([{ value: 'Match beyond row 1000', label: 'Match beyond row 1000' }]);
  });
  test('keeps LIKE wildcard and SQL-looking input literal and bound', async () => {
    expect(literalLike('50%_off=')).toBe('%50=%=_off==%');
    await distinctValues({ tenantId: 14, namePart: 'first', search: "' OR 1=1 --" });
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.sql).not.toContain('OR 1=1');
    expect(query.values).toContain("%' OR 1==1 --%");
  });
});
