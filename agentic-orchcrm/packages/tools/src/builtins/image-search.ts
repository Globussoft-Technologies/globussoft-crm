/**
 * image_search — returns URLs of real, free-to-use photos for a query.
 *
 * Safe as a tool (unlike PDF rendering): it returns only a short list of URLs,
 * never large HTML, so it can't trigger the tool-call-arg loop. A researcher
 * agent uses it to gather real imagery that the designer then embeds verbatim.
 */
import type { Tool } from '../types.js';
import { searchPhotos, aiImageUrl } from '../assets.js';

export const imageSearchTool: Tool = {
  name: 'image_search',
  description:
    'Search FREE-to-use real photos (Pexels/Unsplash/Openverse/Wikimedia) for a specific subject and return image URLs to embed in a brochure. Use precise queries like "Kyoto Fushimi Inari torii gates" or "Tokyo Skytree night skyline".',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'A specific subject to find photos of (place + subject), e.g. "Kyoto Fushimi Inari torii gates".',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args, _ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return 'Error: query is required.';

    const photos = await searchPhotos(query, 3);
    if (!photos.length) {
      // No real photo found — hand back a keyless AI-generated image URL instead.
      return `No free photo found for "${query}". Use this AI image instead:\n${aiImageUrl(
        `${query}, travel photography, high quality, natural light`,
      )}`;
    }
    return photos.map((p, i) => `${i + 1}. ${p.url}  (source: ${p.source})`).join('\n');
  },
};
