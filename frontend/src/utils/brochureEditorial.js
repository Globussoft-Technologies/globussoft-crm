// Convert operational itinerary rows into presentation-ready brochure facts.
// These helpers are travel-only and deliberately preserve meaning while
// collapsing semantic duplicates that are painful to read in print.

export function summarizeImportedTransfers(items = []) {
  let hasArrival = false;
  let hasDeparture = false;
  const intercity = new Set();
  const rail = new Set();
  const hotelAreas = new Set();

  for (const item of items) {
    const text = String(item?.description || item || '').replace(/\s+/g, ' ').replace(/[.;]+$/, '').trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (/train|rail/.test(lower)) {
      rail.add(text);
      continue;
    }
    if (/airport/.test(lower)) {
      if (/return|back to|departure|to (?:the )?(?:[a-z ]+ )?airport/.test(lower)) hasDeparture = true;
      if (/airport.*(?:hotel|resort)|from (?:the )?(?:[a-z ]+ )?airport/.test(lower)) hasArrival = true;
      if (!hasArrival && !hasDeparture) intercity.add(text);
      continue;
    }
    const area = text.match(/\b(?:to|in)\s+((?:north|south|east|west|central)\s+[a-z][a-z -]*)/i)?.[1];
    if (area) hotelAreas.add(area.replace(/\b\w/g, (char) => char.toUpperCase()));
    else intercity.add(text);
  }

  const airportTransfers = hasArrival && hasDeparture
    ? 'Airport-hotel transfers on arrival and departure'
    : hasArrival
      ? 'Arrival transfer from the airport to the hotel'
      : hasDeparture
        ? 'Departure transfer from the hotel to the airport'
        : '';
  if (hotelAreas.size > 1) intercity.add(`Hotel transfers between ${[...hotelAreas].join(' and ')}`);
  else if (hotelAreas.size === 1) intercity.add(`Hotel transfer to ${[...hotelAreas][0]}`);

  return {
    airportTransfers,
    intercityTransport: [...intercity].join('; '),
    railJourneys: [...rail].join('; '),
  };
}

export function summarizeImportedHotels(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    let name = String(row?.name || '').replace(/\s+/g, ' ').trim();
    if (!name || /\bcheck[- ]?out\b|\btransfer\b|\bdeparture\b/i.test(name)) continue;
    let city = String(row?.city || '').replace(/\s+/g, ' ').trim();
    if (!row?._structuredName) {
      const area = name.match(/\b(?:in|at)\s+((?:north|south|east|west|central)\s+[a-z][a-z -]*)/i)?.[1];
      if (area) city = area.replace(/\b\w/g, (char) => char.toUpperCase());
      name = name
        .replace(/^\s*(?:\d+[- ]night\s+)?(?:stay|check[- ]?in)\s+(?:at|in)\s+/i, '')
        .replace(/^(?:a|the)\s+/i, '')
        .replace(/\s+in\s+(?:north|south|east|west|central)\s+[a-z][a-z -]*$/i, '')
        .trim();
      if (name) name = name.charAt(0).toUpperCase() + name.slice(1);
    }
    if (!name) continue;
    const key = `${name.toLowerCase()}|${city.toLowerCase()}|${String(row?.category || '').toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing) existing.nights += Number(row?.nights) || 1;
    else grouped.set(key, { name, city, category: row?.category || '', nights: Number(row?.nights) || 1 });
  }
  return [...grouped.values()];
}
