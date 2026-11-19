import { Country, State } from 'country-state-city';

// Keep the territory picker backed by the package's ISO country and
// administrative-division dataset instead of maintaining a partial list by
// hand. This gives every country the same state/region behavior.
export const TERRITORY_COUNTRIES = Country.getAllCountries()
  .map(country => ({ code: country.isoCode, name: country.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function countryName(code) {
  return TERRITORY_COUNTRIES.find(country => country.code === code)?.name || code;
}

export function statesForCountry(code) {
  return State.getStatesOfCountry(code).map(state => ({
    code: state.isoCode || state.name,
    name: state.name,
  }));
}
