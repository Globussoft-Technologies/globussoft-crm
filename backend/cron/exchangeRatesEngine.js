const cronRegistry = require('../lib/cronRegistry');
const { getSnapshot } = require('../lib/dashboardExchangeRates');

async function tickExchangeRates() {
  const { snapshot, refreshFailed } = await getSnapshot();
  if (!snapshot || refreshFailed) throw new Error('Exchange-rate refresh failed; last successful snapshot retained');
  return { source: snapshot.source, checkedAt: snapshot.checkedAt };
}

function initExchangeRatesCron() {
  return cronRegistry.register({
    name: 'exchangeRatesEngine',
    description: 'Refresh public reference exchange rates for Generic dashboard valuations',
    defaultSchedule: '15 * * * *',
    tickFn: tickExchangeRates,
  }).catch(error => console.error('[ExchangeRates] registration failed:', error.message));
}

module.exports = { initExchangeRatesCron, tickExchangeRates };
