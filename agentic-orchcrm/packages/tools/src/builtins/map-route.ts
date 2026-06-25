/**
 * map_route — builds a styled route-map image URL (pins per city + a route line)
 * for a trip itinerary. Returns a single URL (loop-safe; no HTML). Uses keyless
 * Nominatim geocoding + MapTiler static maps (if MAPTILER_API_KEY is set).
 */
import type { Tool } from '../types.js';
import { routeMapUrl } from '../assets.js';

export const mapRouteTool: Tool = {
  name: 'map_route',
  description:
    'Build a styled route-map IMAGE URL showing a marker per city and a line between them, for a trip itinerary. Pass the ordered city names. Returns one image URL (or a note to design a CSS/AI map if maps are unavailable).',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      cities: {
        type: 'string',
        description:
          'Ordered cities along the route as a SEMICOLON-separated list, each "City, Country", e.g. "Tokyo, Japan; Kyoto, Japan; Nara, Japan; Osaka, Japan".',
      },
      color: { type: 'string', description: 'Hex accent for the route line, e.g. E4002B.' },
    },
    required: ['cities'],
    additionalProperties: false,
  },
  async handler(args, _ctx) {
    const cities = String(args.cities ?? '')
      .split(/[;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!cities.length) return 'Error: cities is required.';
    const color = args.color ? String(args.color) : undefined;
    const url = await routeMapUrl(cities, color ? { color } : undefined);
    return url
      ? `Route map image URL: ${url}`
      : 'No map available (no MapTiler key or geocoding failed) — design a stylised CSS/AI journey map instead.';
  },
};
