const { seedDemoCurrencies } = require('../../lib/seedDemoCurrencies');

describe('demo currency seed', () => {
  test('persists tenant-scoped INR-based rates for every starter currency', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 6 });
    await seedDemoCurrencies({ currency: { createMany } }, 7);
    const { data } = createMany.mock.calls[0][0];
    expect(data).toHaveLength(6);
    expect(data.every(row => row.tenantId === 7 && row.exchangeRate > 0)).toBe(true);
    expect(data.filter(row => row.isBase).map(row => row.code)).toEqual(['INR']);
    const rates = Object.fromEntries(data.map(row => [row.code, row.exchangeRate]));
    expect(rates.INR).toBe(1);
    expect(100 * rates.INR / rates.USD).toBeCloseTo(9496);
  });
});
