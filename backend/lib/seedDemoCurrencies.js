// Deterministic demo snapshot, not a live market-rate feed. Rates share an
// INR base so the seeded INR reporting currency can value USD deals offline.
const USD_RATES = [
  ['USD', '$', 'US Dollar', 1],
  ['INR', '₹', 'Indian Rupee', 94.96],
  ['EUR', '€', 'Euro', 0.8887],
  ['GBP', '£', 'British Pound', 0.7503],
  ['CAD', 'C$', 'Canadian Dollar', 1.4161],
  ['AUD', 'A$', 'Australian Dollar', 1.4371],
];

async function seedDemoCurrencies(prisma, tenantId) {
  return prisma.currency.createMany({
    data: USD_RATES.map(([code, symbol, name, rate]) => ({
      tenantId, code, symbol, name,
      exchangeRate: rate / 94.96,
      isBase: code === 'INR',
    })),
  });
}

module.exports = { seedDemoCurrencies };
