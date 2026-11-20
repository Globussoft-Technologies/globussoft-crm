// Backpressure for independent side effects. Results preserve input order.
async function mapBounded(items, concurrency, work) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.min(concurrency, 8))) }, worker));
  return results;
}
module.exports = { mapBounded };
