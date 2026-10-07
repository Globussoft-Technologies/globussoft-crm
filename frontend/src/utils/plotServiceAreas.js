const INDIA_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry', 'Chandigarh',
];

// Plot addresses are frequently saved without a formal state component. Keep
// narrowly-scoped aliases for unambiguous city names so an address such as
// "Koramangala, Bangalore - 560095" still produces the correct state.
const CITY_STATE_ALIASES = [
  { pattern: /\b(?:Bangalore|Banglore|Bengaluru)\b/i, state: 'Karnataka' },
];

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function serviceAreaFromPlot(plot, suggestion = null) {
  const address = clean(plot?.address);
  const pincode = clean(suggestion?.postcode).match(/^\d{6}$/)?.[0]
    || address.match(/\b\d{6}\b/)?.[0]
    || '';
  const state = clean(suggestion?.state)
    || INDIA_STATES.find((candidate) => new RegExp(`\\b${candidate.replace(/ /g, '\\s+')}\\b`, 'i').test(address))
    || CITY_STATE_ALIASES.find(({ pattern }) => pattern.test(address))?.state
    || '';

  const parts = address.split(',').map((part) => part.trim()).filter(Boolean)
    .map((part) => part.replace(/\b\d{6}\b/g, '').replace(/[\s:,-]+$/g, '').trim())
    .filter((part) => part && !/^india$/i.test(part) && part.toLowerCase() !== state.toLowerCase());
  const fallbackArea = parts.length >= 3 ? parts[parts.length - 2] : parts[0] || clean(plot?.name);
  const area = clean(suggestion?.name)
    || clean(suggestion?.district)
    || clean(suggestion?.city)
    || fallbackArea;

  return {
    plotSiteId: Number(plot?.id),
    plotName: clean(plot?.name),
    address,
    area,
    state,
    pincode,
  };
}

export function serviceAreasForPlots(plots, selectedIds) {
  const selected = new Set((selectedIds || []).map(Number));
  return (plots || []).filter((plot) => selected.has(Number(plot.id))).map((plot) => serviceAreaFromPlot(plot));
}
